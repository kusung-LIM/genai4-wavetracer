# 08. 앱처럼 만들기 (PWA)

목표: 홈 화면에 아이콘으로 설치되고, 주소창 없이 전체화면으로 열리게 하기.
앱스토어 없이 된다.

---

## 1. PWA vs 앱스토어

| | PWA | 앱스토어(Play/App Store) |
|---|---|---|
| 홈 화면 아이콘 | ✅ | ✅ |
| 주소창 없는 전체화면 | ✅ | ✅ |
| 스토어 검색으로 발견 | ❌ | ✅ |
| 개발자 계정 | 불필요 | 필요(구글 $25 등) |
| 심사 | 없음 | 있음 |
| 배포 | 그냥 배포하면 끝 | 별도 빌드·업로드 |

**"아이콘 눌러서 바로 열기"만 필요하면 PWA로 충분하다.** 나중에 스토어가
필요해지면 이 PWA를 얇은 껍데기로 감싸는 방식(TWA)이 있고, 그때도 웹 코드는
그대로 쓴다.

## 2. 설치 가능해지는 조건 세 가지

안드로이드 크롬이 "홈 화면에 추가"를 정식 설치로 제안하려면 **세 개가 다** 필요하다.

1. **매니페스트** — 앱 이름·아이콘·시작 주소를 적은 JSON
2. **아이콘** — 192×192, 512×512 PNG
3. **서비스워커** — `fetch` 이벤트를 처리하는 스크립트

그리고 **HTTPS**여야 한다(Cloudflare에 배포하면 자동으로 충족된다).

## 3. 매니페스트

`public/manifest.webmanifest`:

```json
{
  "name": "내 웹앱 — 긴 이름",
  "short_name": "내앱",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#06121d",
  "theme_color": "#06121d",
  "lang": "ko",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

| 항목 | 뜻 |
|---|---|
| `name` / `short_name` | 긴 이름(설치 화면) / 짧은 이름(아이콘 아래 라벨) |
| `start_url` | 아이콘을 눌렀을 때 열릴 주소 |
| `display: standalone` | 주소창 없이 앱처럼 열기 |
| `background_color` | 실행 직후 스플래시 배경. **앱 배경색과 같게 해야** 하얗게 번쩍이지 않는다 |
| `theme_color` | 상단 상태바 색 |
| `purpose: maskable` | 안드로이드가 아이콘을 원형 등으로 잘라도 괜찮은 이미지 |

HTML `<head>`에 연결한다.

```html
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#06121d">

<!-- iOS 사파리는 매니페스트를 완전히 따르지 않아 별도 태그가 필요하다 -->
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="내앱">
```

## 4. 아이콘 만들기

이미지 편집 도구가 없어도 **브라우저로 만들 수 있다.** 캔버스에 그려서 PNG로
뽑는 방법이다(이 저장소의 아이콘도 이렇게 만들었다).

임시 HTML 파일을 만들어 `public/`에 두고 로컬 서버로 열면 된다.

```html
<canvas id="c" width="512" height="512"></canvas>
<script>
const ctx = document.getElementById("c").getContext("2d");
const size = 512;

// 배경 (앱 테마색과 같게)
ctx.fillStyle = "#06121d";
ctx.fillRect(0, 0, size, size);

// 중앙에 이모지나 글자
ctx.textAlign = "center";
ctx.textBaseline = "middle";
ctx.font = (size * 0.56) + "px sans-serif";
ctx.fillText("🌊", size / 2, size * 0.54);

