-- 파도 제보 게시판 스키마.
-- IF NOT EXISTS 로 멱등하게 작성 — 로컬/원격에 여러 번 적용해도 안전하다.
--
-- ip_hash: 원본 IP 는 저장하지 않는다(개인정보). 대신 "IP + 앱 salt" 를
-- SHA-256 해시한 값만 저장해 도배 방지(레이트리밋)에만 쓴다.
-- 자세한 트레이드오프 설명은 src/worker.js 참고.
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spot_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  rating INTEGER,
  wave_height REAL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ip_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC);
