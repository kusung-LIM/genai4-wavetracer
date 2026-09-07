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

// 스팟 표. id 는 프론트(public/index.html 의 SPOTS)와 반드시 같아야 한다 — 그쪽은
// 이름·지역·facing 같은 표시용 정보를, 여기서는 수집에 필요한 좌표와 특보구역을
// 들고 있고 id 로 join 한다. 스팟을 추가할 때는 양쪽 다 넣어야 한다.
//
//   lat/lon : 해변 좌표 (바람 수집용)
//   sea     : 앞바다 좌표 (해상 수집용 — 해변 좌표를 그대로 쓰면 파랑 모델이
//             육지로 판정해 null 만 돌려준다)
//
// zoneName 은 잠정치다. TODO 실키 연동 전 반드시 검증할 것: 공공데이터포털의
// 공식 코드표("기상청_기상특보구역정보", 데이터셋 15043573)를 인증키로 내려받아
// 실제 특보 응답의 지역명 표기와 일치하는지, 해변이 그 구역 경계 안에 있는지
// 대조 확인해야 한다. 지금은 인증키 없이 그 코드표를 열람할 수 없다.
const SPOTS = {
  sampo:     { zoneName: "동해중부앞바다", lat: 38.2650, lon: 128.5620, sea: [38.2650, 128.5950] },
  hajodae:   { zoneName: "동해중부앞바다", lat: 38.0480, lon: 128.6960, sea: [38.0480, 128.7300] },
  jukdo:     { zoneName: "동해중부앞바다", lat: 38.0158, lon: 128.7186, sea: [38.0158, 128.7500] },
  ingu:      { zoneName: "동해중부앞바다", lat: 37.9930, lon: 128.7290, sea: [37.9930, 128.7600] },
  gyeongpo:  { zoneName: "동해중부앞바다", lat: 37.8010, lon: 128.9080, sea: [37.8010, 128.9400] },
  geumjin:   { zoneName: "동해중부앞바다", lat: 37.6360, lon: 129.0460, sea: [37.6360, 129.0750] },
  yonghan:   { zoneName: "동해남부앞바다", lat: 36.1170, lon: 129.4090, sea: [36.1170, 129.4400] },
  songjeong: { zoneName: "남해동부앞바다", lat: 35.1786, lon: 129.1997, sea: [35.1640, 129.2130] },
  dadaepo:   { zoneName: "남해서부앞바다", lat: 35.0430, lon: 128.9670, sea: [35.0250, 128.9670] },
  jungmun:   { zoneName: "제주도앞바다",   lat: 33.2447, lon: 126.4106, sea: [33.2250, 126.4106] },
  iho:       { zoneName: "제주도앞바다",   lat: 33.4990, lon: 126.4530, sea: [33.5200, 126.4530] },
  woljeong:  { zoneName: "제주도앞바다",   lat: 33.5560, lon: 126.7960, sea: [33.5750, 126.7960] },
  malli:     { zoneName: "서해중부앞바다", lat: 36.7889, lon: 126.1379, sea: [36.7889, 126.1050] },
};
const SPOT_IDS = Object.keys(SPOTS); // 파도 제보의 스팟 검증에도 그대로 재사용
const ZONE_MAP = SPOTS;              // 풍랑특보 매핑은 같은 표를 본다

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

/* ---------- 안전 코퍼스 검색 (챗봇의 근거 공급원) ----------
   벡터 임베딩 없이 D1 FTS5(trigram) + LIKE 로 질문과 관련된 문서를 찾는다.
   여기서 찾은 발췌만 LLM 에 근거로 넘겨서, 모델이 코퍼스 밖 규정을 지어내지
   못하게 막는다. (FTS5 와 LIKE 를 같이 쓰는 이유는 searchSafetyDocs 참고) */
const SAFETY_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8"; // 다국어·한국어 성능 확인된 Cloudflare 호스팅 모델
const SAFETY_SALT = "wavetracer-safety-v1-salt"; // reports 와 해시 공간을 분리하기 위한 별도 salt
const SAFETY_RATE_LIMIT_MAX = 15;
const SAFETY_RATE_LIMIT_WINDOW_MIN = 10;
const SAFETY_TOP_K = 5;

