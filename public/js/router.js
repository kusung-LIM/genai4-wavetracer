import { $, $$ } from "./util.js";
import { readURL } from "./state.js";
import { renderForecastPage } from "./forecast.js";
import { renderReportsPage } from "./reports.js";
import { renderHomePage } from "./home.js";
import { renderSessionDetailPage, renderSessionsListPage } from "./sessions.js";
import { chatConsumePopState } from "./chat.js";

/* ============================ 라우팅 ============================
   경로 4개: / (홈) · /forecast (파도예보) · /reports (파도제보) · /sessions[/:id] (내 기록).
   안전·규정 Q&A 는 라우트가 아니라 어디서나 열리는 챗봇(#chat)이 맡는다.
   해시 라우팅 대신 History API 를 쓴다 — wrangler.jsonc 의
   assets.not_found_handling: "single-page-application" 덕분에 /forecast, /reports,
   /sessions, /sessions/3 을 새로고침해도(또는 직접 주소창에 쳐도) 그대로 이
   index.html 이 서빙된다.
================================================================== */
const TITLE_OF = {
  home:     "WaveTracer — 국내 서핑 파도 예보",
  forecast: "WaveTracer — 파도예보",
  reports:  "WaveTracer — 파도 제보",
  sessions: "WaveTracer — 내 기록",
};

/** 현재 location 을 라우트 이름으로 해석.
    - 옛 공유 링크(예: /?spot=jukdo&date=...)는 /forecast 로 보정한다.
    - 알 수 없는 경로는 홈으로 보정한다.
    둘 다 replaceState 라 브라우저 히스토리를 어지럽히지 않는다.
    /sessions/:id 는 목록과 같은 "sessions" 라우트로 묶는다 — 상세냐 목록이냐는
    탭 활성화·타이틀에는 영향이 없고, renderRoute() 가 pathname 을 한 번 더
    봐서 렌더만 갈라준다. */
function resolveRoute(){
  const path = location.pathname;
  if (path === "/"){
    if (/[?&](spot|date)=/.test(location.search)){
      history.replaceState(null, "", "/forecast" + location.search);
      return "forecast";
    }
    return "home";
  }
  if (path === "/forecast") return "forecast";
  if (path === "/reports") return "reports";
  if (path === "/sessions" || /^\/sessions\/\d+$/.test(path)) return "sessions";
  history.replaceState(null, "", "/");
  return "home";
}

function updateChrome(route){
  document.title = TITLE_OF[route];
  $("#controls").hidden = route !== "forecast";
  $$(".tab").forEach(a => {
    if (a.dataset.route === route) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

function renderRoute(){
  const route = resolveRoute();
  updateChrome(route);
  if (route === "forecast"){
    readURL(); // /forecast 로 "진입"할 때만 쿼리(?spot=&date=)를 state 에 반영
    renderForecastPage();
  }
  else if (route === "reports") renderReportsPage();
  else if (route === "sessions"){
    const m = location.pathname.match(/^\/sessions\/(\d+)$/);
    if (m) renderSessionDetailPage(m[1]);
    else renderSessionsListPage();
  }
  else renderHomePage();
}

function navigate(path){
  if (path !== location.pathname + location.search) history.pushState(null, "", path);
  renderRoute();
}


window.addEventListener("popstate", () => {
  // 모바일 뒤로가기는 화면 이동보다 "열려 있는 챗봇 닫기"가 우선이다.
  if (chatConsumePopState()) return;
  renderRoute();
});

// 로고·탭·"전체 보기" 링크 등 data-nav 를 단 내부 링크는 전부 여기서 가로채
// pushState 로 처리한다 — 전체 새로고침 없이 SPA 로 전환된다.
document.addEventListener("click", e => {
  const a = e.target.closest("a[data-nav]");
  if (!a) return;
  e.preventDefault();
  navigate(a.getAttribute("href"));
});

export { renderRoute, navigate };
