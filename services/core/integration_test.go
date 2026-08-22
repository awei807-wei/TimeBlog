package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"
)

// openDatabaseIntegration is deliberately opt-in. The URL alone is not
// sufficient because a normal developer shell may point at a shared or live
// database. Keep both gates before openPersistentDatabase, which can migrate
// and seed the database.
func openDatabaseIntegration(t *testing.T) *sql.DB {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL not configured; use a dedicated test database")
	}
	if os.Getenv("TIMEBLOG_RUN_DATABASE_INTEGRATION") != "1" {
		t.Skip("database integration is opt-in; set TIMEBLOG_RUN_DATABASE_INTEGRATION=1 with a dedicated test database")
	}
	db, err := openPersistentDatabase(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("close integration database: %v", err)
		}
	})
	return db
}

func TestPostgresMigrationSmoke(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "integration-password")
	t.Setenv("ADMIN_TOTP_SECRET", "JBSWY3DPEHPK3PXP")
	t.Setenv("TOTP_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	t.Setenv("CONFIG_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	t.Setenv("ACCOUNT_RECOVERY_KEY_BOOTSTRAP", "integration-recovery-key-very-long")
	db := openDatabaseIntegration(t)
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM users WHERE username='owner'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("owner count=%d", n)
	}
	if err := applyMigrations(context.Background(), db); err != nil {
		t.Fatalf("reapplying migrations after the 009 transaction: %v", err)
	}
	var purposeColumn bool
	if err := db.QueryRow(`SELECT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema=current_schema() AND table_name='mfa_challenges' AND column_name='purpose'
		  AND is_nullable='NO' AND column_default LIKE '%login%'
	)`).Scan(&purposeColumn); err != nil {
		t.Fatal(err)
	}
	if !purposeColumn {
		t.Fatal("migration 009 did not install the non-null mfa_challenges.purpose column")
	}
	var purposeConstraint string
	if err := db.QueryRow(`SELECT pg_get_constraintdef(oid)
		FROM pg_constraint
		WHERE conrelid='mfa_challenges'::regclass AND conname='mfa_challenges_purpose_check'`).Scan(&purposeConstraint); err != nil {
		t.Fatalf("migration 009 purpose constraint: %v", err)
	}
	constraint := strings.ToLower(purposeConstraint)
	if !strings.Contains(constraint, "login") || !strings.Contains(constraint, "password_reset") {
		t.Fatalf("migration 009 purpose constraint=%q", purposeConstraint)
	}
	for _, table := range []string{"totp_replay_guards", "auth_operation_idempotency"} {
		var exists bool
		if err := db.QueryRow(`SELECT to_regclass(current_schema() || $1) IS NOT NULL`, "."+table).Scan(&exists); err != nil {
			t.Fatalf("migration 009 table %s: %v", table, err)
		}
		if !exists {
			t.Fatalf("migration 009 table %s is missing", table)
		}
	}
}

