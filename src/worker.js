// Cloudflare Worker 진입점.
//
// 정적 파일(public/)은 기본적으로 이 워커를 거치지 않고 바로 서빙된다 —
// wrangler.jsonc 의 assets.run_worker_first 가 "/api/*" 만 이 워커로 보내도록
// 되어 있어서, 나머지 요청(HTML/이미지 등)은 지금까지와 똑같이 무료·고속 경로를 탄다.
//
// /api/advisory
//   기상청 풍랑특보(주의보/경보) 발효 현황을 서버에서 대신 조회해 브라우저에 돌려준다.
//   브라우저에서 공공데이터포털 API를 직접 부르면 인증키가 그대로 노출되고,
//   대부분의 국내 공공 API 는 임의 출처의 CORS 를 열어주지 않아 클라이언트 fetch 가
//   막힐 가능성이 커서 여기서 대리 호출(proxy)한다.
//
// 인증키는 코드에도 .dev.vars 에도 평문으로 두지 않고 Cloudflare 시크릿으로만 넣는다.
//   운영:   npx wrangler secret put KMA_SERVICE_KEY
//   로컬:   .dev.vars 파일에 KMA_SERVICE_KEY=발급받은키   (커밋 금지, .gitignore 처리됨)
//
// KMA_SERVICE_KEY 가 아직 없으면 { ready:false } 를 돌려주고, 프론트는 이를
// "연동 준비 중" 배너로 보여준다. 시크릿을 넣는 순간 재배포 없이 바로 실데이터로 전환된다.

const KMA_ENDPOINT = "https://apis.data.go.kr/1360000/WthrWrnInfoService/getWthrWrnList";
const CACHE_SECONDS = 600; // 10분 — 공공데이터포털 하루 호출 한도(기본 1,000회/키)를 아낀다

// 스팟 → 해상 예보구역 매핑 (잠정치).
//
// TODO 실키 연동 전 반드시 검증할 것: 공공데이터포털의 공식 코드표
// ("기상청_기상특보구역정보", 데이터셋 15043573)를 인증키로 내려받아
// 아래 zoneName 이 실제 특보 응답의 지역명 표기와 정확히 일치하는지,
// 그리고 해변이 그 구역 경계 안에 있는지 대조 확인해야 한다.
// 지금은 인증키 없이는 그 코드표를 열람할 수 없어 이름만 잠정 매핑해 두었다.
const ZONE_MAP = {
  sampo:     { zoneName: "동해중부앞바다" },
  hajodae:   { zoneName: "동해중부앞바다" },
  jukdo:     { zoneName: "동해중부앞바다" },
  ingu:      { zoneName: "동해중부앞바다" },
  gyeongpo:  { zoneName: "동해중부앞바다" },
  geumjin:   { zoneName: "동해중부앞바다" },
  yonghan:   { zoneName: "동해남부앞바다" },
  songjeong: { zoneName: "남해동부앞바다" },
  dadaepo:   { zoneName: "남해서부앞바다" },
  jungmun:   { zoneName: "제주도앞바다" },
  iho:       { zoneName: "제주도앞바다" },
  woljeong:  { zoneName: "제주도앞바다" },
  malli:     { zoneName: "서해중부앞바다" },
};
const SPOT_IDS = Object.keys(ZONE_MAP); // 파도 제보의 스팟 검증에도 그대로 재사용 — 스팟 표를 두 곳에 두지 않는다

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------- 파도 제보 게시판 (/api/reports) ---------- */
// 레이트리밋: 클라이언트당 10분에 5건. IP 를 직접 저장하면 방문자 신원이 남는
// 개인정보라, "IP + 고정 salt" 를 SHA-256 해시한 값만 저장해 같은 클라이언트인지
// 판별하는 용도로만 쓴다. salt 는 비밀값이 아니라 원본 IP를 평문으로 남기지
// 않기 위한 장치일 뿐이다(같은 IP는 항상 같은 해시가 되므로 완전한 익명화는
// 아니지만, 원본 IP를 그대로 쌓아두는 것보다는 안전한 절충안이다).
const REPORT_SALT = "wavetracer-report-v1-salt";
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MIN = 10;

