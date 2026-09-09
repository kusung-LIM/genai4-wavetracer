import { $, nowKST, ymd } from "./util.js";
import { SPOTS } from "./spots.js";
import { DEFAULT_LEVEL, LEVELS } from "./levels.js";

/* ============================ 상태 & 라우팅 ============================ */
// level 은 URL 에 넣지 않는다 — 스팟·날짜와 달리 "어디를 보고 있나"가 아니라
// "내가 어떤 서퍼인가"라는 개인 설정이라, 링크를 받은 사람은 자기 레벨 기준으로
// 보는 게 맞다. 그래서 localStorage 에만 남긴다.
const state = { spot: "jukdo", date: ymd(nowKST()), level: DEFAULT_LEVEL };

function loadLevelPref(){
  try {
    const saved = localStorage.getItem("wt:level");
    if (saved && LEVELS[saved]) state.level = saved;
  } catch (_){ /* 프라이빗 모드 등에서 접근이 막힐 수 있다 */ }
}
function setLevel(key){
  if (!LEVELS[key] || key === state.level) return false;
  state.level = key;
  try { localStorage.setItem("wt:level", key); } catch (_){}
  return true;
}

function readURL(){
  const q = new URLSearchParams(location.search);
  const s = q.get("spot"), d = q.get("date");
  if (s && SPOTS.some(x => x.id === s)) state.spot = s;
  if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) state.date = d;
}
function writeURL(){
  // 이 함수는 /forecast 라우트에 있을 때만 호출된다 — 경로를 직접 못박아 둔다.
  history.replaceState(null, "", "/forecast?" + new URLSearchParams({ spot: state.spot, date: state.date }));
}

/* 렌더 요청 토큰. 화면 전환·재렌더가 겹칠 때 먼저 시작한 느린 응답이 나중
   화면을 덮어쓰지 않도록, 각 렌더는 토큰을 발급받고 await 뒤에 그 토큰이
   아직 최신인지(isStale) 확인한 다음에만 DOM 을 건드린다. */
let reqId = 0;
function nextReqId(){ return ++reqId; }
function isStale(token){ return token !== reqId; }

/* 홈·제보 폼이 쓰는 '마지막으로 본 포인트'. 예보 화면에서 포인트를 바꿀 때마다
   저장해두고(main.js), 다음 방문 때 그 포인트를 기본값으로 보여준다. */
function lastSpotOrDefault(){
  let id = "jukdo";
  try {
    const saved = localStorage.getItem("wt:lastSpot");
    if (saved && SPOTS.some(s => s.id === saved)) id = saved;
  } catch (_){ /* 일부 컨텍스트(프라이빗 모드 등)에서 localStorage 접근이 막혀 있을 수 있음 */ }
  return SPOTS.find(s => s.id === id) || SPOTS[0];
}

export { state, loadLevelPref, setLevel, readURL, writeURL,
         nextReqId, isStale, lastSpotOrDefault };
