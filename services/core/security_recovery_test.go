package main

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

const securityRecoveryTestTOTP = "JBSWY3DPEHPK3PXP"

func TestValidateTOTPWithStepRecordsMatchedAdjacentStep(t *testing.T) {
	secret := securityRecoveryTestTOTP
	now := time.Unix(1_700_000_001, 0).UTC()
	currentStep := totpStepForTime(now)
	futureStep := currentStep + 1
	code, err := totp.GenerateCodeCustom(secret, time.Unix(futureStep*totpPeriodSeconds, 0).UTC(), totp.ValidateOpts{
		Period:    uint(totpPeriodSeconds),
		Skew:      0,
		Digits:    otp.DigitsSix,
		Algorithm: otp.AlgorithmSHA1,
	})
	if err != nil {
		t.Fatal(err)
	}
	matchedStep, valid, err := validateTOTPWithStep(code, secret, now)
	if err != nil || !valid || matchedStep != futureStep {
		t.Fatalf("future TOTP matched step=%d valid=%v err=%v want=%d", matchedStep, valid, err, futureStep)
	}

	// Exercise the replay guard at the exact boundary: accepting C(n+1) at
	// n must record n+1, so the same code cannot be accepted again at n+1.
	t.Setenv("TOTP_ENCRYPTION_KEY", base64.RawStdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32)))
	encrypted, err := encryptSecret(secret)
	if err != nil {
		t.Fatal(err)
	}
	factors := ownerAuthFactors{TOTPEncrypted: encrypted}
	acceptedStep, err := verifyTOTPFactor(factors, code, time.Unix(currentStep*totpPeriodSeconds+1, 0).UTC(), currentStep-1)
	if err != nil || acceptedStep != futureStep {
		t.Fatalf("boundary verification step=%d err=%v want=%d", acceptedStep, err, futureStep)
	}
	if _, err = verifyTOTPFactor(factors, code, time.Unix(futureStep*totpPeriodSeconds+1, 0).UTC(), acceptedStep); !errors.Is(err, errPasswordResetReplay) {
		t.Fatalf("same adjacent code was reusable at next step: %v", err)
	}
}

func TestRecoveryCommitResolutionRequiresActiveBoundKey(t *testing.T) {
	state := authOperationState{PayloadMAC: "payload", RecoveryKeyID: sql.NullString{String: "key-1", Valid: true}}
	if !authOperationCommitMatches(state, true, recoveryRotationPurpose, "payload", true) {
		t.Fatal("valid recovery operation was not considered committed")
	}
	for name, tc := range map[string]struct {
		state     authOperationState
		found     bool
		payload   string
		keyActive bool
	}{
		"missing operation":       {state: state, found: false, payload: "payload", keyActive: true},
		"payload mismatch":        {state: state, found: true, payload: "other", keyActive: true},
		"missing recovery key id": {state: authOperationState{PayloadMAC: "payload"}, found: true, payload: "payload", keyActive: true},
		"superseded recovery key": {state: state, found: true, payload: "payload", keyActive: false},
	} {
		t.Run(name, func(t *testing.T) {
			if authOperationCommitMatches(tc.state, tc.found, recoveryRotationPurpose, tc.payload, tc.keyActive) {
				t.Fatal("ambiguous recovery commit was incorrectly accepted")
			}
		})
	}

	fullRecovery := recoveryOperationState{RecoveryKeyID: "key-1", PayloadMAC: "payload", KeyActive: true}
	if !recoveryCommitMatches(fullRecovery, true, "payload") {
		t.Fatal("valid full recovery operation was not considered committed")
	}
	fullRecovery.KeyActive = false
	if recoveryCommitMatches(fullRecovery, true, "payload") {
		t.Fatal("full recovery with a superseded key was incorrectly accepted")
	}
	fullRecovery.KeyActive = true
	fullRecovery.RecoveryKeyID = ""
	if recoveryCommitMatches(fullRecovery, true, "payload") {
		t.Fatal("full recovery without a bound key id was incorrectly accepted")
	}
}

