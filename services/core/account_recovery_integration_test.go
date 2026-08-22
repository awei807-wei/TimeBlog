package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base32"
	"net/http"
	"testing"
	"time"
)

type persistentRecoveryFixture struct {
	keyID             string
	keyHash           string
	keyExpiry         time.Time
	ownerID           string
	passwordHash      string
	totpCipher        string
	replayGuardStep   int64
	replayGuardExists bool
	auditBaseline     int64
	sessions          map[string]sql.NullTime
}

func TestPersistentAccountRecoveryIsIdempotent(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "integration-password")
	t.Setenv("ADMIN_TOTP_SECRET", "JBSWY3DPEHPK3PXP")
	t.Setenv("TOTP_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	t.Setenv("CONFIG_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	t.Setenv("ACCOUNT_RECOVERY_KEY_BOOTSTRAP", "integration-recovery-key-very-long")
	db := openDatabaseIntegration(t)
	ctx := context.Background()
	currentKey, err := generateRecoveryKey()
	if err != nil {
		t.Fatal(err)
	}
	currentHash, err := hashPassword(currentKey)
	if err != nil {
		t.Fatal(err)
	}
	in := randomPersistentRecoveryRequest(t, currentKey)
	operationHash := recoveryOperationHash(in.OperationToken)
	fixture := installPersistentRecoveryFixture(t, ctx, db, currentHash)
	registerPersistentRecoveryCleanup(t, db, fixture, operationHash)

	srv := NewServer(NewPersistentStore(db))
	first := performRecoveryRequest(srv, in)
	if first.Code != http.StatusOK {
		t.Fatalf("first persistent recovery status=%d body=%s", first.Code, first.Body.String())
	}
	second := performRecoveryRequest(srv, in)
	if second.Code != http.StatusOK || second.Body.String() != first.Body.String() {
		t.Fatalf("persistent retry status=%d first=%s second=%s", second.Code, first.Body.String(), second.Body.String())
	}
	conflicting := in
	conflicting.NewPassword = "different-integration-password"
	if response := performRecoveryRequest(srv, conflicting); response.Code != http.StatusConflict {
		t.Fatalf("persistent operation conflict status=%d body=%s", response.Code, response.Body.String())
	}
	assertPersistentRecoveryState(t, ctx, db, fixture, operationHash, in)
}

