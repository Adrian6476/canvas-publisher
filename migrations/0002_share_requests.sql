ALTER TABLE revisions ADD COLUMN share_request_id TEXT;
ALTER TABLE revisions ADD COLUMN share_request_hash TEXT;

CREATE UNIQUE INDEX revisions_share_request
ON revisions (created_by, share_request_id)
WHERE share_request_id IS NOT NULL;
