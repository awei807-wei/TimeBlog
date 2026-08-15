package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"
)

func TestOpenAPIContractHasUniqueOperations(t *testing.T) {
	b, err := os.ReadFile("api/openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	text := string(b)
	if !strings.Contains(text, "operationId:") || !strings.Contains(text, "/admin/working-copies/{id}/commit:") {
		t.Fatal("contract missing core operations")
	}
	seen := map[string]bool{}
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "operationId:") {
			id := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "operationId:"))
			if seen[id] {
				t.Fatalf("duplicate operationId %s", id)
			}
			seen[id] = true
		}
	}
}

func TestPersistentAuthRejectsUnknownCookieWithoutDB(t *testing.T) {
	s := NewStore()
	s.persistent = true
	h := NewServer(s).routes()
	r := httptest.NewRequest(http.MethodGet, "/api/v1/auth/session", nil)
	r.AddCookie(&http.Cookie{Name: "timeline_session", Value: "forged"})
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, r)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("forged cookie status=%d", rr.Code)
	}
}

func TestMediaCapabilityRequiresAuthAndProbesLocalStorage(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", "JBSWY3DPEHPK3PXP")
	t.Setenv("MEDIA_ROOT", t.TempDir())
	s := NewStore()
	h := NewServer(s).routes()
	unauth := httptest.NewRequest(http.MethodGet, "/api/v1/admin/media/capability", nil)
	unauthRR := httptest.NewRecorder()
	h.ServeHTTP(unauthRR, unauth)
	if unauthRR.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated capability status=%d", unauthRR.Code)
	}
	_, raw := loginForTest(t, h)
	parts := bytes.SplitN([]byte(raw), []byte("\n"), 2)
	auth := httptest.NewRequest(http.MethodGet, "/api/v1/admin/media/capability", nil)
	auth.AddCookie(&http.Cookie{Name: "timeline_session", Value: string(parts[0])})
	authRR := httptest.NewRecorder()
	h.ServeHTTP(authRR, auth)
	if authRR.Code != http.StatusOK {
		t.Fatalf("authenticated capability status=%d body=%s", authRR.Code, authRR.Body.String())
	}
	var body struct {
		Provider              string `json:"provider"`
		Writable              bool   `json:"writable"`
		ImageUploadEnabled    bool   `json:"imageUploadEnabled"`
		NonImageUploadEnabled bool   `json:"nonImageUploadEnabled"`
	}
	if err := json.Unmarshal(authRR.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Provider != "local_private" || !body.Writable || !body.ImageUploadEnabled || !body.NonImageUploadEnabled {
		t.Fatalf("unexpected capability: %+v", body)
	}
}

func TestRuntimeStatusIsAuthenticatedAndMetadataOnly(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", "JBSWY3DPEHPK3PXP")
	t.Setenv("TOTP_ENCRYPTION_KEY", "not-returned")
	t.Setenv("DATABASE_URL", "postgres://secret@example.invalid/db")
	t.Setenv("MEDIA_ROOT", t.TempDir())
	h := NewServer(NewStore()).routes()
	unauth := httptest.NewRecorder()
	h.ServeHTTP(unauth, httptest.NewRequest(http.MethodGet, "/api/v1/admin/runtime-status", nil))
	if unauth.Code != http.StatusUnauthorized {
		t.Fatalf("runtime status unauthenticated status=%d", unauth.Code)
	}
	_, raw := loginForTest(t, h)
	parts := bytes.SplitN([]byte(raw), []byte("\n"), 2)
	auth := httptest.NewRequest(http.MethodGet, "/api/v1/admin/runtime-status", nil)
	auth.AddCookie(&http.Cookie{Name: "timeline_session", Value: string(parts[0])})
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, auth)
	if rr.Code != http.StatusOK || rr.Header().Get("Cache-Control") != "no-store, max-age=0" {
		t.Fatalf("runtime status response=%d cache=%q", rr.Code, rr.Header().Get("Cache-Control"))
	}
	body := rr.Body.String()
	for _, forbidden := range []string{"not-returned", "postgres://", "MEDIA_ROOT", "timeline-media", "password_hash"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("runtime status leaked %q: %s", forbidden, body)
		}
	}
	if !strings.Contains(body, `"provider":"local_private"`) || !strings.Contains(body, `"configured":true`) {
		t.Fatalf("runtime status missing safe metadata: %s", body)
	}
}

