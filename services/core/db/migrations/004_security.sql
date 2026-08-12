CREATE TABLE IF NOT EXISTS login_attempts (
    account_hash text NOT NULL,
    ip_hash text NOT NULL,
    stage text NOT NULL CHECK (stage IN ('password','totp','recovery')),
    failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
    blocked_until timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_hash, ip_hash, stage)
);
CREATE INDEX IF NOT EXISTS login_attempts_blocked_idx ON login_attempts(blocked_until);

CREATE TABLE IF NOT EXISTS account_recovery_keys (
    id uuid PRIMARY KEY,
    key_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS account_recovery_keys_active_uq
    ON account_recovery_keys ((used_at IS NULL)) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS account_recovery_keys_expiry_idx
    ON account_recovery_keys(expires_at);

CREATE TABLE IF NOT EXISTS account_recovery_audit (
    id bigserial PRIMARY KEY,
    key_id uuid REFERENCES account_recovery_keys(id) ON DELETE SET NULL,
    account_hash text NOT NULL,
    ip_hash text NOT NULL,
    success boolean NOT NULL,
    event text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_recovery_audit_created_idx
    ON account_recovery_audit(created_at DESC);

ALTER TABLE media DROP CONSTRAINT IF EXISTS media_visibility_check;
ALTER TABLE media ADD CONSTRAINT media_visibility_check CHECK (visibility IN ('public','private'));