func securityRecoveryToken(seed byte) string {
	return base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{seed}, 32))
}

func securityRecoveryJSONRequest(method, path string, body any) *http.Request {
	encoded, _ := json.Marshal(body)
	req := httptest.NewRequest(method, path, bytes.NewReader(encoded))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://localhost:3000")
	req.RemoteAddr = "192.0.2.10:12345"
	return req
}

func TestTOTPPasswordRecoveryMemoryFlowIsOneTimeAndIdempotent(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", securityRecoveryTestTOTP)
	oldRecoveryHash, err := hashPassword("recovery-key")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ACCOUNT_RECOVERY_KEY_HASH", oldRecoveryHash)
	srv := NewServer(NewStore())
	h := srv.routes()
	_, sessionRaw := loginForTest(t, h)
	parts := bytes.SplitN([]byte(sessionRaw), []byte("\n"), 2)
	oldCookie := string(parts[0])

	start := httptest.NewRecorder()
	h.ServeHTTP(start, securityRecoveryJSONRequest(http.MethodPost, "/api/v1/auth/recovery/totp/start", map[string]any{}))
	if start.Code != http.StatusOK || start.Header().Get("Cache-Control") != "no-store, max-age=0" {
		t.Fatalf("start status=%d headers=%v body=%s", start.Code, start.Header(), start.Body.String())
	}
	var startBody struct {
		Challenge string    `json:"challenge"`
		ExpiresAt time.Time `json:"expiresAt"`
	}
	if err := json.Unmarshal(start.Body.Bytes(), &startBody); err != nil {
		t.Fatal(err)
	}
	if !validOpaqueRecoveryToken(startBody.Challenge) || !startBody.ExpiresAt.After(time.Now()) {
		t.Fatalf("invalid challenge response: %+v", startBody)
	}

	code, err := totp.GenerateCode(securityRecoveryTestTOTP, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	reset := map[string]string{
		"challenge":      startBody.Challenge,
		"code":           code,
		"newPassword":    "new-password-value-123",
		"operationToken": securityRecoveryToken(1),
	}
	first := httptest.NewRecorder()
	h.ServeHTTP(first, securityRecoveryJSONRequest(http.MethodPost, "/api/v1/auth/recovery/totp/complete", reset))
	if first.Code != http.StatusOK || first.Header().Get("Cache-Control") != "no-store, max-age=0" {
		t.Fatalf("complete status=%d body=%s", first.Code, first.Body.String())
	}
	second := httptest.NewRecorder()
	h.ServeHTTP(second, securityRecoveryJSONRequest(http.MethodPost, "/api/v1/auth/recovery/totp/complete", reset))
	if second.Code != http.StatusOK || second.Body.String() != first.Body.String() {
		t.Fatalf("idempotent retry status=%d body=%s first=%s", second.Code, second.Body.String(), first.Body.String())
	}
	conflict := map[string]string{}
	for key, value := range reset {
		conflict[key] = value
	}
	conflict["newPassword"] = "different-password-value-123"
	conflictResponse := httptest.NewRecorder()
	h.ServeHTTP(conflictResponse, securityRecoveryJSONRequest(http.MethodPost, "/api/v1/auth/recovery/totp/complete", conflict))
	if conflictResponse.Code != http.StatusConflict {
		t.Fatalf("operation token conflict status=%d body=%s", conflictResponse.Code, conflictResponse.Body.String())
	}

	srv.store.mu.RLock()
	password, totpSecret, recoveryHash := srv.store.userPassword, srv.store.userTOTP, srv.store.recoveryKeyHash
	srv.store.mu.RUnlock()
	if password != reset["newPassword"] || totpSecret != securityRecoveryTestTOTP || recoveryHash != oldRecoveryHash {
		t.Fatalf("TOTP-only reset changed protected factors: password=%q totp=%q recoveryChanged=%v", password, totpSecret, recoveryHash != oldRecoveryHash)
	}
	oldSession := httptest.NewRecorder()
	oldSessionRequest := httptest.NewRequest(http.MethodGet, "/api/v1/auth/session", nil)
	oldSessionRequest.AddCookie(&http.Cookie{Name: "timeline_session", Value: oldCookie})
	h.ServeHTTP(oldSession, oldSessionRequest)
	if oldSession.Code != http.StatusUnauthorized {
		t.Fatalf("old session survived TOTP-only reset: %d", oldSession.Code)
	}
}

func TestTOTPPasswordRecoveryRequiresOriginAndJSON(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", securityRecoveryTestTOTP)
	srv := NewServer(NewStore())
	h := srv.routes()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/recovery/totp/start", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "text/plain")
	req.RemoteAddr = "192.0.2.11:12345"
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("invalid origin/content type status=%d body=%s", rr.Code, rr.Body.String())
	}
}