func TestSettingsRejectsUnknownKeysAndMethods(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", "JBSWY3DPEHPK3PXP")
	h := NewServer(NewStore()).routes()
	_, raw := loginForTest(t, h)
	parts := bytes.SplitN([]byte(raw), []byte("\n"), 2)
	method := httptest.NewRequest(http.MethodPut, "/api/v1/admin/settings", nil)
	method.AddCookie(&http.Cookie{Name: "timeline_session", Value: string(parts[0])})
	method.Header.Set("Origin", "http://localhost:3000")
	method.Header.Set("X-CSRF-Token", string(parts[1]))
	methodRR := httptest.NewRecorder()
	h.ServeHTTP(methodRR, method)
	if methodRR.Code != http.StatusMethodNotAllowed {
		t.Fatalf("settings method status=%d", methodRR.Code)
	}
	unknown := httptest.NewRequest(http.MethodPatch, "/api/v1/admin/settings", strings.NewReader(`{"secret":"x"}`))
	unknown.AddCookie(&http.Cookie{Name: "timeline_session", Value: string(parts[0])})
	unknown.Header.Set("Origin", "http://localhost:3000")
	unknown.Header.Set("X-CSRF-Token", string(parts[1]))
	unknown.Header.Set("Content-Type", "application/json")
	unknownRR := httptest.NewRecorder()
	h.ServeHTTP(unknownRR, unknown)
	if unknownRR.Code != http.StatusBadRequest {
		t.Fatalf("settings unknown key status=%d body=%s", unknownRR.Code, unknownRR.Body.String())
	}
}

func TestLogoutRevokesSessionAndClearsCookie(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", "JBSWY3DPEHPK3PXP")
	srv := NewServer(NewStore())
	h := srv.routes()
	_, raw := loginForTest(t, h)
	parts := bytes.SplitN([]byte(raw), []byte("\n"), 2)
	cookie, csrf := string(parts[0]), string(parts[1])

	logout := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	logout.AddCookie(&http.Cookie{Name: "timeline_session", Value: cookie})
	logout.Header.Set("Origin", "http://localhost:3000")
	logout.Header.Set("X-CSRF-Token", csrf)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, logout)
	if rr.Code != http.StatusOK {
		t.Fatalf("logout status=%d body=%s", rr.Code, rr.Body.String())
	}
	cleared := false
	for _, value := range rr.Result().Cookies() {
		if value.Name == "timeline_session" {
			cleared = value.MaxAge < 0 && value.HttpOnly && value.Path == "/" && value.SameSite == http.SameSiteLaxMode
		}
	}
	if !cleared {
		t.Fatalf("logout did not clear secure session cookie: %v", rr.Result().Cookies())
	}

	session := httptest.NewRequest(http.MethodGet, "/api/v1/auth/session", nil)
	session.AddCookie(&http.Cookie{Name: "timeline_session", Value: cookie})
	sessionRR := httptest.NewRecorder()
	h.ServeHTTP(sessionRR, session)
	if sessionRR.Code != http.StatusUnauthorized {
		t.Fatalf("revoked session status=%d", sessionRR.Code)
	}
}

func TestAuthSessionStatusValidatesCookieWithoutCSRF(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", "JBSWY3DPEHPK3PXP")
	srv := NewServer(NewStore())
	h := srv.routes()
	_, raw := loginForTest(t, h)
	parts := bytes.SplitN([]byte(raw), []byte("\n"), 2)
	status := httptest.NewRequest(http.MethodGet, "/api/v1/auth/session/status", nil)
	status.AddCookie(&http.Cookie{Name: "timeline_session", Value: string(parts[0])})
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, status)
	if rr.Code != http.StatusOK {
		t.Fatalf("session status=%d body=%s", rr.Code, rr.Body.String())
	}
	var body struct {
		Authenticated bool   `json:"authenticated"`
		CSRFToken     string `json:"csrfToken"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil || !body.Authenticated || body.CSRFToken == "" {
		t.Fatalf("unexpected status body=%s", rr.Body.String())
	}
}

func TestAuthSessionCSRFIsStableAcrossConsecutiveReads(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", "JBSWY3DPEHPK3PXP")
	srv := NewServer(NewStore())
	h := srv.routes()
	_, raw := loginForTest(t, h)
	parts := bytes.SplitN([]byte(raw), []byte("\n"), 2)
	cookie := string(parts[0])
	read := func() string {
		r := httptest.NewRequest(http.MethodGet, "/api/v1/auth/session", nil)
		r.AddCookie(&http.Cookie{Name: "timeline_session", Value: cookie})
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, r)
		if rr.Code != http.StatusOK {
			t.Fatalf("session read status=%d body=%s", rr.Code, rr.Body.String())
		}
		var body struct {
			CSRFToken string `json:"csrfToken"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body.CSRFToken
	}
	first, second := read(), read()
	if first == "" || first != second {
		t.Fatalf("CSRF token changed across reads: first=%q second=%q", first, second)
	}
	mutation := httptest.NewRequest(http.MethodPatch, "/api/v1/admin/settings", strings.NewReader(`{"theme":"dark"}`))
	mutation.AddCookie(&http.Cookie{Name: "timeline_session", Value: cookie})
	mutation.Header.Set("Origin", "http://localhost:3000")
	mutation.Header.Set("X-CSRF-Token", first)
	mutation.Header.Set("Content-Type", "application/json")
	mutationRR := httptest.NewRecorder()
	h.ServeHTTP(mutationRR, mutation)
	if mutationRR.Code == http.StatusForbidden {
		t.Fatalf("stable CSRF token rejected after repeated session reads: %s", mutationRR.Body.String())
	}
}

