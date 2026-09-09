import { $, $$, DOW, app, clamp, dirName, esc, isNum, nowKST, pad, ymd } from "./util.js";
import { SPOTS } from "./spots.js";
import { LEVELS, LEVEL_KEYS } from "./levels.js";
import { isStale, nextReqId, setLevel, state, writeURL } from "./state.js";
import { GRADES, grade, scoreOf, summarize, windLabel } from "./score.js";
import { loadAdvisory, loadSpot } from "./api.js";
import { renderAdvisoryBanner } from "./advisory.js";

/* ============================ 파도예보 화면 ============================
   상단 컨트롤(포인트·날짜 칩) + 히어로 요약 + 시간대별 차트 + 상세 표.
   차트/표/레벨 선택기는 홈의 '오늘의 파도' 카드도 그대로 재사용한다.
==================================================================== */

function arrowSVG(deg){
  if (!isNum(deg)) return '<span class="dimc">–</span>';
  return '<svg class="arw" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(' + (deg + 180).toFixed(0) + 'deg)" ' +
    'aria-hidden="true"><path d="M12 21V4M12 4l-5.5 6M12 4l5.5 6"/></svg>';
}

/* 차트 기하 — 렌더와 상호작용이 같은 값을 쓰도록 한 곳에 모음 */
const CH = { W:720, H:210, L:38, R:14, T:14, B:40 };
CH.iw = CH.W - CH.L - CH.R;
CH.ih = CH.H - CH.T - CH.B;
const yMaxOf = hours => {
  const vs = hours.map(h => h.waveH).filter(isNum);
  return Math.ceil(Math.max.apply(null, [0.6].concat(vs)) * 1.25 * 4) / 4;
};
const chartX = (i, n) => CH.L + (n > 1 ? i / (n - 1) : 0.5) * CH.iw;
const chartY = (v, yMax) => CH.T + CH.ih - (clamp(isNum(v) ? v : 0, 0, yMax) / yMax) * CH.ih;

function renderChart(hours){
  const n = hours.length, yMax = yMaxOf(hours);
  const pts = hours.map((h, i) => chartX(i, n).toFixed(1) + "," + chartY(h.waveH, yMax).toFixed(1));
  const line = "M" + pts.join("L");
  const base = (CH.T + CH.ih).toFixed(1);
  const area = line + "L" + chartX(n-1, n).toFixed(1) + "," + base +
                      "L" + chartX(0, n).toFixed(1) + "," + base + "Z";

  const ticks = [0, yMax/2, yMax].map(v => {
    const y = chartY(v, yMax).toFixed(1);
    return '<line x1="' + CH.L + '" y1="' + y + '" x2="' + (CH.W - CH.R) + '" y2="' + y +
      '" stroke="rgba(255,255,255,.09)" stroke-width="1"/>' +
      '<text x="' + (CH.L - 8) + '" y="' + (+y + 4).toFixed(1) + '" text-anchor="end" font-size="10.5" ' +
      'fill="#63798a" font-variant-numeric="tabular-nums">' + v.toFixed(1) + '</text>';
  }).join("");

  const bw = CH.iw / n;
  const strip = hours.map((h, i) => {
    const sc = scoreOf(h);
    const g = grade(sc);
    const op = isNum(sc) ? (0.28 + (sc / 100) * 0.72) : 0.18;
    return '<rect x="' + (CH.L + i * bw + 0.6).toFixed(1) + '" y="' + (CH.T + CH.ih + 9).toFixed(1) +
      '" width="' + Math.max(1, bw - 1.2).toFixed(1) + '" height="7" rx="2" fill="' + g[2] +
      '" opacity="' + op.toFixed(2) + '"/>';
  }).join("");

  const xlab = hours.map((h, i) => i % 3 === 0
    ? '<text x="' + chartX(i, n).toFixed(1) + '" y="' + (CH.H - 6) + '" text-anchor="middle" font-size="10.5" ' +
      'fill="#63798a" font-variant-numeric="tabular-nums">' + pad(h.hour) + '</text>'
    : "").join("");

  const hits = hours.map((h, i) =>
    '<rect class="hit" data-i="' + i + '" x="' + (chartX(i, n) - bw / 2).toFixed(1) + '" y="' + CH.T +
    '" width="' + bw.toFixed(1) + '" height="' + (CH.ih + 18) + '" fill="transparent" style="pointer-events:all"/>'
  ).join("");

  return '<div class="chart-box">' +
    '<svg class="chart" viewBox="0 0 ' + CH.W + ' ' + CH.H + '" role="img" ' +
    'aria-label="시간대별 파고 그래프">' +
      '<defs><linearGradient id="g-area" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="#38bdf8" stop-opacity=".42"/>' +
        '<stop offset="100%" stop-color="#38bdf8" stop-opacity=".02"/>' +
      '</linearGradient></defs>' +
      ticks +
      '<path d="' + area + '" fill="url(#g-area)"/>' +
      '<path d="' + line + '" fill="none" stroke="#38bdf8" stroke-width="2.2" ' +
      'stroke-linejoin="round" stroke-linecap="round"/>' +
      strip + xlab +
      '<line id="cursor" x1="0" y1="' + CH.T + '" x2="0" y2="' + (CH.T + CH.ih) +
      '" stroke="#38bdf8" stroke-width="1" stroke-dasharray="3 3" opacity="0"/>' +
      '<circle id="cdot" r="4" fill="#38bdf8" stroke="#06121d" stroke-width="2" opacity="0"/>' +
      hits +
    '</svg><div class="tip" id="tip"></div></div>';
}

