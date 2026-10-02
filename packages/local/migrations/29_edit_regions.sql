-- P3-R 选镜改片：一次“时间段 + 画面区域 + 一句话修改”的记录（docs/phase3-region-edit.md）。
-- 内核侧的事实是 video 节点的 edit 参数与结果版本；这张表只记流程状态（任务、策略、估价、结果版本 id）。
CREATE TABLE IF NOT EXISTS edit_regions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  base_version_id TEXT NOT NULL,
  t0_ms INTEGER NOT NULL,
  t1_ms INTEGER NOT NULL,
  rect TEXT NOT NULL,
  prompt TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'region',
  strategy TEXT NOT NULL,
  task_id TEXT,
  result_version_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  cost_estimate_cents INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_edit_regions_node ON edit_regions(episode_id, node_id, id);

CREATE INDEX IF NOT EXISTS idx_edit_regions_task ON edit_regions(task_id);
