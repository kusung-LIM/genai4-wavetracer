import { $, app, esc, isNum, pad, relTime } from "./util.js";
import { SPOTS } from "./spots.js";
import { LEVELS } from "./levels.js";
import { isStale, nextReqId, state } from "./state.js";
import { expandDailyHours, grade, scoreOf, windLabel } from "./score.js";
import { navigate } from "./router.js";

/* ============================ 내 기록(GPS 세션) ============================
   /api/sessions, /api/sessions/:id 를 씀 — docs/gps-tracker-plan.md 참고.
   계정이 없다: 스트라바는 2025년 3월부터 한국에서 신규 앱 설치가 막혀 포기했고,
   대신 이 기기(브라우저)만의 임의 토큰으로 소유권을 식별한다. localStorage 를
   지우면 접근 수단이 함께 사라지고 복구할 방법이 없다 — 계정이 없으니 당연한
   트레이드오프다.

   GPX/TCX 파싱은 반드시 브라우저에서 한다. Cloudflare Workers 런타임에는 DOM/XML
   파서가 없고, 이 프로젝트는 의존성 0 · 빌드 스텝 0 을 유지하고 있어 XML 파싱
   라이브러리를 서버에 새로 들이고 싶지 않았다.
================================================================ */

/** 이 브라우저의 소유권 토큰. 처음 필요할 때(업로드·목록 조회) 딱 한 번 만든다 —
    /sessions 를 한 번도 안 쓴 방문자에게 굳이 식별자를 미리 심어둘 이유가 없다. */
function deviceToken(){
  let t = null;
  try { t = localStorage.getItem("wt:device"); } catch (_){}
  if (!t){
    t = crypto.randomUUID();
    try { localStorage.setItem("wt:device", t); } catch (_){}
  }
  return t;
}

const SESSION_MIN_POINTS = 5; // src/worker.js 의 SESSION_MIN_POINTS 와 맞춘다

/** XML 요소 하위(자손 포함)에서 네임스페이스 접두사와 무관하게 로컬 이름으로
    첫 텍스트를 찾는다. 삼성헬스 GPX 의 심박수는 <extensions><gpxtpx:hr> 처럼
    접두사가 붙어 있어 getElementsByTagName("hr") 로는 못 찾기 때문. */
function firstChildText(el, localName){
  if (!el) return null;
  for (const c of Array.from(el.getElementsByTagName("*"))){
    const ln = c.localName || c.tagName.split(":").pop();
    if (ln === localName) return c.textContent;
  }
  return null;
}

/** GPX <trkpt> 목록 → [위도, 경도, 고도|null, epoch ms, 심박|null] 배열.
    시각이 없는 점은 거리·시간 계산의 기준이 없어 버린다. */
function parseGPX(xml){
  const pts = [];
  for (const pt of Array.from(xml.getElementsByTagName("trkpt"))){
    const lat = parseFloat(pt.getAttribute("lat"));
    const lon = parseFloat(pt.getAttribute("lon"));
    if (!isNum(lat) || !isNum(lon)) continue;
    const t = Date.parse(firstChildText(pt, "time") || "");
    if (!Number.isFinite(t)) continue;
    const eleStr = firstChildText(pt, "ele");
    const hrStr = firstChildText(pt, "hr");
    pts.push([lat, lon, eleStr !== null ? parseFloat(eleStr) : null, t, hrStr !== null ? parseInt(hrStr, 10) : null]);
  }
  return pts;
}

/** TCX <Trackpoint> 목록 → GPX 파서와 같은 배열 모양으로 맞춘다. */
function parseTCX(xml){
  const pts = [];
  for (const pt of Array.from(xml.getElementsByTagName("Trackpoint"))){
    const latStr = firstChildText(pt, "LatitudeDegrees");
    const lonStr = firstChildText(pt, "LongitudeDegrees");
    if (latStr === null || lonStr === null) continue;
    const lat = parseFloat(latStr), lon = parseFloat(lonStr);
    if (!isNum(lat) || !isNum(lon)) continue;
    const t = Date.parse(firstChildText(pt, "Time") || "");
    if (!Number.isFinite(t)) continue;
    const eleStr = firstChildText(pt, "AltitudeMeters");
    const hrStr = firstChildText(pt, "Value"); // HeartRateBpm><Value> — Trackpoint 안엔 이거 하나뿐
    pts.push([lat, lon, eleStr !== null ? parseFloat(eleStr) : null, t, hrStr !== null ? parseInt(hrStr, 10) : null]);
  }
  return pts;
}

