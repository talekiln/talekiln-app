-- Durable AI task queue (E01). Idempotency key is unique, so one key never submits twice.
CREATE TABLE IF NOT EXISTS ai_tasks (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'generic',
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','submitting','submitted','polling','downloading','succeeded','failed','cancelled')),
  params TEXT,
  vendor_task_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  poll_attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  result TEXT,
  next_attempt_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  submit_started_at INTEGER,
  submitted_at INTEGER,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ai_tasks_state ON ai_tasks(state, provider);
