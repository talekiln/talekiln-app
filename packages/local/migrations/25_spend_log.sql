-- D06 spend control: one row per finished task (UNIQUE task_id keeps recording idempotent).
CREATE TABLE IF NOT EXISTS spend_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'generic',
  model TEXT,
  project_id TEXT,
  currency TEXT NOT NULL DEFAULT 'CNY',
  estimated REAL NOT NULL DEFAULT 0,
  actual REAL,
  day TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spend_log_day ON spend_log(day);
CREATE INDEX IF NOT EXISTS idx_spend_log_provider ON spend_log(provider, day)