/** 루트 태그로 GPX/TCX 를 가려 파싱한다. 실패하면 사용자에게 보여줄 메시지를
    담은 Error 를 던진다 — 호출부는 이 메시지를 그대로 화면에 띄운다. */
function parseTrackFile(text){
  const xml = new DOMParser().parseFromString(text, "application/xml");
  if (xml.getElementsByTagName("parsererror").length){
    throw new Error("파일을 읽을 수 없습니다. GPX 또는 TCX 파일이 맞는지 확인해주세요.");
  }
  const root = xml.documentElement.tagName.toLowerCase();
  const pts = root === "gpx" ? parseGPX(xml) : root === "trainingcenterdatabase" ? parseTCX(xml) : null;
  if (!pts) throw new Error("지원하지 않는 파일 형식입니다. GPX 또는 TCX 파일을 올려주세요.");
  if (pts.length < SESSION_MIN_POINTS) throw new Error("GPS 기록이 너무 적습니다(위치·시각이 있는 지점 " + SESSION_MIN_POINTS + "개 미만).");
  return pts;
}

const SES_DUR_FMT = sec => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h > 0 ? h + "시간 " + m + "분" : m + "분";
};

/** iso 시각의 KST 정시(0~23). worker.js 의 toKSTDateHour() 와 같은 변환이라야
    dailyHourly 의 hour 필드와 맞아떨어진다. */
function hourKST(iso){
  let hh = null;
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", hour: "2-digit", hour12: false })
    .formatToParts(new Date(iso)).forEach(x => { if (x.type === "hour") hh = +x.value; });
  return hh === 24 ? 0 : hh;
}

/** 트랙 좌표만의 지역 범위로 SVG 투영을 만든다. 홈 지도의 projectMap() 은
    남한 전체 범위로 고정돼 있어 세션 하나(보통 수백 m~수 km)를 그리면 점 하나로
    뭉개진다 — 그래서 이 세션의 위경도 최소/최대로 새로 스케일을 잡는다. */
function projectTrack(track, W, H, pad){
  const lats = track.map(p => p[0]), lons = track.map(p => p[1]);
  let latMin = Math.min.apply(null, lats), latMax = Math.max.apply(null, lats);
  let lonMin = Math.min.apply(null, lons), lonMax = Math.max.apply(null, lons);
  if (latMax - latMin < 0.0002){ latMin -= 0.0005; latMax += 0.0005; }
  if (lonMax - lonMin < 0.0002){ lonMin -= 0.0005; lonMax += 0.0005; }

  const lonScale = Math.cos((latMin + latMax) / 2 * Math.PI / 180); // 위도 보정(경도 1도가 더 짧음)
  const innerW = W - pad * 2, innerH = H - pad * 2;
  const spanLon = (lonMax - lonMin) * lonScale, spanLat = latMax - latMin;
  const scale = Math.min(innerW / Math.max(spanLon, 1e-9), innerH / Math.max(spanLat, 1e-9));
  const offX = pad + (innerW - spanLon * scale) / 2;
  const offY = pad + (innerH - spanLat * scale) / 2;

  return track.map(p => ({
    x: offX + (p[1] - lonMin) * lonScale * scale,
    y: offY + (latMax - p[0]) * scale, // 위도는 위로 갈수록 커지므로 뒤집는다(북쪽이 위)
  }));
}

function renderSessionTrackSvg(track){
  const W = 320, H = 220, pad = 16;
  const pts = projectTrack(track, W, H, pad);
  const d = "M" + pts.map(p => p.x.toFixed(1) + "," + p.y.toFixed(1)).join("L");
  const start = pts[0], end = pts[pts.length - 1];
  return '<svg class="session-track" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="GPS 이동 경로">' +
    '<path d="' + d + '" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<circle cx="' + start.x.toFixed(1) + '" cy="' + start.y.toFixed(1) + '" r="5" fill="var(--r-exc)"/>' +
    '<circle cx="' + end.x.toFixed(1) + '" cy="' + end.y.toFixed(1) + '" r="5" fill="var(--r-poor)"/>' +
  '</svg>';
}