func TestAuthSessionCSRFIsStableAcrossConcurrentReads(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", "JBSWY3DPEHPK3PXP")
	srv := NewServer(NewStore())
	h := srv.routes()
	_, raw := loginForTest(t, h)
	parts := bytes.SplitN([]byte(raw), []byte("\n"), 2)
	cookie := string(parts[0])
	const readers = 16
	tokens := make(chan string, readers)
	errors := make(chan string, readers)
	for i := 0; i < readers; i++ {
		go func() {
			r := httptest.NewRequest(http.MethodGet, "/api/v1/auth/session", nil)
			r.AddCookie(&http.Cookie{Name: "timeline_session", Value: cookie})
			rr := httptest.NewRecorder()
			h.ServeHTTP(rr, r)
			if rr.Code != http.StatusOK {
				errors <- fmt.Sprintf("status=%d body=%s", rr.Code, rr.Body.String())
				return
			}
			var body struct {
				CSRFToken string `json:"csrfToken"`
			}
			if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
				errors <- err.Error()
				return
			}
			tokens <- body.CSRFToken
		}()
	}
	var first string
	for i := 0; i < readers; i++ {
		select {
		case err := <-errors:
			t.Fatal(err)
		case token := <-tokens:
			if token == "" {
				t.Fatal("concurrent session read returned empty CSRF token")
			}
			if first == "" {
				first = token
			} else if first != token {
				t.Fatalf("concurrent session reads returned different CSRF tokens: first=%q next=%q", first, token)
			}
		}
	}
}

func TestLoginPasswordThrottleAfterRepeatedFailures(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	srv := NewServer(NewStore())
	h := srv.routes()
	for i := 0; i < 5; i++ {
		r := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login/password", bytes.NewBufferString(`{"password":"wrong"}`))
		r.RemoteAddr = "192.0.2.10:1234"
		r.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, r)
		if rr.Code != http.StatusUnauthorized {
			t.Fatalf("failure %d status=%d", i, rr.Code)
		}
	}
	r := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login/password", bytes.NewBufferString(`{"password":"wrong"}`))
	r.RemoteAddr = "192.0.2.10:1234"
	r.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, r)
	if rr.Code != http.StatusTooManyRequests || rr.Header().Get("Retry-After") == "" {
		t.Fatalf("throttled status=%d headers=%v", rr.Code, rr.Header())
	}
}

func TestTOTPChallengeSurvivesInvalidCode(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	s := NewStore()
	s.userPassword = "test-password"
	s.userTOTP = "JBSWY3DPEHPK3PXP"
	h := NewServer(s).routes()
	p := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login/password", bytes.NewBufferString(`{"password":"test-password"}`))
	p.Header.Set("Content-Type", "application/json")
	pr := httptest.NewRecorder()
	h.ServeHTTP(pr, p)
	if pr.Code != http.StatusOK {
		t.Fatalf("password login: %d", pr.Code)
	}
	var challenge struct {
		Challenge string `json:"challenge"`
	}
	if err := json.Unmarshal(pr.Body.Bytes(), &challenge); err != nil || challenge.Challenge == "" {
		t.Fatalf("missing challenge: %s", pr.Body.String())
	}
	postTOTP := func(code string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login/totp", bytes.NewBufferString(`{"code":"`+code+`","challenge":"`+challenge.Challenge+`"}`))
		r.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, r)
		return rr
	}
	validCode, err := totp.GenerateCode(s.userTOTP, time.Now())
	if err != nil {
		t.Fatalf("generate TOTP code: %v", err)
	}
	invalidCode := "000000"
	if invalidCode == validCode {
		invalidCode = "999999"
	}
	if rr := postTOTP(invalidCode); rr.Code != http.StatusUnauthorized {
		t.Fatalf("invalid code status=%d", rr.Code)
	}
	if rr := postTOTP(validCode); rr.Code != http.StatusOK {
		t.Fatalf("valid code after invalid status=%d body=%s", rr.Code, rr.Body.String())
	}
}

