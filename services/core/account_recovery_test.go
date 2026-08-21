package main

import (
	"bytes"
	"encoding/base32"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync"
	"testing"
)

func TestMemoryAccountRecoveryIsIdempotentAndNoStore(t *testing.T) {
	const currentKey = "current-recovery-key"
	currentHash, err := hashPassword(currentKey)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ACCOUNT_RECOVERY_KEY_HASH", currentHash)
	srv := NewServer(NewStore())
	in := testRecoveryRequest(1)
	in.RecoveryKey = currentKey + "\r\n"

	first := performRecoveryRequest(srv, in)
	if first.Code != http.StatusOK {
		t.Fatalf("first recovery status=%d body=%s", first.Code, first.Body.String())
	}
	if first.Header().Get("Cache-Control") != "no-store, max-age=0" || first.Header().Get("CDN-Cache-Control") != "no-store" {
		t.Fatalf("sensitive recovery response is cacheable: %v", first.Header())
	}
	second := performRecoveryRequest(srv, in)
	if second.Code != http.StatusOK || second.Body.String() != first.Body.String() {
		t.Fatalf("idempotent retry status=%d first=%s second=%s", second.Code, first.Body.String(), second.Body.String())
	}

	srv.store.mu.RLock()
	password := srv.store.userPassword
	totpSecret := srv.store.userTOTP
	activeHash := srv.store.recoveryKeyHash
	srv.store.mu.RUnlock()
	if password != in.NewPassword || totpSecret != in.NewTOTPSecret || !verifyPassword(in.NewRecoveryKey, activeHash) {
		t.Fatal("recovered credentials do not match the client-generated material")
	}

	conflicting := in
	conflicting.NewPassword = "different-password-value"
	conflict := performRecoveryRequest(srv, conflicting)
	if conflict.Code != http.StatusConflict {
		t.Fatalf("operation token reuse status=%d body=%s", conflict.Code, conflict.Body.String())
	}
}

func TestMemoryAccountRecoverySerializesDifferentOperations(t *testing.T) {
	const currentKey = "concurrent-current-recovery-key"
	currentHash, err := hashPassword(currentKey)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("ACCOUNT_RECOVERY_KEY_HASH", currentHash)
	srv := NewServer(NewStore())
	requests := []accountRecoveryRequest{testRecoveryRequest(2), testRecoveryRequest(3)}
	requests[0].RecoveryKey = currentKey
	requests[1].RecoveryKey = currentKey

	statuses := make([]int, len(requests))
	start := make(chan struct{})
	var group sync.WaitGroup
	for index := range requests {
		group.Add(1)
		go func(index int) {
			defer group.Done()
			<-start
			statuses[index] = performRecoveryRequest(srv, requests[index]).Code
		}(index)
	}
	close(start)
	group.Wait()
	slices.Sort(statuses)
	if !slices.Equal(statuses, []int{http.StatusOK, http.StatusUnauthorized}) {
		t.Fatalf("concurrent recovery statuses=%v", statuses)
	}
}

func testRecoveryRequest(seed byte) accountRecoveryRequest {
	totpBytes := bytes.Repeat([]byte{seed}, 20)
	return accountRecoveryRequest{
		RecoveryKey:    "current-recovery-key",
		NewPassword:    "new-password-value-123",
		OperationToken: base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{seed}, 32)),
		NewRecoveryKey: base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{seed + 10}, 32)),
		NewTOTPSecret:  base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(totpBytes),
	}
}

func performRecoveryRequest(srv *Server, in accountRecoveryRequest) *httptest.ResponseRecorder {
	body, _ := json.Marshal(in)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/recovery/account", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://localhost:3000")
	req.RemoteAddr = "192.0.2.10:12345"
	rr := httptest.NewRecorder()
	srv.recoverAccount(rr, req)
	return rr
}
