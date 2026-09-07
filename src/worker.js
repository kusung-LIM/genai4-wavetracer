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
