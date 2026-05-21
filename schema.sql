-- kahoot-cf D1 schema
-- Auth is Zero Trust Access — users are auto-provisioned by verified email.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS quizzes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_quizzes_owner ON quizzes(owner_id);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  quiz_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  options_json TEXT NOT NULL,
  correct_index INTEGER NOT NULL,
  time_limit_sec INTEGER NOT NULL DEFAULT 20,
  FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_questions_quiz ON questions(quiz_id, position);

CREATE TABLE IF NOT EXISTS game_history (
  id TEXT PRIMARY KEY,
  quiz_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  pin TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  total_players INTEGER DEFAULT 0,
  results_json TEXT,
  FOREIGN KEY (quiz_id) REFERENCES quizzes(id),
  FOREIGN KEY (host_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_history_host ON game_history(host_id, started_at DESC);
