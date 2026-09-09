/* 예보 화면의 순수 렌더 함수 테스트(문자열만 만들고 DOM 을 건드리지 않는 것들).
   이 파일이 있는 이유: grade() 가 점수 없는 시간대에 undefined 를 돌려주던 탓에
   파고가 null 인 시간대가 하나만 섞여도 차트·표가 통째로 안 뜨는 버그가 있었다.
   Open-Meteo 는 실제로 일부 시간대에 null 을 주므로 언제든 재발할 수 있는 경로다. */
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.location = { search: "", pathname: "/" };

const { offshoreness, scoreHourAllLevels } = await import("../public/js/score.js");
const { renderChart, renderTable, renderHero } = await import("../public/js/forecast.js");
const { summarize } = await import("../public/js/score.js");
const { SPOTS } = await import("../public/js/spots.js");

const jukdo = SPOTS.find(s => s.id === "jukdo");

/** loadSpot() 이 만드는 시간대 객체와 같은 모양으로 하루치를 만든다.
    nullAt 에 지정한 시각은 파고를 null 로 둔다(= scores 가 null 이 된다). */
function day({ nullAt = [], waveH = 1.2 } = {}){
  return Array.from({ length: 24 }, (_, i) => {
    const hh = String(i).padStart(2, "0");
    const h = {
      time: `2026-09-09T${hh}:00`, hour: i,
      waveH: nullAt.includes(i) ? null : waveH,
      waveP: 8, waveD: 80, swellH: null, swellP: null, swellD: null,
      windSpd: 3, windDir: 265, seaT: 24,
    };
    h.off = offshoreness(h.windDir, jukdo.facing);
    h.scores = scoreHourAllLevels(h);
    return h;
  });
}

test("정상 하루치: 차트와 표가 그려진다", () => {
  const hours = day();
  assert.match(renderChart(hours), /<svg class="chart"/);
  assert.match(renderTable(hours), /<table/);
});

test("파고가 null 인 시간대가 섞여도 차트가 그려진다", () => {
  // 회귀 방지: 예전엔 grade(null) 이 undefined 라 g[2] 접근에서 터졌다.
  const hours = day({ nullAt: [7] });
  assert.equal(hours[7].scores, null, "전제: 파고 null 이면 scores 도 null");
  assert.match(renderChart(hours), /<svg class="chart"/);
});

test("파고가 null 인 시간대가 섞여도 표가 그려진다", () => {
  const hours = day({ nullAt: [0, 7, 23] });
  const html = renderTable(hours);
  assert.match(html, /<table/);
  assert.equal((html.match(/<tr/g) || []).length, 25, "헤더 1 + 24시간");
});

test("하루 전체가 결측이어도 차트·표가 터지지 않는다", () => {
  const hours = day({ nullAt: Array.from({ length: 24 }, (_, i) => i) });
  assert.doesNotThrow(() => renderChart(hours));
  assert.doesNotThrow(() => renderTable(hours));
  assert.equal(summarize(hours), null, "요약은 null 이 맞다");
});

test("히어로: 요약이 있으면 점수와 등급이 들어간다", () => {
  const sm = summarize(day());
  const html = renderHero(jukdo, "2026-09-09", sm);
  assert.match(html, /죽도 해변/);
  assert.match(html, new RegExp(String(sm.avg)));
});
