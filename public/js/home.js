import { $, app, clamp, esc, isNum, nowKST, ymd } from "./util.js";
import { SPOTS } from "./spots.js";
import { LEVELS } from "./levels.js";
import { isStale, lastSpotOrDefault, nextReqId, state } from "./state.js";
import { GRADES, conditionToHour, grade, summarize } from "./score.js";
import { fetchReports, loadAdvisory, loadConditions, loadSpot } from "./api.js";
import { renderAdvisoryBanner } from "./advisory.js";
import { renderChart, renderHero, wireChart, wireLevelPicker } from "./forecast.js";
import { renderReportCard, reportsEmptyState } from "./reports.js";
import { navigate } from "./router.js";

/* ============================ 홈 ============================
   블로그 스타일로 딱 두 섹션만: 오늘의 파도(마지막으로 본 포인트 기준) +
   최근 파도 제보 5개. 두 섹션은 서로 독립적으로 로드해서, 한쪽이 느리거나
   실패해도 다른 쪽을 막지 않는다.
================================================================ */

/* ============================ 전국 지도 (홈) ============================
   지도 라이브러리 없이 인라인 SVG 로만 그린다 — 이 앱은 의존성 0, 빌드 스텝 0 을
   유지하고 있고, 지도 하나 때문에 그 성질을 깨고 싶지 않았다.

   외곽선을 SVG path 문자열이 아니라 "위경도 점 목록"으로 두는 게 핵심이다.
   해안선과 스팟 마커를 똑같은 projectMap() 으로 투영하므로, 좌표계가 어긋날
   여지가 구조적으로 없다. 대신 외곽선은 손으로 찍은 단순화 버전이라 실제
   해안선과 정확히 일치하지는 않는다 — 배경 삽화 수준으로만 봐야 한다.

   경도 1도는 위도 1도보다 짧으므로(위도 36도에서 약 90km 대 111km) 가로를
   cos 보정해 뷰박스를 잡는다. 안 하면 남한이 옆으로 퍼져 보인다. */
const MAP = { latMin: 32.9, latMax: 38.75, lonMin: 125.7, lonMax: 129.85, W: 360 };
MAP.H = Math.round(MAP.W *
  ((MAP.latMax - MAP.latMin) * 110.9) / ((MAP.lonMax - MAP.lonMin) * 90.3));

function projectMap(lat, lon){
  return {
    x: (lon - MAP.lonMin) / (MAP.lonMax - MAP.lonMin) * MAP.W,
    y: (MAP.latMax - lat) / (MAP.latMax - MAP.latMin) * MAP.H,
  };
}

// 단순화한 남한 해안선. 본토는 북서쪽에서 시계방향, 제주는 별도 폐곡선.
const MAP_SHAPES = [
  [ // 본토
    [37.78,126.68],[38.00,126.95],[38.31,127.35],[38.30,127.80],[38.45,128.05],[38.62,128.38],
    [38.20,128.60],[37.75,129.05],[37.40,129.18],[36.99,129.42],[36.60,129.46],[36.05,129.43],
    [35.72,129.48],[35.48,129.42],[35.20,129.22],[35.08,129.05],[34.94,128.68],[34.85,128.42],
    [34.72,128.05],[34.75,127.72],[34.60,127.48],[34.47,127.30],[34.60,126.98],[34.42,126.75],
    [34.30,126.55],[34.48,126.30],[34.72,126.35],[34.79,126.38],[35.10,126.42],[35.45,126.48],
    [35.75,126.60],[35.98,126.68],[36.25,126.50],[36.45,126.42],[36.60,126.35],[36.78,126.13],
    [36.95,126.32],[36.88,126.55],[37.05,126.70],[37.30,126.60],[37.45,126.62],[37.62,126.55],
  ],
  [ // 제주
    [33.56,126.50],[33.52,126.72],[33.45,126.90],[33.33,126.94],[33.24,126.85],[33.20,126.62],
    [33.23,126.42],[33.29,126.22],[33.40,126.17],[33.50,126.25],
  ],
];

const shapePath = pts =>
  "M" + pts.map(([la, lo]) => {
    const p = projectMap(la, lo);
    return p.x.toFixed(1) + "," + p.y.toFixed(1);
  }).join("L") + "Z";