func TestTOTPPasswordRecoveryConcurrentSameOperationIsIdempotent(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", securityRecoveryTestTOTP)
	srv := NewServer(NewStore())
	h := srv.routes()
	start := httptest.NewRecorder()
	h.ServeHTTP(start, securityRecoveryJSONRequest(http.MethodPost, "/api/v1/auth/recovery/totp/start", map[string]any{}))
	var startBody struct {
		Challenge string `json:"challenge"`
	}
	if err := json.Unmarshal(start.Body.Bytes(), &startBody); err != nil {
		t.Fatal(err)
	}
	requestBody := map[string]string{
		"challenge":      startBody.Challenge,
		"code":           mustSecurityRecoveryCode(t),
		"newPassword":    "concurrent-password-value-123",
		"operationToken": securityRecoveryToken(31),
	}
	statuses := make([]int, 2)
	startGate := make(chan struct{})
	var group sync.WaitGroup
	for index := range statuses {
		group.Add(1)
		go func(index int) {
			defer group.Done()
			<-startGate
			rr := httptest.NewRecorder()
			h.ServeHTTP(rr, securityRecoveryJSONRequest(http.MethodPost, "/api/v1/auth/recovery/totp/complete", requestBody))
			statuses[index] = rr.Code
		}(index)
	}
	close(startGate)
	group.Wait()
	if statuses[0] != http.StatusOK || statuses[1] != http.StatusOK {
		t.Fatalf("concurrent same-operation statuses=%v", statuses)
	}
}

func TestRecoveryThrottleHasIndependentAccountAndIPDimensions(t *testing.T) {
	srv := NewServer(NewStore())
	accountA := httptest.NewRequest(http.MethodPost, "/", nil)
	accountA.RemoteAddr = "192.0.2.20:12345"
	accountB := httptest.NewRequest(http.MethodPost, "/", nil)
	accountB.RemoteAddr = "192.0.2.21:12345"
	for i := 0; i < 5; i++ {
		srv.throttleFailure(accountA, "owner-recovery")
	}
	if srv.throttleAllows(accountB, "owner-recovery") {
		t.Fatal("account-wide recovery bucket did not block a new IP")
	}

	srv = NewServer(NewStore())
	otherAccount := httptest.NewRequest(http.MethodPost, "/", nil)
	otherAccount.RemoteAddr = "192.0.2.20:12345"
	for i := 0; i < 5; i++ {
		srv.throttleFailure(otherAccount, "other-owner-recovery")
	}
	if srv.throttleAllows(accountA, "owner-recovery") {
		t.Fatal("IP-wide recovery bucket did not block a new account")
	}
}

