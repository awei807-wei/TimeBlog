package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

type authSecuritySessionSnapshot struct {
	ID              string
	UserID          string
	TokenHash       string
	CSRFTokenHash   string
	LastSeen        time.Time
	IdleExpires     time.Time
	AbsoluteExpires time.Time
	RevokedAt       sql.NullTime
}

func TestPostgresLoginTOTPReplayAndChallengeTransaction(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", securityRecoveryTestTOTP)
	t.Setenv("TOTP_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	t.Setenv("CONFIG_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	t.Setenv("APP_ENV", "")
	t.Setenv("SESSION_COOKIE_SECURE", "")
	db := openDatabaseIntegration(t)
	ctx := context.Background()

	var ownerID, originalPasswordHash, originalTOTPCipher string
	if err := db.QueryRowContext(ctx, `SELECT id::text,password_hash,totp_secret_encrypted
		FROM users WHERE username='owner'`).Scan(&ownerID, &originalPasswordHash, &originalTOTPCipher); err != nil {
		t.Fatal(err)
	}
	originalGuard, guardErr := queryReplayGuard(ctx, db, ownerID)
	guardExists := guardErr == nil
	if guardErr != nil && guardErr != sql.ErrNoRows {
		t.Fatal(guardErr)
	}
	sessions, err := snapshotAuthSecuritySessions(ctx, db)
	if err != nil {
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
	if _, err := db.ExecContext(ctx, `INSERT INTO totp_replay_guards(user_id,last_used_step) VALUES($1::uuid,-1) ON CONFLICT(user_id) DO UPDATE SET last_used_step=-1,updated_at=now()`, ownerID); err != nil {
		t.Fatal(err)
	}

	var challengeHashes []string
	var sessionTokens []string
	var sessionTokenMu sync.Mutex
	remoteIPs := []string{"192.0.2.61:12001", "192.0.2.62:12001", "192.0.2.63:12001", "192.0.2.64:12001"}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		tx, cleanupErr := db.BeginTx(cleanupCtx, nil)
		if cleanupErr == nil {
			_, cleanupErr = tx.ExecContext(cleanupCtx, `UPDATE users SET password_hash=$1,totp_secret_encrypted=$2 WHERE id=$3::uuid`, originalPasswordHash, originalTOTPCipher, ownerID)
		}
		if cleanupErr == nil {
			if guardExists {
				_, cleanupErr = tx.ExecContext(cleanupCtx, `UPDATE totp_replay_guards SET last_used_step=$2,updated_at=now() WHERE user_id=$1::uuid`, ownerID, originalGuard)
			} else {
				_, cleanupErr = tx.ExecContext(cleanupCtx, `DELETE FROM totp_replay_guards WHERE user_id=$1::uuid`, ownerID)
			}
		}
		for _, challengeHash := range challengeHashes {
			if cleanupErr != nil {
				break
			}
			_, cleanupErr = tx.ExecContext(cleanupCtx, `DELETE FROM mfa_challenges WHERE token_hash=$1`, challengeHash)
		}
		for _, token := range sessionTokens {
			if cleanupErr != nil {
				break
			}
			_, cleanupErr = tx.ExecContext(cleanupCtx, `DELETE FROM sessions WHERE token_hash=$1`, tokenHash(token))
		}
		for _, remote := range remoteIPs {
			if cleanupErr != nil {
				break
			}
			host, _, splitErr := net.SplitHostPort(remote)
			if splitErr != nil {
				host = remote
			}
			ipHash := hashLoginField(host)
			for _, stage := range []string{"password", "totp"} {
				if _, cleanupErr = tx.ExecContext(cleanupCtx, `DELETE FROM login_attempts WHERE account_hash=$1 AND ip_hash=$2 AND stage=$3`, hashLoginField("owner"), ipHash, stage); cleanupErr != nil {
					break
				}
			}
		}
		if cleanupErr == nil {
			cleanupErr = restoreAuthSecuritySessions(cleanupCtx, tx, sessions)
		}
		if cleanupErr == nil {
			cleanupErr = tx.Commit()
		} else {
			_ = tx.Rollback()
		}
		if cleanupErr != nil {
			t.Errorf("restore login replay fixture: %v", cleanupErr)
		}
	})

	srv := NewServer(NewPersistentStore(db))
	h := srv.routes()
	issue := func(remote string) string {
		t.Helper()
		request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login/password", strings.NewReader(`{"password":"test-password"}`))
		request.RemoteAddr = remote
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		h.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("password login status=%d body=%s", response.Code, response.Body.String())
		}
		var body struct {
			Challenge string `json:"challenge"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body.Challenge == "" {
			t.Fatalf("password challenge response=%s", response.Body.String())
		}
		challengeHashes = append(challengeHashes, tokenHash(body.Challenge))
		return body.Challenge
	}
	complete := func(challenge, code, remote string) int {
		requestBody := `{"challenge":"` + challenge + `","code":"` + code + `"}`
		request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login/totp", bytes.NewBufferString(requestBody))
		request.RemoteAddr = remote
		request.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		h.ServeHTTP(response, request)
		if response.Code == http.StatusOK {
			for _, cookie := range response.Result().Cookies() {
				if cookie.Name == secureSessionCookieName || cookie.Name == legacySessionCookieName {
					sessionTokenMu.Lock()
					sessionTokens = append(sessionTokens, cookie.Value)
					sessionTokenMu.Unlock()
					break
				}
			}
		}
		return response.Code
	}
	code, err := totp.GenerateCode(securityRecoveryTestTOTP, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	firstChallenge := issue(remoteIPs[0])
	invalidCode := "000000"
	if invalidCode == code {
		invalidCode = "999999"
	}
	if status := complete(firstChallenge, invalidCode, remoteIPs[0]); status != http.StatusUnauthorized {
		t.Fatalf("invalid TOTP status=%d", status)
	}
	if status := complete(firstChallenge, code, remoteIPs[0]); status != http.StatusOK {
		t.Fatalf("valid retry status=%d", status)
	}
	secondChallenge := issue(remoteIPs[1])
	if status := complete(secondChallenge, code, remoteIPs[1]); status != http.StatusUnauthorized {
		t.Fatalf("cross-challenge same-step status=%d", status)
	}
	var guard int64
	if err := db.QueryRowContext(ctx, `SELECT last_used_step FROM totp_replay_guards WHERE user_id=$1::uuid`, ownerID).Scan(&guard); err != nil {
		t.Fatal(err)
	}
	if guard < 0 {
		t.Fatalf("accepted TOTP step was not persisted: %d", guard)
	}

	thirdChallenge := issue(remoteIPs[2])
	futureStep := totpStepForTime(time.Now()) + 1
	futureCode, err := totp.GenerateCodeCustom(securityRecoveryTestTOTP, time.Unix(futureStep*totpPeriodSeconds, 0).UTC(), totp.ValidateOpts{
		Period:    uint(totpPeriodSeconds),
		Skew:      0,
		Digits:    otp.DigitsSix,
		Algorithm: otp.AlgorithmSHA1,
	})
	if err != nil {
		t.Fatal(err)
	}
	statuses := make(chan int, 2)
	var wait sync.WaitGroup
	for _, remote := range []string{remoteIPs[2], remoteIPs[3]} {
		wait.Add(1)
		go func(remote string) {
			defer wait.Done()
			statuses <- complete(thirdChallenge, futureCode, remote)
		}(remote)
	}
	wait.Wait()
	close(statuses)
	accepted, rejected := 0, 0
	for status := range statuses {
		switch status {
		case http.StatusOK:
			accepted++
		case http.StatusUnauthorized:
			rejected++
		default:
			t.Fatalf("unexpected concurrent status=%d", status)
		}
	}
	if accepted != 1 || rejected != 1 {
		t.Fatalf("concurrent same challenge accepted=%d rejected=%d", accepted, rejected)
	}
}

func queryReplayGuard(ctx context.Context, db *sql.DB, ownerID string) (int64, error) {
	var step int64
	err := db.QueryRowContext(ctx, `SELECT last_used_step FROM totp_replay_guards WHERE user_id=$1::uuid`, ownerID).Scan(&step)
	return step, err
}

func snapshotAuthSecuritySessions(ctx context.Context, db *sql.DB) (map[string]authSecuritySessionSnapshot, error) {
	rows, err := db.QueryContext(ctx, `SELECT id::text,user_id::text,token_hash,csrf_token_hash,last_seen,idle_expires,absolute_expires,revoked_at FROM sessions`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	snapshots := map[string]authSecuritySessionSnapshot{}
	for rows.Next() {
		var snapshot authSecuritySessionSnapshot
		if err := rows.Scan(&snapshot.ID, &snapshot.UserID, &snapshot.TokenHash, &snapshot.CSRFTokenHash, &snapshot.LastSeen, &snapshot.IdleExpires, &snapshot.AbsoluteExpires, &snapshot.RevokedAt); err != nil {
			return nil, err
		}
		snapshots[snapshot.ID] = snapshot
	}
	return snapshots, rows.Err()
}

func restoreAuthSecuritySessions(ctx context.Context, tx *sql.Tx, snapshots map[string]authSecuritySessionSnapshot) error {
	rows, err := tx.QueryContext(ctx, `SELECT id::text FROM sessions`)
	if err != nil {
		return err
	}
	var currentIDs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		currentIDs = append(currentIDs, id)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, id := range currentIDs {
		if _, keep := snapshots[id]; !keep {
			if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE id=$1::uuid`, id); err != nil {
				return err
			}
		}
	}
	for _, snapshot := range snapshots {
		if _, err := tx.ExecContext(ctx, `UPDATE sessions SET token_hash=$2,csrf_token_hash=$3,last_seen=$4,idle_expires=$5,absolute_expires=$6,revoked_at=$7 WHERE id=$1::uuid`, snapshot.ID, snapshot.TokenHash, snapshot.CSRFTokenHash, snapshot.LastSeen, snapshot.IdleExpires, snapshot.AbsoluteExpires, snapshot.RevokedAt); err != nil {
			return err
		}
	}
	return nil
}