function sessionCard(s){
  const spot = SPOTS.find(x => x.id === s.spotId);
  return '<a href="/sessions/' + s.id + '" data-nav class="session-card">' +
    '<div class="session-head">' +
      '<span class="badge spot-badge">' + esc(spot ? spot.name : "스팟 밖") + '</span>' +
      '<span class="session-time dimc">' + esc(relTime(s.startedAt)) + '</span>' +
    '</div>' +
    '<div class="session-stats">' +
      '<span><b>' + (s.distanceM / 1000).toFixed(2) + '</b>km</span>' +
      '<span><b>' + SES_DUR_FMT(s.durationSec) + '</b></span>' +
      '<span>' + s.pointCount + '개 포인트</span>' +
    '</div>' +
  '</a>';
}

function wireSessionsUpload(){
  const input = $("#ses-file"), msg = $("#ses-msg");
  input.addEventListener("change", async () => {
    const file = input.files[0];
    input.value = ""; // 같은 파일을 다시 선택해도 change 가 다시 뜨도록 비워둔다
    if (!file) return;

    msg.textContent = "";
    msg.className = "rf-msg";
    try {
      const points = parseTrackFile(await file.text());
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceToken: deviceToken(), points: points }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 201 && j && j.session){
        navigate("/sessions/" + j.session.id);
      } else if (res.status === 429){
        msg.textContent = (j && j.message) || "너무 많은 요청입니다. 잠시 후 다시 시도해주세요.";
        msg.className = "rf-msg rf-err";
      } else {
        msg.textContent = (j && j.message) || "업로드에 실패했습니다.";
        msg.className = "rf-msg rf-err";
      }
    } catch (e){
      msg.textContent = e.message || "파일을 읽는 중 오류가 발생했습니다.";
      msg.className = "rf-msg rf-err";
    }
  });
}

async function renderSessionsListPage(){
  const my = nextReqId();
  app.innerHTML =
    '<div class="card">' +
      "<h2>GPS 기록 업로드</h2>" +
      '<div class="sub">스마트워치에서 내보낸 GPX 또는 TCX 파일을 올려주세요</div>' +
      '<label class="ses-upload-btn" for="ses-file">파일 선택</label>' +
      '<input type="file" id="ses-file" accept=".gpx,.tcx" hidden>' +
      '<div id="ses-msg" class="rf-msg" role="status" aria-live="polite"></div>' +
    "</div>" +
    '<div class="card">' +
      "<h2>내 기록</h2>" +
      '<div class="sub">이 기기에서 올린 세션 · 로그인이 없어 다른 기기와는 공유되지 않습니다</div>' +
      '<div id="session-list"><div class="state"><div class="spin"></div>불러오는 중…</div></div>' +
    "</div>";
  wireSessionsUpload();

  try {
    const res = await fetch("/api/sessions?token=" + encodeURIComponent(deviceToken()), { cache: "no-store" });
    const j = await res.json().catch(() => ({}));
    if (isStale(my)) return;
    const list = $("#session-list");
    if (!res.ok || !j.sessions || !j.sessions.length){
      list.innerHTML = '<div class="state">' +
        '<div style="font-size:26px;margin-bottom:8px" aria-hidden="true">🏄</div>' +
        "<div>아직 업로드된 기록이 없어요.</div>" +
        '<div class="dimc" style="margin-top:4px;font-size:12.5px">워치에서 GPX/TCX 파일을 내보내 올려보세요.</div>' +
      "</div>";
    } else {
      list.innerHTML = '<div class="report-list">' + j.sessions.map(sessionCard).join("") + "</div>";
    }
  } catch (e){
    if (isStale(my)) return;
    $("#session-list").innerHTML = '<div class="state err">기록을 불러오지 못했습니다.</div>';
  }
}

/** spot_daily 의 그날 데이터에서 세션이 시작한 정시(KST) 한 시간만 뽑아 보여준다.
    expandDailyHours()/summarize() 와 같은 점수 계산(scoreHourAllLevels)을 그대로
    쓰므로, 예보 화면·챗봇·여기 세 곳의 점수가 항상 같은 계산에서 나온다. */
