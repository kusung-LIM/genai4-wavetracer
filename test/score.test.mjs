/* 컨디션 점수 로직 테스트.
   점수 곡선은 프론트 한 곳에만 두는 게 이 프로젝트의 규칙이라(서버가 따로 채점하면
   지도·예보·챗봇이 서로 다른 점수를 말한다) 이 파일이 그 한 곳을 지키는 안전망이다.

   util.js 가 모듈 로드 시점에 $("#app") 을 잡아두기 때문에 Node 에는 없는 document
   가 필요하다. jsdom 같은 의존성을 들이는 대신 필요한 것만 스텁으로 채우고, 정적
   import 보다 먼저 실행되도록 동적 import 를 쓴다. */
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.location = { search: "", pathname: "/" };

const { curve } = await import("../public/js/util.js");
const { LEVELS, DEFAULT_LEVEL } = await import("../public/js/levels.js");
const { state } = await import("../public/js/state.js");
const {
  offshoreness, scoreHourAllLevels, scoreOf, grade, windLabel,
  summarize, conditionToHour, expandDailyHours,
} = await import("../public/js/score.js");
const { SPOTS } = await import("../public/js/spots.js");

const jukdo = SPOTS.find(s => s.id === "jukdo"); // facing 85

/* ============================ 보간 곡선 ============================ */

test("curve: 구간 양 끝을 벗어나면 끝값으로 잘린다", () => {
  const pts = [[0, 0], [10, 100]];
  assert.equal(curve(-5, pts), 0);
  assert.equal(curve(15, pts), 100);
});

test("curve: 꼭짓점에서는 그 값 그대로", () => {
  const pts = [[0, 0], [5, 80], [10, 100]];
  assert.equal(curve(0, pts), 0);
  assert.equal(curve(5, pts), 80);
  assert.equal(curve(10, pts), 100);
});

test("curve: 구간 안은 선형 보간", () => {
  assert.equal(curve(5, [[0, 0], [10, 100]]), 50);
  assert.equal(curve(2.5, [[0, 0], [10, 100]]), 25);
});

test("curve: 숫자가 아니면 0", () => {
  assert.equal(curve(null, [[0, 50]]), 0);
  assert.equal(curve(undefined, [[0, 50]]), 0);
  assert.equal(curve(NaN, [[0, 50]]), 0);
});

/* ============================ 오프쇼어 판정 ============================ */

test("offshoreness: 해변이 바라보는 방위의 반대에서 불면 완전 오프쇼어(+1)", () => {
  // windDir 은 '바람이 불어오는 방위'. facing+180 에서 불어오면 육지→바다.
  assert.ok(Math.abs(offshoreness(85 + 180, 85) - 1) < 1e-9);
});

test("offshoreness: 바다 쪽에서 불면 완전 온쇼어(-1)", () => {
  assert.ok(Math.abs(offshoreness(85, 85) + 1) < 1e-9);
});

test("offshoreness: 직각이면 사이드(0에 가까움)", () => {
  assert.ok(Math.abs(offshoreness(85 + 90, 85)) < 1e-9);
});

test("offshoreness: 풍향이 없으면 0", () => {
  assert.equal(offshoreness(null, 85), 0);
});

test("windLabel: 오프쇼어/온쇼어/사이드 라벨", () => {
  assert.equal(windLabel(1)[0], "오프쇼어");
  assert.equal(windLabel(-1)[0], "온쇼어");
  assert.equal(windLabel(0)[0], "사이드");
});

/* ============================ 시간대 채점 ============================ */

const hour = (o = {}) => {
  const h = { waveH: 1.0, waveP: 8, windSpd: 3, windDir: 265, ...o };
  h.off = offshoreness(h.windDir, jukdo.facing);
  return h;
};

test("scoreHourAllLevels: 파고가 없으면 null (결측을 0점으로 위장하지 않는다)", () => {
  assert.equal(scoreHourAllLevels(hour({ waveH: null })), null);
  assert.equal(scoreHourAllLevels(hour({ waveH: undefined })), null);
});

test("scoreHourAllLevels: 세 레벨 점수를 모두 돌려준다", () => {
  const s = scoreHourAllLevels(hour());
  assert.deepEqual(Object.keys(s).sort(), Object.keys(LEVELS).sort());
  for (const v of Object.values(s)) assert.ok(v >= 0 && v <= 100, `점수 범위: ${v}`);
});

test("scoreHourAllLevels: 작은 파도는 비기너가, 큰 파도는 숏보더가 더 높다", () => {
  const small = scoreHourAllLevels(hour({ waveH: 0.5, waveP: 6 }));
  const big   = scoreHourAllLevels(hour({ waveH: 2.2, waveP: 12 }));
  assert.ok(small.beginner > small.shortboard,
    `작은 파도 비기너 ${small.beginner} > 숏보더 ${small.shortboard}`);
  assert.ok(big.shortboard > big.beginner,
    `큰 파도 숏보더 ${big.shortboard} > 비기너 ${big.beginner}`);
});

