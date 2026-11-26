ALTER TABLE revisions ADD COLUMN presentation TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(presentation) AND json_type(presentation) = 'object');
