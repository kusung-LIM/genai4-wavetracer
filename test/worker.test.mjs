/* 워커의 순수 함수 테스트. `npm test` 로 실행된다.
   픽스처는 만들어낸 문자열이 아니라 2026-09-09 에 실제 기상청 API 에서 받은
   통보문 t6 본문이다 — 이 파싱이 이 프로젝트에서 가장 여러 번 틀렸던 부분이라,
   그때 확인한 사실을 그대로 테스트로 굳혀둔다. */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  haversineM, toKSTDateHour, matchSpot, kmaTimeToISO, advisorySpotsFromBulletins,
} from "../src/worker.js";

/* ============================ 거리 계산 ============================ */

test("haversineM: 같은 지점은 0", () => {
  assert.equal(haversineM(38.0158, 128.7186, 38.0158, 128.7186), 0);
});

test("haversineM: 서울–부산 약 325km (오차 5km 이내)", () => {
  const d = haversineM(37.5665, 126.9780, 35.1796, 129.0756);
  assert.ok(Math.abs(d - 325000) < 5000, `실제 ${Math.round(d)}m`);
});

test("haversineM: 방향을 바꿔도 같은 거리", () => {
  const a = haversineM(33.2447, 126.4106, 38.2650, 128.5620);
  const b = haversineM(38.2650, 128.5620, 33.2447, 126.4106);
  assert.ok(Math.abs(a - b) < 1e-6);
});

/* ============================ GPS 스팟 매칭 ============================ */

const track = (lat, lon, n = 10) =>
  Array.from({ length: n }, (_, i) => [lat + i * 0.00002, lon + i * 0.00002, 5, 0, null]);

test("matchSpot: 스팟 중심 좌표는 그 스팟으로 매칭", () => {
  assert.equal(matchSpot(track(38.0158, 128.7186)), "jukdo");
  assert.equal(matchSpot(track(35.1786, 129.1997)), "songjeong");
  assert.equal(matchSpot(track(33.5560, 126.7960)), "woljeong");
});

test("matchSpot: 반경(3km) 밖 내륙 지점은 억지 매칭 없이 null", () => {
  // 실측용 GPX 샘플을 찍은 지점(경기 용인 인근). 어떤 스팟과도 무관해야 한다.
  assert.equal(matchSpot(track(37.2512, 127.0461)), null);
});

test("matchSpot: 두 스팟 사이에서는 더 가까운 쪽", () => {
  // 죽도(38.0158) 와 인구(37.9930) 사이. 죽도에 훨씬 가깝게 잡는다.
  assert.equal(matchSpot(track(38.0150, 128.7190)), "jukdo");
});

test("matchSpot: 중심점을 쓰므로 일부 점이 흩어져도 스팟이 유지된다", () => {
  const pts = [...track(38.0158, 128.7186, 8), [38.0300, 128.7400, 5, 0, null]];
  assert.equal(matchSpot(pts), "jukdo");
});

/* ============================ KST 변환 ============================ */

test("toKSTDateHour: UTC 15시는 KST 다음날 0시 (날짜 넘김)", () => {
  // spot_daily 는 KST 달력 기준이라, 이 경계를 틀리면 하루가 밀린다.
  assert.deepEqual(toKSTDateHour(Date.parse("2026-09-08T15:00:00Z")),
    { date: "2026-09-09", hour: 0 });
});

test("toKSTDateHour: UTC 14:59 는 아직 같은 날 23시", () => {
  assert.deepEqual(toKSTDateHour(Date.parse("2026-09-08T14:59:00Z")),
    { date: "2026-09-08", hour: 23 });
});

test("toKSTDateHour: 정오 근처 일반 케이스", () => {
  assert.deepEqual(toKSTDateHour(Date.parse("2026-09-09T01:33:42Z")),
    { date: "2026-09-09", hour: 10 });
});

test("kmaTimeToISO: tmFc 숫자를 KST 오프셋 ISO 로", () => {
  assert.equal(kmaTimeToISO(202609090900), "2026-09-09T09:00:00+09:00");
  // Date 로 파싱해도 같은 순간을 가리켜야 한다
  assert.equal(new Date(kmaTimeToISO(202609090900)).toISOString(), "2026-09-09T00:00:00.000Z");
});

/* ============================ 풍랑특보 t6 파싱 ============================
   아래 t6 문자열은 2026-09-09 09시 실제 통보문에서 그대로 가져온 것이다. */

const T6_BUSAN = [            // stnId 159 (부산)
  "o 강풍주의보 : 경상남도(거제), 부산, 울산",
  "o 풍랑경보 : 동해남부남쪽안쪽먼바다, 동해남부남쪽바깥먼바다",
  "o 풍랑주의보 : 동해남부앞바다(울산앞바다), 남해동부앞바다(부산앞바다, 거제시동부앞바다), 남해동부안쪽먼바다, 남해동부바깥먼바다",
].join("\n");