test("scoreHourAllLevels: 너울이 있으면 풍랑 대신 너울을 기준으로 삼는다", () => {
  const windWaveOnly = scoreHourAllLevels(hour({ waveH: 0.3, waveP: 4 }));
  const withSwell    = scoreHourAllLevels(hour({ waveH: 0.3, waveP: 4, swellH: 1.5, swellP: 11 }));
  assert.ok(withSwell.shortboard > windWaveOnly.shortboard,
    `너울 반영 ${withSwell.shortboard} > 풍랑만 ${windWaveOnly.shortboard}`);
});

test("scoreHourAllLevels: 같은 파도라도 오프쇼어가 온쇼어보다 높다", () => {
  const off = scoreHourAllLevels(hour({ windDir: 265, windSpd: 6 })); // facing 85 의 반대
  const on  = scoreHourAllLevels(hour({ windDir: 85,  windSpd: 6 }));
  assert.ok(off.shortboard > on.shortboard, `오프 ${off.shortboard} > 온 ${on.shortboard}`);
});

/* ============================ 등급 ============================ */

test("grade: 점수 구간별 라벨", () => {
  assert.equal(grade(90)[1], "최상");
  assert.equal(grade(70)[1], "좋음");
  assert.equal(grade(50)[1], "보통");
  assert.equal(grade(30)[1], "아쉬움");
  assert.equal(grade(10)[1], "잔잔함");
});

test("grade: 점수가 없으면 잔잔함으로 떨어진다", () => {
  assert.equal(grade(null)[1], "잔잔함");
  assert.equal(grade(undefined)[1], "잔잔함");
});

/* ============================ 하루 요약 ============================ */

const dayHours = (waveHs) => waveHs.map((waveH, i) => {
  const h = { hour: i, waveH, waveP: 8, windSpd: 3, windDir: 265 };
  h.off = offshoreness(h.windDir, jukdo.facing);
  h.scores = scoreHourAllLevels(h);
  return h;
});

test("summarize: 채점 가능한 시간대가 없으면 null", () => {
  assert.equal(summarize([]), null);
  assert.equal(summarize(dayHours([null, null, null])), null);
});

test("summarize: 평균 점수와 최고 파고를 낸다", () => {
  state.level = "shortboard";
  const sm = summarize(dayHours(Array.from({ length: 24 }, (_, i) => 1.0 + i * 0.05)));
  assert.ok(sm.avg > 0 && sm.avg <= 100);
  assert.ok(Math.abs(sm.peakWave - (1.0 + 23 * 0.05)) < 1e-9, "최고 파고");
});

test("summarize: 추천 시간대는 05~20시 안에서 잡는다", () => {
  state.level = "shortboard";
  // 새벽 3시에 최고점을 두더라도 낮 시간대에서 추천 구간을 고른다
  const hs = dayHours(Array.from({ length: 24 }, (_, i) => (i === 3 ? 2.0 : 1.2)));
  const sm = summarize(hs);
  assert.ok(sm.best.from >= 5 && sm.best.to <= 20, `추천 ${sm.best.from}–${sm.best.to}시`);
});

test("summarize: 레벨별 평균을 모두 담는다", () => {
  const sm = summarize(dayHours(Array.from({ length: 24 }, () => 1.2)));
  assert.deepEqual(Object.keys(sm.avgByLevel).sort(), Object.keys(LEVELS).sort());
});

test("scoreOf: 현재 선택된 레벨의 점수를 돌려준다", () => {
  const h = dayHours([0.5])[0];
  state.level = "beginner";
  assert.equal(scoreOf(h), h.scores.beginner);
  state.level = "shortboard";
  assert.equal(scoreOf(h), h.scores.shortboard);
  state.level = DEFAULT_LEVEL;
});

/* ============================ 서버 데이터 → 시간대 객체 ============================ */

test("expandDailyHours: spot_daily 자리 기반 배열의 순서 계약을 지킨다", () => {
  // [시각, 파고, 주기, 너울고, 너울주기, 풍속, 풍향] — worker 가 쓰는 순서와 같아야 한다.
  // 이 순서가 어긋나면 에러 없이 파고 자리에 주기가 들어가는 식으로 조용히 틀린다.
  const [h] = expandDailyHours([[14, 1.7, 9, 1.4, 11, 4.2, 265]], jukdo);
  assert.equal(h.hour, 14);
  assert.equal(h.waveH, 1.7);
  assert.equal(h.waveP, 9);
  assert.equal(h.swellH, 1.4);
  assert.equal(h.swellP, 11);
  assert.equal(h.windSpd, 4.2);
  assert.equal(h.windDir, 265);
  assert.ok(h.off > 0.9, "facing 85 기준 오프쇼어여야 한다");
  assert.ok(h.scores.shortboard > 0, "채점까지 끝난 상태로 나온다");
});

test("conditionToHour: /api/conditions 행을 채점된 시간대 객체로 바꾼다", () => {
  const h = conditionToHour({
    waveH: 1.2, waveP: 8, waveD: 80, swellH: 1.0, swellP: 10, swellD: 85,
    windSpd: 5, windDir: 265, seaT: 24.1,
  }, jukdo);
  assert.equal(h.waveH, 1.2);
  assert.equal(h.seaT, 24.1);
  assert.ok(h.off > 0.9);
  assert.ok(h.scores && h.scores.shortboard > 0);
});
