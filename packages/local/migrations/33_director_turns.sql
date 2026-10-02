-- 导演模式（P3-D）：每次自然语言指令 -> 执行计划 -> 校验 / 干跑结果 -> 影响范围与估价，执行后记下内核事务 id，可整体撤销。
-- plan / validation / impact / cost_estimate 为 JSON 文本；status 取值 planned | rejected | applied | undone。
CREATE TABLE IF NOT EXISTS director_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL,
  message TEXT NOT NULL,
  plan TEXT,
  validation TEXT,
  impact TEXT,
  cost_estimate TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  tx_id TEXT,
  created_at TEXT NOT NULL,
  applied_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_director_turns_episode ON director_turns(episode_id, id);