const T6_HQ = [               // stnId 108 (본청) — 전국 대상
  "o 강풍주의보 : 전라남도(여수, 거문도.초도), 경상북도(포항, 경주동부), 부산, 울산, 울릉도.독도",
  "o 풍랑경보 : 동해남부남쪽안쪽먼바다, 동해남부남쪽바깥먼바다, 동해남부북쪽안쪽먼바다, 동해남부북쪽바깥먼바다",
  "o 풍랑주의보 : 동해남부앞바다, 동해중부전해상, 서해남부북쪽바깥먼바다, 서해중부바깥먼바다, 남해동부앞바다(부산앞바다, 거제시동부앞바다), 남해서부동쪽먼바다, 제주도남쪽바깥먼바다",
].join("\n");

test("t6: 먼바다 경보와 앞바다 주의보가 같이 오면 앞바다(근해) 단계를 쓴다", () => {
  // 동해남부는 먼바다가 경보(2), 앞바다가 주의보(1). 서핑 포인트는 근해이므로 1.
  // 먼바다 경보를 그대로 반영하면 실제보다 위험하게 표시되는 오탐이 된다.
  const s = advisorySpotsFromBulletins([{ t6: T6_BUSAN, tmFc: 202609090900 }]);
  assert.equal(s.yonghan.level, 1, "용한리(동해남부앞바다)");
  assert.equal(s.songjeong.level, 1, "송정(남해동부앞바다)");
});

test("t6: '전해상' 표기도 근해로 인정한다", () => {
  // "동해중부전해상" 은 "동해중부앞바다" 를 포함하는 통합 발표다. 앞바다 문자열만
  // 찾으면 이 케이스를 통째로 놓친다(실제로 이 버그를 잡은 적이 있다).
  const s = advisorySpotsFromBulletins([{ t6: T6_HQ, tmFc: 202609090900 }]);
  for (const id of ["sampo", "hajodae", "jukdo", "ingu", "gyeongpo", "geumjin"]){
    assert.equal(s[id].level, 1, `${id}(동해중부앞바다)`);
  }
});

test("t6: 먼바다만 언급된 구역은 근해에 반영하지 않는다", () => {
  // T6_HQ 에 "서해중부바깥먼바다" 만 있고 "서해중부앞바다" 는 없다 → 만리포는 평소.
  const s = advisorySpotsFromBulletins([{ t6: T6_HQ, tmFc: 202609090900 }]);
  assert.equal(s.malli.level, 0, "만리포(서해중부앞바다)");
  // "제주도남쪽바깥먼바다" 도 먼바다이므로 제주 스팟은 평소.
  assert.equal(s.jungmun.level, 0);
  assert.equal(s.iho.level, 0);
  assert.equal(s.woljeong.level, 0);
});

test("t6: 상위 구역('제주도앞바다') 통째 발표를 하위 3개 스팟이 모두 받는다", () => {
  const s = advisorySpotsFromBulletins([
    { t6: "o 풍랑주의보 : 제주도앞바다, 제주도남서쪽안쪽먼바다", tmFc: 202609091100 },
  ]);
  assert.equal(s.jungmun.level, 1, "중문(제주도남부앞바다)");
  assert.equal(s.iho.level, 1, "이호(제주도북부앞바다)");
  assert.equal(s.woljeong.level, 1, "월정리(제주도동부앞바다)");
});

test("t6: 하위 구역만 발표되면 그 스팟만 받는다", () => {
  const s = advisorySpotsFromBulletins([
    { t6: "o 풍랑경보 : 제주도북부앞바다", tmFc: 202609091100 },
  ]);
  assert.equal(s.iho.level, 2, "이호만 경보");
  assert.equal(s.jungmun.level, 0);
  assert.equal(s.woljeong.level, 0);
});

test("t6: 여러 관서가 겹쳐 발표하면 더 높은 단계가 이긴다", () => {
  const s = advisorySpotsFromBulletins([
    { t6: "o 풍랑주의보 : 동해중부앞바다", tmFc: 202609090500 },
    { t6: "o 풍랑경보 : 동해중부앞바다",   tmFc: 202609090900 },
  ]);
  assert.equal(s.jukdo.level, 2);
  assert.equal(s.jukdo.issuedAt, "2026-09-09T09:00:00+09:00", "더 높은 단계의 발표시각");
});

test("t6: 풍랑 외 특보(강풍 등)는 무시한다", () => {
  const s = advisorySpotsFromBulletins([
    { t6: "o 강풍주의보 : 부산, 울산\no 건조주의보 : 강원도", tmFc: 202609090900 },
  ]);
  assert.ok(Object.values(s).every(v => v.level === 0));
});

test("t6: 빈 통보문·특보 없음이면 전부 평소(0)", () => {
  for (const t6 of ["", null, undefined, "o 없음"]){
    const s = advisorySpotsFromBulletins([{ t6, tmFc: 202609090900 }]);
    assert.ok(Object.values(s).every(v => v.level === 0 && v.issuedAt === null),
      `t6=${JSON.stringify(t6)}`);
  }
});

test("t6: 발표가 아예 없으면 13개 스팟이 모두 평소로 채워진다", () => {
  const s = advisorySpotsFromBulletins([]);
  assert.equal(Object.keys(s).length, 13);
  assert.ok(Object.values(s).every(v => v.level === 0));
  assert.equal(s.jukdo.zone, "동해중부앞바다", "구역명은 항상 실려야 한다");
});
