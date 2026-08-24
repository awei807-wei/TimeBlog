package main

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/pquerna/otp/totp"
)

func authSecurityRequest(method, path string, body any, remote string) *http.Request {
	encoded, _ := json.Marshal(body)
	req := httptest.NewRequest(method, path, bytes.NewReader(encoded))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://localhost:3000")
	if remote != "" {
		req.RemoteAddr = remote
	}
	return req
}

func issueAuthSecurityChallenge(t *testing.T, h http.Handler, remote string) string {
	t.Helper()
	req := authSecurityRequest(http.MethodPost, "/api/v1/auth/login/password", map[string]string{"password": "test-password"}, remote)
	response := httptest.NewRecorder()
	h.ServeHTTP(response, req)
	if response.Code != http.StatusOK {
		t.Fatalf("password login status=%d body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		Challenge string `json:"challenge"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil || payload.Challenge == "" {
		t.Fatalf("missing login challenge: err=%v body=%s", err, response.Body.String())
	}
	return payload.Challenge
}

func authSecurityTOTPResponse(h http.Handler, challenge, code, remote string) *httptest.ResponseRecorder {
	request := authSecurityRequest(http.MethodPost, "/api/v1/auth/login/totp", map[string]string{
		"challenge": challenge,
		"code":      code,
	}, remote)
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	return response
}

func TestMemoryLoginTOTPRejectsSameStepAcrossChallenges(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", securityRecoveryTestTOTP)
	t.Setenv("APP_ENV", "")
	t.Setenv("SESSION_COOKIE_SECURE", "")
	srv := NewServer(NewStore())
	h := srv.routes()
	firstChallenge := issueAuthSecurityChallenge(t, h, "192.0.2.10:10001")
	secondChallenge := issueAuthSecurityChallenge(t, h, "192.0.2.11:10001")
	code, err := totp.GenerateCode(srv.store.userTOTP, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if response := authSecurityTOTPResponse(h, firstChallenge, code, "192.0.2.12:10001"); response.Code != http.StatusOK {
		t.Fatalf("first TOTP status=%d body=%s", response.Code, response.Body.String())
	}
	if response := authSecurityTOTPResponse(h, secondChallenge, code, "192.0.2.13:10001"); response.Code != http.StatusUnauthorized {
		t.Fatalf("same-step replay status=%d body=%s", response.Code, response.Body.String())
	}

	srv.store.mu.RLock()
	defer srv.store.mu.RUnlock()
	if len(srv.store.sessions) != 1 {
		t.Fatalf("same TOTP step created %d sessions, want 1", len(srv.store.sessions))
	}
	if !srv.store.totpLastUsedSet {
		t.Fatal("accepted TOTP step was not recorded")
	}
}

func TestMemoryLoginTOTPInvalidCodeKeepsChallenge(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", securityRecoveryTestTOTP)
	srv := NewServer(NewStore())
	h := srv.routes()
	challenge := issueAuthSecurityChallenge(t, h, "192.0.2.14:10001")
	validCode, err := totp.GenerateCode(srv.store.userTOTP, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	invalidCode := "000000"
	if invalidCode == validCode {
		invalidCode = "999999"
	}
	if response := authSecurityTOTPResponse(h, challenge, invalidCode, "192.0.2.15:10001"); response.Code != http.StatusUnauthorized {
		t.Fatalf("invalid TOTP status=%d body=%s", response.Code, response.Body.String())
	}
	if response := authSecurityTOTPResponse(h, challenge, validCode, "192.0.2.16:10001"); response.Code != http.StatusOK {
		t.Fatalf("valid TOTP after invalid status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestMemoryLoginTOTPConcurrentSameChallengeOnlyCreatesOneSession(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", securityRecoveryTestTOTP)
	srv := NewServer(NewStore())
	h := srv.routes()
	challenge := issueAuthSecurityChallenge(t, h, "192.0.2.17:10001")
	code, err := totp.GenerateCode(srv.store.userTOTP, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	responses := make(chan int, 2)
	var wait sync.WaitGroup
	for i, remote := range []string{"192.0.2.18:10001", "192.0.2.19:10001"} {
		wait.Add(1)
		go func(i int, remote string) {
			defer wait.Done()
			responses <- authSecurityTOTPResponse(h, challenge, code, remote).Code
		}(i, remote)
	}
	wait.Wait()
	close(responses)
	accepted := 0
	rejected := 0
	for status := range responses {
		switch status {
		case http.StatusOK:
			accepted++
		case http.StatusUnauthorized:
			rejected++
		default:
			t.Fatalf("unexpected concurrent TOTP status=%d", status)
		}
	}
	if accepted != 1 || rejected != 1 {
		t.Fatalf("concurrent TOTP accepted=%d rejected=%d, want 1/1", accepted, rejected)
	}
	srv.store.mu.RLock()
	defer srv.store.mu.RUnlock()
	if len(srv.store.sessions) != 1 {
		t.Fatalf("concurrent TOTP created %d sessions, want 1", len(srv.store.sessions))
	}
}

func TestSessionCookiePolicyAndCompatibility(t *testing.T) {
	t.Setenv("TRUSTED_PROXY_CIDRS", "127.0.0.1/32")
	t.Setenv("APP_ENV", "")
	t.Setenv("SESSION_COOKIE_SECURE", "")

	devRequest := httptest.NewRequest(http.MethodGet, "http://localhost/", nil)
	if sessionCookieSecure(devRequest) {
		t.Fatal("HTTP development request unexpectedly selected Secure cookie")
	}
	if got := sessionCookieName(false); got != "timeline_session" {
		t.Fatalf("development cookie name=%q", got)
	}

	t.Setenv("APP_ENV", "production")
	productionRequest := httptest.NewRequest(http.MethodGet, "http://localhost/", nil)
	if !sessionCookieSecure(productionRequest) {
		t.Fatal("production request did not select Secure cookie")
	}
	if got := sessionCookieName(true); got != "__Host-timeline_session" {
		t.Fatalf("secure cookie name=%q", got)
	}

	t.Setenv("APP_ENV", "")
	t.Setenv("SESSION_COOKIE_SECURE", "true")
	if !sessionCookieSecure(devRequest) {
		t.Fatal("explicit SESSION_COOKIE_SECURE=true did not select Secure cookie")
	}
	t.Setenv("SESSION_COOKIE_SECURE", "")
	tlsRequest := httptest.NewRequest(http.MethodGet, "https://localhost/", nil)
	tlsRequest.TLS = &tls.ConnectionState{}
	if !sessionCookieSecure(tlsRequest) {
		t.Fatal("TLS request did not select Secure cookie")
	}

	proxyRequest := httptest.NewRequest(http.MethodGet, "http://localhost/", nil)
	proxyRequest.RemoteAddr = "127.0.0.1:12345"
	proxyRequest.Header.Set("X-Forwarded-Proto", "https")
	if !sessionCookieSecure(proxyRequest) {
		t.Fatal("trusted HTTPS proxy did not select Secure cookie")
	}
	proxyRequest.RemoteAddr = "192.0.2.20:12345"
	if sessionCookieSecure(proxyRequest) {
		t.Fatal("untrusted HTTPS proxy selected Secure cookie")
	}

	secureRequest := httptest.NewRequest(http.MethodGet, "/", nil)
	secureRequest.AddCookie(&http.Cookie{Name: "timeline_session", Value: "legacy"})
	secureRequest.AddCookie(&http.Cookie{Name: "__Host-timeline_session", Value: "secure"})
	cookie, err := requestSessionCookie(secureRequest)
	if err != nil || cookie.Value != "secure" {
		t.Fatalf("secure cookie was not preferred: cookie=%v err=%v", cookie, err)
	}
	legacyRequest := httptest.NewRequest(http.MethodGet, "/", nil)
	legacyRequest.AddCookie(&http.Cookie{Name: "timeline_session", Value: "legacy"})
	cookie, err = requestSessionCookie(legacyRequest)
	if err != nil || cookie.Value != "legacy" {
		t.Fatalf("legacy cookie compatibility failed: cookie=%v err=%v", cookie, err)
	}

	response := httptest.NewRecorder()
	clearSessionCookies(response, secureRequest)
	setCookies := response.Result().Cookies()
	if len(setCookies) != 2 {
		t.Fatalf("clear emitted %d cookies, want both names", len(setCookies))
	}
	seen := map[string]bool{}
	for _, setCookie := range setCookies {
		seen[setCookie.Name] = true
		if setCookie.MaxAge >= 0 {
			t.Errorf("clear cookie %q MaxAge=%d", setCookie.Name, setCookie.MaxAge)
		}
	}
	if !seen["timeline_session"] || !seen["__Host-timeline_session"] {
		t.Fatalf("clear cookie names=%v", seen)
	}

	t.Setenv("APP_ENV", "production")
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", securityRecoveryTestTOTP)
	srv := NewServer(NewStore())
	h := srv.routes()
	challenge := issueAuthSecurityChallenge(t, h, "192.0.2.21:10001")
	code, err := totp.GenerateCode(srv.store.userTOTP, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	loginResponse := authSecurityTOTPResponse(h, challenge, code, "192.0.2.22:10001")
	if loginResponse.Code != http.StatusOK {
		t.Fatalf("production TOTP login status=%d body=%s", loginResponse.Code, loginResponse.Body.String())
	}
	var sessionCookie *http.Cookie
	for _, cookie := range loginResponse.Result().Cookies() {
		if cookie.Name == secureSessionCookieName {
			sessionCookie = cookie
			break
		}
	}
	if sessionCookie == nil || !sessionCookie.Secure || sessionCookie.Path != "/" || sessionCookie.Domain != "" || !sessionCookie.HttpOnly {
		t.Fatalf("production session cookie=%v", sessionCookie)
	}
}

func TestMemoryPasswordComparisonRejectsDifferentLengths(t *testing.T) {
	if !constantTimePasswordEqual("secret", "secret") {
		t.Fatal("equal passwords were rejected")
	}
	for _, candidate := range []string{"", "s", "secret-too-long"} {
		if constantTimePasswordEqual(candidate, "secret") {
			t.Fatalf("different password %q was accepted", candidate)
		}
	}
}
