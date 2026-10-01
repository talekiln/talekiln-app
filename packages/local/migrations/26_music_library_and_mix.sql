-- F05: music library (user-imported files + self-generated placeholders) and per-timeline mix settings.
CREATE TABLE IF NOT EXISTS music_library (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','builtin')),
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

ALTER TABLE timelines ADD COLUMN settings TEXT;
