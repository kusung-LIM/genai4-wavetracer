# 06. 정기 작업 (Cron)

목표: "방문자마다 부르기"를 "정해진 시각에 한 번 모아두기"로 바꾸는 법.
이건 성능 최적화가 아니라 **비용 구조를 바꾸는 설계 결정**이다.

---

## 1. 언제 필요한가

```
방문자마다 외부 API 호출
  → 호출 횟수 = 방문자 수 × 호출 수
  → 무료 한도가 트래픽에 비례해 녹는다
  → 인기가 생기면 서비스가 멈춘다

정기 작업으로 모아두기
  → 호출 횟수 = 실행 주기로 고정 (방문자 수와 무관)
  → 화면은 저장된 값만 읽는다 (빠르다)
```

이 저장소의 실제 계산:

| | 방문자별 호출 | Cron 수집 |
|---|---|---|
| 13개 지점을 부르는 요청 | 방문자 1명당 2건 | 15분마다 2건 |
| 방문자 1,000명이면 | **2,000건** | **192건** (하루 고정) |

**단점**: 데이터가 최대 15분 낡을 수 있다. 파도 예보는 15분 단위로 안 바뀌니
괜찮은 거래였다. 초 단위 최신성이 필요한 데이터라면 이 방식이 맞지 않는다.

## 2. 설정

```jsonc
// wrangler.jsonc
"triggers": {
  "crons": ["*/15 * * * *"]     // 15분마다
}
```

cron 표기법은 다섯 칸이다.

```
분  시  일  월  요일
*/15 *  *   *   *      15분마다
0    *  *   *   *      매시 정각
0    3  *   *   *      매일 03:00 (UTC 기준!)
0    0  1   *   *      매월 1일 00:00
```

**시간대는 UTC다.** 한국 시간 오전 9시에 돌리려면 UTC 0시(`0 0 * * *`)로 적는다.

## 3. 코드

`fetch`와 나란히 `scheduled` 함수를 내보낸다.

```js
// src/worker.js
export default {
  async fetch(request, env, ctx){ /* ... 평소 요청 처리 ... */ },

  // Cron 이 정해진 시각에 부른다
  async scheduled(event, env, ctx){
    ctx.waitUntil(
      collectData(env).catch(err => {
        console.error("수집 실패:", err && err.message);
      })
    );
  },
};
```

**두 가지가 중요하다.**

**`ctx.waitUntil()`** — 이걸 안 쓰면 함수가 끝나는 순간 진행 중인 작업이
중단된다. 비동기 작업을 끝까지 보장하려면 감싸야 한다.

**실패를 삼킨다** — `.catch()`로 잡아 로그만 남긴다. Cron은 다음 주기에 또
돌기 때문에, 한 번 실패가 서비스에 영향을 주지 않게 두는 게 낫다. 화면은
직전에 저장된 값을 계속 보여준다.

## 4. 수집 함수 패턴

```js
async function collectData(env){
  // 1. 여러 지점을 한 번의 요청으로 (가능하면)
  const url = "https://api.example.com/data?lat=38.01,37.80&lon=128.71,128.90";
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();

  // 2. 여러 행을 한 번에 쓴다 (batch)
  const now = new Date().toISOString();
  const stmt = env.DB.prepare(
    "INSERT OR REPLACE INTO spot_conditions (spot_id, value, updated_at) VALUES (?1, ?2, ?3)"
  );
  await env.DB.batch(SPOT_IDS.map((id, i) => stmt.bind(id, data[i], now)));
}
```

**요청을 합친다** — 많은 API가 좌표를 쉼표로 여러 개 받는다. 13번 부르는 대신
1번 부르면 한도를 13분의 1만 쓴다.

**`INSERT OR REPLACE`** — 같은 키가 있으면 덮어쓴다. "현재 상태"만 필요할 때
행이 무한히 쌓이지 않는다.

**`env.DB.batch()`** — 여러 문장을 한 번에 보낸다. 하나씩 `run()`하면 왕복이
13번이다.

## 5. 로컬에서 Cron 테스트하기

Cron은 로컬 dev 서버에서 **자동으로 안 돌아간다.** 수동으로 쏴야 한다.

```bash
npm run dev
# 다른 터미널에서
curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled"
```

`ok`가 오면 `scheduled` 함수가 실행된 것이다. 그 다음 데이터베이스를 확인한다.

```bash
npx wrangler d1 execute my-database --local \
  --command "SELECT COUNT(*) AS n, MAX(updated_at) AS latest FROM spot_conditions;"
```

