package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSensitiveRecoveryEndpointsRequireStrictJSON(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", securityRecoveryTestTOTP)
	cases := []struct {
		name          string
		path          string
		authenticated bool
	}{
		{name: "start", path: "/api/v1/auth/recovery/totp/start"},
		{name: "complete", path: "/api/v1/auth/recovery/totp/complete"},
		{name: "password change", path: "/api/v1/auth/password/change", authenticated: true},
		{name: "recovery key rotation", path: "/api/v1/auth/recovery/key/rotate", authenticated: true},
	}
	bodies := map[string]string{
		"null":    "null",
		"unknown": `{"unexpected":true}`,
		"trailing": `{}
{}`,
	}
	for _, tc := range cases {
		for bodyName, body := range bodies {
			t.Run(tc.name+"/"+bodyName, func(t *testing.T) {
				srv := NewServer(NewStore())
				h := srv.routes()
				var cookie, csrf string
				if tc.authenticated {
					_, raw := loginForTest(t, h)
					parts := bytes.SplitN([]byte(raw), []byte("\n"), 2)
					cookie, csrf = string(parts[0]), string(parts[1])
				}
				req := httptest.NewRequest(http.MethodPost, tc.path, bytes.NewBufferString(body))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Origin", localAppOrigin)
				req.RemoteAddr = "192.0.2.42:12345"
				if cookie != "" {
					req.AddCookie(&http.Cookie{Name: "timeline_session", Value: cookie})
					req.Header.Set("X-CSRF-Token", csrf)
				}
				rr := httptest.NewRecorder()
				h.ServeHTTP(rr, req)
				if rr.Code != http.StatusBadRequest {
					t.Fatalf("strict JSON status=%d body=%s", rr.Code, rr.Body.String())
				}
			})
		}
	}
}

