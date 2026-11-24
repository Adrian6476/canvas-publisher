CREATE TABLE canvases (
  id TEXT PRIMARY KEY,
  latest_revision INTEGER NOT NULL CHECK (latest_revision >= 1),
  published_revision INTEGER,
  created_by TEXT NOT NULL,
  create_key TEXT,
  UNIQUE (created_by, create_key)
) STRICT;

CREATE TABLE revisions (
  canvas_id TEXT NOT NULL REFERENCES canvases(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  title TEXT NOT NULL,
  html TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (canvas_id, revision)
) STRICT;