function renderKoreaMap(rows){
  const byId = new Map(rows.map(r => [r.spotId, r]));
  const markers = SPOTS.map(s => {
    const row = byId.get(s.id);
    const sc = row ? conditionToHour(row, s).scores : null;
    const v = sc ? sc[state.level] : null;
    const g = grade(v);
    const p = projectMap(s.lat, s.lon);
    return { spot: s, score: v, color: isNum(v) ? g[2] : "var(--r-flat)", grade: g[1], p: p };
  });

  const dots = markers.map(m =>
    '<g class="kmap-spot" data-spot="' + m.spot.id + '" tabindex="0" role="button" ' +
      'aria-label="' + esc(m.spot.name + " " + (isNum(m.score) ? m.score + "점 " + m.grade : "정보 없음")) + '">' +
      '<circle class="kmap-halo" cx="' + m.p.x.toFixed(1) + '" cy="' + m.p.y.toFixed(1) + '" r="11" fill="' + m.color + '"/>' +
      '<circle class="kmap-dot" cx="' + m.p.x.toFixed(1) + '" cy="' + m.p.y.toFixed(1) + '" r="5.5" fill="' + m.color + '"/>' +
    "</g>").join("");

  return '<svg class="kmap" viewBox="0 0 ' + MAP.W + ' ' + MAP.H + '" role="img" ' +
    'aria-label="남한 지도 위 서핑 포인트별 현재 컨디션">' +
    MAP_SHAPES.map(pts => '<path class="kmap-land" d="' + shapePath(pts) + '"/>').join("") +
    dots +
  "</svg>";
}

/** 지도 옆(좁은 화면에선 아래) 순위 목록. 지도만으로는 어디가 어딘지 모르므로
    이름과 점수를 같이 보여주고, 지도 마커와 같은 색을 쓴다. */
function renderMapRanking(rows){
  const byId = new Map(rows.map(r => [r.spotId, r]));
  const items = SPOTS.map(s => {
    const row = byId.get(s.id);
    const sc = row ? conditionToHour(row, s).scores : null;
    const v = sc ? sc[state.level] : null;
    return { s: s, v: v, row: row };
  }).sort((a, b) => (isNum(b.v) ? b.v : -1) - (isNum(a.v) ? a.v : -1));

  return '<ol class="map-rank">' + items.map(it => {
    const g = grade(it.v);
    return '<li><a href="/forecast?spot=' + it.s.id + '" data-nav data-spot="' + it.s.id + '" class="map-rank-row">' +
      '<span class="map-rank-dot" style="background:' + (isNum(it.v) ? g[2] : "var(--r-flat)") + '"></span>' +
      '<span class="map-rank-name">' + esc(it.s.name) + '</span>' +
      '<span class="map-rank-wave">' + (it.row && isNum(it.row.waveH) ? it.row.waveH.toFixed(1) + "m" : "–") + "</span>" +
      '<span class="map-rank-score" style="color:' + (isNum(it.v) ? g[2] : "var(--dim)") + '">' +
        (isNum(it.v) ? it.v : "–") + "</span>" +
    "</a></li>";
  }).join("") + "</ol>";
}

async function loadHomeMap(my){
  const el = $("#home-map");
  const data = await loadConditions();
  if (isStale(my)) return;

  if (!data.ready || !data.spots.length){
    el.innerHTML = '<div class="state">현재 컨디션을 아직 수집하지 못했습니다.<br>' +
      '<span class="dimc" style="font-size:12px">잠시 후 다시 확인해주세요.</span></div>';
    return;
  }

  el.innerHTML = '<div class="map-wrap">' +
    '<div class="map-figure">' + renderKoreaMap(data.spots) + '<div class="kmap-tip" id="kmap-tip"></div></div>' +
    renderMapRanking(data.spots) +
  "</div>";

  const stamp = data.spots[0] && data.spots[0].observedAt;
  const subEl = $("#map-sub");
  if (stamp && subEl){
    subEl.textContent = "13개 포인트 · " + LEVELS[state.level].label + " 기준 · " +
      stamp.slice(11, 16) + " 관측";
  }
  wireKoreaMap(data.spots);
}

/** 마커 hover/포커스 시 이름·점수 툴팁, 클릭 시 해당 포인트 예보로 이동. */
function wireKoreaMap(rows){
  const svg = $("svg.kmap"), tip = $("#kmap-tip"), fig = $(".map-figure");
  if (!svg || !tip) return;
  const byId = new Map(rows.map(r => [r.spotId, r]));

  const show = g => {
    const s = SPOTS.find(x => x.id === g.dataset.spot);
    const row = byId.get(s.id);
    const sc = row ? conditionToHour(row, s).scores : null;
    const v = sc ? sc[state.level] : null;
    const gr = grade(v);
    tip.innerHTML = "<b>" + esc(s.name) + "</b><br>" +
      (row && isNum(row.waveH) ? row.waveH.toFixed(1) + "m · " : "") +
      '<span style="color:' + (isNum(v) ? gr[2] : "var(--dim)") + '">' +
      (isNum(v) ? v + "점 " + gr[1] : "정보 없음") + "</span>";
    tip.classList.add("on");
    const c = g.querySelector(".kmap-dot");
    const bw = fig.clientWidth, bh = fig.clientHeight;
    const x = (+c.getAttribute("cx") / MAP.W) * bw;
    const y = (+c.getAttribute("cy") / MAP.H) * bh;
    tip.style.left = "0px";
    tip.style.left = clamp(x - tip.offsetWidth / 2, 2, Math.max(2, bw - tip.offsetWidth - 2)) + "px";
    tip.style.top = Math.max(0, y - tip.offsetHeight - 14) + "px";
  };
  const hide = () => tip.classList.remove("on");

  svg.querySelectorAll(".kmap-spot").forEach(g => {
    g.addEventListener("pointerenter", ev => { if (ev.pointerType === "mouse") show(g); });
    g.addEventListener("pointerdown", () => show(g));
    g.addEventListener("focus", () => show(g));
    g.addEventListener("blur", hide);
    g.addEventListener("click", () => navigate("/forecast?spot=" + g.dataset.spot));
    g.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " "){ e.preventDefault(); navigate("/forecast?spot=" + g.dataset.spot); }
    });
  });
  svg.addEventListener("pointerleave", ev => { if (ev.pointerType === "mouse") hide(); });
}

