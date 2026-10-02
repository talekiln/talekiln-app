-- P3-S 工作室版基础：本机已发布 / 已拉取的共享条目及版本（docs/phase3-studio.md）。
-- 共享素材本身在对象存储 <prefix>/shared/<studio_id>/{characters,templates}/<shared_id>/ 下（manifest.json + 文件）；
-- 这张表只记「本机把哪个角色 / 模板发成了哪个共享条目的第几版」和「拉取了哪个共享条目的第几版到本机哪个角色 / 模板」，
-- 用来显示「我发布的」「可更新」，以及更新时覆盖同一个本机角色而不是再建一个。
-- kind 取值 character | template；direction 取值 published | pulled。
CREATE TABLE IF NOT EXISTS studio_shared_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  studio_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  shared_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  local_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  sha256 TEXT,
  manifest_key TEXT,
  title TEXT,
  author TEXT,
  remote_updated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(studio_id, kind, shared_id, direction)
);

CREATE INDEX IF NOT EXISTS idx_studio_shared_items_studio ON studio_shared_items(studio_id, kind);
CREATE INDEX IF NOT EXISTS idx_studio_shared_items_local ON studio_shared_items(kind, local_id);
