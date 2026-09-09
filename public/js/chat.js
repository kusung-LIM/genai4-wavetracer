import { $, $$, esc, isNum } from "./util.js";
import { SPOTS } from "./spots.js";
import { LEVELS } from "./levels.js";
import { state } from "./state.js";
import { conditionToHour, expandDailyHours, summarize } from "./score.js";
import { loadConditions, loadDailyForecast } from "./api.js";

/* ============================ AI 챗봇 ============================
   /api/chat 이 안전 코퍼스(D1 FTS5)와 현재 컨디션을 근거로 붙여 답한다.

   점수는 클라이언트가 계산해서 보낸다 — 레벨별 점수 곡선을 프론트 한 곳에만
   두려는 기존 결정을 지키기 위해서다. 워커가 따로 채점하면 곡선이 두 벌이 되고,
   지도에 82점으로 뜨는 스팟을 챗봇이 다르게 말하는 사고가 난다.

   답변은 LLM 이 만든 문자열이라 신뢰할 수 없는 입력과 똑같이 다룬다 —
   화면에 넣기 전 반드시 esc() 를 거친다(프롬프트 인젝션으로 질문 속 HTML 이
   답변에 그대로 옮겨질 수 있다). */
const CHAT_CHIPS = [
  "오늘 어디가 제일 좋아?",
  "풍랑주의보 때 신고해야 하나요?",
  "이안류에 휘말리면 어떻게 해요?",
  "지금 수온에 웻수트 뭐 입어요?",
];
const chatState = { open: false, busy: false, history: [] };

/** 챗봇에 넘길 날짜별 점수표. 스팟 × 날짜마다 하루 평균 점수를 낸다. */
async function chatDailySnapshot(){
  try {
    const data = await loadDailyForecast();
    if (!data.ready || !data.days.length) return [];
    const out = [];
    for (const d of data.days){
      const spot = SPOTS.find(s => s.id === d.spotId);
      if (!spot || !Array.isArray(d.hourly)) continue;
      const sm = summarize(expandDailyHours(d.hourly, spot));
      if (!sm) continue;
      out.push({ id: spot.id, name: spot.name, date: d.date, score: sm.avg });
    }
    return out;
  } catch (_){ return []; }
}

/** 챗봇에 넘길 현재 컨디션 요약. 지도와 같은 /api/conditions 를 재사용하므로
    추가 요청이 없고, 지도에 보이는 점수와 챗봇이 말하는 점수가 항상 일치한다. */
async function chatSpotSnapshot(){
  try {
    const data = await loadConditions();
    if (!data.ready || !data.spots.length) return [];
    const byId = new Map(data.spots.map(r => [r.spotId, r]));
    return SPOTS.map(s => {
      const row = byId.get(s.id);
      if (!row) return null;
      const sc = conditionToHour(row, s).scores;
      return {
        id: s.id, name: s.name,
        score: sc ? sc[state.level] : null,
        waveH: isNum(row.waveH) ? row.waveH : null,
      };
    }).filter(Boolean);
  } catch (_){ return []; }
}

function chatBubble(role, html, extra){
  return '<div class="chat-msg ' + role + (extra ? " " + extra : "") + '">' + html + "</div>";
}

function renderChatSources(sources){
  if (!sources || !sources.length) return "";
  return '<div class="chat-src"><div class="chat-src-label">참고 자료</div>' +
    sources.map(s => s.sourceUrl
      ? '<a href="' + esc(s.sourceUrl) + '" target="_blank" rel="noopener">' + esc(s.title) + "</a>"
      : "<span>" + esc(s.title) + "</span>").join("") +
  "</div>";
}

function chatAppend(html){
  const log = $("#chat-log");
  log.insertAdjacentHTML("beforeend", html);
  log.scrollTop = log.scrollHeight;
}

function renderChatChips(){
  const el = $("#chat-chips");
  // 대화가 시작되면 추천 프롬프트는 감춘다 — 입력창 공간을 돌려준다.
  if (chatState.history.length){ el.innerHTML = ""; return; }
  el.innerHTML = CHAT_CHIPS.map(q =>
    '<button type="button" class="chat-chip" data-q="' + esc(q) + '">' + esc(q) + "</button>").join("");
  $$(".chat-chip").forEach(c => c.addEventListener("click", () => chatSend(c.dataset.q)));
}