// 한국어는 조사가 단어 끝에 그대로 붙어("풍랑주의보에는") FTS5 트라이그램의
// 부분문자열 매칭을 깨뜨리기 쉽다. 형태소 분석기 없이 가장 흔한 조사만 잘라내는
// 얕은 스테밍이다 — 완벽하지 않지만, 15~30개 규모 코퍼스에서 재현율을 크게
// 끌어올린다. 긴 조사를 먼저 시도해야 짧은 조사가 잘못 걸리는 걸 막는다.
const JOSA = ["으로부터", "이라고는", "에서는", "에게서", "한테서", "이라고", "으로는",
  "에는", "으로", "이랑", "하고", "이나", "은", "는", "이", "가", "을", "를",
  "의", "에", "와", "과", "도", "만", "까지", "부터", "보다", "처럼", "마다", "라"]
  .sort((a, b) => b.length - a.length);

function stripJosa(word){
  for (const j of JOSA){
    if (word.length - j.length >= 2 && word.endsWith(j)) return word.slice(0, -j.length);
  }
  return word;
}

const SAFETY_STOPWORDS = new Set([
  "그리고", "그런데", "그러면", "어떻게", "무엇", "뭔가", "뭐", "하나요", "되나요",
  "인가요", "있나요", "합니까", "입니까", "해야", "해야하나요", "알려줘", "알려주세요",
  "궁금해요", "좀", "혹시", "만약", "때는", "경우", "대해", "대한", "관련", "입니다", "합니다"
]);