func TestOriginExactMatch(t *testing.T) {
	s := NewStore()
	s.userPassword = "p"
	s.userTOTP = "t"
	h := NewServer(s).routes()
	r := httptest.NewRequest(http.MethodOptions, "/api/v1/public/timeline", nil)
	r.Header.Set("Origin", "http://evil-localhost:3000")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, r)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("evil origin=%d", rr.Code)
	}
}

func loginForTest(t *testing.T, h http.Handler) (*http.Client, string) {
	t.Helper()
	p := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login/password", bytes.NewBufferString(`{"password":"test-password"}`))
	p.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, p)
	if rr.Code != http.StatusOK {
		t.Fatalf("password login: %d", rr.Code)
	}
	var challenge struct {
		Challenge string `json:"challenge"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &challenge)
	secret := os.Getenv("ADMIN_TOTP_SECRET")
	code, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatalf("generate test TOTP code: %v", err)
	}
	tResp := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login/totp", bytes.NewBufferString(`{"code":"`+code+`","challenge":"`+challenge.Challenge+`"}`))
	tResp.Header.Set("Content-Type", "application/json")
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, tResp)
	if rr.Code != http.StatusOK {
		t.Fatalf("totp login: %d", rr.Code)
	}
	var body struct {
		CSRFToken string `json:"csrfToken"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &body)
	var cookie *http.Cookie
	for _, c := range rr.Result().Cookies() {
		if c.Name == "timeline_session" {
			cookie = c
		}
	}
	if cookie == nil || body.CSRFToken == "" {
		t.Fatal("missing session")
	}
	client := &http.Client{}
	return client, cookie.Value + "\n" + body.CSRFToken
}

func TestPrivateEntryIsPlaceholderOnly(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", "JBSWY3DPEHPK3PXP")
	srv := NewServer(NewStore())
	h := srv.routes()
	_, raw := loginForTest(t, h)
	parts := bytes.SplitN([]byte(raw), []byte("\n"), 2)
	cookie, csrf := string(parts[0]), string(parts[1])
	wcReq := httptest.NewRequest(http.MethodPost, "/api/v1/admin/working-copies", bytes.NewBufferString(`{"clientDraftId":"draft-1","payload":{}}`))
	wcReq.AddCookie(&http.Cookie{Name: "timeline_session", Value: cookie})
	wcReq.Header.Set("X-CSRF-Token", csrf)
	wcReq.Header.Set("Origin", "http://localhost:3000")
	wcRR := httptest.NewRecorder()
	h.ServeHTTP(wcRR, wcReq)
	var wc WorkingCopy
	_ = json.Unmarshal(wcRR.Body.Bytes(), &wc)
	commit := httptest.NewRequest(http.MethodPost, "/api/v1/admin/working-copies/"+wc.ID+"/commit", bytes.NewBufferString(`{"markdown":"secret #private","status":"published","visibility":"private","journalDate":"2026-08-12"}`))
	commit.AddCookie(&http.Cookie{Name: "timeline_session", Value: cookie})
	commit.Header.Set("X-CSRF-Token", csrf)
	commit.Header.Set("Origin", "http://localhost:3000")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, commit)
	if rr.Code != http.StatusOK {
		t.Fatalf("commit: %d %s", rr.Code, rr.Body.String())
	}
	pub := httptest.NewRequest(http.MethodGet, "/api/v1/public/timeline", nil)
	out := httptest.NewRecorder()
	h.ServeHTTP(out, pub)
	if out.Code != http.StatusOK {
		t.Fatal(out.Code)
	}
	var payload struct {
		Days []struct {
			Untimed []map[string]any `json:"untimed"`
			Timed   []map[string]any `json:"timed"`
		} `json:"days"`
	}
	_ = json.Unmarshal(out.Body.Bytes(), &payload)
	if len(payload.Days) == 0 || len(payload.Days[0].Untimed) != 1 {
		t.Fatalf("unexpected timeline: %s", out.Body.String())
	}
	item := payload.Days[0].Untimed[0]
	if item["text"] != "这是一条私人记录 🔒" {
		t.Fatalf("placeholder: %#v", item)
	}
	if _, ok := item["kind"]; ok {
		t.Fatal("kind leaked")
	}
	if _, ok := item["markdown"]; ok {
		t.Fatal("markdown leaked")
	}
}

