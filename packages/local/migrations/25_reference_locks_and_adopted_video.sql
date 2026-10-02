-- P1-07 locked character/scene reference images, and P1-08 adopted candidate video per shot.
CREATE TABLE IF NOT EXISTS reference_locks (
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  image_url TEXT,
  local_path TEXT,
  source_image_id INTEGER,
  locked_at TEXT,
  PRIMARY KEY (entity_type, entity_id)
);
ALTER TABLE storyboards ADD COLUMN adopted_video_id INTEGER;
