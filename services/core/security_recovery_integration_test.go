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

func TestPersistentTOTPPasswordRecoveryPreservesFactorsAndRevokesSessions(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", securityRecoveryTestTOTP)
	t.Setenv("TOTP_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	t.Setenv("CONFIG_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	db := openDatabaseIntegration(t)
	ctx := context.Background()

	var ownerID, originalPasswordHash, originalTOTPCipher string
	if err := db.QueryRowContext(ctx, `SELECT id::text,password_hash,totp_secret_encrypted FROM users WHERE username='owner'`).Scan(&ownerID, &originalPasswordHash, &originalTOTPCipher); err != nil {
		t.Fatal(err)
	}
	var originalGuard int64
	guardExists := true
	if err := db.QueryRowContext(ctx, `SELECT last_used_step FROM totp_replay_guards WHERE user_id=$1::uuid`, ownerID).Scan(&originalGuard); err != nil {
		if err != sql.ErrNoRows {
			t.Fatal(err)
		}
		guardExists = false
	}
	var auditBaseline int64
	if err := db.QueryRowContext(ctx, `SELECT COALESCE(max(id),0) FROM account_recovery_audit`).Scan(&auditBaseline); err != nil {
		t.Fatal(err)
	}
	sessionRevocations := map[string]sql.NullTime{}
	rows, err := db.QueryContext(ctx, `SELECT id::text,revoked_at FROM sessions`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id string
		var revokedAt sql.NullTime
		if err := rows.Scan(&id, &revokedAt); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		sessionRevocations[id] = revokedAt
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	knownPasswordHash, err := hashPassword("test-password")
	if err != nil {
		t.Fatal(err)
	}
	knownTOTPCipher, err := encryptSecret(securityRecoveryTestTOTP)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE users SET password_hash=$1,totp_secret_encrypted=$2 WHERE id=$3::uuid`, knownPasswordHash, knownTOTPCipher, ownerID); err != nil {
		t.Fatal(err)
	}
	if guardExists {
		if _, err := db.ExecContext(ctx, `UPDATE totp_replay_guards SET last_used_step=-1,updated_at=now() WHERE user_id=$1::uuid`, ownerID); err != nil {
			t.Fatal(err)
		}
	}
	var loginCookie string
	var challengeToken string
	operationHash := namespacedOperationHash(totpOperationPurpose, securityRecoveryToken(81))
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		tx, cleanupErr := db.BeginTx(cleanupCtx, nil)
		if cleanupErr == nil {
			_, cleanupErr = tx.ExecContext(cleanupCtx, `UPDATE users SET password_hash=$1,totp_secret_encrypted=$2 WHERE id=$3::uuid`, originalPasswordHash, originalTOTPCipher, ownerID)
		}
		for id, revokedAt := range sessionRevocations {
			if cleanupErr != nil {
				break
			}
			_, cleanupErr = tx.ExecContext(cleanupCtx, `UPDATE sessions SET revoked_at=$2 WHERE id=$1::uuid`, id, revokedAt)
		}
		if cleanupErr == nil && loginCookie != "" {
			_, cleanupErr = tx.ExecContext(cleanupCtx, `DELETE FROM sessions WHERE token_hash=$1`, tokenHash(loginCookie))
		}
		if cleanupErr == nil {
			if guardExists {
				_, cleanupErr = tx.ExecContext(cleanupCtx, `UPDATE totp_replay_guards SET last_used_step=$2,updated_at=now() WHERE user_id=$1::uuid`, ownerID, originalGuard)
			} else {
				_, cleanupErr = tx.ExecContext(cleanupCtx, `DELETE FROM totp_replay_guards WHERE user_id=$1::uuid`, ownerID)
			}
		}
		if cleanupErr == nil {
			_, cleanupErr = tx.ExecContext(cleanupCtx, `DELETE FROM auth_operation_idempotency WHERE operation_hash=$1`, operationHash)
		}
		if cleanupErr == nil && challengeToken != "" {
			_, cleanupErr = tx.ExecContext(cleanupCtx, `DELETE FROM mfa_challenges WHERE token_hash=$1 AND purpose=$2`, tokenHash(challengeToken), passwordResetChallengePurpose)
		}
		if cleanupErr == nil {
			_, cleanupErr = tx.ExecContext(cleanupCtx, `DELETE FROM account_recovery_audit WHERE id>$1 AND event IN ('totp_password_reset','totp_password_reset_failed')`, auditBaseline)
		}
		if cleanupErr == nil {
			cleanupErr = tx.Commit()
		} else {
			_ = tx.Rollback()
		}
		if cleanupErr != nil {
			t.Errorf("restore persistent TOTP recovery fixture: %v", cleanupErr)
		}
	})

	srv := NewServer(NewPersistentStore(db))
	h := srv.routes()
	_, sessionRaw := loginForTest(t, h)
	parts := splitSecurityRecoverySession(sessionRaw)
	loginCookie = parts[0]
	start := httptest.NewRecorder()
	h.ServeHTTP(start, securityRecoveryJSONRequest(http.MethodPost, "/api/v1/auth/recovery/totp/start", map[string]any{}))
	if start.Code != http.StatusOK {
		t.Fatalf("persistent TOTP recovery start status=%d body=%s", start.Code, start.Body.String())
	}
	var startBody struct {
		Challenge string `json:"challenge"`
	}
	if err := json.Unmarshal(start.Body.Bytes(), &startBody); err != nil {
		t.Fatal(err)
	}
	challengeToken = startBody.Challenge
	requestBody := map[string]string{
		"challenge":      startBody.Challenge,
		"code":           mustSecurityRecoveryCode(t),
		"newPassword":    "persistent-new-password-123",
		"operationToken": securityRecoveryToken(81),
	}
	beforeSessions := 0
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM sessions`).Scan(&beforeSessions); err != nil {
		t.Fatal(err)
	}
	complete := httptest.NewRecorder()
	h.ServeHTTP(complete, securityRecoveryJSONRequest(http.MethodPost, "/api/v1/auth/recovery/totp/complete", requestBody))
	if complete.Code != http.StatusOK {
		t.Fatalf("persistent TOTP recovery complete status=%d body=%s", complete.Code, complete.Body.String())
	}
	retry := httptest.NewRecorder()
	h.ServeHTTP(retry, securityRecoveryJSONRequest(http.MethodPost, "/api/v1/auth/recovery/totp/complete", requestBody))
	if retry.Code != http.StatusOK {
		t.Fatalf("persistent TOTP recovery retry status=%d body=%s", retry.Code, retry.Body.String())
	}
	var passwordHash, totpCipher string
	if err := db.QueryRowContext(ctx, `SELECT password_hash,totp_secret_encrypted FROM users WHERE id=$1::uuid`, ownerID).Scan(&passwordHash, &totpCipher); err != nil {
		t.Fatal(err)
	}
	if !verifyPassword(requestBody["newPassword"], passwordHash) || totpCipher != knownTOTPCipher {
		t.Fatal("persistent TOTP-only reset changed more than the password")
	}
	var afterSessions, activeSessions, operations int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM sessions`).Scan(&afterSessions); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM sessions WHERE revoked_at IS NULL`).Scan(&activeSessions); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM auth_operation_idempotency WHERE operation_hash=$1`, operationHash).Scan(&operations); err != nil {
		t.Fatal(err)
	}
	if afterSessions != beforeSessions || activeSessions != 0 || operations != 1 {
		t.Fatalf("persistent reset session/operation state sessions=%d/%d active=%d operations=%d", beforeSessions, afterSessions, activeSessions, operations)
	}
}

func splitSecurityRecoverySession(value string) [2]string {
	parts := strings.SplitN(value, "\n", 2)
	result := [2]string{}
	copy(result[:], parts)
	return result
}