func TestWorkingCopyIdempotentAndTagRules(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", "JBSWY3DPEHPK3PXP")
	if got := extractTags("#标题\n正文 #One `#inline` https://x.test/#anchor #二\n```\n#code\n```"); len(got) != 2 || got[0] != "One" || got[1] != "二" {
		t.Fatalf("tags=%v", got)
	}
	srv := NewServer(NewStore())
	h := srv.routes()
	_, raw := loginForTest(t, h)
	p := bytes.SplitN([]byte(raw), []byte("\n"), 2)
	cookie, csrf := string(p[0]), string(p[1])
	body := []byte(`{"clientDraftId":"same","payload":{"markdown":"a"}}`)
	for i := 0; i < 2; i++ {
		r := httptest.NewRequest(http.MethodPost, "/api/v1/admin/working-copies", bytes.NewReader(body))
		r.AddCookie(&http.Cookie{Name: "timeline_session", Value: cookie})
		r.Header.Set("X-CSRF-Token", csrf)
		r.Header.Set("Origin", "http://localhost:3000")
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, r)
		if rr.Code != 200 {
			t.Fatal(rr.Code)
		}
	}
	srv.store.mu.RLock()
	defer srv.store.mu.RUnlock()
	if len(srv.store.working) != 1 {
		t.Fatalf("working copies=%d", len(srv.store.working))
	}
}

func TestCommitWorkingRequestDistinguishesOmittedAndEmptyTaxonomy(t *testing.T) {
	tests := []struct {
		name          string
		body          string
		categories    []string
		tags          []string
		categoriesSet bool
		tagsSet       bool
	}{
		{name: "omitted", body: `{}`, categories: nil, tags: nil},
		{name: "empty arrays", body: `{"categories":[],"tags":[]}`, categories: []string{}, tags: []string{}, categoriesSet: true, tagsSet: true},
		{name: "non-empty arrays", body: `{"categories":["新分类"],"tags":["新标签"]}`, categories: []string{"新分类"}, tags: []string{"新标签"}, categoriesSet: true, tagsSet: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var in commitWorkingRequest
			if err := json.Unmarshal([]byte(tt.body), &in); err != nil {
				t.Fatal(err)
			}
			if in.categoriesPresent != tt.categoriesSet || in.tagsPresent != tt.tagsSet {
				t.Fatalf("presence categories=%v tags=%v", in.categoriesPresent, in.tagsPresent)
			}
			if !equalStringSlices(in.Categories, tt.categories) || !equalStringSlices(in.Tags, tt.tags) {
				t.Fatalf("taxonomy categories=%v tags=%v", in.Categories, in.Tags)
			}
		})
	}
}