func installPersistentRecoveryFixture(t *testing.T, ctx context.Context, db *sql.DB, currentHash string) persistentRecoveryFixture {
	t.Helper()
	fixture := persistentRecoveryFixture{sessions: map[string]sql.NullTime{}}
	if err := db.QueryRowContext(ctx, `SELECT id::text,key_hash,expires_at FROM account_recovery_keys
		WHERE used_at IS NULL AND expires_at>now()`).Scan(&fixture.keyID, &fixture.keyHash, &fixture.keyExpiry); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT id::text,password_hash,totp_secret_encrypted FROM users WHERE username='owner'`).Scan(&fixture.ownerID, &fixture.passwordHash, &fixture.totpCipher); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT last_used_step FROM totp_replay_guards WHERE user_id=$1::uuid`, fixture.ownerID).Scan(&fixture.replayGuardStep); err == nil {
		fixture.replayGuardExists = true
	} else if err != sql.ErrNoRows {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT COALESCE(max(id),0) FROM account_recovery_audit`).Scan(&fixture.auditBaseline); err != nil {
		t.Fatal(err)
	}
	rows, err := db.QueryContext(ctx, `SELECT id::text,revoked_at FROM sessions`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var revokedAt sql.NullTime
		if err = rows.Scan(&id, &revokedAt); err != nil {
			t.Fatal(err)
		}
		fixture.sessions[id] = revokedAt
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(ctx, `UPDATE account_recovery_keys SET key_hash=$2 WHERE id=$1::uuid`, fixture.keyID, currentHash); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func randomPersistentRecoveryRequest(t *testing.T, currentKey string) accountRecoveryRequest {
	t.Helper()
	operationToken, err := generateRecoveryKey()
	if err != nil {
		t.Fatal(err)
	}
	newRecoveryKey, err := generateRecoveryKey()
	if err != nil {
		t.Fatal(err)
	}
	totpBytes := make([]byte, 20)
	if _, err = rand.Read(totpBytes); err != nil {
		t.Fatal(err)
	}
	return accountRecoveryRequest{
		RecoveryKey:    currentKey,
		NewPassword:    "integration-new-password-123",
		OperationToken: operationToken,
		NewRecoveryKey: newRecoveryKey,
		NewTOTPSecret:  base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(totpBytes),
	}
}

func assertPersistentRecoveryState(t *testing.T, ctx context.Context, db *sql.DB, fixture persistentRecoveryFixture, operationHash string, in accountRecoveryRequest) {
	t.Helper()
	var activeID, activeHash string
	if err := db.QueryRowContext(ctx, `SELECT id::text,key_hash FROM account_recovery_keys
		WHERE used_at IS NULL AND expires_at>now()`).Scan(&activeID, &activeHash); err != nil {
		t.Fatal(err)
	}
	if activeID == fixture.keyID || !verifyPassword(in.NewRecoveryKey, activeHash) {
		t.Fatal("persistent recovery did not activate the client-generated recovery key")
	}
	var passwordHash, totpCipher string
	if err := db.QueryRowContext(ctx, `SELECT password_hash,totp_secret_encrypted FROM users WHERE username='owner'`).Scan(&passwordHash, &totpCipher); err != nil {
		t.Fatal(err)
	}
	plainTOTP, err := decryptSecret(totpCipher)
	if err != nil || !verifyPassword(in.NewPassword, passwordHash) || plainTOTP != in.NewTOTPSecret {
		t.Fatal("persistent recovery credentials do not match the idempotent request")
	}
	var operationCount, auditCount int
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM account_recovery_operations
		WHERE operation_hash=$1 AND recovery_key_id=$2::uuid`, operationHash, activeID).Scan(&operationCount); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM account_recovery_audit
		WHERE id>$1 AND key_id=$2::uuid AND success=true AND event='account_recovered'`, fixture.auditBaseline, fixture.keyID).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if operationCount != 1 || auditCount != 1 {
		t.Fatalf("operation rows=%d audit rows=%d want=1,1", operationCount, auditCount)
	}
	if fixture.replayGuardExists {
		var replayStep int64
		if err = db.QueryRowContext(ctx, `SELECT last_used_step FROM totp_replay_guards WHERE user_id=$1::uuid`, fixture.ownerID).Scan(&replayStep); err != nil {
			t.Fatal(err)
		}
		if replayStep != -1 {
			t.Fatalf("TOTP replay guard was not reset after replacing secret: %d", replayStep)
		}
	}
}

func registerPersistentRecoveryCleanup(t *testing.T, db *sql.DB, fixture persistentRecoveryFixture, operationHash string) {
	t.Helper()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Errorf("begin persistent recovery cleanup: %v", err)
			return
		}
		defer tx.Rollback()
		if err = lockRecoveryKeyTable(ctx, tx); err == nil {
			_, err = tx.ExecContext(ctx, `DELETE FROM account_recovery_operations WHERE operation_hash=$1`, operationHash)
		}
		if err == nil {
			_, err = tx.ExecContext(ctx, `DELETE FROM account_recovery_audit WHERE id>$1 AND key_id=$2::uuid AND event='account_recovered'`, fixture.auditBaseline, fixture.keyID)
		}
		if err == nil {
			_, err = tx.ExecContext(ctx, `DELETE FROM account_recovery_keys WHERE id<>$1::uuid AND used_at IS NULL`, fixture.keyID)
		}
		if err == nil {
			_, err = tx.ExecContext(ctx, `UPDATE account_recovery_keys SET key_hash=$2,expires_at=$3,used_at=NULL WHERE id=$1::uuid`, fixture.keyID, fixture.keyHash, fixture.keyExpiry)
		}
		if err == nil {
			_, err = tx.ExecContext(ctx, `UPDATE users SET password_hash=$1,totp_secret_encrypted=$2 WHERE username='owner'`, fixture.passwordHash, fixture.totpCipher)
		}
		if err == nil && fixture.replayGuardExists {
			_, err = tx.ExecContext(ctx, `UPDATE totp_replay_guards SET last_used_step=$2,updated_at=now() WHERE user_id=$1::uuid`, fixture.ownerID, fixture.replayGuardStep)
		}
		if err == nil && !fixture.replayGuardExists {
			_, err = tx.ExecContext(ctx, `DELETE FROM totp_replay_guards WHERE user_id=$1::uuid`, fixture.ownerID)
		}
		for id, revokedAt := range fixture.sessions {
			if err != nil {
				break
			}
			_, err = tx.ExecContext(ctx, `UPDATE sessions SET revoked_at=$2 WHERE id=$1::uuid`, id, revokedAt)
		}
		if err == nil {
			err = tx.Commit()
		}
		if err != nil {
			t.Errorf("restore persistent recovery fixture: %v", err)
		}
	})
}
