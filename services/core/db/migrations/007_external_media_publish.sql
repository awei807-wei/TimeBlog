ALTER TABLE media ADD COLUMN IF NOT EXISTS external_publish_status text NOT NULL DEFAULT 'not_requested';
ALTER TABLE media ADD COLUMN IF NOT EXISTS external_publish_error text;
ALTER TABLE media ADD COLUMN IF NOT EXISTS external_published_at timestamptz;
ALTER TABLE media ADD COLUMN IF NOT EXISTS external_config_revision bigint;

ALTER TABLE media DROP CONSTRAINT IF EXISTS media_external_publish_status_check;
ALTER TABLE media ADD CONSTRAINT media_external_publish_status_check
    CHECK (external_publish_status IN ('not_requested','pending','publishing','published','failed','trash_pending'));

CREATE INDEX IF NOT EXISTS media_external_publish_idx
    ON media(external_publish_status, created_at DESC)
    WHERE external_publish_status <> 'not_requested';

CREATE UNIQUE INDEX IF NOT EXISTS jobs_publish_media_active_uq
    ON jobs ((payload->>'mediaId'), (payload->>'configRevision'))
    WHERE type='publish_media' AND status IN ('queued','running');