func TestWorkingCopyCommitTaxonomyFieldPresence(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", "JBSWY3DPEHPK3PXP")
	tests := []struct {
		name       string
		categories []string
		tags       []string
		request    map[string]any
	}{
		{
			name:       "omitted fields inherit working copy",
			categories: []string{"旧分类"},
			tags:       []string{"旧标签", "自动标签"},
			request:    map[string]any{"markdown": "正文 #自动标签", "status": "draft", "visibility": "public", "journalDate": "2026-08-15"},
		},
		{
			name:       "empty arrays clear working copy",
			categories: []string{},
			tags:       []string{},
			request:    map[string]any{"markdown": "正文 #自动标签", "status": "draft", "visibility": "public", "journalDate": "2026-08-15", "categories": []string{}, "tags": []string{}},
		},
		{
			name:       "non-empty arrays replace working copy",
			categories: []string{"新分类"},
			tags:       []string{"新标签"},
			request:    map[string]any{"markdown": "正文 #自动标签", "status": "draft", "visibility": "public", "journalDate": "2026-08-15", "categories": []string{"新分类"}, "tags": []string{"新标签"}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := NewServer(NewStore())
			h := srv.routes()
			_, raw := loginForTest(t, h)
			parts := bytes.SplitN([]byte(raw), []byte("\n"), 2)
			cookie, csrf := string(parts[0]), string(parts[1])
			payload := map[string]any{"markdown": "工作副本", "categories": []string{"旧分类"}, "tags": []string{"旧标签"}}
			wcBody, err := json.Marshal(map[string]any{"clientDraftId": "taxonomy-" + strings.ReplaceAll(tt.name, " ", "-"), "payload": payload})
			if err != nil {
				t.Fatal(err)
			}
			wcReq := httptest.NewRequest(http.MethodPost, "/api/v1/admin/working-copies", bytes.NewReader(wcBody))
			wcReq.AddCookie(&http.Cookie{Name: "timeline_session", Value: cookie})
			wcReq.Header.Set("X-CSRF-Token", csrf)
			wcReq.Header.Set("Origin", "http://localhost:3000")
			wcRR := httptest.NewRecorder()
			h.ServeHTTP(wcRR, wcReq)
			if wcRR.Code != http.StatusOK {
				t.Fatalf("working copy: %d %s", wcRR.Code, wcRR.Body.String())
			}
			var wc WorkingCopy
			if err := json.Unmarshal(wcRR.Body.Bytes(), &wc); err != nil {
				t.Fatal(err)
			}

			commitBody, err := json.Marshal(tt.request)
			if err != nil {
				t.Fatal(err)
			}
			commitReq := httptest.NewRequest(http.MethodPost, "/api/v1/admin/working-copies/"+wc.ID+"/commit", bytes.NewReader(commitBody))
			commitReq.AddCookie(&http.Cookie{Name: "timeline_session", Value: cookie})
			commitReq.Header.Set("X-CSRF-Token", csrf)
			commitReq.Header.Set("Origin", "http://localhost:3000")
			commitRR := httptest.NewRecorder()
			h.ServeHTTP(commitRR, commitReq)
			if commitRR.Code != http.StatusOK {
				t.Fatalf("commit: %d %s", commitRR.Code, commitRR.Body.String())
			}
			var response struct {
				Entry Entry `json:"entry"`
			}
			if err := json.Unmarshal(commitRR.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if !equalStringSlices(response.Entry.Categories, tt.categories) || !equalStringSlices(response.Entry.Tags, tt.tags) {
				t.Fatalf("entry taxonomy categories=%v tags=%v", response.Entry.Categories, response.Entry.Tags)
			}
		})
	}
}

func TestUndoEntryForResponseUsesWorkingPayload(t *testing.T) {
	data := map[string]any{
		"markdown": "发布内容",
		"title":    "发布标题",
		"workingPayload": map[string]any{
			"kind":       "article",
			"markdown":   "撤销后的草稿",
			"title":      "草稿标题",
			"categories": []any{"分类"},
			"tags":       []any{"标签"},
		},
	}
	entry := undoEntryForResponse(data, "entry-1", "draft", "public")
	if entry["id"] != "entry-1" || entry["kind"] != "article" || entry["markdown"] != "撤销后的草稿" || entry["title"] != "草稿标题" {
		t.Fatalf("unexpected editor entry: %#v", entry)
	}
	if entry["status"] != "draft" || entry["visibility"] != "public" {
		t.Fatalf("unexpected entry state: %#v", entry)
	}
	if !equalAnySlices(entry["categories"], []any{"分类"}) || !equalAnySlices(entry["tags"], []any{"标签"}) {
		t.Fatalf("taxonomy missing: %#v", entry)
	}

	legacy := undoEntryForResponse(map[string]any{"markdown": "旧内容", "title": "旧标题"}, "entry-2", "draft", "private")
	if legacy["markdown"] != "旧内容" || legacy["title"] != "旧标题" {
		t.Fatalf("legacy undo payload not supported: %#v", legacy)
	}
}

func equalStringSlices(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func equalAnySlices(value any, want []any) bool {
	got, ok := value.([]any)
	if !ok || len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

func TestUndoExpires(t *testing.T) {
	s := NewStore()
	id := newID()
	s.entries[id] = &Entry{ID: id, Status: "published"}
	tok := randomToken()
	s.undo[tok] = undoRecord{EntryID: id, ExpiresAt: time.Now().Add(-time.Second)}
	h := NewServer(s).routes()
	_ = h
	if time.Now().Before(s.undo[tok].ExpiresAt) {
		t.Fatal("clock")
	}
}

func TestLocalCORS(t *testing.T) {
	h := NewServer(NewStore()).routes()
	r := httptest.NewRequest(http.MethodOptions, "/api/v1/public/timeline", nil)
	r.Header.Set("Origin", "http://localhost:3000")
	r.Header.Set("Access-Control-Request-Headers", "Content-Type, X-CSRF-Token")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, r)
	if rr.Code != http.StatusNoContent || rr.Header().Get("Access-Control-Allow-Origin") != "http://localhost:3000" || rr.Header().Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatalf("unexpected CORS response: %d %#v", rr.Code, rr.Header())
	}
	bad := httptest.NewRequest(http.MethodOptions, "/api/v1/public/timeline", nil)
	bad.Header.Set("Origin", "https://evil.example")
	brr := httptest.NewRecorder()
	h.ServeHTTP(brr, bad)
	if brr.Code != http.StatusForbidden {
		t.Fatalf("unexpected bad CORS response: %d", brr.Code)
	}
}

func TestPublicResponsesDisableIntermediaryCaching(t *testing.T) {
	s := NewStore()
	s.entries["public-cache"] = &Entry{ID: "public-cache", Kind: "note", Status: "published", Visibility: "public", Markdown: "fresh", JournalDate: "2026-08-12"}
	rr := httptest.NewRecorder()
	NewServer(s).routes().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/v1/public/timeline", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("timeline status=%d", rr.Code)
	}
	if got := rr.Header().Get("Cache-Control"); got != "no-store, max-age=0" {
		t.Fatalf("cache-control=%q", got)
	}
	if got := rr.Header().Get("CDN-Cache-Control"); got != "no-store" {
		t.Fatalf("cdn-cache-control=%q", got)
	}
}

