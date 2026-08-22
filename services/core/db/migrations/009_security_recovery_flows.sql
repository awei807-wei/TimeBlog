-- Recovery challenges remain short-lived and single-purpose. Existing rows
-- are login challenges; new rows may be used for TOTP password recovery.
ALTER TABLE mfa_challenges
    ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'login';

ALTER TABLE mfa_challenges
    DROP CONSTRAINT IF EXISTS mfa_challenges_purpose_check;

ALTER TABLE mfa_challenges
    ADD CONSTRAINT mfa_challenges_purpose_check
    CHECK (purpose IN ('login', 'password_reset'));

CREATE INDEX IF NOT EXISTS mfa_challenges_purpose_expiry_idx
    ON mfa_challenges(purpose, expires_at);

-- The last accepted TOTP time step is used only by high-risk account
-- operations. Keeping it in a side table leaves the existing users model
-- unchanged and lets login challenges retain their existing semantics.
CREATE TABLE IF NOT EXISTS totp_replay_guards (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    last_used_step bigint NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Operation records make a committed password reset or recovery-key rotation
-- safely retryable after an ambiguous HTTP response. Plaintext credentials are
-- never stored here; payload_mac is derived from the configured operation key.
CREATE TABLE IF NOT EXISTS auth_operation_idempotency (
    operation_hash text PRIMARY KEY,
    purpose text NOT NULL CHECK (purpose IN ('totp_password_reset', 'recovery_key_rotation')),
    payload_mac text NOT NULL,
    recovery_key_id uuid REFERENCES account_recovery_keys(id) ON DELETE SET NULL,
    completed_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_operation_idempotency_expiry_idx
    ON auth_operation_idempotency(expires_at);