function renderTable(hours){
  const now = nowKST();
  const todayStr = ymd(now);
  const rows = hours.map((h, i) => {
    const g = grade(scoreOf(h));
    const wl = windLabel(h.off);
    const isNow = h.time.slice(0, 10) === todayStr && h.hour === now.getHours();
    const per = isNum(h.swellP) ? h.swellP : h.waveP;
    const dir = isNum(h.swellD) ? h.swellD : h.waveD;
    return '<tr data-i="' + i + '" class="' + (isNow ? "now" : "") + '">' +
      '<td class="time">' + pad(h.hour) + ':00</td>' +
      '<td><span class="dot" style="background:' + g[2] + '"></span>' +
        '<span class="wv">' + (isNum(h.waveH) ? h.waveH.toFixed(1) : "–") + '</span><span class="unit"> m</span></td>' +
      '<td class="num">' + (isNum(per) ? per.toFixed(0) : "–") + '<span class="unit"> s</span></td>' +
      '<td>' + arrowSVG(dir) + ' <span class="muted">' + (isNum(dir) ? dirName(dir) : "–") + '</span></td>' +
      '<td class="num">' + (isNum(h.windSpd) ? h.windSpd.toFixed(1) : "–") + '<span class="unit"> m/s</span></td>' +
      '<td>' + arrowSVG(h.windDir) + ' <span class="badge ' + wl[1] + '">' + wl[0] + '</span></td>' +
      '<td class="num muted">' + (isNum(h.seaT) ? h.seaT.toFixed(1) + "°" : "–") + '</td>' +
      '<td><span style="color:' + g[2] + ';font-weight:670">' + g[1] + '</span></td>' +
    '</tr>';
  }).join("");

  return '<div class="tscroll"><table><thead><tr>' +
    '<th>시각</th><th>파고</th><th class="num">주기</th><th>파향</th>' +
    '<th class="num">풍속</th><th>풍향</th><th class="num">수온</th><th>컨디션 · ' + esc(LEVELS[state.level].short) + '</th>' +
    '</tr></thead><tbody id="tbody">' + rows + '</tbody></table></div>';
}