func TestPostgresAuthSessionResponseIncludesExpiryMetadata(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", "JBSWY3DPEHPK3PXP")
	t.Setenv("TOTP_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	t.Setenv("CONFIG_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	t.Setenv("ACCOUNT_RECOVERY_KEY_BOOTSTRAP", "integration-recovery-key-very-long")
	db := openDatabaseIntegration(t)
	ctx := context.Background()
	var ownerID, originalPasswordHash, originalTOTPCipher string
	if err := db.QueryRowContext(ctx, `SELECT id::text,password_hash,totp_secret_encrypted
		FROM users WHERE username='owner'`).Scan(&ownerID, &originalPasswordHash, &originalTOTPCipher); err != nil {
		t.Fatal(err)
	}
	type sessionSnapshot struct {
		tokenHash       string
		csrfTokenHash   string
		lastSeen        time.Time
		idleExpires     time.Time
		absoluteExpires time.Time
		revokedAt       sql.NullTime
	}
	sessions := map[string]sessionSnapshot{}
	rows, err := db.QueryContext(ctx, `SELECT id::text,token_hash,csrf_token_hash,last_seen,idle_expires,absolute_expires,revoked_at FROM sessions`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id string
		var snapshot sessionSnapshot
		if err := rows.Scan(&id, &snapshot.tokenHash, &snapshot.csrfTokenHash, &snapshot.lastSeen, &snapshot.idleExpires, &snapshot.absoluteExpires, &snapshot.revokedAt); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		sessions[id] = snapshot
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	if err := rows.Err(); err != nil {
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
	var loginCookie, challengeHash string
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		tx, cleanupErr := db.BeginTx(cleanupCtx, nil)
		if cleanupErr == nil {
			_, cleanupErr = tx.ExecContext(cleanupCtx, `UPDATE users SET password_hash=$1,totp_secret_encrypted=$2 WHERE id=$3::uuid`, originalPasswordHash, originalTOTPCipher, ownerID)
		}
		if cleanupErr == nil && challengeHash != "" {
			_, cleanupErr = tx.ExecContext(cleanupCtx, `DELETE FROM mfa_challenges WHERE token_hash=$1`, challengeHash)
		}
		if cleanupErr == nil && loginCookie != "" {
			_, cleanupErr = tx.ExecContext(cleanupCtx, `DELETE FROM sessions WHERE token_hash=$1`, tokenHash(loginCookie))
		}
		for id, snapshot := range sessions {
			if cleanupErr != nil {
				break
			}
			_, cleanupErr = tx.ExecContext(cleanupCtx, `UPDATE sessions
				SET token_hash=$2,csrf_token_hash=$3,last_seen=$4,idle_expires=$5,absolute_expires=$6,revoked_at=$7
				WHERE id=$1::uuid`, id, snapshot.tokenHash, snapshot.csrfTokenHash, snapshot.lastSeen, snapshot.idleExpires, snapshot.absoluteExpires, snapshot.revokedAt)
		}
		if cleanupErr == nil {
			cleanupErr = tx.Commit()
		} else {
			_ = tx.Rollback()
		}
		if cleanupErr != nil {
			t.Errorf("restore auth session fixture: %v", cleanupErr)
		}
	})
	if _, err := db.ExecContext(ctx, `UPDATE users SET password_hash=$1,totp_secret_encrypted=$2 WHERE id=$3::uuid`, knownPasswordHash, knownTOTPCipher, ownerID); err != nil {
		t.Fatal(err)
	}

	srv := NewServer(NewPersistentStore(db))
	h := srv.routes()
	remoteAddr := "timeblog-auth-session-fixture-" + newID()
	passwordRequest := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login/password", strings.NewReader(`{"password":"test-password"}`))
	passwordRequest.RemoteAddr = remoteAddr
	passwordRequest.Header.Set("Content-Type", "application/json")
	passwordResponse := httptest.NewRecorder()
	h.ServeHTTP(passwordResponse, passwordRequest)
	if passwordResponse.Code != http.StatusOK {
		t.Fatalf("password login status=%d body=%s", passwordResponse.Code, passwordResponse.Body.String())
	}
	var passwordBody struct {
		Challenge string `json:"challenge"`
	}
	if err := json.Unmarshal(passwordResponse.Body.Bytes(), &passwordBody); err != nil || passwordBody.Challenge == "" {
		t.Fatalf("password challenge response=%s", passwordResponse.Body.String())
	}
	challengeHash = tokenHash(passwordBody.Challenge)
	code, err := totp.GenerateCode(securityRecoveryTestTOTP, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	totpRequest := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login/totp", strings.NewReader(`{"code":"`+code+`","challenge":"`+passwordBody.Challenge+`"}`))
	totpRequest.RemoteAddr = remoteAddr
	totpRequest.Header.Set("Content-Type", "application/json")
	totpResponse := httptest.NewRecorder()
	h.ServeHTTP(totpResponse, totpRequest)
	if totpResponse.Code != http.StatusOK {
		t.Fatalf("TOTP login status=%d body=%s", totpResponse.Code, totpResponse.Body.String())
	}
	for _, cookie := range totpResponse.Result().Cookies() {
		if cookie.Name == "timeline_session" {
			loginCookie = cookie.Value
			break
		}
	}
	if loginCookie == "" {
		t.Fatalf("TOTP login did not create a session: %s", totpResponse.Body.String())
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/auth/session", nil)
	request.AddCookie(&http.Cookie{Name: "timeline_session", Value: loginCookie})
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("session status=%d body=%s", response.Code, response.Body.String())
	}
	var body struct {
		Authenticated         bool      `json:"authenticated"`
		IdleExpiresAt         time.Time `json:"idleExpiresAt"`
		AbsoluteExpiresAt     time.Time `json:"absoluteExpiresAt"`
		IdleExpiresInDays     int       `json:"idleExpiresInDays"`
		AbsoluteExpiresInDays int       `json:"absoluteExpiresInDays"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.Authenticated || body.IdleExpiresAt.IsZero() || body.AbsoluteExpiresAt.IsZero() {
		t.Fatalf("session expiry metadata missing: %+v", body)
	}
	if body.IdleExpiresInDays != 30 || body.AbsoluteExpiresInDays != 90 {
		t.Fatalf("legacy session duration metadata=%d/%d", body.IdleExpiresInDays, body.AbsoluteExpiresInDays)
	}
	if !body.AbsoluteExpiresAt.After(body.IdleExpiresAt) || !body.IdleExpiresAt.After(time.Now()) {
		t.Fatalf("unexpected session expiry order: idle=%s absolute=%s", body.IdleExpiresAt, body.AbsoluteExpiresAt)
	}
}

func TestPostgresMediaRefsAndExpiredPurge(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "integration-password")
	t.Setenv("ADMIN_TOTP_SECRET", "JBSWY3DPEHPK3PXP")
	t.Setenv("TOTP_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	t.Setenv("CONFIG_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	t.Setenv("ACCOUNT_RECOVERY_KEY_BOOTSTRAP", "integration-recovery-key-very-long")
	db := openDatabaseIntegration(t)
	var ownerID string
	if err := db.QueryRow(`SELECT id::text FROM users WHERE username='owner'`).Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	var entryID, mediaID string
	if err := db.QueryRow(`INSERT INTO entries(id,author_id,kind,status,visibility,markdown,journal_date,time_precision,deleted_at) VALUES(gen_random_uuid(),$1,'note','trashed','private','media://placeholder',current_date,'day',now()-interval '31 days') RETURNING id::text`, ownerID).Scan(&entryID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := db.Exec(`DELETE FROM media_refs WHERE entry_id=$1::uuid`, entryID); err != nil {
			t.Errorf("cleanup media refs for entry %s: %v", entryID, err)
		}
		if _, err := db.Exec(`DELETE FROM entries WHERE id=$1::uuid`, entryID); err != nil {
			t.Errorf("cleanup entry %s: %v", entryID, err)
		}
		if mediaID != "" {
			if _, err := db.Exec(`DELETE FROM media WHERE id=$1::uuid`, mediaID); err != nil {
				t.Errorf("cleanup media %s: %v", mediaID, err)
			}
		}
	})
	if err := db.QueryRow(`INSERT INTO media(id,owner_id,provider,visibility,original_name,mime_type,size_bytes,status,storage_path) VALUES(gen_random_uuid(),$1,'local_private','private','fixture.txt','text/plain',1,'ready','') RETURNING id::text`, ownerID).Scan(&mediaID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO media_refs(entry_id,media_id) VALUES($1::uuid,$2::uuid)`, entryID, mediaID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`DELETE FROM entries WHERE id=$1::uuid AND author_id=$2::uuid AND status='trashed' AND deleted_at <= now() - interval '30 days'`, entryID, ownerID); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM entries WHERE id=$1::uuid`, entryID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("expired trash entry remains: %d", count)
	}
	if err := db.QueryRow(`SELECT count(*) FROM media_refs WHERE entry_id=$1::uuid`, entryID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("media refs remain after cascade: %d", count)
	}
}

func TestPostgresImportEntryStorageSmoke(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "integration-password")
	t.Setenv("ADMIN_TOTP_SECRET", "JBSWY3DPEHPK3PXP")
	t.Setenv("TOTP_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	t.Setenv("CONFIG_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	t.Setenv("ACCOUNT_RECOVERY_KEY_BOOTSTRAP", "integration-recovery-key-very-long")
	db := openDatabaseIntegration(t)
	var ownerID string
	if err := db.QueryRow(`SELECT id::text FROM users WHERE username='owner'`).Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	id := newID()
	t.Cleanup(func() {
		if _, err := db.Exec(`DELETE FROM entries WHERE id=$1::uuid`, id); err != nil {
			t.Errorf("cleanup entry %s: %v", id, err)
		}
	})
	insert := func(title, markdown string) {
		_, err := db.Exec(`INSERT INTO entries(id,author_id,kind,status,visibility,title,markdown,journal_date,time_precision) VALUES($1::uuid,$2,'note','published','private',$3,$4,current_date,'day')`, id, ownerID, title, markdown)
		if err != nil {
			t.Fatal(err)
		}
	}
	insert("Original", "one")
	// This smoke test verifies the imported-entry storage tables are available
	// in the dedicated PostgreSQL integration database.
	var versions int
	if err := db.QueryRow(`SELECT count(*) FROM entry_versions WHERE entry_id=$1::uuid`, id).Scan(&versions); err != nil {
		t.Fatal(err)
	}
	if versions != 0 {
		t.Fatalf("unexpected pre-existing versions: %d", versions)
	}
}

func TestPostgresCanonicalArticleCommitAndUUIDFallback(t *testing.T) {
	password := os.Getenv("ADMIN_PASSWORD")
	if password == "" {
		password = "integration-password"
	}
	t.Setenv("ADMIN_PASSWORD", password)
	t.Setenv("ADMIN_TOTP_SECRET", "JBSWY3DPEHPK3PXP")
	t.Setenv("TOTP_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	t.Setenv("CONFIG_ENCRYPTION_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	t.Setenv("ACCOUNT_RECOVERY_KEY_BOOTSTRAP", "integration-recovery-key-very-long")
	db := openDatabaseIntegration(t)
	var err error
	var ownerID string
	if err := db.QueryRow(`SELECT id::text FROM users WHERE username='owner'`).Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	srv := NewServer(NewPersistentStore(db))
	h := srv.routes()
	var sessionCookie, challengeHash string
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		tx, cleanupErr := db.BeginTx(cleanupCtx, nil)
		if cleanupErr == nil && challengeHash != "" {
			_, cleanupErr = tx.ExecContext(cleanupCtx, `DELETE FROM mfa_challenges WHERE token_hash=$1 AND purpose='login'`, challengeHash)
		}
		if cleanupErr == nil && sessionCookie != "" {
			_, cleanupErr = tx.ExecContext(cleanupCtx, `DELETE FROM sessions WHERE token_hash=$1`, tokenHash(sessionCookie))
		}
		if cleanupErr == nil {
			cleanupErr = tx.Commit()
		} else if tx != nil {
			_ = tx.Rollback()
		}
		if cleanupErr != nil {
			t.Errorf("cleanup canonical article auth session: %v", cleanupErr)
		}
	})

	passwordReq := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login/password", bytes.NewBufferString(`{"password":"`+password+`"}`))
	passwordReq.Header.Set("Content-Type", "application/json")
	passwordRR := httptest.NewRecorder()
	h.ServeHTTP(passwordRR, passwordReq)
	if passwordRR.Code != http.StatusOK {
		t.Fatalf("password login status=%d body=%s", passwordRR.Code, passwordRR.Body.String())
	}
	var challenge struct {
		Challenge string `json:"challenge"`
	}
	if err := json.Unmarshal(passwordRR.Body.Bytes(), &challenge); err != nil || challenge.Challenge == "" {
		t.Fatalf("password challenge: %s", passwordRR.Body.String())
	}
	challengeHash = tokenHash(challenge.Challenge)
	code, err := totp.GenerateCode(os.Getenv("ADMIN_TOTP_SECRET"), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	totpReq := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login/totp", bytes.NewBufferString(`{"code":"`+code+`","challenge":"`+challenge.Challenge+`"}`))
	totpReq.Header.Set("Content-Type", "application/json")
	totpRR := httptest.NewRecorder()
	h.ServeHTTP(totpRR, totpReq)
	if totpRR.Code != http.StatusOK {
		t.Fatalf("totp login status=%d body=%s", totpRR.Code, totpRR.Body.String())
	}
	var loginBody struct {
		CSRFToken string `json:"csrfToken"`
	}
	if err := json.Unmarshal(totpRR.Body.Bytes(), &loginBody); err != nil || loginBody.CSRFToken == "" {
		t.Fatalf("totp response: %s", totpRR.Body.String())
	}
	for _, cookie := range totpRR.Result().Cookies() {
		if cookie.Name == "timeline_session" {
			sessionCookie = cookie.Value
		}
	}
	if sessionCookie == "" {
		t.Fatal("missing persistent session cookie")
	}

	newMutation := func(method, path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, bytes.NewBufferString(body))
		r.AddCookie(&http.Cookie{Name: "timeline_session", Value: sessionCookie})
		r.Header.Set("Origin", "http://localhost:3000")
		r.Header.Set("X-CSRF-Token", loginBody.CSRFToken)
		r.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, r)
		return rr
	}

	draftID := "canonical-article-" + strings.ReplaceAll(time.Now().Format("150405.000000000"), ".", "-")
	wcRR := newMutation(http.MethodPost, "/api/v1/admin/working-copies", `{"clientDraftId":"`+draftID+`","payload":{"kind":"article","status":"published","visibility":"public","title":"","markdown":"db canonical","journalDate":"2026-08-15"}}`)
	if wcRR.Code != http.StatusOK {
		t.Fatalf("working copy status=%d body=%s", wcRR.Code, wcRR.Body.String())
	}
	var wc WorkingCopy
	if err := json.Unmarshal(wcRR.Body.Bytes(), &wc); err != nil || wc.ID == "" {
		t.Fatalf("working copy response: %s", wcRR.Body.String())
	}
	t.Cleanup(func() {
		if _, err := db.Exec(`DELETE FROM entry_working_copies WHERE id=$1::uuid`, wc.ID); err != nil {
			t.Errorf("cleanup working copy %s: %v", wc.ID, err)
		}
	})
	commitRR := newMutation(http.MethodPost, "/api/v1/admin/working-copies/"+wc.ID+"/commit", `{"kind":"article","status":"published","visibility":"public","title":"","slug":"","markdown":"db canonical","journalDate":"2026-08-15"}`)
	if commitRR.Code != http.StatusOK {
		t.Fatalf("commit status=%d body=%s", commitRR.Code, commitRR.Body.String())
	}
	var commitBody struct {
		Entry Entry `json:"entry"`
	}
	if err := json.Unmarshal(commitRR.Body.Bytes(), &commitBody); err != nil {
		t.Fatal(err)
	}
	entryID := commitBody.Entry.ID
	if entryID != "" {
		t.Cleanup(func() {
			if _, err := db.Exec(`DELETE FROM entries WHERE id=$1::uuid`, entryID); err != nil {
				t.Errorf("cleanup entry %s: %v", entryID, err)
			}
		})
	}
	if entryID == "" || !strings.HasPrefix(commitBody.Entry.Slug, "article-") {
		t.Fatalf("database commit did not create canonical slug: %+v", commitBody.Entry)
	}
	var storedSlug, precision string
	if err := db.QueryRow(`SELECT COALESCE(slug,''),time_precision FROM entries WHERE id=$1::uuid`, entryID).Scan(&storedSlug, &precision); err != nil {
		t.Fatal(err)
	}
	if storedSlug != commitBody.Entry.Slug || precision != "day" {
		t.Fatalf("database row mismatch slug=%q precision=%q response=%q", storedSlug, precision, commitBody.Entry.Slug)
	}

	legacyID := newID()
	t.Cleanup(func() {
		if _, err := db.Exec(`DELETE FROM entries WHERE id=$1::uuid`, legacyID); err != nil {
			t.Errorf("cleanup legacy entry %s: %v", legacyID, err)
		}
	})
	if _, err := db.Exec(`INSERT INTO entries(id,author_id,kind,status,visibility,title,slug,markdown,journal_date,time_precision) VALUES($1::uuid,$2::uuid,'article','published','public','Historical',NULL,'legacy',current_date,'day')`, legacyID, ownerID); err != nil {
		t.Fatal(err)
	}
	legacyRR := httptest.NewRecorder()
	h.ServeHTTP(legacyRR, httptest.NewRequest(http.MethodGet, "/api/v1/public/articles/"+legacyID, nil))
	if legacyRR.Code != http.StatusOK || !strings.Contains(legacyRR.Body.String(), `"title":"Historical"`) {
		t.Fatalf("historical UUID lookup status=%d body=%s", legacyRR.Code, legacyRR.Body.String())
	}
}
