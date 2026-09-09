// PWA 설치 가능(installable) 요건을 채우기 위한 최소 서비스워커.
//
// 안드로이드 크롬이 "홈 화면에 추가"를 정식으로 제안하려면 매니페스트 +
// 아이콘뿐 아니라 fetch 이벤트를 처리하는 서비스워커까지 등록돼 있어야 한다.
// 이 앱은 예보·특보처럼 시시각각 바뀌는 데이터가 핵심이라, 공격적으로
// 캐싱하면 오히려 위험하다(예: 옛날 특보를 오프라인 캐시에서 계속 보여주는
// 사고). 그래서 캐시는 앱 셸(정적 HTML) 하나만 "오프라인에서도 앱은 뜨게"
// 하는 최소 용도로 두고, /api/* 는 절대 건드리지 않는다 — 항상 네트워크로
// 직행해 최신 데이터를 받는다.
const CACHE_NAME = "wavetracer-shell-v1";
const SHELL_URL = "/";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.add(SHELL_URL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // API 호출·POST 등은 캐시 로직을 아예 타지 않는다 — 항상 네트워크로 보낸다.
  if (url.pathname.startsWith("/api/") || req.method !== "GET") return;

  // 그 외(앱 셸)는 네트워크 우선, 실패(오프라인)하면 마지막으로 받아둔
  // 캐시로 폴백한다 — 최신 내용을 우선하면서도 오프라인 진입점을 남겨둔다.
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match(SHELL_URL)))
  );
});