function renderHero(spot, dateStr, sm){
  const g = grade(sm.avg);
  const C = 2 * Math.PI * 45;
  const dash = (clamp(sm.avg, 0, 100) / 100) * C;
  const d = new Date(dateStr + "T00:00:00");
  const dateLbl = (d.getMonth() + 1) + "월 " + d.getDate() + "일 (" + DOW[d.getDay()] + ")";
  const suit = !isNum(sm.seaT) ? "&nbsp;"
    : sm.seaT >= 24 ? "보드숏" : sm.seaT >= 19 ? "3/2 스프링" : sm.seaT >= 14 ? "3/2 풀슈트" : "4/3 이상";
  const perLbl = !isNum(sm.peakPeriod) ? "&nbsp;"
    : sm.peakPeriod >= 9 ? "긴 너울" : sm.peakPeriod >= 6 ? "보통" : "짧은 풍랑";

  return '<div class="hero"><div class="hero-l">' +
    '<div class="spot-name">' + esc(spot.name) + '<span class="spot-region">' + esc(spot.region) + '</span></div>' +
    '<div class="hero-date">' + dateLbl + ' · 하루 종합</div>' +
    '<div class="metrics">' +
      '<div class="m"><div class="k">최고 파고</div><div class="v">' +
        (isNum(sm.peakWave) ? sm.peakWave.toFixed(1) : "–") + '<small>m</small></div>' +
        '<div class="s">' + (isNum(sm.dirMode) ? dirName(sm.dirMode) + "쪽 너울" : "&nbsp;") + '</div></div>' +
      '<div class="m"><div class="k">최대 주기</div><div class="v">' +
        (isNum(sm.peakPeriod) ? sm.peakPeriod.toFixed(0) : "–") + '<small>s</small></div>' +
        '<div class="s">' + perLbl + '</div></div>' +
      '<div class="m"><div class="k">평균 바람</div><div class="v">' +
        (isNum(sm.windAvg) ? sm.windAvg.toFixed(1) : "–") + '<small>m/s</small></div>' +
        '<div class="s">' + windLabel(sm.offAvg)[0] + ' 경향</div></div>' +
      '<div class="m"><div class="k">수온</div><div class="v">' +
        (isNum(sm.seaT) ? sm.seaT.toFixed(1) : "–") + '<small>°C</small></div>' +
        '<div class="s">' + suit + '</div></div>' +
    '</div></div>' +
    '<div class="score"><div class="ring">' +
      '<svg width="104" height="104" viewBox="0 0 104 104" style="transform:rotate(-90deg)">' +
        '<circle cx="52" cy="52" r="45" fill="none" stroke="rgba(255,255,255,.09)" stroke-width="8"/>' +
        '<circle cx="52" cy="52" r="45" fill="none" stroke="' + g[2] + '" stroke-width="8" stroke-linecap="round" ' +
        'stroke-dasharray="' + dash.toFixed(1) + ' ' + C.toFixed(1) + '"/></svg>' +
      '<div class="lbl"><div class="num" style="color:' + g[2] + '">' + sm.avg + '</div><div class="of">/ 100</div></div>' +
    '</div><div>' +
      '<div class="grade" style="color:' + g[2] + '">' + g[1] + '</div>' +
      '<div class="best">추천 ' + pad(sm.best.from) + ':00–' + pad(sm.best.to) + ':00</div>' +
      levelSizeWarning(sm.peakWave) +
    '</div></div>' +
    renderLevelPicker(sm) +
  '</div>';
}

/** 레벨별 "이 이상은 무리" 사이즈 경고.
    점수만으로는 위험이 안 읽히는 구간이 있다 — 5m 파도라도 주기가 길고 오프쇼어면
    비기너 점수가 34점(=아쉬움)에서 더 안 떨어진다. "아쉬움"은 아쉬운 거지 위험한
    게 아니라서, 크기 자체를 따로 못 박아 준다. 숏보더는 상한을 두지 않는다. */
function levelSizeWarning(peakWave){
  const max = LEVELS[state.level].maxSafe;
  if (!isNum(peakWave) || !isNum(max) || peakWave <= max) return "";
  return '<div class="lvl-warn">⚠ ' + esc(LEVELS[state.level].label) + '에겐 큰 파도예요 · 최고 ' +
    peakWave.toFixed(1) + "m</div>";
}

/** 레벨 선택기 겸 비교표. 버튼마다 그 레벨의 점수를 같이 보여줘서, 굳이 눌러보지
    않아도 "오늘은 롱보드가 낫겠다" 같은 판단이 바로 되게 했다. */
function renderLevelPicker(sm){
  return '<div class="lvl-row" role="group" aria-label="서핑 레벨 선택">' +
    LEVEL_KEYS.map(key => {
      const v = sm.avgByLevel ? sm.avgByLevel[key] : null;
      const lg = grade(v);
      const on = key === state.level;
      return '<button type="button" class="lvl-btn' + (on ? " on" : "") + '" data-level="' + key + '"' +
        (on ? ' aria-current="true"' : "") + '>' +
        '<span class="lvl-name">' + LEVELS[key].label + '</span>' +
        '<span class="lvl-score" style="color:' + (isNum(v) ? lg[2] : "var(--dim)") + '">' +
          (isNum(v) ? v : "–") + "</span>" +
      "</button>";
    }).join("") +
  "</div>";
}

