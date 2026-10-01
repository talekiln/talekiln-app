-- 数据内核持久化：项目图快照 + 只追加的事务日志（docs/kernel-design.md §1、§6）。
CREATE TABLE IF NOT EXISTS project_graphs (
  episode_id INTEGER PRIMARY KEY,
  snapshot TEXT NOT NULL,
  snapshot_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_ops (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL,
  tx_id TEXT NOT NULL,
  tx TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (episode_id, tx_id)
);

CREATE INDEX IF NOT EXISTS idx_graph_ops_episode ON graph_ops(episode_id, seq);

-- 物化时给“图里新建、旧表还没有行”的镜头分配的 storyboards.id，撤销再重做时复用同一行。
CREATE TABLE IF NOT EXISTS graph_legacy_map (
  episode_id INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  storyboard_id INTEGER NOT NULL,
  PRIMARY KEY (episode_id, node_id)
);