const ftsQuote = s => '"' + s.replace(/"/g, '""') + '"';

function extractTerms(question){
  const words = question.replace(/[?!.,~]/g, " ").split(/\s+/).map(s => s.trim()).filter(Boolean);
  const terms = new Set();
  for (const w of words){
    if (w.length < 2 || SAFETY_STOPWORDS.has(w)) continue;
    terms.add(w);
    const stem = stripJosa(w);
    if (stem.length >= 2 && !SAFETY_STOPWORDS.has(stem)) terms.add(stem);
  }
  return terms;
}

/** 코퍼스에서 질문과 관련된 문서를 찾는다.
    FTS5 트라이그램은 3글자 미만 용어를 원천적으로 매칭할 수 없다 — 트라이그램
    자체가 연속 3글자 단위라, "신고"·"번호"·"특보"처럼 흔한 2음절 한국어 명사는
    코퍼스에 그대로 있어도 걸리지 않는다(직접 재현해서 확인했다). 그래서 2글자
    용어는 FTS 대신 LIKE 전체 스캔으로 따로 찾아 합친다 — 코퍼스가 16개 문서
    수준이라 스캔 비용은 무시할 만하다. 코퍼스가 수백 개로 늘면 이 절충은
    다시 봐야 한다. */
async function searchSafetyDocs(env, question){
  const terms = extractTerms(question);
  if (!terms.size) return [];

  const longTerms = [...terms].filter(t => t.length >= 3);
  const shortTerms = [...terms].filter(t => t.length < 3);
  const docMap = new Map();

  if (longTerms.length){
    try {
      const ftsQuery = longTerms.map(ftsQuote).join(" OR ");
      const { results } = await env.DB.prepare(
        "SELECT s.id, s.title, s.category, s.body, s.source_name, s.source_url " +
        "FROM safety_docs_fts f JOIN safety_docs s ON s.id = f.rowid " +
        "WHERE safety_docs_fts MATCH ? ORDER BY rank LIMIT ?"
      ).bind(ftsQuery, SAFETY_TOP_K * 2).all();
      for (const r of (results || [])) docMap.set(r.id, r);
    } catch (_){ /* FTS 실패는 아래 LIKE 결과만으로도 응답 가능하니 무시한다 */ }
  }

  if (shortTerms.length){
    try {
      const conds = shortTerms.map(() => "(title LIKE ? OR body LIKE ?)").join(" OR ");
      const binds = [];
      for (const t of shortTerms) binds.push(`%${t}%`, `%${t}%`);
      binds.push(SAFETY_TOP_K * 2);
      const { results } = await env.DB.prepare(
        `SELECT id, title, category, body, source_name, source_url FROM safety_docs WHERE ${conds} LIMIT ?`
      ).bind(...binds).all();
      for (const r of (results || [])) if (!docMap.has(r.id)) docMap.set(r.id, r);
    } catch (_){ /* 마찬가지로 위 FTS 결과만으로 응답 가능하니 무시한다 */ }
  }

  return [...docMap.values()].slice(0, SAFETY_TOP_K);
}

/* ---------- AI 챗봇 (/api/chat) ----------
   안전·규정 질문과 "오늘 어디가 좋아?" 같은 추천을 한 창구에서 받는다.

   근거는 두 갈래로 붙인다.
     1) 안전 자료 — 질문 키워드로 D1 코퍼스를 검색해(searchSafetyDocs) 걸린 것만
     2) 현재 컨디션 — spot_conditions 는 13행뿐이라 늘 통째로 넣는다

   도구 호출(function calling)로 모델이 갈래를 고르게 할 수도 있지만, LLM 왕복이
   두 번이 되고 지연·비용이 늘어난다. 자료가 이 정도로 작으면 둘 다 넣고 한 번만
   부르는 쪽이 단순하고 빠르다.

   점수는 클라이언트가 계산해 보내온다. 레벨별 점수 곡선을 프론트 한 곳에만 두려는
   기존 결정을 유지하기 위해서다 — 워커가 따로 채점하면 곡선이 두 벌이 되고, 지도에
   82점으로 뜨는 스팟을 챗봇이 다르게 말하는 사고가 난다. 사용자가 조작해도 자기
   대화에만 영향이 있어 위험이 낮다. */
const CHAT_MAX_TURNS = 8;      // 왕복 히스토리 상한 (토큰·비용 방어)
const CHAT_MAX_CHARS = 500;    // 한 메시지 길이 상한
const CHAT_RATE_LIMIT_MAX = 20;

function conditionsBlock(spotScores, level){
  if (!Array.isArray(spotScores) || !spotScores.length) return "";
  const lines = spotScores
    .filter(s => s && typeof s.id === "string" && SPOTS[s.id])
    .slice(0, SPOT_IDS.length)
    .map(s => {
      const name = typeof s.name === "string" ? s.name.slice(0, 20) : s.id;
      const score = Number.isFinite(s.score) ? Math.round(s.score) : null;
      const wave = Number.isFinite(s.waveH) ? s.waveH.toFixed(1) + "m" : "-";
      return `- ${name}: ${score == null ? "점수 없음" : score + "점"}, 파고 ${wave}`;
    });
  if (!lines.length) return "";
  return `[현재 컨디션 · ${level} 기준 · 이 앱이 계산한 점수]\n` + lines.join("\n");
}

async function handleChat(request, env, ctx){
  if (request.method !== "POST"){
    return json({ error: "method_not_allowed", message: "허용되지 않은 메서드입니다." }, 405, { allow: "POST" });
  }
  if (!env.DB || !env.AI) return json({ ready: false, reason: "not_configured" });

  let raw;
  try { raw = await request.json(); } catch (_){
    return json({ error: "validation", message: "요청을 읽을 수 없습니다." }, 400);
  }
  if (!raw || typeof raw !== "object") raw = {};

  // 히스토리 검증: 역할과 길이를 강제하고 최근 것만 남긴다.
  const history = (Array.isArray(raw.messages) ? raw.messages : [])
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-CHAT_MAX_TURNS)
    .map(m => ({ role: m.role, content: m.content.trim().slice(0, CHAT_MAX_CHARS) }))
    .filter(m => m.content.length > 0);

  const last = history[history.length - 1];
  if (!last || last.role !== "user"){
    return json({ error: "validation", message: "질문을 입력해주세요." }, 400);
  }
  if (last.content.length < 2){
    return json({ error: "validation", message: "질문은 2자 이상 입력해주세요." }, 400);
  }

  const levelLabel = typeof raw.level === "string" ? raw.level.slice(0, 12) : "숏보더";

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipHash = await sha256Hex(ip + SAFETY_SALT);
  const windowStart = new Date(Date.now() - SAFETY_RATE_LIMIT_WINDOW_MIN * 60 * 1000).toISOString();
  try {
    await env.DB.prepare("DELETE FROM safety_asks WHERE created_at < ?1").bind(windowStart).run();
    const { results: recent } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM safety_asks WHERE ip_hash = ?1 AND created_at > ?2"
    ).bind(ipHash, windowStart).all();
    if (((recent && recent[0] && recent[0].n) || 0) >= CHAT_RATE_LIMIT_MAX){
      return json({ error: "rate_limited", message: "짧은 시간에 너무 많은 질문이 들어왔습니다. 잠시 후 다시 시도해주세요." }, 429);
    }
    ctx.waitUntil(env.DB.prepare(
      "INSERT INTO safety_asks (ip_hash, created_at) VALUES (?1, ?2)"
    ).bind(ipHash, new Date().toISOString()).run());
  } catch (_){ /* 집계 실패가 답변을 막을 이유는 없다 */ }

  const docs = await searchSafetyDocs(env, last.content);
  const docBlock = docs.length
    ? "[안전 자료]\n" + docs.map((d, i) =>
        `[문서 ${i + 1}] ${d.title}\n${d.body}\n(출처: ${d.source_name})`).join("\n\n")
    : "";
  const condBlock = conditionsBlock(raw.spots, levelLabel);

  // 인용 규칙은 안전 자료가 실제로 붙었을 때만 넣는다. 조건 없이 넣어두면
  // 자료가 하나도 없는 추천 질문에도 모델이 [문서 1] 을 붙여서, 가리킬 대상이
  // 없는 인용이 화면에 남는다(실제로 재현했다).
  const citeRule = docs.length
    ? "5. 참고한 안전 문서가 있으면 끝에 [문서 1] 처럼 번호를 표시한다."
    : "5. 이번 질문에는 안전 자료가 제공되지 않았다. [문서 1] 같은 문서 번호 표기를 절대 쓰지 마라.";

  const systemPrompt =
    "너는 국내 서핑 예보 앱 WaveTracer 의 안내 도우미다. 한국어로 친근하되 간결하게 답한다(5문장 이내).\n" +
    "규칙:\n" +
    "1. [안전 자료] 에 있는 내용만 근거로 규정·법령·안전 수칙을 말한다. 자료에 없으면 모른다고 말하고 기상청·해양경찰청 확인을 권한다. 절대 지어내지 않는다.\n" +
    "2. [현재 컨디션] 의 점수는 이 앱이 계산한 값이다. 그대로 인용하고 임의로 바꾸거나 새로 매기지 않는다. " +
    "포인트 추천은 [현재 컨디션] 만으로 답한다 — 안전 자료가 없어도 추천은 얼마든지 가능하니, 자료가 없다는 이유로 추천을 거절하지 마라. 점수가 높은 순으로 답한다.\n" +
    "3. 서핑·해양 안전과 무관한 질문에는 답할 수 없다고 짧게 말한다.\n" +
    "4. 안전·규정을 다뤘다면 법률 자문이 아닌 참고 정보임을 한 문장으로 덧붙인다.\n" +
    citeRule;

  const grounding = [condBlock, docBlock].filter(Boolean).join("\n\n");
  const messages = [{ role: "system", content: systemPrompt }];
  // 직전 대화는 그대로 넘겨 다회차 맥락을 유지하고, 자료는 마지막 질문에만 붙인다.
  history.slice(0, -1).forEach(m => messages.push(m));
  messages.push({
    role: "user",
    content: (grounding ? grounding + "\n\n" : "") + "[질문]\n" + last.content,
  });

  try {
    // max_tokens 를 반드시 넘긴다. 이 모델은 추론형이라 생각 과정에도 출력 토큰을
    // 쓰는데, 기본값에 맡기면 프롬프트가 길어질 때 생각만 하다 예산이 떨어져
    // response 가 빈 문자열로 돌아온다(운영에서 실제로 재현했다).
    const ai = await env.AI.run(SAFETY_MODEL, { messages, max_tokens: 900 });
    // 모델이 앞뒤로 빈 줄을 붙여 보내는 경우가 있다. 말풍선은 pre-wrap 이라
    // 그대로 두면 위아래로 빈 공간이 생긴다.
    const answer = String((ai && (ai.response || ai.result)) || "").trim() ||
      "답변을 생성하지 못했습니다.";
    return json({
      ready: true,
      answer,
      sources: docs.map(d => ({
        id: d.id, title: d.title, category: d.category,
        sourceName: d.source_name, sourceUrl: d.source_url,
      })),
    });
  } catch (_){
    return json({ error: "ai_error", message: "답변 생성 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요." }, 502);
  }
}