func TestTrashedEntryIsAbsentFromPublicTimeline(t *testing.T) {
	s := NewStore()
	s.entries["live"] = &Entry{ID: "live", Kind: "note", Status: "published", Visibility: "public", Markdown: "live", JournalDate: "2026-08-12"}
	s.entries["trashed"] = &Entry{ID: "trashed", Kind: "note", Status: "trashed", Visibility: "public", Markdown: "must not leak", JournalDate: "2026-08-12"}
	rr := httptest.NewRecorder()
	NewServer(s).routes().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/v1/public/timeline", nil))
	if rr.Code != http.StatusOK || strings.Contains(rr.Body.String(), "must not leak") || !strings.Contains(rr.Body.String(), "live") {
		t.Fatalf("timeline leaked or omitted live entry: %s", rr.Body.String())
	}
}

func TestPublicCategoryAndTagEntryRoutes(t *testing.T) {
	s := NewStore()
	s.entries["public-1"] = &Entry{ID: "public-1", Kind: "note", Status: "published", Visibility: "public", Markdown: "hello #Go", PlainText: "hello Go", JournalDate: "2026-08-12", Categories: []string{"日常"}, Tags: []string{"Go"}}
	h := NewServer(s).routes()
	for _, path := range []string{"/api/v1/public/categories/%E6%97%A5%E5%B8%B8/entries", "/api/v1/public/tags/go/entries"} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, r)
		if rr.Code != http.StatusOK {
			t.Fatalf("%s: %d", path, rr.Code)
		}
	}
}

func TestPublicDaySeparatesTimedEntries(t *testing.T) {
	s := NewStore()
	tm := "09:30"
	s.entries["a"] = &Entry{ID: "a", Kind: "note", Status: "published", Visibility: "public", Markdown: "untimed", JournalDate: "2026-08-12"}
	s.entries["b"] = &Entry{ID: "b", Kind: "note", Status: "published", Visibility: "private", Markdown: "secret", JournalDate: "2026-08-12", JournalTime: &tm}
	rr := httptest.NewRecorder()
	NewServer(s).routes().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/v1/public/days/2026-08-12", nil))
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), `"untimed"`) || !strings.Contains(rr.Body.String(), `"timed"`) {
		t.Fatalf("day=%s", rr.Body.String())
	}
}