func TestMemoryTOTPRecoveryChallengeStoresOnlyHash(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", securityRecoveryTestTOTP)
	srv := NewServer(NewStore())
	h := srv.routes()
	request := securityRecoveryJSONRequest(http.MethodPost, "/api/v1/auth/recovery/totp/start", map[string]any{})
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("start status=%d body=%s", response.Code, response.Body.String())
	}
	var body struct {
		Challenge string `json:"challenge"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	challengeHash := tokenHash(body.Challenge)
	srv.store.mu.RLock()
	_, plaintextKeyPresent := srv.store.mfaChallenges[body.Challenge]
	stored, hashKeyPresent := srv.store.mfaChallenges[challengeHash]
	srv.store.mu.RUnlock()
	if plaintextKeyPresent || !hashKeyPresent || stored.ChallengeHash != challengeHash || stored.Purpose != passwordResetChallengePurpose {
		t.Fatalf("memory recovery challenge storage leaked plaintext or lost hash: plaintext=%v hash=%v stored=%+v", plaintextKeyPresent, hashKeyPresent, stored)
	}
}

func TestProblemUsesProblemJSONContentType(t *testing.T) {
	rr := httptest.NewRecorder()
	problem(rr, http.StatusBadRequest, "invalid")
	if got := rr.Header().Get("Content-Type"); got != "application/problem+json; charset=utf-8" {
		t.Fatalf("problem content type=%q", got)
	}
}

func TestMemorySessionCollectionAndActions(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", securityRecoveryTestTOTP)
	srv := NewServer(NewStore())
	h := srv.routes()
	_, rawCurrent := loginForTest(t, h)
	currentParts := bytes.SplitN([]byte(rawCurrent), []byte("\n"), 2)
	currentCookie, currentCSRF := string(currentParts[0]), string(currentParts[1])
	_, rawOther := loginForTest(t, h)
	otherParts := bytes.SplitN([]byte(rawOther), []byte("\n"), 2)
	otherCookie := string(otherParts[0])

	list := func(cookie string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/sessions", nil)
		req.AddCookie(&http.Cookie{Name: "timeline_session", Value: cookie})
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		return rr
	}
	first := list(currentCookie)
	if first.Code != http.StatusOK || first.Header().Get("Cache-Control") != "no-store, max-age=0" {
		t.Fatalf("session list status=%d headers=%v body=%s", first.Code, first.Header(), first.Body.String())
	}
	var firstBody struct {
		Sessions []struct {
			ID      string `json:"id"`
			Current bool   `json:"current"`
		} `json:"sessions"`
	}
	if err := json.Unmarshal(first.Body.Bytes(), &firstBody); err != nil {
		t.Fatal(err)
	}
	if len(firstBody.Sessions) != 2 {
		t.Fatalf("session list=%+v", firstBody.Sessions)
	}
	currentCount := 0
	for _, session := range firstBody.Sessions {
		if session.Current {
			currentCount++
		}
	}
	if currentCount != 1 {
		t.Fatalf("current session flags=%+v", firstBody.Sessions)
	}

	// Expired sessions are not exposed even though they remain in the store.
	srv.store.mu.Lock()
	srv.store.sessions[tokenHash(otherCookie)].IdleExpires = time.Now().Add(-time.Second)
	srv.store.mu.Unlock()
	expired := list(currentCookie)
	var expiredBody struct {
		Sessions []map[string]any `json:"sessions"`
	}
	if err := json.Unmarshal(expired.Body.Bytes(), &expiredBody); err != nil {
		t.Fatal(err)
	}
	if len(expiredBody.Sessions) != 1 {
		t.Fatalf("expired session leaked: %+v", expiredBody.Sessions)
	}
	srv.store.mu.Lock()
	otherSession := srv.store.sessions[tokenHash(otherCookie)]
	otherSession.IdleExpires = time.Now().Add(time.Hour)
	otherSession.AbsoluteExpires = time.Now().Add(-time.Second)
	srv.store.mu.Unlock()
	absoluteExpired := list(currentCookie)
	var absoluteExpiredBody struct {
		Sessions []map[string]any `json:"sessions"`
	}
	if err := json.Unmarshal(absoluteExpired.Body.Bytes(), &absoluteExpiredBody); err != nil {
		t.Fatal(err)
	}
	if len(absoluteExpiredBody.Sessions) != 1 {
		t.Fatalf("absolute-expired session leaked: %+v", absoluteExpiredBody.Sessions)
	}

	// Method and action shape are part of the public contract, before auth.
	for name, methodPath := range map[string][2]string{
		"collection POST":      {http.MethodPost, "/api/v1/auth/sessions"},
		"revoke others DELETE": {http.MethodDelete, "/api/v1/auth/sessions/revoke-others"},
		"session POST":         {http.MethodPost, "/api/v1/auth/sessions/not-an-id"},
		"session GET":          {http.MethodGet, "/api/v1/auth/sessions/not-an-id"},
	} {
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequest(methodPath[0], methodPath[1], nil)
			rr := httptest.NewRecorder()
			h.ServeHTTP(rr, req)
			if rr.Code != http.StatusMethodNotAllowed {
				t.Fatalf("method status=%d body=%s", rr.Code, rr.Body.String())
			}
		})
	}

	revokeOthers := httptest.NewRequest(http.MethodPost, "/api/v1/auth/sessions/revoke-others", nil)
	revokeOthers.AddCookie(&http.Cookie{Name: "timeline_session", Value: currentCookie})
	revokeOthers.Header.Set("Origin", localAppOrigin)
	revokeOthers.Header.Set("X-CSRF-Token", currentCSRF)
	revokeResponse := httptest.NewRecorder()
	h.ServeHTTP(revokeResponse, revokeOthers)
	if revokeResponse.Code != http.StatusOK {
		t.Fatalf("revoke others status=%d body=%s", revokeResponse.Code, revokeResponse.Body.String())
	}
	otherStatus := httptest.NewRecorder()
	otherRequest := httptest.NewRequest(http.MethodGet, "/api/v1/auth/session/status", nil)
	otherRequest.AddCookie(&http.Cookie{Name: "timeline_session", Value: otherCookie})
	h.ServeHTTP(otherStatus, otherRequest)
	if otherStatus.Code != http.StatusUnauthorized {
		t.Fatalf("revoked other session survived: %d", otherStatus.Code)
	}

	_, rawDelete := loginForTest(t, h)
	deleteParts := bytes.SplitN([]byte(rawDelete), []byte("\n"), 2)
	deleteCookie := string(deleteParts[0])
	srv.store.mu.RLock()
	deleteSession := srv.store.sessions[tokenHash(deleteCookie)]
	deleteID := deleteSession.ID
	srv.store.mu.RUnlock()
	deleteRequest := httptest.NewRequest(http.MethodDelete, "/api/v1/auth/sessions/"+deleteID, nil)
	deleteRequest.AddCookie(&http.Cookie{Name: "timeline_session", Value: currentCookie})
	deleteRequest.Header.Set("Origin", localAppOrigin)
	deleteRequest.Header.Set("X-CSRF-Token", currentCSRF)
	deleteResponse := httptest.NewRecorder()
	h.ServeHTTP(deleteResponse, deleteRequest)
	if deleteResponse.Code != http.StatusOK {
		t.Fatalf("delete session status=%d body=%s", deleteResponse.Code, deleteResponse.Body.String())
	}
	deleteStatus := httptest.NewRecorder()
	deleteStatusRequest := httptest.NewRequest(http.MethodGet, "/api/v1/auth/session/status", nil)
	deleteStatusRequest.AddCookie(&http.Cookie{Name: "timeline_session", Value: deleteCookie})
	h.ServeHTTP(deleteStatus, deleteStatusRequest)
	if deleteStatus.Code != http.StatusUnauthorized {
		t.Fatalf("deleted session survived: %d", deleteStatus.Code)
	}
}

func TestAuthSessionEndpointsOnlyAllowGETAndDoNotCache(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", securityRecoveryTestTOTP)
	srv := NewServer(NewStore())
	h := srv.routes()
	_, raw := loginForTest(t, h)
	parts := bytes.SplitN([]byte(raw), []byte("\n"), 2)
	cookie := &http.Cookie{Name: "timeline_session", Value: string(parts[0])}
	for _, path := range []string{"/api/v1/auth/session", "/api/v1/auth/session/status"} {
		t.Run(path+" GET", func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			req.AddCookie(cookie)
			rr := httptest.NewRecorder()
			h.ServeHTTP(rr, req)
			if rr.Code != http.StatusOK {
				t.Fatalf("GET status=%d body=%s", rr.Code, rr.Body.String())
			}
			if rr.Header().Get("Cache-Control") != "no-store, max-age=0" {
				t.Fatalf("GET cache header=%q", rr.Header().Get("Cache-Control"))
			}
		})
		for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodHead} {
			t.Run(path+" "+method, func(t *testing.T) {
				req := httptest.NewRequest(method, path, nil)
				req.AddCookie(cookie)
				rr := httptest.NewRecorder()
				h.ServeHTTP(rr, req)
				if rr.Code != http.StatusMethodNotAllowed {
					t.Fatalf("%s status=%d body=%s", method, rr.Code, rr.Body.String())
				}
				if rr.Header().Get("Cache-Control") != "no-store, max-age=0" {
					t.Fatalf("%s cache header=%q", method, rr.Header().Get("Cache-Control"))
				}
			})
		}
	}
}

func TestProductionOriginPolicyUsesConfiguredOriginOnly(t *testing.T) {
	t.Setenv("APP_ENV", "production")
	t.Setenv("APP_ORIGIN", "https://blog.example")
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", securityRecoveryTestTOTP)
	h := NewServer(NewStore()).routes()

	configured := httptest.NewRequest(http.MethodOptions, "/api/v1/public/timeline", nil)
	configured.Header.Set("Origin", "https://blog.example")
	configuredResponse := httptest.NewRecorder()
	h.ServeHTTP(configuredResponse, configured)
	if configuredResponse.Code != http.StatusNoContent || configuredResponse.Header().Get("Access-Control-Allow-Origin") != "https://blog.example" {
		t.Fatalf("configured production origin status=%d headers=%v", configuredResponse.Code, configuredResponse.Header())
	}

	local := httptest.NewRequest(http.MethodOptions, "/api/v1/public/timeline", nil)
	local.Header.Set("Origin", localAppOrigin)
	localResponse := httptest.NewRecorder()
	h.ServeHTTP(localResponse, local)
	if localResponse.Code != http.StatusForbidden {
		t.Fatalf("localhost production CORS status=%d body=%s", localResponse.Code, localResponse.Body.String())
	}

	start := httptest.NewRequest(http.MethodPost, "/api/v1/auth/recovery/totp/start", bytes.NewBufferString("{}"))
	start.Header.Set("Content-Type", "application/json")
	start.Header.Set("Origin", localAppOrigin)
	startResponse := httptest.NewRecorder()
	h.ServeHTTP(startResponse, start)
	if startResponse.Code != http.StatusForbidden {
		t.Fatalf("localhost production recovery status=%d body=%s", startResponse.Code, startResponse.Body.String())
	}

	_, raw := loginForTest(t, h)
	parts := bytes.SplitN([]byte(raw), []byte("\n"), 2)
	mutation := httptest.NewRequest(http.MethodPost, "/api/v1/auth/password/change", bytes.NewBufferString("null"))
	mutation.AddCookie(&http.Cookie{Name: "timeline_session", Value: string(parts[0])})
	mutation.Header.Set("Content-Type", "application/json")
	mutation.Header.Set("Origin", "https://blog.example")
	mutation.Header.Set("X-CSRF-Token", string(parts[1]))
	mutationResponse := httptest.NewRecorder()
	h.ServeHTTP(mutationResponse, mutation)
	if mutationResponse.Code != http.StatusBadRequest {
		t.Fatalf("configured production mutation status=%d body=%s", mutationResponse.Code, mutationResponse.Body.String())
	}
}