async function renderHomePage(){
  const my = nextReqId();
  const spot = lastSpotOrDefault();

  app.innerHTML =
    '<section class="card">' +
      '<h2>전국 파도 현황</h2>' +
      '<div class="sub" id="map-sub">13개 포인트의 현재 컨디션</div>' +
      '<div id="home-map"><div class="state"><div class="spin"></div>불러오는 중…</div></div>' +
    '</section>' +
    '<section class="card">' +
      '<h2>오늘의 파도</h2>' +
      '<div class="sub">최근 확인한 포인트 · ' + esc(spot.name) + '</div>' +
      '<div id="home-today"><div class="state"><div class="spin"></div>불러오는 중…</div></div>' +
    '</section>' +
    '<section class="card">' +
      '<h2>최근 파도 제보</h2>' +
      '<div class="sub">서퍼들이 남긴 최신 제보</div>' +
      '<div id="home-reports"><div class="state"><div class="spin"></div>불러오는 중…</div></div>' +
    '</section>';

  loadHomeMap(my);
  loadHomeToday(my, spot);
  loadHomeReports(my);
}

async function loadHomeToday(my, spot){
  const el = $("#home-today");
  const today = ymd(nowKST());
  try {
    const [data, advisory] = await Promise.all([ loadSpot(spot), loadAdvisory() ]);
    if (isStale(my)) return;
    const dateStr = data.dates.indexOf(today) >= 0 ? today : data.dates[0];
    const hours = data.byDate.get(dateStr) || [];
    const sm = summarize(hours);
    if (!sm){ el.innerHTML = '<div class="state">오늘의 예보 데이터가 아직 없습니다.</div>'; return; }
    // 시간대별 파고 그래프는 /forecast 와 같은 renderChart/wireChart 를 그대로
    // 재사용한다 — 별도 .card 로 감싸지 않고 "오늘의 파도" 카드 안에 이어 붙여서
    // 홈 화면다운 한 덩어리로 보이게 한다(헤딩만 .sub 로 가볍게).
    el.innerHTML =
      renderAdvisoryBanner(advisory, spot.id) +
      renderHero(spot, dateStr, sm) +
      '<div class="sub">시간대별 파고 · 막대는 ' + esc(LEVELS[state.level].label) + ' 기준 컨디션</div>' +
      renderChart(hours) +
      '<div class="legend">' +
        GRADES.slice().reverse().map(g =>
          '<span><i class="dot" style="background:' + g[2] + '"></i>' + g[1] + "</span>").join("") +
      "</div>" +
      '<div class="home-more-row"><a href="/forecast?' +
        esc(new URLSearchParams({ spot: spot.id, date: dateStr }).toString()) +
        '" data-nav class="home-more">전체 예보 보기 →</a></div>';
    wireChart(hours);
    // 지도·순위도 레벨 기준으로 색과 정렬이 바뀌므로 같이 다시 그린다.
    // reqId 를 건드리지 않으므로 my 토큰은 그대로 유효하다.
    wireLevelPicker(() => { loadHomeToday(my, spot); loadHomeMap(my); });
  } catch (e){
    if (isStale(my)) return;
    el.innerHTML = '<div class="state"><div class="err">예보를 불러오지 못했습니다.</div></div>';
  }
}

async function loadHomeReports(my){
  const el = $("#home-reports");
  try {
    const data = await fetchReports(5);
    if (isStale(my)) return;
    if (!data.ready || !data.reports.length){ el.innerHTML = reportsEmptyState(true); return; }
    el.innerHTML = '<div class="report-list">' + data.reports.map(renderReportCard).join("") + '</div>' +
      '<div class="home-more-row"><a href="/reports" data-nav class="home-more">제보 전체 보기 →</a></div>';
  } catch (e){
    if (isStale(my)) return;
    el.innerHTML = reportsEmptyState(true);
  }
}

export { renderHomePage };