`latest`가 방금 시각이면 수집이 동작한 것이다.

> `wrangler dev`를 실행하면 안내 문구에 이 URL이 출력된다. 버전에 따라 경로가
> 다를 수 있으니 그 출력을 따르는 게 확실하다.

## 6. 배포 후 확인

```bash
npx wrangler tail          # 실시간 로그. Cron 실행과 에러가 보인다
```

Cloudflare 대시보드 → Workers & Pages → 해당 워커 → **Settings → Trigger Events**
에서 등록된 Cron 스케줄을 볼 수 있고, **Logs**에서 실행 이력을 볼 수 있다.

## 7. 함께 쓰는 캐시

Cron으로 모아둔 데이터를 화면이 읽을 때, 응답 자체도 캐시하면 요청이 더 줄어든다.

```js
// src/worker.js
const CACHE_SECONDS = 600;   // 10분

async function handleData(request, env, ctx){
  const cache = caches.default;
  const cacheKey = new Request(new URL("/api/data", request.url).toString());

  const cached = await cache.match(cacheKey);
  if (cached) return cached;                       // 캐시 적중이면 바로 반환

  const res = Response.json(data, {
    headers: { "cache-control": `public, max-age=${CACHE_SECONDS}` }
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));  // 저장은 백그라운드로
  return res;
}
```

**주의**: 캐시에 넣기 전 `res.clone()`을 해야 한다. 응답 본문은 한 번만 읽을 수
있어서, 원본을 캐시에 주면 호출자가 읽을 게 없어진다.

**절대 캐시하면 안 되는 것**: 사용자별 데이터, 방금 쓴 내용, 실시간성이 중요한
값. 이 저장소는 실패 응답에 `cache-control: no-store`를 붙여 에러가 캐시되지
않게 한다.

## 8. 과거 데이터를 지울까 남길까

이 저장소는 처음에 Cron이 돌 때마다 과거 날짜를 지웠다. 나중에 "그날 그 시간의
조건과 대조하는" 기능이 필요해졌는데, **이미 지운 데이터는 다시 만들 수 없었다.**

그래서 보존으로 바꿨다. 계산해 보니 비용이 거의 없었다.

```
지점당 하루 1행(1KB 안팎) × 13지점 × 365일 ≈ 연간 5MB
```

**교훈**: 저장 공간은 싸고, 지운 데이터는 복구할 수 없다. **지우는 판단은
보수적으로** 한다. 다만 하루 쓰기 한도는 보존 여부와 무관하다는 것도 확인해야
한다(이 경우 갱신 행 수는 같았다).

## 9. 직접 해보기

매시 정각에 방문자 수를 집계해 저장하는 작업을 만들어 보자.

```jsonc
// wrangler.jsonc
"triggers": { "crons": ["0 * * * *"] }
```

```sql
-- schema.sql
CREATE TABLE IF NOT EXISTS hourly_stats (
  hour_key TEXT PRIMARY KEY,      -- "2026-09-09T06"
  count    INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
```

```js
// src/worker.js
async scheduled(event, env, ctx){
  ctx.waitUntil((async () => {
    const key = new Date().toISOString().slice(0, 13);   // "2026-09-09T06"
    await env.DB.prepare(
      `INSERT INTO hourly_stats (hour_key, count, updated_at) VALUES (?1, 1, ?2)
       ON CONFLICT(hour_key) DO UPDATE SET count = count + 1, updated_at = ?2`)
      .bind(key, new Date().toISOString()).run();
  })().catch(e => console.error(e)));
}
```

로컬에서 `curl .../cdn-cgi/local/scheduled`로 몇 번 쏘고, 표를 조회해 `count`가
올라가는지 확인한다.

---

## 자주 겪는 문제

**Cron이 로컬에서 안 돌아간다**
정상이다. 수동으로 쏴야 한다(5번 항목).

**배포했는데 Cron이 안 도는 것 같다**
`npx wrangler tail`로 로그를 본다. 시간대가 UTC임을 다시 확인한다.
`wrangler.jsonc`를 고친 뒤 **배포를 했는지**도 확인한다(설정 변경도 배포해야 적용된다).

**작업이 중간에 끊긴다**
`ctx.waitUntil()`로 감쌌는지 확인한다.

**D1 쓰기 한도 초과**
행 수 계산을 다시 한다(9번 항목의 접어 넣기 방식 참고). 주기를 늘리는 것도 방법이다.

다음: [07-AI-기능](./07-AI-기능.md)