// 콘솔에 이 값이 찍히면 복사해서 PNG 로 저장한다
console.log(document.getElementById("c").toDataURL("image/png"));
</script>
```

`toDataURL()`이 준 문자열(`data:image/png;base64,...`)을 브라우저 주소창에
붙여넣고 이미지를 저장하면 PNG가 된다. 512짜리 하나를 만들고 크기만 줄여
192·180을 만들어도 된다.

**maskable 아이콘 팁**: 안드로이드가 아이콘 바깥쪽을 잘라낼 수 있으니, 내용을
가운데 80% 안에 두면 안전하다.

## 5. 서비스워커 — 여기서 사고가 난다

서비스워커는 브라우저와 네트워크 사이에 끼어들어 요청을 가로챈다. **잘못 만들면
옛 데이터를 계속 보여준다.**

`public/sw.js`:

```js
const CACHE_NAME = "myapp-shell-v1";
const SHELL_URL = "/";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then(c => c.add(SHELL_URL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // 이름이 다른 옛 캐시를 지운다 (버전 올릴 때 정리됨)
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // ★ API 는 절대 캐시하지 않는다 — 손대지 않고 그냥 네트워크로 보낸다
  if (url.pathname.startsWith("/api/") || req.method !== "GET") return;

  // 그 외는 네트워크 우선, 실패(오프라인)하면 캐시로 폴백
  event.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then(c => c || caches.match(SHELL_URL)))
  );
});
```

등록은 진입점에서 한다.

```js
// public/js/main.js
if ("serviceWorker" in navigator){
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
```

### 반드시 지킬 두 가지

**1) API 응답은 캐시하지 않는다.**
이 앱은 예보·특보처럼 매 순간 바뀌는 데이터가 핵심이다. 그걸 캐시했다가
오프라인에서 옛 값을 보여주면 **안전 정보가 틀리는 사고**가 된다.
그래서 `/api/*`는 서비스워커 로직을 아예 타지 않게 `return`으로 빠져나간다.

**2) 네트워크 우선(network-first)으로 한다.**
캐시 우선(cache-first)이 빠르지만, 코드를 고쳐 배포해도 사용자에게 **옛 화면이
계속 보인다.** 네트워크 우선이면 항상 최신을 받고, 캐시는 오프라인 대비용으로만
남는다.

**캐시 이름에 버전을 붙이는 이유**: `v1` → `v2`로 올리면 `activate`에서 옛 캐시가
지워진다. 캐시 전략을 바꿀 때 버전을 올린다.

## 6. 확인하기

배포한 뒤 브라우저 개발자 도구 → **Application** 탭에서:

- **Manifest** — 이름·아이콘이 제대로 읽혔는지, 경고가 없는지
- **Service Workers** — "activated and is running" 상태인지
- **Cache Storage** — 무엇이 캐시됐는지 (`/api/*`가 없어야 정상)

코드로 확인하려면 콘솔에서:

```js
await navigator.serviceWorker.getRegistration()   // 등록돼 있으면 객체가 나온다
```

### 설치해 보기

- **안드로이드 크롬**: 메뉴 → "홈 화면에 추가" (또는 자동 설치 배너)
- **iOS 사파리**: 공유 버튼 → "홈 화면에 추가"
- **데스크톱 크롬**: 주소창 오른쪽 설치 아이콘

## 7. 서비스워커 때문에 곤란할 때

**증상**: 배포했는데 옛 화면이 계속 보인다.

개발자 도구 → Application → Service Workers에서:
- **Update on reload** 체크 — 개발 중에는 켜두면 편하다
- **Unregister** — 등록을 지운다
- Cache Storage에서 캐시를 직접 삭제

사용자에게 이걸 시킬 수는 없으니, **애초에 네트워크 우선으로 만드는 것**이
진짜 해결책이다.

---

## 자주 겪는 문제

**설치 배너가 안 뜬다**
세 조건(매니페스트·아이콘·서비스워커)과 HTTPS를 모두 확인한다. Application →
Manifest 탭에 무엇이 빠졌는지 경고가 나온다. 로컬(`localhost`)은 예외적으로
HTTPS 없이도 동작한다.

**아이콘이 안 보이거나 깨진다**
경로가 `/`로 시작하는 절대 경로인지, 실제로 그 주소로 접속되는지 확인한다.
`sizes` 값이 실제 이미지 크기와 같아야 한다.

**스플래시가 하얗게 번쩍인다**
`background_color`를 앱 배경색과 같게 맞춘다.

**아이콘 모서리가 잘려 이상하다**
`purpose: "maskable"` 아이콘의 내용을 가운데 80% 안으로 넣는다.

**서비스워커를 등록했는데 API가 이상하게 동작한다**
`fetch` 핸들러에서 `/api/*`를 `return`으로 빠져나가는지 확인한다.

다음: [09-코드정리와-테스트](./09-코드정리와-테스트.md)