async function chatSend(text){
  const q = (text || "").trim();
  if (!q || chatState.busy) return;
  if (q.length < 2) return;

  chatState.busy = true;
  $("#chat-send").disabled = true;
  $("#chat-input").value = "";
  chatState.history.push({ role: "user", content: q });
  chatAppend(chatBubble("me", esc(q)));
  renderChatChips();
  chatAppend('<div class="chat-msg bot" id="chat-pending">' +
    '<span class="chat-typing"><i></i><i></i><i></i></span></div>');

  try {
    const [spots, daily] = await Promise.all([chatSpotSnapshot(), chatDailySnapshot()]);
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: chatState.history.slice(-8),
        level: LEVELS[state.level].label,
        spots: spots,
        daily: daily,
      }),
    });
    const j = await res.json().catch(() => ({}));
    $("#chat-pending")?.remove();

    if (res.status === 200 && j && j.ready && j.answer){
      chatState.history.push({ role: "assistant", content: j.answer });
      chatAppend(chatBubble("bot", esc(j.answer) + renderChatSources(j.sources)));
    } else {
      const msg = (j && j.message) ||
        (j && j.ready === false ? "도우미가 아직 준비되지 않았습니다." : "답변을 가져오지 못했습니다.");
      chatAppend(chatBubble("bot", esc(msg), "err"));
    }
  } catch (_){
    $("#chat-pending")?.remove();
    chatAppend(chatBubble("bot", "네트워크 오류로 답변을 가져오지 못했습니다.", "err"));
  } finally {
    chatState.busy = false;
    $("#chat-send").disabled = false;
    $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
  }
}

/* 모바일에서 뒤로가기(제스처·하드웨어 버튼)로 챗봇이 닫히게 하려고 history 항목을
   하나 쌓는다. 이게 없으면 사용자가 본능적으로 누르는 뒤로가기가 앱 자체를
   떠나버린다 — 모바일에서 "빠져나오기 어렵다"는 느낌의 가장 큰 원인이었다.
   URL 은 그대로 두고 항목만 추가하므로 라우팅에는 영향이 없다. */
let chatPushedState = false;
let chatSuppressPop = false;

function openChat(){
  chatState.open = true;
  $("#chat").hidden = false;
  $("#chat-fab").classList.add("hidden");
  $("#chat-fab").setAttribute("aria-expanded", "true");
  if (!chatPushedState){
    history.pushState({ chat: true }, "", location.href);
    chatPushedState = true;
  }
  // 스크림은 모바일에서만 띄운다. 데스크톱 패널은 뒤 내용을 계속 봐야 하므로 없다.
  $("#chat-scrim").hidden = window.innerWidth > 720;
  if (!$("#chat-log").children.length){
    chatAppend(chatBubble("bot",
      "안녕하세요! 안전·규정이나 오늘 좋은 포인트를 물어보세요.<br>" +
      '<span class="dimc" style="font-size:11.5px">답변은 참고 정보입니다. 입수 전 기상청·해양경찰청 정보를 확인하세요.</span>'));
  }
  renderChatChips();
  $("#chat-input").focus();
}
/** fromPop: 뒤로가기로 들어온 경우. 그때는 이미 항목이 빠졌으므로 back() 을
    다시 부르면 안 된다(한 번 더 뒤로 가서 앱을 떠나버린다). */
function closeChat(fromPop){
  if (!chatState.open) return;
  chatState.open = false;
  $("#chat").hidden = true;
  $("#chat-scrim").hidden = true;
  $("#chat-fab").classList.remove("hidden");
  $("#chat-fab").setAttribute("aria-expanded", "false");
  $("#chat-fab").focus();

  if (chatPushedState && !fromPop){
    // ✕·스크림으로 닫을 때도 쌓아둔 항목을 되돌려 히스토리를 깨끗하게 유지한다.
    chatPushedState = false;
    chatSuppressPop = true;
    history.back();
  } else {
    chatPushedState = false;
  }
}

function initChat(){
  $("#chat-fab").addEventListener("click", openChat);
  // 닫는 길을 여러 개 둔다 — ✕, 시트 위 여백(스크림), 손잡이, ESC, 뒤로가기.
  $("#chat-close").addEventListener("click", () => closeChat());
  $("#chat-scrim").addEventListener("click", () => closeChat());
  $("#chat-grab").addEventListener("click", () => closeChat());
  $("#chat-form").addEventListener("submit", e => {
    e.preventDefault();
    chatSend($("#chat-input").value);
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && chatState.open) closeChat();
  });
  // 데스크톱↔모바일 폭이 바뀌면 스크림 필요 여부도 바뀐다.
  window.addEventListener("resize", () => {
    if (chatState.open) $("#chat-scrim").hidden = window.innerWidth > 720;
  });
}

/** 뒤로가기를 챗봇이 소비했는지 라우터에 알려준다. 판단에 필요한 상태
    (chatSuppressPop·chatState)를 라우터와 공유하지 않으려고, 판단 자체를
    이 모듈 안에 두고 결과만 넘긴다. */
function chatConsumePopState(){
  // 챗봇이 쌓아둔 항목을 우리가 back() 으로 되돌린 경우 — 이미 닫았으니 무시한다.
  if (chatSuppressPop){ chatSuppressPop = false; return true; }
  // 모바일 뒤로가기는 화면 이동이 아니라 "챗봇 닫기"로 먼저 소비한다.
  if (chatState.open){ closeChat(true); return true; }
  return false;
}

export { initChat, chatConsumePopState };
