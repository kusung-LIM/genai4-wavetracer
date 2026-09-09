import { clamp, curve, isNum } from "./util.js";
import { LEVELS, LEVEL_KEYS, WIND_C } from "./levels.js";
import { state } from "./state.js";

/* ============================ 컨디션 점수 ============================
   레벨별 곡선 정의 자체는 levels.js 에 있고, 여기서는 그 곡선을 적용해
   실제 점수를 낸다. 점수 계산은 프론트 한 곳(이 파일)에만 두는 게 이
   프로젝트의 규칙 — 서버가 따로 채점하면 지도·예보·챗봇이 서로 다른
   점수를 말하는 사고가 난다.
==================================================================== */
/**
 * 오프쇼어 정도: +1 완전 오프쇼어(육지→바다), -1 완전 온쇼어.
 * windDir 은 '바람이 불어오는 방위'(기상 관례) → 오프쇼어는 facing+180 에서 분다.
 */
function offshoreness(windDir, facing){
  if (!isNum(windDir)) return 0;
  return Math.cos((windDir - (facing + 180)) * Math.PI / 180);
}

/** 한 시간대를 세 레벨 모두로 채점해 { beginner, longboard, shortboard } 로 돌려준다.
    로딩 시점에 한 번만 계산해 저장하므로(168시간 × 3), 레벨을 바꿔도 재계산이 없다. */
function scoreHourAllLevels(h){
  const hgt = (isNum(h.swellH) && h.swellH > 0.05) ? h.swellH : h.waveH;
  const per = (isNum(h.swellP) && h.swellP > 0)    ? h.swellP : h.waveP;
  if (!isNum(hgt)) return null;

  const spd = isNum(h.windSpd) ? h.windSpd : 0;
  const windBase = curve(spd, WIND_C);
  const out = {};
  for (const key of LEVEL_KEYS){
    const L = LEVELS[key];
    // 바람 = 세기 기본점 + 오프쇼어 보정(바람이 셀수록 방향의 영향이 커짐)
    const wd = clamp(windBase + h.off * Math.min(spd, 11) * L.offBonus, 0, 100);
    out[key] = Math.round(
      curve(hgt, L.size) * L.w.size + curve(per, L.period) * L.w.period + wd * L.w.wind
    );
  }
  return out;
}

/** 현재 선택된 레벨 기준 점수. h.scores 가 null 이면(파고 결측) null. */
const scoreOf = h => (h.scores ? h.scores[state.level] : null);

const GRADES = [
  [78, "최상",   "var(--r-exc)"],
  [62, "좋음",   "var(--r-good)"],
  [45, "보통",   "var(--r-fair)"],
  [27, "아쉬움", "var(--r-poor)"],
  [-1, "잔잔함", "var(--r-flat)"]
];
/** 점수 → 등급 행 [기준점, 라벨, 색]. 점수가 없으면(파고 결측) 가장 낮은 등급으로
    떨어진다. 마지막 기준점(-1)은 "-1 > -1" 이 거짓이라 find 가 undefined 를 주는데,
    호출부 중에는 g[1]·g[2] 를 가드 없이 바로 쓰는 곳이 있어(차트 컨디션 띠, 홈 지도
    마커, 세션 상세 패널) 그러면 화면이 통째로 안 뜬다 — 항상 행을 돌려준다. */
const grade = s => GRADES.find(g => (isNum(s) ? s : -1) > g[0]) ?? GRADES[GRADES.length - 1];

function windLabel(off){
  if (off >  0.42) return ["오프쇼어", "b-off"];
  if (off < -0.42) return ["온쇼어",   "b-on"];
  return ["사이드", "b-side"];
}

/* ============================ 하루 요약 ============================
   avg/top/best 는 현재 선택된 레벨(state.level) 기준이고, avgByLevel 에는 세
   레벨 평균을 다 담아 준다 — 히어로의 레벨 선택 버튼이 각자 점수를 같이
   보여줘야 해서(선택기 겸 비교표) 한 번에 계산해 둔다. */
