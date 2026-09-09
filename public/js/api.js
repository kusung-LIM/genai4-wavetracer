import { isNum } from "./util.js";
import { offshoreness, scoreHourAllLevels } from "./score.js";

/* ============================ API ============================
   이 앱이 네트워크로 말을 거는 곳은 전부 여기 모여 있다.
   - Open-Meteo: 파고·바람 예보를 브라우저가 직접 부른다(무인증·CORS 허용).
   - /api/*: 인증키·저장소·AI 가 필요한 것들. src/worker.js 가 대신 처리한다.
============================================================== */
/* ============================ API ============================ */
const MARINE_VARS = "wave_height,wave_direction,wave_period,swell_wave_height," +
                    "swell_wave_direction,swell_wave_period,wind_wave_height,sea_surface_temperature";
const AIR_VARS = "wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m";
const DAYS = 7;

async function getJSON(url){
  const res = await fetch(url);
  if (!res.ok){
    let msg = "HTTP " + res.status;
    try { const j = await res.json(); if (j && j.reason) msg = j.reason; } catch (_){}
    throw new Error(msg);
  }
  return res.json();
}

const marineURL = (lat, lon, vars) =>
  "https://marine-api.open-meteo.com/v1/marine?latitude=" + lat.toFixed(4) +
  "&longitude=" + lon.toFixed(4) + "&hourly=" + vars +
  "&timezone=Asia%2FSeoul&forecast_days=" + DAYS;

/** 격자가 육지로 판정돼 전부 null 이면 앞바다 쪽으로 조금씩 밀어가며 재시도 */
async function fetchMarine(spot){
  const lat0 = spot.sea[0], lon0 = spot.sea[1];
  const rad = spot.facing * Math.PI / 180;
  const steps = [0, 0.06, 0.13, 0.22];
  let lastErr = null;

  for (const step of steps){
    const lat = lat0 + Math.cos(rad) * step;
    const lon = lon0 + Math.sin(rad) * step / Math.cos(lat0 * Math.PI / 180);
    try {
      let d;
      try {
        d = await getJSON(marineURL(lat, lon, MARINE_VARS));
      } catch (_){
        // 일부 격자는 수온을 제공하지 않음 → 제외하고 1회 재시도
        d = await getJSON(marineURL(lat, lon, MARINE_VARS.replace(",sea_surface_temperature", "")));
      }
      if (d && d.hourly && d.hourly.wave_height && d.hourly.wave_height.some(isNum)) return d;
      lastErr = new Error("해당 좌표에 파랑 모델 데이터가 없습니다.");
    } catch (e){ lastErr = e; }
  }
  throw lastErr || new Error("해상 데이터를 불러오지 못했습니다.");
}

const cache = new Map();

async function loadSpot(spot){
  if (cache.has(spot.id)) return cache.get(spot.id);

  const airURL = "https://api.open-meteo.com/v1/forecast?latitude=" + spot.lat +
    "&longitude=" + spot.lon + "&hourly=" + AIR_VARS +
    "&timezone=Asia%2FSeoul&forecast_days=" + DAYS + "&wind_speed_unit=ms";

  const both = await Promise.all([ fetchMarine(spot), getJSON(airURL) ]);
  const M = both[0].hourly, A = both[1].hourly;
  const airAt = new Map(A.time.map((t, i) => [t, i]));
  const pick = (arr, i) => (arr && arr[i] != null) ? arr[i] : null;

  const byDate = new Map();
  M.time.forEach((t, i) => {
    const j = airAt.has(t) ? airAt.get(t) : -1;
    const h = {
      time: t,
      hour: +t.slice(11, 13),
      waveH:  pick(M.wave_height, i),
      waveD:  pick(M.wave_direction, i),
      waveP:  pick(M.wave_period, i),
      swellH: pick(M.swell_wave_height, i),
      swellD: pick(M.swell_wave_direction, i),
      swellP: pick(M.swell_wave_period, i),
      windWH: pick(M.wind_wave_height, i),
      seaT:   pick(M.sea_surface_temperature, i),
      windSpd: j < 0 ? null : pick(A.wind_speed_10m, j),
      windDir: j < 0 ? null : pick(A.wind_direction_10m, j),
      gust:    j < 0 ? null : pick(A.wind_gusts_10m, j),
      airT:    j < 0 ? null : pick(A.temperature_2m, j)
    };
    h.off = offshoreness(h.windDir, spot.facing);
    h.scores = scoreHourAllLevels(h);
    const d = t.slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(h);
  });

  const data = { byDate: byDate, dates: Array.from(byDate.keys()).sort() };
  cache.set(spot.id, data);
  return data;
}

let advisoryPromise = null;
function loadAdvisory(){
  if (!advisoryPromise){
    // 실패해도 reject 하지 않고 ready:false 로 눙쳐서, render() 의 에러 경로가
    // 파도 예보 실패 때문인지와 뒤섞이지 않게 한다.
    advisoryPromise = fetch("/api/advisory")
      .then(r => r.json())
      .catch(() => ({ ready: false, reason: "fetch_failed" }));
  }
  return advisoryPromise;
}

async function fetchReports(limit){
  const res = await fetch("/api/reports?limit=" + limit, { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

let conditionsPromise = null;
function loadConditions(){
  if (!conditionsPromise){
    conditionsPromise = fetch("/api/conditions")
      .then(r => r.json())
      .catch(() => ({ ready: false, spots: [] }));
  }
  return conditionsPromise;
}

/* 7일치 예보. "이번주 수요일 어디가 좋아?" 같은 질문에 답하려면 현재 시점만으로는
   근거가 없다. 응답이 100KB 안팎이라 홈에서 미리 받지 않고 챗봇을 처음 열 때만
   가져온다 — 예보만 보고 가는 방문자는 이 비용을 내지 않는다.

   서버는 원시 시간별 값만 주고 점수는 여기서 낸다. 기존 summarize() 를 그대로
   써서, 챗봇이 말하는 날짜별 점수와 예보 화면의 점수가 같은 계산에서 나온다. */
let dailyPromise = null;
function loadDailyForecast(){
  if (!dailyPromise){
    dailyPromise = fetch("/api/forecast")
      .then(r => r.json())
      .catch(() => ({ ready: false, days: [] }));
  }
  return dailyPromise;
}

export { loadSpot, loadAdvisory, loadConditions, loadDailyForecast, fetchReports };
