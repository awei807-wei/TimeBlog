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
	var sessionCookie string
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