function summarize(hours){
  const valid = hours.filter(h => isNum(scoreOf(h)));
  if (!valid.length) return null;

  const peak = valid.reduce((a, b) => (b.waveH || 0) > (a.waveH || 0) ? b : a);
  const avg  = Math.round(valid.reduce((s, h) => s + scoreOf(h), 0) / valid.length);

  const avgByLevel = {};
  for (const key of LEVEL_KEYS){
    const xs = hours.map(h => h.scores && h.scores[key]).filter(isNum);
    avgByLevel[key] = xs.length ? Math.round(xs.reduce((s, v) => s + v, 0) / xs.length) : null;
  }

  // 추천 시간대: 05~20시 중 최고점에서 좌우로 -10점 이내까지 확장
  const day = valid.filter(h => h.hour >= 5 && h.hour <= 20);
  const pool = day.length ? day : valid;
  const top = pool.reduce((a, b) => scoreOf(b) > scoreOf(a) ? b : a);
  const idx = pool.indexOf(top);
  let a = idx, b = idx;
  while (a > 0 && scoreOf(pool[a-1]) >= scoreOf(top) - 10) a--;
  while (b < pool.length - 1 && scoreOf(pool[b+1]) >= scoreOf(top) - 10) b++;

  const seaTs = valid.map(h => h.seaT).filter(isNum);
  const winds = valid.map(h => h.windSpd).filter(isNum);
  const pers  = valid.map(h => isNum(h.swellP) ? h.swellP : h.waveP).filter(isNum);
  const dirs  = valid.map(h => isNum(h.swellD) ? h.swellD : h.waveD).filter(isNum);

  // 하루의 바람 성향: 시간별 오프쇼어도를 풍속으로 가중 평균.
  // (최고점 한 시간의 풍향만 쓰면 나머지 23시간과 어긋난 라벨이 나온다)
  const wh = valid.filter(h => isNum(h.windDir) && isNum(h.windSpd));
  const wsum = wh.reduce((s, h) => s + Math.max(h.windSpd, 0.5), 0);
  const offAvg = wsum > 0
    ? wh.reduce((s, h) => s + h.off * Math.max(h.windSpd, 0.5), 0) / wsum
    : 0;

  return {
    avg: avg,
    avgByLevel: avgByLevel,
    top: top,
    offAvg: offAvg,
    best: { from: pool[a].hour, to: pool[b].hour },
    peakWave: peak.waveH,
    peakPeriod: pers.length ? Math.max.apply(null, pers) : null,
    windAvg: winds.length ? winds.reduce((s, v) => s + v, 0) / winds.length : null,
    seaT: seaTs.length ? seaTs.reduce((s, v) => s + v, 0) / seaTs.length : null,
    dirMode: dirs.length ? dirs[Math.floor(dirs.length / 2)] : null
  };
}

/* 수집된 관측값(/api/conditions)을 점수 계산이 쓰는 시간대 객체 모양으로 맞춘다.
   점수 곡선은 프론트에만 있으므로(worker 는 원시값만 저장한다) 여기서 계산한다. */
function conditionToHour(row, spot){
  const h = {
    waveH: row.waveH, waveP: row.waveP, waveD: row.waveD,
    swellH: row.swellH, swellP: row.swellP, swellD: row.swellD,
    windSpd: row.windSpd, windDir: row.windDir, seaT: row.seaT,
  };
  h.off = offshoreness(h.windDir, spot.facing);
  h.scores = scoreHourAllLevels(h);
  return h;
}

/** spot_daily 의 자리 기반 배열을 시간대 객체로 펼친다.
    [시각, 파고, 주기, 너울고, 너울주기, 풍속, 풍향] 순서는 worker 와 맞춰야 한다. */
function expandDailyHours(rows, spot){
  return rows.map(r => {
    const h = {
      hour: r[0], waveH: r[1], waveP: r[2], swellH: r[3], swellP: r[4],
      windSpd: r[5], windDir: r[6],
    };
    h.off = offshoreness(h.windDir, spot.facing);
    h.scores = scoreHourAllLevels(h);
    return h;
  });
}

export { offshoreness, scoreHourAllLevels, scoreOf, GRADES, grade, windLabel,
         summarize, conditionToHour, expandDailyHours };
