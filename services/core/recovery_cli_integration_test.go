package main

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"
)

type recoveryAuthState struct {
	passwordHash string
	totpCipher   string
	sessionHash  string
	sessionCount int
}

func TestRecoveryKeyRotationPostgres(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "integration-password")
	t.Setenv("ADMIN_TOTP_SECRET", "JBSWY3DPEHPK3PXP")
	t.Setenv("TOTP_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	t.Setenv("CONFIG_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	t.Setenv("ACCOUNT_RECOVERY_KEY_BOOTSTRAP", "integration-recovery-key-very-long")
	db := openDatabaseIntegration(t)
	ctx := context.Background()

	var originalID, originalHash string
	var originalExpires time.Time
	if err := db.QueryRowContext(ctx, `SELECT id::text,key_hash,expires_at
		FROM account_recovery_keys WHERE used_at IS NULL ORDER BY created_at DESC LIMIT 1`).Scan(&originalID, &originalHash, &originalExpires); err != nil {
		t.Fatal(err)
	}
	secret := "integration-rotated-recovery-key"
	newHash, err := hashPassword(secret)
	if err != nil {
		t.Fatal(err)
	}
	registerRecoveryRotationCleanup(t, db, originalID, originalHash, originalExpires, newHash)
	authBefore := readRecoveryAuthState(t, ctx, db)

	// Reproduce the production lockout state: the unique-index occupant is
	// unused but expired. Rotation must invalidate it before inserting.
	if _, err := db.ExecContext(ctx, `UPDATE account_recovery_keys SET expires_at=now()-interval '1 day' WHERE id=$1::uuid`, originalID); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(trustedRecoveryOutputDir(t), "recovery-key")
	store := &sqlRecoveryKeyRotationStore{db: db}
	if err := rotateRecoveryKeyWith(
		ctx, store, output,
		func() (string, error) { return secret, nil },
		func(string) (string, error) { return newHash, nil },
	); err != nil {
		t.Fatal(err)
	}

	newID := assertRotatedRecoveryKey(t, ctx, db, originalID, secret, newHash)
	var auditCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM account_recovery_audit
		WHERE key_id=$1::uuid AND success=true AND event='recovery_key_rotated'`, newID).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if auditCount != 1 {
		t.Fatalf("rotation audit count=%d want=1", auditCount)
	}
	if authAfter := readRecoveryAuthState(t, ctx, db); authAfter != authBefore {
		t.Fatal("recovery key rotation changed owner credentials, TOTP ciphertext, or sessions")
	}
}

func assertRotatedRecoveryKey(
	t *testing.T,
	ctx context.Context,
	db *sql.DB,
	originalID, secret, newHash string,
) string {
	t.Helper()
	var newID, storedHash string
	var expires time.Time
	if err := db.QueryRowContext(ctx, `SELECT id::text,key_hash,expires_at FROM account_recovery_keys
		WHERE used_at IS NULL AND expires_at>now()`).Scan(&newID, &storedHash, &expires); err != nil {
		t.Fatal(err)
	}
	if storedHash != newHash || !verifyPassword(secret, storedHash) {
		t.Fatal("rotated recovery key hash does not verify")
	}
	if time.Until(expires) < 89*24*time.Hour || time.Until(expires) > 91*24*time.Hour {
		t.Fatalf("rotated recovery key expiry=%s", expires)
	}
	var originalUsedAt sql.NullTime
	if err := db.QueryRowContext(ctx, `SELECT used_at FROM account_recovery_keys WHERE id=$1::uuid`, originalID).Scan(&originalUsedAt); err != nil {
		t.Fatal(err)
	}
	if !originalUsedAt.Valid {
		t.Fatal("expired unused recovery key was not invalidated")
	}
	return newID
}

func readRecoveryAuthState(t *testing.T, ctx context.Context, db *sql.DB) recoveryAuthState {
	t.Helper()
	var state recoveryAuthState
	err := db.QueryRowContext(ctx, `SELECT password_hash,totp_secret_encrypted,
		(SELECT md5(COALESCE(string_agg(row_to_json(s)::text,'' ORDER BY s.id),'')) FROM sessions s),
		(SELECT count(*) FROM sessions)
		FROM users WHERE username='owner'`).Scan(
		&state.passwordHash,
		&state.totpCipher,
		&state.sessionHash,
		&state.sessionCount,
	)
	if err != nil {
		t.Fatal(err)
	}
	return state
}

func registerRecoveryRotationCleanup(
	t *testing.T,
	db *sql.DB,
	originalID, originalHash string,
	originalExpires time.Time,
	newHash string,
) {
	t.Helper()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Errorf("begin recovery rotation cleanup: %v", err)
			return
		}
		if _, err = tx.ExecContext(ctx, `DELETE FROM account_recovery_audit
			WHERE key_id IN (SELECT id FROM account_recovery_keys WHERE key_hash=$1)`, newHash); err == nil {
			_, err = tx.ExecContext(ctx, `DELETE FROM account_recovery_keys WHERE key_hash=$1`, newHash)
		}
		if err == nil {
			_, err = tx.ExecContext(ctx, `UPDATE account_recovery_keys
				SET key_hash=$1,expires_at=$2,used_at=NULL WHERE id=$3::uuid`, originalHash, originalExpires, originalID)
		}
		if err != nil {
			_ = tx.Rollback()
			t.Errorf("restore recovery key fixture: %v", err)
			return
		}
		if err = tx.Commit(); err != nil {
			t.Errorf("commit recovery rotation cleanup: %v", err)
		}
	})
}
