/* ============================ 유틸 ============================
   화면·도메인과 무관한 공용 도구만 둔다. 여기서 다른 모듈을 import 하지
   않는 것이 규칙 — 그래야 순환 참조가 구조적으로 불가능해진다.
============================================================== */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const pad = n => String(n).padStart(2, "0");
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const isNum = v => typeof v === "number" && Number.isFinite(v);

const DOW  = ["일","월","화","수","목","금","토"];
const DIRS = ["북","북북동","북동","동북동","동","동남동","남동","남남동",
              "남","남남서","남서","서남서","서","서북서","북서","북북서"];
const dirName = d => DIRS[Math.round((((d % 360) + 360) % 360) / 22.5) % 16];

const ymd = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());

/** 한국 시간(KST) 기준 '지금'을 로컬 Date 필드에 담아 반환 */
function nowKST(){
  const p = {};
  new Intl.DateTimeFormat("en-CA", {
    timeZone:"Asia/Seoul", year:"numeric", month:"2-digit", day:"2-digit",
    hour:"2-digit", minute:"2-digit", hour12:false
  }).formatToParts(new Date()).forEach(x => { p[x.type] = x.value; });
  const hh = +p.hour === 24 ? 0 : +p.hour;
  return new Date(+p.year, +p.month - 1, +p.day, hh, +p.minute);
}

/** 구간 선형 보간 점수 */
function curve(v, pts){
  if (!isNum(v)) return 0;
  if (v <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++){
    const x0 = pts[i-1][0], y0 = pts[i-1][1], x1 = pts[i][0], y1 = pts[i][1];
    if (v <= x1) return y0 + (y1 - y0) * (v - x0) / (x1 - x0);
  }
  return pts[pts.length - 1][1];
}


/* 라우터가 화면을 갈아끼우는 컨테이너. 모듈 스크립트는 defer 라 이 시점에
   이미 DOM 이 파싱돼 있어 여기서 바로 잡아둬도 안전하다. */
const app = $("#app");
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));

/** ISO 문자열 → "3분 전"/"2시간 전"/"어제"/"3일 전" 같은 상대 시각 */
function relTime(iso){
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const min = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (min < 1) return "방금 전";
  if (min < 60) return min + "분 전";
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + "시간 전";
  const day = Math.floor(hr / 24);
  if (day === 1) return "어제";
  if (day < 7) return day + "일 전";
  const d = new Date(t);
  return (d.getMonth() + 1) + "월 " + d.getDate() + "일";
}

export { $, $$, pad, clamp, isNum, DOW, DIRS, dirName, ymd, nowKST, curve, app, esc, relTime };
