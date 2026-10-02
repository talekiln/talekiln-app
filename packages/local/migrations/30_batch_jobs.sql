-- P3-B 批量生成：一次排多集，按服务商并发上限与总预算上限调度（docs/phase3-batch.md）。
-- 金额一律以分（cents）存整数；json 列存文本。
CREATE TABLE IF NOT EXISTS batch_jobs (
  id TEXT PRIMARY KEY,
  drama_id INTEGER NOT NULL,
  episode_ids TEXT NOT NULL DEFAULT '[]',
  kinds TEXT NOT NULL DEFAULT '["image","video"]',
  concurrency TEXT NOT NULL DEFAULT '{}',
  budget_cap_cents INTEGER,
  failure_policy TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','paused','completed','failed','cancelled')),
  totals TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_batch_jobs_drama ON batch_jobs(drama_id, created_at);
CREATE INDEX IF NOT EXISTS idx_batch_jobs_status ON batch_jobs(status, created_at);

CREATE TABLE IF NOT EXISTS batch_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  episode_id INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed','cancelled')),
  task_ids TEXT NOT NULL DEFAULT '[]',
  prior_task_ids TEXT NOT NULL DEFAULT '[]',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  plan TEXT,
  cursor INTEGER NOT NULL DEFAULT 0,
  retries TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (batch_id, episode_id)
);
CREATE INDEX IF NOT EXISTS idx_batch_items_batch ON batch_items(batch_id, position);
