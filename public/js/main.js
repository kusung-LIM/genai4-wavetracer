import { $ } from "./util.js";
import { loadLevelPref, state } from "./state.js";
import { buildSpotSelect, renderForecastPage } from "./forecast.js";
import { initChat } from "./chat.js";
import { renderRoute } from "./router.js";

/* 진입점. index.html 이 <script type="module" src="/js/main.js"> 하나만 부르고,
   나머지 모듈은 import 그래프를 따라 브라우저가 알아서 가져온다 — 번들러도
   빌드 스텝도 필요 없다. */

/* ============================ init ============================ */
loadLevelPref();
buildSpotSelect();
initChat();

// PWA 설치 가능 요건(매니페스트+아이콘+서비스워커) 중 마지막 조각.
// 실패해도(구형 브라우저, 프라이빗 모드 등) 조용히 넘어간다 — 설치 기능이
// 없어질 뿐 예보 화면은 그대로 동작해야 한다.
if ("serviceWorker" in navigator){
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
$("#date").value = state.date;

$("#spot").addEventListener("change", e => {
  state.spot = e.target.value;
  try { localStorage.setItem("wt:lastSpot", state.spot); } catch (_){}
  renderForecastPage();
});
$("#date").addEventListener("change", e => {
  if (e.target.value){ state.date = e.target.value; renderForecastPage(); }
});

renderRoute();
