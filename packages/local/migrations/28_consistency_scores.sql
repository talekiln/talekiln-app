-- P3-C 角色一致性：生成结果（首帧图 / 视频版本）对镜头里每张锁定参考图（场景 / 角色）的评分，一行一个 版本 × 参考实体。
CREATE TABLE IF NOT EXISTS consistency_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  score REAL NOT NULL,
  parts TEXT,
  suggestion TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_consistency_scores_unique ON consistency_scores(episode_id, node_id, version_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_consistency_scores_episode ON consistency_scores(episode_id, node_id);