func TestLoggedInPasswordChangeRequiresFactorsAndRevokesSessions(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", securityRecoveryTestTOTP)
	srv := NewServer(NewStore())
	h := srv.routes()
	_, sessionRaw := loginForTest(t, h)
	parts := bytes.SplitN([]byte(sessionRaw), []byte("\n"), 2)
	request := securityRecoveryJSONRequest(http.MethodPost, "/api/v1/auth/password/change", map[string]string{
		"currentPassword": "test-password",
		"code":            mustSecurityRecoveryCode(t),
		"newPassword":     "changed-password-value-123",
	})
	request.AddCookie(&http.Cookie{Name: "timeline_session", Value: string(parts[0])})
	request.Header.Set("X-CSRF-Token", string(parts[1]))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, request)
	if rr.Code != http.StatusOK {
		t.Fatalf("password change status=%d body=%s", rr.Code, rr.Body.String())
	}
	cleared := false
	for _, cookie := range rr.Result().Cookies() {
		if cookie.Name == "timeline_session" && cookie.MaxAge < 0 {
			cleared = true
		}
	}
	if !cleared {
		t.Fatal("password change did not clear the session cookie")
	}
	check := httptest.NewRequest(http.MethodGet, "/api/v1/auth/session", nil)
	check.AddCookie(&http.Cookie{Name: "timeline_session", Value: string(parts[0])})
	checkRR := httptest.NewRecorder()
	h.ServeHTTP(checkRR, check)
	if checkRR.Code != http.StatusUnauthorized {
		t.Fatalf("password change left old session active: %d", checkRR.Code)
	}
}

func TestLoggedInRecoveryKeyRotationIsIdempotentAndPreservesTOTP(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", securityRecoveryTestTOTP)
	oldKey := "current-recovery-key"
	oldHash, err := hashPassword(oldKey)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ACCOUNT_RECOVERY_KEY_HASH", oldHash)
	srv := NewServer(NewStore())
	h := srv.routes()
	_, sessionRaw := loginForTest(t, h)
	parts := bytes.SplitN([]byte(sessionRaw), []byte("\n"), 2)
	newKey := securityRecoveryToken(9)
	requestBody := map[string]string{
		"password":       "test-password",
		"code":           mustSecurityRecoveryCode(t),
		"operationToken": securityRecoveryToken(10),
		"newRecoveryKey": newKey,
	}
	request := securityRecoveryJSONRequest(http.MethodPost, "/api/v1/auth/recovery/key/rotate", requestBody)
	request.AddCookie(&http.Cookie{Name: "timeline_session", Value: string(parts[0])})
	request.Header.Set("X-CSRF-Token", string(parts[1]))
	first := httptest.NewRecorder()
	h.ServeHTTP(first, request)
	if first.Code != http.StatusOK {
		t.Fatalf("recovery key rotation status=%d body=%s", first.Code, first.Body.String())
	}
	secondRequest := securityRecoveryJSONRequest(http.MethodPost, "/api/v1/auth/recovery/key/rotate", requestBody)
	secondRequest.AddCookie(&http.Cookie{Name: "timeline_session", Value: string(parts[0])})
	secondRequest.Header.Set("X-CSRF-Token", string(parts[1]))
	second := httptest.NewRecorder()
	h.ServeHTTP(second, secondRequest)
	if second.Code != http.StatusOK {
		t.Fatalf("recovery key idempotent retry status=%d body=%s", second.Code, second.Body.String())
	}
	srv.store.mu.RLock()
	currentHash, currentTOTP := srv.store.recoveryKeyHash, srv.store.userTOTP
	srv.store.mu.RUnlock()
	if currentHash == oldHash || !verifyPassword(newKey, currentHash) || currentTOTP != securityRecoveryTestTOTP {
		t.Fatal("recovery key rotation did not atomically preserve TOTP and replace the key hash")
	}
}

func mustSecurityRecoveryCode(t *testing.T) string {
	t.Helper()
	code, err := totp.GenerateCode(securityRecoveryTestTOTP, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return code
}