function renderSessionDailyPanel(s, spot, dailyHourly){
  if (!spot || !dailyHourly || !dailyHourly.length) return "";
  const hours = expandDailyHours(dailyHourly, spot);
  const hr = hourKST(s.startedAt);
  const h = hours.find(x => x.hour === hr);
  if (!h) return "";

  const v = scoreOf(h);
  const g = grade(v);
  const wl = windLabel(h.off);
  return '<div class="card">' +
    "<h2>그날 그 시간 컨디션</h2>" +
    '<div class="sub">' + esc(spot.name) + " · " + hr + "시 기준(" + esc(LEVELS[state.level].label) + ")</div>" +
    '<div class="metrics">' +
      '<div class="m"><div class="k">점수</div><div class="v" style="color:' + g[2] + '">' +
        (isNum(v) ? v : "–") + '<small>/100 · ' + g[1] + "</small></div></div>" +
      '<div class="m"><div class="k">파고</div><div class="v">' +
        (isNum(h.waveH) ? h.waveH.toFixed(1) : "–") + "<small>m</small></div></div>" +
      '<div class="m"><div class="k">바람</div><div class="v">' +
        (isNum(h.windSpd) ? h.windSpd.toFixed(1) : "–") + "<small>m/s</small></div></div>" +
      '<div class="m"><div class="k">바람 성향</div><div class="v badge ' + wl[1] + '" style="display:inline-block;padding:4px 10px">' +
        wl[0] + "</div></div>" +
    "</div>" +
  "</div>";
}

async function renderSessionDetailPage(id){
  const my = nextReqId();
  app.innerHTML = '<div class="card"><div class="state"><div class="spin"></div>불러오는 중…</div></div>';

  let res, j;
  try {
    res = await fetch("/api/sessions/" + id + "?token=" + encodeURIComponent(deviceToken()), { cache: "no-store" });
    j = await res.json().catch(() => ({}));
  } catch (e){
    if (isStale(my)) return;
    app.innerHTML = '<div class="card"><div class="state err">기록을 불러오지 못했습니다.</div></div>';
    return;
  }
  if (isStale(my)) return;

  if (res.status === 403){
    app.innerHTML = '<div class="card"><div class="state">이 기록에 접근할 권한이 없습니다.</div></div>';
    return;
  }
  if (!res.ok || !j.session){
    app.innerHTML = '<div class="card"><div class="state">기록을 찾을 수 없습니다.</div></div>';
    return;
  }

  const s = j.session, spot = SPOTS.find(x => x.id === s.spotId);
  app.innerHTML =
    '<div class="card">' +
      "<h2>" + esc(spot ? spot.name : "매칭된 스팟 없음") + "</h2>" +
      '<div class="sub">' + esc(new Date(s.startedAt).toLocaleString("ko-KR")) + "</div>" +
      '<div class="metrics">' +
        '<div class="m"><div class="k">거리</div><div class="v">' + (s.distanceM / 1000).toFixed(2) + "<small>km</small></div></div>" +
        '<div class="m"><div class="k">시간</div><div class="v">' + SES_DUR_FMT(s.durationSec) + "</div></div>" +
        '<div class="m"><div class="k">포인트</div><div class="v">' + s.pointCount + "</div></div>" +
      "</div>" +
    "</div>" +
    '<div class="card">' +
      "<h2>이동 경로</h2>" +
      '<div class="sub">' + j.track.length + "개 지점</div>" +
      renderSessionTrackSvg(j.track) +
    "</div>" +
    renderSessionDailyPanel(s, spot, j.dailyHourly) +
    '<div class="card">' +
      '<button type="button" id="ses-delete" class="ses-delete-btn">기록 삭제</button>' +
    "</div>";

  $("#ses-delete").addEventListener("click", async () => {
    if (!confirm("이 기록을 삭제할까요? 되돌릴 수 없습니다.")) return;
    try {
      await fetch("/api/sessions/" + id + "?token=" + encodeURIComponent(deviceToken()), { method: "DELETE" });
    } catch (e){ /* 실패해도 목록으로 보낸다 — 다시 열어보면 남아있으므로 재시도할 수 있다 */ }
    navigate("/sessions");
  });
}

export { renderSessionsListPage, renderSessionDetailPage };
