import { $, app, clamp, esc, isNum, relTime } from "./util.js";
import { SPOTS, spotNameOf } from "./spots.js";
import { isStale, lastSpotOrDefault, nextReqId } from "./state.js";
import { fetchReports } from "./api.js";

/* ============================ 파도 제보 게시판 ============================
   /api/reports 를 씀 — src/worker.js 가 D1(reports 테이블)에 저장/조회한다.
   D1 바인딩이 아직 없으면 advisory 와 같은 패턴으로 { ready:false } 가 오고,
   화면은 에러가 아니라 "첫 제보를 남겨보세요" 같은 친절한 빈 상태로 그린다.
============================================================================ */
const stars = n => isNum(n) ? "★".repeat(clamp(Math.round(n), 0, 5)) + "☆".repeat(5 - clamp(Math.round(n), 0, 5)) : "";
const excerpt = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

/* 홈의 "최근 파도 제보"와 /reports 목록이 같은 카드를 재사용한다.
   nickname/body 는 사용자 입력이라 반드시 esc() 를 거쳐 innerHTML 에 들어간다. */
function renderReportCard(r){
  return '<article class="report-card">' +
    '<div class="report-head">' +
      '<span class="badge spot-badge">' + esc(spotNameOf(r.spotId)) + '</span>' +
      '<span class="report-nick">' + esc(r.nickname) + '</span>' +
      '<span class="report-time dimc">' + esc(relTime(r.createdAt)) + '</span>' +
    '</div>' +
    (isNum(r.rating) ? '<div class="report-stars">' + stars(r.rating) + '</div>' : '') +
    '<p class="report-body">' + esc(excerpt(String(r.body), 100)) + '</p>' +
    (isNum(r.waveHeight) ? '<div class="report-wh muted">체감 파고 ' + r.waveHeight.toFixed(1) + ' m</div>' : '') +
  '</article>';
}

/** withLink: 홈 카드에서는 "제보하러 가기" 링크를 보여주고, /reports 자체에서는 생략 */
function reportsEmptyState(withLink){
  return '<div class="state">' +
    '<div style="font-size:26px;margin-bottom:8px" aria-hidden="true">🏄</div>' +
    '<div>아직 등록된 파도 제보가 없어요.</div>' +
    '<div class="dimc" style="margin-top:4px;font-size:12.5px">' +
      (withLink ? "가장 먼저 오늘의 파도를 알려주세요!" : "위 양식으로 가장 먼저 알려주세요!") +
    '</div>' +
    (withLink ? '<a href="/reports" data-nav class="retry" style="display:inline-block;text-decoration:none;margin-top:14px">제보하러 가기 →</a>' : '') +
  '</div>';
}

/* ============================ 파도제보 (/reports) ============================ */
function reportSpotOptions(selected){
  return SPOTS.map(s =>
    '<option value="' + s.id + '"' + (s.id === selected ? " selected" : "") + '>' + esc(s.name) + '</option>'
  ).join("");
}

function renderReportForm(){
  const lastSpot = lastSpotOrDefault().id;
  const ratingOpts = [5, 4, 3, 2, 1].map(n =>
    '<option value="' + n + '">' + "★".repeat(n) + "☆".repeat(5 - n) + '</option>').join("");
  return '<div class="card">' +
    '<h2>파도 제보 남기기</h2>' +
    '<div class="sub">방금 다녀온 포인트의 파도 상태를 알려주세요</div>' +
    '<form id="reportForm" class="rform" novalidate>' +
      '<div class="rf-row">' +
        '<label class="fld"><span>포인트</span><select id="rf-spot" required>' + reportSpotOptions(lastSpot) + '</select></label>' +
        '<label class="fld"><span>닉네임</span><input id="rf-nick" type="text" maxlength="20" placeholder="예: 죽도서퍼" required></label>' +
      '</div>' +
      '<div class="rf-row">' +
        '<label class="fld"><span>별점</span><select id="rf-rating"><option value="">선택 안 함</option>' + ratingOpts + '</select></label>' +
        '<label class="fld"><span>체감 파고(m)</span><input id="rf-wh" type="number" min="0" max="15" step="0.1" placeholder="예: 1.2"></label>' +
      '</div>' +
      '<div class="rf-textarea-wrap">' +
        '<span>내용</span>' +
        '<textarea id="rf-body" maxlength="500" rows="4" placeholder="파도 상태, 바람, 사람 많은지 등을 자유롭게 적어주세요" required></textarea>' +
      '</div>' +
      '<div class="rf-foot">' +
        '<span id="rf-count" class="dimc rf-count">0 / 500</span>' +
        '<button type="submit" id="rf-submit" class="rf-submit">제보 등록</button>' +
      '</div>' +
      '<div id="rf-msg" class="rf-msg" role="status" aria-live="polite"></div>' +
    '</form>' +
  '</div>';
}

