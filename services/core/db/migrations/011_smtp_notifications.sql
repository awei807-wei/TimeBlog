ALTER TABLE integration_settings DROP CONSTRAINT IF EXISTS integration_settings_name_check;
ALTER TABLE integration_settings ADD CONSTRAINT integration_settings_name_check CHECK (name IN ('external_image_host','nas_backup','smtp_relay'));

CREATE TABLE IF NOT EXISTS digital_asset_notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id uuid NOT NULL CONSTRAINT digital_asset_notifications_asset_id_fkey REFERENCES digital_assets(id) ON DELETE CASCADE,
    notice_stage integer NOT NULL,
    target_date date NOT NULL,
    recipient text NOT NULL,
    sent_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_digital_asset_notification_stage UNIQUE (asset_id, notice_stage, target_date)
);

CREATE INDEX IF NOT EXISTS digital_asset_notifications_asset_idx
    ON digital_asset_notifications(asset_id, sent_at DESC);