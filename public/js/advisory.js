import { esc } from "./util.js";

/* ============================ 입수 가능 여부 (기상청 풍랑특보) ============================
   /api/advisory 는 Cloudflare Worker 가 공공데이터포털 기상특보 조회서비스를 대리 호출해
   돌려준다(src/worker.js). 서비스 인증키가 아직 없으면 ready:false 가 오고, 그 상태를
   그대로 "연동 준비 중" 배너로 보여준다 — 인증키가 들어오는 순간 코드 변경 없이 실데이터로
   전환된다.

   중요: 이 값은 "지금 이 순간" 발효 중인 특보다. 기상청은 미래 특정 날짜에 특보가 내려질지
   미리 알려주는 구조화된 예보 데이터를 제공하지 않는다. 그래서 이 배너는 날짜 칩 선택과
   무관하게 항상 현재 시각 기준으로만 표시된다.
================================================================================ */
const ADVISORY_INFO = {
  0: { label: "평소",      detail: "입수 가능",                icon: "✅" },
  1: { label: "풍랑주의보", detail: "신고서 작성 후 입수 가능",   icon: "⚠️" },
  2: { label: "풍랑경보",   detail: "입수 불가",                icon: "⛔" }
};
const KMA_LINK = "https://www.weather.go.kr/w/ocean/warning.do";

// 풍랑ㆍ호우ㆍ대설ㆍ강풍 "주의보"가 발효된 해역에서 파도·바람만으로 움직이는 수상레저기구
// (서프보드 포함, 무동력)로 활동하려면 해양경찰청에 신고해야 한다 — 확인된 근거:
// https://boat.kcg.go.kr/home/wtrlsrActInfo/weathrSpcnwsDclr/infoView1.do
// "경보" 단계는 이 신고 대상이 아니라 애초에 입수 자체가 금지라, 링크는 주의보(level 1)
// 에서만 보여준다. 이 페이지는 신고서 자체가 아니라 해양경찰청 실명인증 로그인 이후
// 신고로 이어지는 안내 페이지다 — 눌렀을 때 로그인 화면이 나오는 게 정상이다.
const REPORT_LINK = "https://boat.kcg.go.kr/home/wtrlsrActInfo/weathrSpcnwsDclr/infoView1.do";

function renderAdvisoryBanner(advisory, spotId){
  if (!advisory || !advisory.ready){
    return '<div class="advisory adv-pending"><div class="advisory-top">' +
      '<span class="adv-ic" aria-hidden="true">🕓</span>' +
      '<div class="adv-main">' +
        '<div class="adv-label">풍랑특보 연동 준비 중</div>' +
        '<div class="adv-detail">기상청 공식 연동 전입니다 · 출항·입수 전 직접 확인하세요</div>' +
      '</div>' +
      '<span class="adv-note"><a href="' + KMA_LINK + '" target="_blank" rel="noopener">기상청 해상특보 바로가기</a></span>' +
    '</div></div>';
  }
  const s = advisory.spots && advisory.spots[spotId];
  const lvl = s ? s.level : 0;
  const info = ADVISORY_INFO[lvl] || ADVISORY_INFO[0];
  // 주의보일 때만: 신고 대상이 바로 이 단계이기 때문. 경보는 신고가 아니라 입수 자체가
  // 금지라 이 버튼을 보여줄 이유가 없다.
  const cta = lvl === 1
    ? '<div class="adv-cta-row">' +
        '<a class="adv-cta" href="' + REPORT_LINK + '" target="_blank" rel="noopener">' +
          '📝 수상레저활동 신고하러 가기 →</a>' +
        '<span class="adv-cta-hint">해양경찰청 실명인증 로그인이 필요합니다</span>' +
      '</div>'
    : '';
  return '<div class="advisory adv-' + lvl + '"><div class="advisory-top">' +
    '<span class="adv-ic" aria-hidden="true">' + info.icon + '</span>' +
    '<div class="adv-main">' +
      '<div class="adv-label">' + info.label + '</div>' +
      '<div class="adv-detail">' + info.detail + (s && s.zone ? " · " + esc(s.zone) : "") + '</div>' +
    '</div>' +
    '<span class="adv-note">지금 기준 · <a href="' + KMA_LINK + '" target="_blank" rel="noopener">기상청 확인</a></span>' +
  '</div>' + cta + '</div>';
}

export { renderAdvisoryBanner };