async function sha256Hex(text){
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function rowToReport(row){
  return {
    id: row.id,
    spotId: row.spot_id,
    nickname: row.nickname,
    rating: row.rating == null ? null : Number(row.rating),
    waveHeight: row.wave_height == null ? null : Number(row.wave_height),
    body: row.body,
    createdAt: row.created_at,
  };
}

async function handleReports(request, env, ctx){
  if (request.method === "GET") return handleReportsGet(request, env);
  if (request.method === "POST") return handleReportsPost(request, env);
  return json({ error: "method_not_allowed", message: "허용되지 않은 메서드입니다." }, 405, { allow: "GET, POST" });
}

async function handleReportsGet(request, env){
  // DB 바인딩 전이면 advisory 와 같은 패턴으로 { ready:false } 를 돌려주고, 프론트는
  // 이를 "아직 게시판이 없다"가 아니라 친절한 빈 상태로 그린다.
  if (!env.DB) return json({ ready: false, reports: [] });

  const url = new URL(request.url);
  let limit = parseInt(url.searchParams.get("limit"), 10);
  if (!Number.isFinite(limit)) limit = 5;
  limit = clamp(limit, 1, 50);

  try {
    const { results } = await env.DB.prepare(
      "SELECT id, spot_id, nickname, rating, wave_height, body, created_at " +
      "FROM reports ORDER BY created_at DESC, id DESC LIMIT ?1"
    ).bind(limit).all();
    return json({ ready: true, reports: (results || []).map(rowToReport) });
  } catch (err){
    // 쿼리 실패도 화면에는 에러가 아니라 빈 게시판으로 보이게 눙친다 — 게시판은
    // 부가 기능이라 예보 화면 전체를 막을 이유가 없다.
    return json({ ready: false, reports: [] });
  }
}

async function handleReportsPost(request, env){
  if (!env.DB){
    return json({ error: "no_database", message: "제보 저장소가 아직 준비되지 않았습니다. 잠시 후 다시 시도해주세요." }, 503);
  }

  let raw;
  try { raw = await request.json(); } catch (_){
    return json({ error: "validation", message: "요청 본문을 읽을 수 없습니다." }, 400);
  }
  if (!raw || typeof raw !== "object") raw = {};

  const spotId   = typeof raw.spotId === "string" ? raw.spotId : "";
  const nickname = typeof raw.nickname === "string" ? raw.nickname.trim() : "";
  const text     = typeof raw.body === "string" ? raw.body.trim() : "";

  if (!SPOT_IDS.includes(spotId)){
    return json({ error: "validation", message: "알 수 없는 포인트입니다." }, 400);
  }
  if (nickname.length < 1 || nickname.length > 20){
    return json({ error: "validation", message: "닉네임은 1~20자로 입력해주세요." }, 400);
  }
  if (text.length < 1 || text.length > 500){
    return json({ error: "validation", message: "내용은 1~500자로 입력해주세요." }, 400);
  }

  let rating = null;
  if (raw.rating !== undefined && raw.rating !== null && raw.rating !== ""){
    const n = Number(raw.rating);
    if (!Number.isInteger(n) || n < 1 || n > 5){
      return json({ error: "validation", message: "별점은 1~5 사이의 정수여야 합니다." }, 400);
    }
    rating = n;
  }

  let waveHeight = null;
  if (raw.waveHeight !== undefined && raw.waveHeight !== null && raw.waveHeight !== ""){
    const n = Number(raw.waveHeight);
    if (!Number.isFinite(n) || n < 0 || n > 15){
      return json({ error: "validation", message: "체감 파고는 0~15m 사이여야 합니다." }, 400);
    }
    waveHeight = n;
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipHash = await sha256Hex(ip + REPORT_SALT);

  try {
    const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MIN * 60 * 1000).toISOString();
    const { results: recent } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM reports WHERE ip_hash = ?1 AND created_at > ?2"
    ).bind(ipHash, windowStart).all();
    const count = (recent && recent[0] && recent[0].n) || 0;
    if (count >= RATE_LIMIT_MAX){
      return json({ error: "rate_limited", message: "짧은 시간에 너무 많은 제보가 등록됐습니다. 10분 후 다시 시도해주세요." }, 429);
    }

    const createdAt = new Date().toISOString();
    const ins = await env.DB.prepare(
      "INSERT INTO reports (spot_id, nickname, rating, wave_height, body, created_at, ip_hash) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"
    ).bind(spotId, nickname, rating, waveHeight, text, createdAt, ipHash).run();

    const id = ins.meta && ins.meta.last_row_id;
    return json({ report: { id, spotId, nickname, rating, waveHeight, body: text, createdAt } }, 201);
  } catch (err){
    return json({ error: "no_database", message: "제보 저장 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요." }, 503);
  }
}

