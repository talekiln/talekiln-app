-- P3-P 插件适配器：已安装的厂商插件（清单、签名状态、权限、开关）。插件代码本身放在 <数据目录>/plugins/<name>/。
CREATE TABLE IF NOT EXISTS installed_plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  dir TEXT NOT NULL,
  manifest TEXT NOT NULL,
  signature_status TEXT NOT NULL DEFAULT 'unsigned',
  signature_kid TEXT,
  signature_hash TEXT,
  permissions TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  reviewed_at TEXT,
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
