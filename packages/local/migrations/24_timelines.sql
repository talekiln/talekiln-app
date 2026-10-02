-- Four-track timeline model (F02): timelines, tracks, clips. Times are integer milliseconds.
CREATE TABLE IF NOT EXISTS timelines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS timeline_tracks (
  id TEXT PRIMARY KEY,
  timeline_id INTEGER NOT NULL REFERENCES timelines(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('video','subtitle','narration','music')),
  name TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  volume REAL NOT NULL DEFAULT 1,
  muted INTEGER NOT NULL DEFAULT 0,
  UNIQUE (timeline_id, kind)
);

CREATE TABLE IF NOT EXISTS timeline_clips (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES timeline_tracks(id) ON DELETE CASCADE,
  timeline_id INTEGER NOT NULL REFERENCES timelines(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  start_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  src_in_ms INTEGER,
  src_out_ms INTEGER,
  asset_ref TEXT,
  asset_kind TEXT,
  storyboard_id INTEGER,
  volume REAL NOT NULL DEFAULT 1,
  text TEXT,
  style TEXT
);

CREATE INDEX IF NOT EXISTS idx_timeline_clips_track ON timeline_clips(track_id, start_ms);
CREATE INDEX IF NOT EXISTS idx_timeline_clips_timeline ON timeline_clips(timeline_id);
