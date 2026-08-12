CREATE TABLE IF NOT EXISTS integration_settings (
    name text PRIMARY KEY CHECK (name IN ('external_image_host','nas_backup')),
    config jsonb NOT NULL DEFAULT '{}',
    secret_encrypted text,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    last_test_status text NOT NULL DEFAULT 'untested',
    last_test_message text NOT NULL DEFAULT '',
    last_tested_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS integration_settings_updated_idx
    ON integration_settings(updated_at DESC);