/** 레벨 버튼 배선. 레벨이 바뀌면 화면 전체를 다시 그린다 — 차트 색, 표의 컨디션,
    추천 시간대, 날짜 칩까지 전부 레벨을 따라가야 해서 부분 갱신이 더 번거롭다.
    데이터는 캐시되어 있어 재요청은 없다. */
function wireLevelPicker(rerender){
  $$(".lvl-btn").forEach(b => b.addEventListener("click", () => {
    if (setLevel(b.dataset.level)) rerender();
  }));
}

/* 차트 ↔ 표 상호작용 */
function wireChart(hours){
  const svg = $("svg.chart");
  if (!svg) return;
  const tip = $("#tip"), box = $(".chart-box"), cur = $("#cursor"), dot = $("#cdot"), tbody = $("#tbody");
  const n = hours.length, yMax = yMaxOf(hours);

  const clear = () => {
    tip.classList.remove("on");
    cur.setAttribute("opacity", "0");
    dot.setAttribute("opacity", "0");
    if (tbody) tbody.querySelectorAll("tr.hl").forEach(r => r.classList.remove("hl"));
  };

  const show = i => {
    const h = hours[i], g = grade(scoreOf(h));
    const x = chartX(i, n), y = chartY(h.waveH, yMax);

    cur.setAttribute("x1", x); cur.setAttribute("x2", x); cur.setAttribute("opacity", ".7");
    dot.setAttribute("cx", x); dot.setAttribute("cy", y); dot.setAttribute("opacity", "1");

    const per = isNum(h.swellP) ? h.swellP : h.waveP;
    tip.innerHTML =
      "<b>" + pad(h.hour) + ':00</b> &nbsp;<span style="color:' + g[2] + ';font-weight:650">' + g[1] + "</span><br>" +
      '<span class="r">파고</span> ' + (isNum(h.waveH) ? h.waveH.toFixed(1) + " m" : "–") + " · " +
      '<span class="r">주기</span> ' + (isNum(per) ? per.toFixed(0) + " s" : "–") + "<br>" +
      '<span class="r">바람</span> ' + (isNum(h.windSpd) ? h.windSpd.toFixed(1) + " m/s" : "–") + " " +
      (isNum(h.windDir) ? dirName(h.windDir) : "");
    tip.classList.add("on");

    const bw = box.clientWidth, bh = box.clientHeight;
    tip.style.left = "0px";
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = clamp((x / CH.W) * bw - tw / 2, 2, Math.max(2, bw - tw - 2)) + "px";
    tip.style.top  = Math.max(0, (y / CH.H) * bh - th - 12) + "px";

    if (tbody){
      tbody.querySelectorAll("tr.hl").forEach(r => r.classList.remove("hl"));
      const row = tbody.querySelector('tr[data-i="' + i + '"]');
      if (row) row.classList.add("hl");
    }
  };

  // 마우스는 hover 로 훑고, 터치는 탭으로 찍는다.
  // 터치 드래그는 가로채지 않는다 — 그래프 위에서도 세로 스크롤이 되어야 하므로
  // preventDefault 도, touch-action:none 도 걸지 않는다.
  svg.querySelectorAll(".hit").forEach(el => {
    const i = +el.dataset.i;
    el.addEventListener("pointerenter", ev => { if (ev.pointerType === "mouse") show(i); });
    el.addEventListener("pointerdown", () => show(i));
  });
  svg.addEventListener("pointerleave", ev => { if (ev.pointerType === "mouse") clear(); });
  svg.addEventListener("pointercancel", clear);
}

function buildSpotSelect(){
  const sel = $("#spot");
  const groups = [];
  SPOTS.forEach(s => { const g = s.region.split(" ")[0]; if (groups.indexOf(g) < 0) groups.push(g); });
  sel.innerHTML = groups.map(g =>
    '<optgroup label="' + esc(g) + '">' +
    SPOTS.filter(s => s.region.indexOf(g) === 0).map(s =>
      '<option value="' + s.id + '">' + esc(s.name) + " · " + esc(s.region.split(" ")[1] || "") + "</option>").join("") +
    "</optgroup>").join("");
  sel.value = state.spot;
}

