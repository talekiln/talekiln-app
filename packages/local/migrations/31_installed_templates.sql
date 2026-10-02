-- P3-T 模板市场：已安装的模板包（内置 / 云端 / 本地导入）。manifest 原样存 JSON；内置模板启动时按磁盘内容重写。
CREATE TABLE IF NOT EXISTS installed_templates (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'local',
  version TEXT NOT NULL,
  manifest TEXT NOT NULL,
  signature_status TEXT NOT NULL DEFAULT 'unsigned',
  installed_at TEXT NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_installed_templates_source ON installed_templates(source);
