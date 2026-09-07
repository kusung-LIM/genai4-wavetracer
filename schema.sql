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

-- 안전·규정 Q&A(/api/safety) 코퍼스.
-- 벡터 임베딩 없이 D1 자체 FTS5 전문검색만 쓴다 — 문서가 15~30개 규모라 트라이그램
-- 토크나이저면 한국어 형태소 분석 없이도 충분히 매칭된다(코드코드는 최소 3글자
-- 연속 매치가 필요). 문서가 수백 개 이상으로 늘면 그때 임베딩 기반 검색으로
-- 옮기는 게 맞다.
CREATE TABLE IF NOT EXISTS safety_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  body TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_url TEXT,
  updated_at TEXT NOT NULL
);

-- external content 테이블 방식: 본문은 safety_docs 에만 두고, FTS5 는 색인만 가진다.
-- content_rowid 를 safety_docs.id(=rowid) 에 맞춰 트리거로 동기화한다.
CREATE VIRTUAL TABLE IF NOT EXISTS safety_docs_fts USING fts5(
  title, body,
  content='safety_docs', content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS safety_docs_ai AFTER INSERT ON safety_docs BEGIN
  INSERT INTO safety_docs_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS safety_docs_ad AFTER DELETE ON safety_docs BEGIN
  INSERT INTO safety_docs_fts(safety_docs_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS safety_docs_au AFTER UPDATE ON safety_docs BEGIN
  INSERT INTO safety_docs_fts(safety_docs_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO safety_docs_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

-- /api/safety 레이트리밋 전용 로그. reports.ip_hash 와 같은 이유로 원본 IP 는 두지
-- 않는다. 콘텐츠가 아니라 카운터라 오래된 행은 조회 시점에 그때그때 지운다
-- (src/worker.js 의 pruneSafetyAsks).
CREATE TABLE IF NOT EXISTS safety_asks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_safety_asks_hash_time ON safety_asks(ip_hash, created_at);

-- 홈 지도용 13개 스팟 현재 상황 스냅샷.
-- Cron(15분)이 Open-Meteo 에서 모아 여기에 덮어쓰고, 홈은 이 표만 읽는다.
-- 방문자마다 13개 스팟을 직접 부르면 요청이 26번씩 나가고 Open-Meteo 무료
-- 쿼터가 트래픽에 비례해 녹는데, 이렇게 두면 하루 192회로 고정된다.
--
-- 점수는 저장하지 않는다. 레벨별 점수 곡선은 프론트(public/index.html)에만
-- 두고 원시 관측값만 저장해서, 곡선을 손봐도 저장분을 다시 만들 필요가 없게 했다.
CREATE TABLE IF NOT EXISTS spot_conditions (
  spot_id TEXT PRIMARY KEY,
  observed_at TEXT NOT NULL,  -- 이 값이 대표하는 정시(KST)
  updated_at TEXT NOT NULL,   -- 수집한 시각
  wave_height REAL, wave_period REAL, wave_dir REAL,
  swell_height REAL, swell_period REAL, swell_dir REAL,
  wind_speed REAL, wind_dir REAL, sea_temp REAL
);

-- 챗봇이 미래 날짜("이번주 수요일 어디가 좋아?")에 답하려면 7일치가 필요하다.
-- 시간별로 한 행씩 넣으면 13스팟 × 168시간 = 2,184행이고, 15분마다 다시 쓰면
-- 하루 20만 행이라 D1 Free 한도(10만 행/일)를 넘긴다. 그래서 "스팟 × 날짜"로
-- 한 행만 두고 그날 24시간을 JSON 배열로 접어 넣는다 — 91행 × 96회 = 8,736행/일.
--
-- hourly 는 자리 기반 배열이라 키 이름이 반복되지 않는다:
--   [[시각, 파고, 주기, 너울고, 너울주기, 풍속, 풍향], ...]
-- 프론트가 이걸 펼쳐 기존 summarize() 를 그대로 돌리므로, 챗봇이 말하는 점수와
-- 예보 화면에 뜨는 점수가 같은 계산에서 나온다.
CREATE TABLE IF NOT EXISTS spot_daily (
  spot_id TEXT NOT NULL,
  date TEXT NOT NULL,
  hourly TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (spot_id, date)
);
