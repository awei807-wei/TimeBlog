package main

import (
	"bytes"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeRetainsUnknownFieldsButRejectsOversizeAndTrailingJSON(t *testing.T) {
	type payload struct {
		Known string `json:"known"`
	}

	unknown := httptest.NewRequest("POST", "/", strings.NewReader(`{"known":"ok","future":true}`))
	var decoded payload
	if err := decode(unknown, &decoded); err != nil || decoded.Known != "ok" {
		t.Fatalf("legacy decode should retain unknown-field compatibility: value=%#v err=%v", decoded, err)
	}

	second := httptest.NewRequest("POST", "/", strings.NewReader(`{"known":"ok"}{"known":"second"}`))
	if err := decode(second, &payload{}); err == nil {
		t.Fatal("legacy decode must reject a second JSON value")
	}

	trailing := httptest.NewRequest("POST", "/", strings.NewReader(`{"known":"ok"} trailing`))
	if err := decode(trailing, &payload{}); err == nil {
		t.Fatal("legacy decode must reject non-whitespace trailing content")
	}

	const maxBodyBytes = 2 << 20
	prefix, suffix := `{"known":"`, `"}`
	boundaryBody := prefix + strings.Repeat("x", maxBodyBytes-len(prefix)-len(suffix)) + suffix
	boundary := httptest.NewRequest("POST", "/", strings.NewReader(boundaryBody))
	if err := decode(boundary, &payload{}); err != nil {
		t.Fatalf("legacy decode rejected an exact 2 MiB body: %v", err)
	}

	oversizeBody := prefix + strings.Repeat("x", maxBodyBytes-len(prefix)-len(suffix)+1) + suffix
	oversize := httptest.NewRequest("POST", "/", strings.NewReader(oversizeBody))
	if err := decode(oversize, &payload{}); err == nil {
		t.Fatal("legacy decode must reject bodies larger than 2 MiB")
	}
}

func TestSecureRandomFailuresFailClosed(t *testing.T) {
	previous := secureRandomRead
	defer func() { secureRandomRead = previous }()
	secureRandomRead = func([]byte) error { return errors.New("forced random failure") }

	if !panics(func() { mustRandomBytes(32) }) {
		t.Fatal("mustRandomBytes must fail closed when crypto/rand fails")
	}
	if !panics(func() { randomToken() }) {
		t.Fatal("randomToken must fail closed when crypto/rand fails")
	}
	if !panics(func() { newID() }) {
		t.Fatal("newID must fail closed when crypto/rand fails")
	}
	t.Setenv("TOTP_ENCRYPTION_KEY", "")
	t.Setenv("CONFIG_ENCRYPTION_KEY", "")
	if !panics(func() { newCSRFKey() }) {
		t.Fatal("newCSRFKey must fail closed when crypto/rand fails")
	}
}

func TestMustRandomBytesReturnsRequestedLength(t *testing.T) {
	previous := secureRandomRead
	defer func() { secureRandomRead = previous }()
	secureRandomRead = func(dst []byte) error {
		for i := range dst {
			dst[i] = byte(i + 1)
		}
		return nil
	}
	got := mustRandomBytes(4)
	if !bytes.Equal(got, []byte{1, 2, 3, 4}) {
		t.Fatalf("unexpected random bytes: %v", got)
	}
}

func panics(fn func()) (result bool) {
	defer func() {
		if recover() != nil {
			result = true
		}
	}()
	fn()
	return false
}
