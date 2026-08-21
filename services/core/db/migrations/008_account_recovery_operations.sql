CREATE TABLE IF NOT EXISTS account_recovery_operations (
    operation_hash text PRIMARY KEY,
    payload_mac text NOT NULL,
    recovery_key_id uuid NOT NULL REFERENCES account_recovery_keys(id) ON DELETE CASCADE,
    completed_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS account_recovery_operations_expiry_idx
    ON account_recovery_operations(expires_at);