/* ---------- 스팟 현재 상황 수집 (/api/conditions + Cron) ----------
   13개 스팟을 방문자마다 부르면 요청이 26번 나가고 Open-Meteo 쿼터가 트래픽에
   비례해 녹는다. 그래서 Cron(15분)이 한 번만 모아 D1 에 넣고, 홈은 D1 만 읽는다.

   Open-Meteo 는 latitude/longitude 에 쉼표로 여러 좌표를 넣으면 입력 순서대로
   배열을 돌려준다. 덕분에 13개 스팟이 해상 1건 + 바람 1건, 총 2요청으로 끝난다.

   점수는 저장하지 않는다 — 레벨별 곡선은 프론트에만 두고 여기서는 원시 관측값만
   넣어서, 점수 곡선을 손봐도 저장분을 다시 만들 필요가 없게 했다. */
const MARINE_FIELDS = "wave_height,wave_direction,wave_period,swell_wave_height," +
                      "swell_wave_direction,swell_wave_period,sea_surface_temperature";
const AIR_FIELDS = "wind_speed_10m,wind_direction_10m";

const pickAt = (arr, i) => (arr && arr[i] != null) ? arr[i] : null;

async function getJSON(url){
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url.slice(0, 60)}`);
  return res.json();
}

/** KST 기준 현재 정시를 Open-Meteo 의 시간 문자열(YYYY-MM-DDTHH:00) 형식으로 */
function nowHourKST(){
  const p = {};
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false,
  }).formatToParts(new Date()).forEach(x => { p[x.type] = x.value; });
  const hh = p.hour === "24" ? "00" : p.hour;
  return `${p.year}-${p.month}-${p.day}T${hh}:00`;
}

async function refreshConditions(env){
  if (!env.DB) return { ok: false, reason: "no_database" };

  const ids = SPOT_IDS;
  const seaLat = ids.map(id => SPOTS[id].sea[0].toFixed(4)).join(",");
  const seaLon = ids.map(id => SPOTS[id].sea[1].toFixed(4)).join(",");
  const airLat = ids.map(id => SPOTS[id].lat.toFixed(4)).join(",");
  const airLon = ids.map(id => SPOTS[id].lon.toFixed(4)).join(",");

  const marineUrl = "https://marine-api.open-meteo.com/v1/marine?latitude=" + seaLat +
    "&longitude=" + seaLon + "&hourly=" + MARINE_FIELDS + "&timezone=Asia%2FSeoul&forecast_days=1";
  const airUrl = "https://api.open-meteo.com/v1/forecast?latitude=" + airLat +
    "&longitude=" + airLon + "&hourly=" + AIR_FIELDS +
    "&timezone=Asia%2FSeoul&forecast_days=1&wind_speed_unit=ms";

  const [marine, air] = await Promise.all([getJSON(marineUrl), getJSON(airUrl)]);
  // 좌표를 하나만 넣으면 배열이 아니라 객체가 오므로 방어적으로 감싼다.
  const M = Array.isArray(marine) ? marine : [marine];
  const A = Array.isArray(air) ? air : [air];

  const target = nowHourKST();
  const now = new Date().toISOString();
  const writes = [];

  ids.forEach((id, n) => {
    const m = M[n], a = A[n];
    if (!m || !m.hourly) return;
    // 현재 정시를 찾고, 없으면(자정 경계 등) 첫 시각으로 떨어진다.
    let i = m.hourly.time.indexOf(target);
    if (i < 0) i = 0;
    const j = (a && a.hourly) ? Math.max(0, a.hourly.time.indexOf(m.hourly.time[i])) : -1;

    writes.push(env.DB.prepare(
      "INSERT INTO spot_conditions (spot_id, observed_at, updated_at, wave_height, wave_period, wave_dir," +
      " swell_height, swell_period, swell_dir, wind_speed, wind_dir, sea_temp)" +
      " VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)" +
      " ON CONFLICT(spot_id) DO UPDATE SET observed_at=excluded.observed_at, updated_at=excluded.updated_at," +
      " wave_height=excluded.wave_height, wave_period=excluded.wave_period, wave_dir=excluded.wave_dir," +
      " swell_height=excluded.swell_height, swell_period=excluded.swell_period, swell_dir=excluded.swell_dir," +
      " wind_speed=excluded.wind_speed, wind_dir=excluded.wind_dir, sea_temp=excluded.sea_temp"
    ).bind(
      id, m.hourly.time[i], now,
      pickAt(m.hourly.wave_height, i), pickAt(m.hourly.wave_period, i), pickAt(m.hourly.wave_direction, i),
      pickAt(m.hourly.swell_wave_height, i), pickAt(m.hourly.swell_wave_period, i), pickAt(m.hourly.swell_wave_direction, i),
      j < 0 ? null : pickAt(a.hourly.wind_speed_10m, j),
      j < 0 ? null : pickAt(a.hourly.wind_direction_10m, j),
      pickAt(m.hourly.sea_surface_temperature, i)
    ));
  });

  if (writes.length) await env.DB.batch(writes);
  return { ok: true, spots: writes.length, observedAt: target };
}

async function handleConditions(request, env){
  if (request.method !== "GET"){
    return json({ error: "method_not_allowed", message: "허용되지 않은 메서드입니다." }, 405, { allow: "GET" });
  }
  // 아직 한 번도 수집되지 않았거나 DB 가 없으면 빈 목록으로 안전하게 저하된다 —
  // 지도는 마커를 회색으로 그리고 예보 화면은 평소대로 돈다.
  if (!env.DB) return json({ ready: false, spots: [] });

  try {
    const { results } = await env.DB.prepare(
      "SELECT spot_id, observed_at, updated_at, wave_height, wave_period, wave_dir," +
      " swell_height, swell_period, swell_dir, wind_speed, wind_dir, sea_temp FROM spot_conditions"
    ).all();
    const spots = (results || []).map(r => ({
      spotId: r.spot_id, observedAt: r.observed_at, updatedAt: r.updated_at,
      waveH: r.wave_height, waveP: r.wave_period, waveD: r.wave_dir,
      swellH: r.swell_height, swellP: r.swell_period, swellD: r.swell_dir,
      windSpd: r.wind_speed, windDir: r.wind_dir, seaT: r.sea_temp,
    }));
    return json({ ready: spots.length > 0, spots }, 200, { "cache-control": "public, max-age=120" });
  } catch (_){
    return json({ ready: false, spots: [] });
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
    if (url.pathname === "/api/chat") return handleChat(request, env, ctx);
    if (url.pathname === "/api/conditions") return handleConditions(request, env);

    // run_worker_first 가 "/api/*" 만 여기로 보내므로 원칙적으로 도달하지 않지만,
    // 방어적으로 정적 자산 폴백을 남겨둔다.
    return env.ASSETS.fetch(request);
  },

  // wrangler.jsonc 의 triggers.crons 가 15분마다 부른다.
  // 실패해도 조용히 넘어간다 — 다음 주기에 다시 시도하고, 그동안 홈 지도는
  // 직전 스냅샷을 계속 보여주면 되기 때문이다.
  async scheduled(event, env, ctx){
    ctx.waitUntil(
      refreshConditions(env).catch(err => {
        console.error("refreshConditions failed:", (err && err.message) || err);
      })
    );
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