/** 서버 검증 규칙을 그대로 거울처럼 복제 — 왕복 없이 바로 안내하기 위함.
    최종 판단은 항상 서버가 하므로(아래 fetch), 여기서 뚫려도 보안엔 영향 없다. */
function validateReportClient(p){
  if (!SPOTS.some(s => s.id === p.spotId)) return "포인트를 선택해주세요.";
  if (p.nickname.length < 1 || p.nickname.length > 20) return "닉네임은 1~20자로 입력해주세요.";
  if (p.body.length < 1 || p.body.length > 500) return "내용은 1~500자로 입력해주세요.";
  if (p.rating !== undefined && (!Number.isInteger(p.rating) || p.rating < 1 || p.rating > 5)) return "별점은 1~5 사이여야 합니다.";
  if (p.waveHeight !== undefined && (!isNum(p.waveHeight) || p.waveHeight < 0 || p.waveHeight > 15)) return "체감 파고는 0~15m 사이여야 합니다.";
  return null;
}

function prependReport(r){
  const list = $("#report-list");
  if (!list) return;
  let grid = list.querySelector(".report-list");
  if (!grid){ list.innerHTML = '<div class="report-list"></div>'; grid = list.querySelector(".report-list"); }
  grid.insertAdjacentHTML("afterbegin", renderReportCard(r));
}

function wireReportForm(){
  const form = $("#reportForm");
  const bodyEl = $("#rf-body"), counter = $("#rf-count");
  const updateCount = () => { counter.textContent = bodyEl.value.length + " / 500"; };
  bodyEl.addEventListener("input", updateCount);
  updateCount();

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const msg = $("#rf-msg");
    const submitBtn = $("#rf-submit");
    const ratingVal = $("#rf-rating").value;
    const whVal = $("#rf-wh").value;
    const payload = {
      spotId: $("#rf-spot").value,
      nickname: $("#rf-nick").value.trim(),
      body: $("#rf-body").value.trim(),
    };
    if (ratingVal !== "") payload.rating = +ratingVal;
    if (whVal !== "") payload.waveHeight = +whVal;

    const clientErr = validateReportClient(payload);
    if (clientErr){
      msg.textContent = clientErr;
      msg.className = "rf-msg rf-err";
      return;
    }

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="rf-spin"></span>등록 중…';
    msg.textContent = "";
    msg.className = "rf-msg";

    try {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 201 && j && j.report){
        prependReport(j.report);
        form.reset();
        updateCount();
        msg.textContent = "제보가 등록되었습니다. 감사합니다!";
        msg.className = "rf-msg rf-ok";
      } else if (res.status === 429){
        msg.textContent = (j && j.message) || "너무 많은 요청입니다. 잠시 후 다시 시도해주세요.";
        msg.className = "rf-msg rf-err";
      } else if (res.status === 503){
        msg.textContent = (j && j.message) || "현재 제보 기능을 사용할 수 없습니다. 잠시 후 다시 시도해주세요.";
        msg.className = "rf-msg rf-err";
      } else if (res.status === 400){
        msg.textContent = (j && j.message) || "입력값을 다시 확인해주세요.";
        msg.className = "rf-msg rf-err";
      } else {
        msg.textContent = "제보 등록에 실패했습니다. 잠시 후 다시 시도해주세요.";
        msg.className = "rf-msg rf-err";
      }
    } catch (e2){
      msg.textContent = "네트워크 오류로 제보를 등록하지 못했습니다.";
      msg.className = "rf-msg rf-err";
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "제보 등록";
    }
  });
}

async function renderReportsPage(){
  const my = nextReqId();
  app.innerHTML =
    renderReportForm() +
    '<div class="card">' +
      "<h2>최근 제보</h2>" +
      '<div class="sub">최신 30개</div>' +
      '<div id="report-list"><div class="state"><div class="spin"></div>제보를 불러오는 중…</div></div>' +
    "</div>";
  wireReportForm();

  try {
    const data = await fetchReports(30);
    if (isStale(my)) return;
    const list = $("#report-list");
    if (!data.ready || !data.reports.length) list.innerHTML = reportsEmptyState(false);
    else list.innerHTML = '<div class="report-list">' + data.reports.map(renderReportCard).join("") + '</div>';
  } catch (e){
    if (isStale(my)) return;
    $("#report-list").innerHTML = reportsEmptyState(false);
  }
}

export { renderReportCard, reportsEmptyState, renderReportsPage };
