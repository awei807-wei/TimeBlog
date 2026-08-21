package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestEnsureRecoveryKeyNeverReusesBootstrapAfterHistoryExists(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "integration-password")
	t.Setenv("ADMIN_TOTP_SECRET", "JBSWY3DPEHPK3PXP")
	t.Setenv("TOTP_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	t.Setenv("CONFIG_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	t.Setenv("ACCOUNT_RECOVERY_KEY_BOOTSTRAP", "integration-recovery-key-very-long")
	db := openDatabaseIntegration(t)
	ctx := context.Background()

	var originalID, originalHash string
	var originalExpiry time.Time
	if err := db.QueryRowContext(ctx, `SELECT id::text,key_hash,expires_at
		FROM account_recovery_keys
		WHERE used_at IS NULL AND expires_at>now()
		ORDER BY created_at DESC LIMIT 1`).Scan(&originalID, &originalHash, &originalExpiry); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		tx, err := db.BeginTx(cleanupCtx, nil)
		if err != nil {
			t.Errorf("begin recovery bootstrap cleanup: %v", err)
			return
		}
		defer tx.Rollback()
		if _, err = tx.ExecContext(cleanupCtx, `LOCK TABLE account_recovery_keys IN EXCLUSIVE MODE`); err == nil {
			_, err = tx.ExecContext(cleanupCtx, `DELETE FROM account_recovery_keys WHERE id<>$1::uuid AND used_at IS NULL`, originalID)
		}
		if err == nil {
			_, err = tx.ExecContext(cleanupCtx, `UPDATE account_recovery_keys
				SET key_hash=$2,expires_at=$3,used_at=NULL WHERE id=$1::uuid`, originalID, originalHash, originalExpiry)
		}
		if err == nil {
			err = tx.Commit()
		}
		if err != nil {
			t.Errorf("restore recovery bootstrap fixture: %v", err)
		}
	})

	if _, err := db.ExecContext(ctx, `UPDATE account_recovery_keys
		SET expires_at=now()-interval '1 hour' WHERE id=$1::uuid`, originalID); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ACCOUNT_RECOVERY_KEY_BOOTSTRAP", "")
	if err := ensureRecoveryKey(ctx, db); err == nil || !strings.Contains(err.Error(), "no active account recovery key") {
		t.Fatalf("ensure without bootstrap error=%v", err)
	}
	var oldUsedAt sql.NullTime
	if err := db.QueryRowContext(ctx, `SELECT used_at FROM account_recovery_keys WHERE id=$1::uuid`, originalID).Scan(&oldUsedAt); err != nil {
		t.Fatal(err)
	}
	if oldUsedAt.Valid {
		t.Fatal("expired recovery key was consumed without a bootstrap secret")
	}

	t.Setenv("ACCOUNT_RECOVERY_KEY_BOOTSTRAP", "replacement-bootstrap-recovery-key")
	if err := ensureRecoveryKey(ctx, db); err == nil || !strings.Contains(err.Error(), "recovery CLI") {
		t.Fatalf("historical bootstrap was unexpectedly accepted: %v", err)
	}
	var activeCount int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM account_recovery_keys
		WHERE used_at IS NULL AND expires_at>now()`).Scan(&activeCount); err != nil {
		t.Fatal(err)
	}
	if activeCount != 0 {
		t.Fatalf("active recovery keys=%d want=0", activeCount)
	}
	if err := db.QueryRowContext(ctx, `SELECT used_at FROM account_recovery_keys WHERE id=$1::uuid`, originalID).Scan(&oldUsedAt); err != nil {
		t.Fatal(err)
	}
	if oldUsedAt.Valid {
		t.Fatal("expired historical key was mutated while bootstrap was rejected")
	}
}

func TestPersistentRuntimeStatusUsesActiveRecoveryKeyState(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "integration-password")
	t.Setenv("ADMIN_TOTP_SECRET", "JBSWY3DPEHPK3PXP")
	t.Setenv("TOTP_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	t.Setenv("CONFIG_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	t.Setenv("ACCOUNT_RECOVERY_KEY_BOOTSTRAP", "integration-recovery-key-very-long")
	t.Setenv("MEDIA_ROOT", t.TempDir())
	db := openDatabaseIntegration(t)
	ctx := context.Background()

	var keyID, keyHash string
	var originalExpiry time.Time
	if err := db.QueryRowContext(ctx, `SELECT id::text,key_hash,expires_at FROM account_recovery_keys
		WHERE used_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1`).Scan(&keyID, &keyHash, &originalExpiry); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := db.ExecContext(context.Background(), `UPDATE account_recovery_keys SET expires_at=$2 WHERE id=$1::uuid`, keyID, originalExpiry); err != nil {
			t.Errorf("restore recovery key expiry: %v", err)
		}
	})

	status := func() (bool, string) {
		t.Helper()
		rr := httptest.NewRecorder()
		NewServer(NewPersistentStore(db)).runtimeStatus(rr, httptest.NewRequest(http.MethodGet, "/api/v1/admin/runtime-status", nil))
		if rr.Code != http.StatusOK {
			t.Fatalf("runtime status=%d body=%s", rr.Code, rr.Body.String())
		}
		var body struct {
			Security struct {
				AccountRecoveryKey struct {
					Configured bool `json:"configured"`
				} `json:"accountRecoveryKey"`
			} `json:"security"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body.Security.AccountRecoveryKey.Configured, rr.Body.String()
	}

	t.Setenv("ACCOUNT_RECOVERY_KEY_HASH", "")
	configured, body := status()
	if !configured {
		t.Fatal("active database recovery key reported as unconfigured")
	}
	if strings.Contains(body, keyHash) {
		t.Fatal("runtime status leaked the database recovery key hash")
	}

	const staleEnvValue = "stale-environment-recovery-hash"
	t.Setenv("ACCOUNT_RECOVERY_KEY_HASH", staleEnvValue)
	if _, err := db.ExecContext(ctx, `UPDATE account_recovery_keys SET expires_at=now()-interval '1 hour' WHERE id=$1::uuid`, keyID); err != nil {
		t.Fatal(err)
	}
	configured, body = status()
	if configured {
		t.Fatal("expired database recovery key reported as configured from stale environment metadata")
	}
	if strings.Contains(body, staleEnvValue) || strings.Contains(body, keyHash) {
		t.Fatal("runtime status leaked recovery credential material")
	}
}
