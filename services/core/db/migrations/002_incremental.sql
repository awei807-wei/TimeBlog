ALTER TABLE entries ADD COLUMN IF NOT EXISTS previous_status text;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS previous_visibility text;
CREATE TABLE IF NOT EXISTS exports (id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), export_type text NOT NULL CHECK (export_type IN ('public','full')), status text NOT NULL CHECK (status IN ('queued','running','ready','failed')), storage_path text, sha256 text, error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS exports_owner_idx ON exports(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS media_uploading_idx ON media(status, created_at);
