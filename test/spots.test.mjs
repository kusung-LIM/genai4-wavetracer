/* 스팟 표 불변식 테스트.
   이 표는 프론트와 워커가 함께 쓰는 유일한 원본이라(public/js/spots.js), 한 줄
   잘못 넣으면 화면·수집·특보 매칭이 한꺼번에 조용히 틀어진다. 스팟을 추가하거나
   좌표를 고칠 때 이 테스트가 먼저 잡아주도록 최소 조건만 못박아 둔다. */
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };

const { SPOTS, spotNameOf } = await import("../public/js/spots.js");

const JEJU = ["jungmun", "iho", "woljeong"];

test("스팟 13곳, id 중복 없음", () => {
  assert.equal(SPOTS.length, 13);
  assert.equal(new Set(SPOTS.map(s => s.id)).size, 13);
});

test("모든 스팟이 필수 필드를 갖는다", () => {
  for (const s of SPOTS){
    for (const k of ["id", "name", "region", "lat", "lon", "sea", "facing", "zoneName"]){
      assert.ok(s[k] !== undefined && s[k] !== null, `${s.id}.${k} 누락`);
    }
    assert.equal(s.sea.length, 2, `${s.id}.sea 는 [위도, 경도]`);
  }
});

test("좌표가 한국 범위 안에 있다", () => {
  for (const s of SPOTS){
    assert.ok(s.lat > 33 && s.lat < 39, `${s.id} 위도 ${s.lat}`);
    assert.ok(s.lon > 125 && s.lon < 132, `${s.id} 경도 ${s.lon}`);
    assert.ok(s.sea[0] > 33 && s.sea[0] < 39, `${s.id} 앞바다 위도 ${s.sea[0]}`);
    assert.ok(s.sea[1] > 125 && s.sea[1] < 132, `${s.id} 앞바다 경도 ${s.sea[1]}`);
  }
});

test("앞바다(sea) 좌표는 해변 좌표와 달라야 한다", () => {
  // 같으면 파랑 모델이 육지로 판정해 null 만 돌려준다 — sea 를 따로 두는 이유가 사라진다.
  for (const s of SPOTS){
    assert.ok(s.sea[0] !== s.lat || s.sea[1] !== s.lon, `${s.id} sea 가 해변 좌표와 동일`);
  }
});

test("앞바다 좌표는 해변에서 너무 멀지 않다 (50km 이내)", () => {
  // 격자에 걸리게 하려고 바다로 밀어낸 값이지, 다른 해역을 가리키면 안 된다.
  const toRad = d => d * Math.PI / 180;
  for (const s of SPOTS){
    const dLat = toRad(s.sea[0] - s.lat), dLon = toRad(s.sea[1] - s.lon);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(s.lat)) * Math.cos(toRad(s.sea[0])) * Math.sin(dLon / 2) ** 2;
    const km = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    assert.ok(km < 50, `${s.id} 앞바다 좌표가 ${km.toFixed(1)}km 떨어져 있다`);
  }
});

test("facing 은 0~360 방위", () => {
  for (const s of SPOTS){
    assert.ok(s.facing >= 0 && s.facing <= 360, `${s.id} facing ${s.facing}`);
  }
});

test("zoneName 은 기상청 근해 구역명 형식('...앞바다')", () => {
  for (const s of SPOTS){
    assert.match(s.zoneName, /앞바다$/, `${s.id} zoneName ${s.zoneName}`);
  }
});

test("제주 스팟만 상위 구역명을 갖고, 값은 '제주도앞바다'", () => {
  for (const s of SPOTS){
    if (JEJU.includes(s.id)){
      assert.equal(s.parentZoneName, "제주도앞바다", `${s.id}`);
      assert.match(s.zoneName, /^제주도(북|남|동|서)부앞바다$/, `${s.id} 하위 구역명`);
    } else {
      assert.equal(s.parentZoneName, undefined, `${s.id} 는 상위 구역명이 없어야 한다`);
    }
  }
});

test("region 첫 단어가 포인트 셀렉트의 optgroup 이 된다", () => {
  // buildSpotSelect 가 region.split(" ")[0] 으로 묶으므로 두 단어여야 라벨이 제대로 나온다.
  for (const s of SPOTS){
    assert.equal(s.region.split(" ").length, 2, `${s.id} region "${s.region}"`);
  }
});

test("spotNameOf: 아는 id 는 이름, 모르는 id 는 그대로", () => {
  assert.equal(spotNameOf("jukdo"), "죽도 해변");
  assert.equal(spotNameOf("없는스팟"), "없는스팟");
});
