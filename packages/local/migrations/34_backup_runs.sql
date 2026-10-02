-- P3-K 可选云备份：每次备份 / 恢复的本地记录。快照本身（zip + json 清单）在 S3 兼容对象存储里，
-- 这张表是离线时的快照清单兜底，也是「运行历史」的数据源（docs/phase3-backup.md）。
-- kind 取值 backup | restore；status 取值 queued | running | done | failed；trigger 取值 manual | daily | after_export。
CREATE TABLE IF NOT EXISTS backup_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drama_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'backup',
  trigger TEXT NOT NULL DEFAULT 'manual',
  title TEXT,
  key TEXT,
  size INTEGER,
  sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  started_at TEXT,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_backup_runs_drama ON backup_runs(drama_id, id);
CREATE INDEX IF NOT EXISTS idx_backup_runs_key ON backup_runs(key);
