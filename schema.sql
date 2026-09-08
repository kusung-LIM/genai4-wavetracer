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
--
-- 과거 날짜를 지우지 않는다(예전엔 매 실행 후 지웠다). GPS 세션 기록이 "그날
-- 그 시간 컨디션"과 세션을 대조하려면 이 이력이 있어야 한다 — 한번 지우면
-- 그 시점 데이터는 다시 만들 수 없다. 지워도 하루 쓰기량은 그대로라(91행 갱신은
-- 보존 여부와 무관) 안 지우는 쪽의 비용은 저장 공간뿐이고, 그마저 스팟당 하루
-- 1행(1KB 안팎)만 늘어 연간 5MB 수준이다(자세한 계산은 src/worker.js 의
-- refreshConditions 주석 참고). 미래 예보만 필요한 조회(/api/forecast)는
-- 워커에서 date >= 오늘 로 걸러 읽는다.
CREATE TABLE IF NOT EXISTS spot_daily (
  spot_id TEXT NOT NULL,
  date TEXT NOT NULL,
  hourly TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (spot_id, date)
);

-- GPS 세션 기록(docs/gps-tracker-plan.md 참고). 계정이 없다 — Strava 로그인은
-- 한국에서 신규 앱 설치 자체가 막혀 있어(2025년 3월부터) 포기했고, 대신
-- device_token(클라이언트가 crypto.randomUUID() 로 만들어 localStorage 에 두는
-- 임의 문자열)으로 소유권만 식별한다. 실명·이메일 등 실제 신원은 아예 안 받는다.
--
-- 트랙 좌표(track 컬럼)는 원래 R2에 두려 했는데, R2는 대시보드에서 수동으로
-- 한 번 활성화해야 API 로 쓸 수 있다(이 계정은 아직 안 돼 있음). 실제 세션
-- 크기가 생각보다 작아서(1Hz 90분 세션도 ~200KB) 그냥 D1 TEXT 컬럼에 넣기로
-- 했다 — spot_daily.hourly 와 같은 자리 기반 JSON 배열 패턴이다. 트래픽이
-- 커지면 그때 R2로 옮기면 되는데, API 계약(엔드포인트 모양)은 안 바뀐다.
--
-- track 형식: [[위도, 경도, 고도, 시작 후 경과초, 심박(없으면 null)], ...]
-- 절대시각이 아니라 "시작 후 경과초"를 쓴다 — started_at 이 이미 시작 시각을
-- 갖고 있어 반복될 필요가 없고, 숫자가 짧아 저장 공간도 아낀다.
--
-- wave_count·longest_ride_m 은 지금(Phase 2)은 NULL 이다. 파도 감지 알고리즘은
-- Phase 3 몫이라, 아직 없는 기능을 있는 척 숫자로 채우지 않는다.
--
-- 레이트리밋은 파도 제보(reports)와 같은 패턴이다 — 별도 로그 테이블 없이 이
-- 테이블 자체에 ip_hash 를 두고 "최근 N분 내 같은 해시의 행 수"로 판단한다.
-- 세션은 reports 처럼 그 자체가 보존할 콘텐츠라, 안전 Q&A(safety_asks)처럼
-- 카운터 전용 테이블을 따로 둘 이유가 없다.
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_token TEXT NOT NULL,
  spot_id TEXT,                          -- 13개 스팟에서 3km 이내로 못 찾으면 NULL
  source TEXT NOT NULL DEFAULT 'upload', -- 지금은 'upload' 뿐. 'strava' 는 보류된 자리만 남겨둠
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  duration_sec INTEGER NOT NULL,
  distance_m REAL NOT NULL,
  point_count INTEGER NOT NULL,
  wave_count INTEGER,
  longest_ride_m REAL,
  visibility TEXT NOT NULL DEFAULT 'private',
  track TEXT NOT NULL,
  ip_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions(device_token, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_ip_time ON sessions(ip_hash, created_at);