function json(data, status = 200, extraHeaders){
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign(
      { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      extraHeaders
    ),
  });
}

export default {
  async fetch(request, env, ctx){
    const url = new URL(request.url);

    if (url.pathname === "/api/advisory") return handleAdvisory(request, env, ctx);
    if (url.pathname === "/api/reports") return handleReports(request, env, ctx);

    // run_worker_first 가 "/api/*" 만 여기로 보내므로 원칙적으로 도달하지 않지만,
    // 방어적으로 정적 자산 폴백을 남겨둔다.
    return env.ASSETS.fetch(request);
  },
};

async function handleAdvisory(request, env, ctx){
  if (!env.KMA_SERVICE_KEY){
    // 인증키 발급 전. 프론트는 이 응답을 보고 "연동 준비 중" 상태를 그린다.
    return json({ ready: false, reason: "no_service_key" });
  }

  const cache = caches.default;
  const cacheKey = new Request(new URL("/api/advisory", request.url).toString());
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  try {
    const spots = await fetchAdvisoryFromKMA(env.KMA_SERVICE_KEY);
    const res = json(
      { ready: true, updatedAt: new Date().toISOString(), spots },
      200,
      { "cache-control": `public, max-age=${CACHE_SECONDS}` }
    );
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  } catch (err) {
    return json({ ready: false, reason: "upstream_error", message: String((err && err.message) || err) }, 502);
  }
}

// TODO 실키 연동 시 이 함수 내부만 고치면 된다 — handleAdvisory 의 캐싱/에러 처리 골격은
// 그대로 재사용된다. 아래 파싱 로직은 data.go.kr 공개 문서 기준의 설계이고, 실제 응답
// 필드명(발표구분 코드, 특보종류 표기 등)은 승인된 키로 한 번 호출해 확인 후 확정해야 한다.
async function fetchAdvisoryFromKMA(serviceKey){
  const qs = new URLSearchParams({
    serviceKey,
    pageNo: "1",
    numOfRows: "100",
    dataType: "JSON",
  });

  const res = await fetch(`${KMA_ENDPOINT}?${qs}`);
  if (!res.ok) throw new Error(`KMA API ${res.status}`);
  const data = await res.json();

  // TODO: 실제 응답 구조 확인 후 파싱 교체. 아래는 자리표시자 — 지금은 활성 특보가
  // 없다고 가정해 모든 스팟을 "평소(0)"로 채운다. 실키를 받으면 이 블록만 채우면 된다.
  //
  // const items = data?.response?.body?.items?.item ?? [];
  // const activeByZone = new Map();
  // for (const it of items) {
  //   const isWave = it.warnVar === "풍랑";                       // 필드명 확정 필요
  //   const isActive = ["1", "3", "5"].includes(String(it.command)); // 발표/연장/변경
  //   if (!isWave || !isActive) continue;
  //   const level = it.warnStress === "경보" ? 2 : 1;              // 필드명 확정 필요
  //   activeByZone.set(it.areaName, { level, issuedAt: it.tmFc });
  // }
  const activeByZone = new Map();
  void data;

  const spots = {};
  for (const [spotId, zone] of Object.entries(ZONE_MAP)){
    const hit = activeByZone.get(zone.zoneName);
    spots[spotId] = {
      zone: zone.zoneName,
      level: hit ? hit.level : 0,
      issuedAt: hit ? hit.issuedAt : null,
    };
  }
  return spots;
}