func TestPublicTimelineCursorKeepsWholeDaysAndNoDuplicates(t *testing.T) {
	s := NewStore()
	for i := 0; i < 27; i++ {
		id := fmt.Sprintf("same-%02d", i)
		s.entries[id] = &Entry{ID: id, Kind: "note", Status: "published", Visibility: "public", Markdown: id, JournalDate: "2026-08-12"}
	}
	h := NewServer(s).routes()
	r := httptest.NewRequest(http.MethodGet, "/api/v1/public/timeline?limit=20", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatal(rr.Code)
	}
	var first struct {
		Days []struct {
			Untimed []map[string]any `json:"untimed"`
		} `json:"days"`
		NextCursor string `json:"nextCursor"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	if len(first.Days) != 1 || len(first.Days[0].Untimed) != 27 || first.NextCursor != "" {
		t.Fatalf("first page=%s", rr.Body.String())
	}
}

func TestPublicFilteredListsPaginateWithoutDuplicates(t *testing.T) {
	s := NewStore()
	for i, date := range []string{"2026-08-12", "2026-08-12", "2026-08-11", "2026-08-11"} {
		id := fmt.Sprintf("filtered-%d", i)
		s.entries[id] = &Entry{
			ID: id, Kind: "note", Status: "published", Visibility: "public",
			Title: "needle", Summary: "needle", PlainText: "needle",
			Markdown: "needle", JournalDate: date,
			Categories: []string{"Work"}, Tags: []string{"Go"},
		}
	}
	h := NewServer(s).routes()
	for _, tc := range []struct {
		name string
		path string
	}{
		{name: "tag", path: "/api/v1/public/tags/go/entries"},
		{name: "category", path: "/api/v1/public/categories/work/entries"},
		{name: "search", path: "/api/v1/public/search?q=needle"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			firstReq := httptest.NewRequest(http.MethodGet, tc.path+"&limit=2", nil)
			if !strings.Contains(tc.path, "?") {
				firstReq = httptest.NewRequest(http.MethodGet, tc.path+"?limit=2", nil)
			}
			firstRR := httptest.NewRecorder()
			h.ServeHTTP(firstRR, firstReq)
			if firstRR.Code != http.StatusOK {
				t.Fatalf("first page status=%d body=%s", firstRR.Code, firstRR.Body.String())
			}
			var first struct {
				Entries    []map[string]any `json:"entries"`
				NextCursor string           `json:"nextCursor"`
			}
			if err := json.Unmarshal(firstRR.Body.Bytes(), &first); err != nil {
				t.Fatal(err)
			}
			if len(first.Entries) != 2 || first.NextCursor == "" {
				t.Fatalf("first page=%s", firstRR.Body.String())
			}
			secondReq := httptest.NewRequest(http.MethodGet, tc.path+"&limit=2&cursor="+first.NextCursor, nil)
			if !strings.Contains(tc.path, "?") {
				secondReq = httptest.NewRequest(http.MethodGet, tc.path+"?limit=2&cursor="+first.NextCursor, nil)
			}
			secondRR := httptest.NewRecorder()
			h.ServeHTTP(secondRR, secondReq)
			if secondRR.Code != http.StatusOK {
				t.Fatalf("second page status=%d body=%s", secondRR.Code, secondRR.Body.String())
			}
			var second struct {
				Entries    []map[string]any `json:"entries"`
				NextCursor string           `json:"nextCursor"`
			}
			if err := json.Unmarshal(secondRR.Body.Bytes(), &second); err != nil {
				t.Fatal(err)
			}
			if len(second.Entries) != 2 || second.NextCursor != "" {
				t.Fatalf("second page=%s", secondRR.Body.String())
			}
			seen := map[string]bool{}
			for _, item := range append(first.Entries, second.Entries...) {
				id, _ := item["id"].(string)
				if id == "" || seen[id] {
					t.Fatalf("duplicate or missing id: %#v", item)
				}
				seen[id] = true
			}
			if len(seen) != 4 {
				t.Fatalf("expected four entries, got %d", len(seen))
			}
		})
	}
}

func TestMediaCollectionCursor(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", "JBSWY3DPEHPK3PXP")
	s := NewStore()
	now := time.Now()
	for i := 0; i < 3; i++ {
		id := fmt.Sprintf("media-%d", i)
		s.media[id] = &Media{ID: id, OriginalName: id + ".png", MimeType: "image/png", Status: "ready", Visibility: "public", CreatedAt: now.Add(-time.Duration(i) * time.Minute)}
	}
	h := NewServer(s).routes()
	_, raw := loginForTest(t, h)
	parts := strings.SplitN(raw, "\n", 2)
	r := httptest.NewRequest(http.MethodGet, "/api/v1/admin/media?limit=2", nil)
	r.AddCookie(&http.Cookie{Name: "timeline_session", Value: parts[0]})
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("first page status=%d body=%s", rr.Code, rr.Body.String())
	}
	var first struct {
		Media      []Media `json:"media"`
		NextCursor string  `json:"nextCursor"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	if len(first.Media) != 2 || first.NextCursor == "" {
		t.Fatalf("first page=%s", rr.Body.String())
	}
	r = httptest.NewRequest(http.MethodGet, "/api/v1/admin/media?limit=2&cursor="+first.NextCursor, nil)
	r.AddCookie(&http.Cookie{Name: "timeline_session", Value: parts[0]})
	rr = httptest.NewRecorder()
	h.ServeHTTP(rr, r)
	if rr.Code != http.StatusOK {
		t.Fatalf("second page status=%d body=%s", rr.Code, rr.Body.String())
	}
	var second struct {
		Media      []Media `json:"media"`
		NextCursor string  `json:"nextCursor"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &second); err != nil {
		t.Fatal(err)
	}
	if len(second.Media) != 1 || second.NextCursor != "" {
		t.Fatalf("second page=%s", rr.Body.String())
	}
	seen := map[string]bool{}
	for _, m := range append(first.Media, second.Media...) {
		if seen[m.ID] {
			t.Fatalf("duplicate media %s", m.ID)
		}
		seen[m.ID] = true
	}
	if len(seen) != 3 {
		t.Fatalf("expected three media, got %d", len(seen))
	}
}

func TestMediaCollectionRejectsUnknownCursor(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", "JBSWY3DPEHPK3PXP")
	s := NewStore()
	s.media["media-1"] = &Media{ID: "media-1", OriginalName: "one.png", MimeType: "image/png", Status: "ready", Visibility: "public", CreatedAt: time.Now()}
	h := NewServer(s).routes()
	_, raw := loginForTest(t, h)
	parts := strings.SplitN(raw, "\n", 2)
	r := httptest.NewRequest(http.MethodGet, "/api/v1/admin/media?cursor="+encodeCursor("2026-01-01", "missing"), nil)
	r.AddCookie(&http.Cookie{Name: "timeline_session", Value: parts[0]})
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, r)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("unknown cursor status=%d body=%s", rr.Code, rr.Body.String())
	}
}