function buildDays(dates, data){
  const el = $("#days");
  const today = ymd(nowKST());
  el.innerHTML = dates.map(ds => {
    const d = new Date(ds + "T00:00:00");
    const sm = summarize(data.byDate.get(ds) || []);
    const g = grade(sm ? sm.avg : null);
    const cls = d.getDay() === 0 ? "sun" : d.getDay() === 6 ? "sat" : "";
    const op = sm ? (0.3 + (sm.avg / 100) * 0.7).toFixed(2) : "0.35";
    return '<button class="day ' + cls + '" type="button" data-d="' + ds + '" aria-pressed="' + (ds === state.date) + '">' +
      '<span class="dow">' + (ds === today ? "오늘" : DOW[d.getDay()]) + "</span>" +
      '<span class="dnum">' + d.getDate() + "</span>" +
      '<span class="pill" style="background:' + (sm ? g[2] : "var(--line-strong)") + ';opacity:' + op + '"></span>' +
    "</button>";
  }).join("");

  el.querySelectorAll(".day").forEach(b =>
    b.addEventListener("click", () => { state.date = b.dataset.d; renderForecastPage(); }));

  const di = $("#date");
  di.min = dates[0];
  di.max = dates[dates.length - 1];
  di.value = state.date;
}

async function renderForecastPage(){
  // 주의: 여기서 readURL() 을 다시 호출하면 안 된다 — 날짜 칩·포인트 셀렉트 변경
  // 핸들러가 state 를 먼저 바꾼 뒤 이 함수를 직접 부르는데, 그 시점엔 URL 이 아직
  // 갱신 전(writeURL 은 아래에서 호출)이라 readURL() 이 그 변경을 도로 덮어써 버린다.
  // URL → state 동기화는 /forecast 라우트 "진입" 시점에만, renderRoute() 에서 한다.
  const my = nextReqId();
  const spot = SPOTS.find(s => s.id === state.spot);
  $("#spot").value = state.spot;
  writeURL();

  app.innerHTML = '<div class="card"><div class="state"><div class="spin"></div>' +
    esc(spot.name) + " 예보를 불러오는 중…</div></div>";

  let data, advisory;
  try {
    [data, advisory] = await Promise.all([ loadSpot(spot), loadAdvisory() ]);
  } catch (e){
    if (isStale(my)) return;
    app.innerHTML = '<div class="card"><div class="state">' +
      '<div class="err">예보를 불러오지 못했습니다.</div>' +
      '<div style="margin-top:6px;font-size:12px" class="dimc">' + esc(e.message) + "</div>" +
      '<button class="retry" id="retry" type="button">다시 시도</button></div></div>';
    $("#retry").addEventListener("click", () => { cache.delete(spot.id); renderForecastPage(); });
    return;
  }
  if (isStale(my)) return;

  if (data.dates.indexOf(state.date) < 0) state.date = data.dates[0];
  buildDays(data.dates, data);
  writeURL();

  const hours = data.byDate.get(state.date) || [];
  const sm = summarize(hours);
  if (!sm){
    app.innerHTML = '<div class="card"><div class="state">이 날짜의 예보 데이터가 아직 없습니다.</div></div>';
    return;
  }

  app.innerHTML =
    renderAdvisoryBanner(advisory, spot.id) +
    renderHero(spot, state.date, sm) +
    '<div class="card">' +
      "<h2>시간대별 파고</h2>" +
      '<div class="sub">아래 막대 색은 ' + esc(LEVELS[state.level].label) + ' 기준 컨디션 점수 · 그래프를 짚으면 상세가 나옵니다</div>' +
      renderChart(hours) +
      '<div class="legend">' +
        GRADES.slice().reverse().map(g =>
          '<span><i class="dot" style="background:' + g[2] + '"></i>' + g[1] + "</span>").join("") +
      "</div>" +
    "</div>" +
    '<div class="card">' +
      "<h2>상세 예보</h2>" +
      '<div class="sub">파향·풍향 화살표는 파도와 바람이 <b>진행하는 방향</b>을 가리킵니다</div>' +
      renderTable(hours) +
    "</div>";

  wireChart(hours);
  wireLevelPicker(renderForecastPage);
}

export { renderForecastPage, buildSpotSelect, buildDays,
         renderChart, renderTable, renderHero, wireChart, wireLevelPicker };
