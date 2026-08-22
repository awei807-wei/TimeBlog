package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
)

const (
	defaultMaxUploadBytes int64 = 200 * 1024 * 1024
	minMaxUploadBytes     int64 = 1 * 1024 * 1024
	maxMaxUploadBytes     int64 = 2 * 1024 * 1024 * 1024
)

// configuredMaxUploadBytes reads the process-level upload limit on demand so
// tests and local operators can change MAX_UPLOAD_BYTES without mutating
// shared server state. Invalid or unreasonable values safely use the default.
func configuredMaxUploadBytes() int64 {
	raw := strings.TrimSpace(os.Getenv("MAX_UPLOAD_BYTES"))
	if raw == "" {
		return defaultMaxUploadBytes
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < minMaxUploadBytes || value > maxMaxUploadBytes {
		return defaultMaxUploadBytes
	}
	return value
}

func jsonResponse(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func problem(w http.ResponseWriter, status int, detail string) {
	w.Header().Set("Content-Type", "application/problem+json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"type": "about:blank", "title": http.StatusText(status), "status": status, "detail": detail})
}

func setNoStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store, max-age=0")
	w.Header().Set("CDN-Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
}

func decode(r *http.Request, dst any) error {
	if r.Body == nil {
		return io.EOF
	}
	return json.NewDecoder(io.LimitReader(r.Body, 2<<20)).Decode(dst)
}

// decodeStrictJSON accepts exactly one JSON object and rejects unknown
// fields, null, arrays, and any second JSON value.  Keep the legacy decoder
// above unchanged: older endpoints intentionally retain their compatibility
// contract while security-sensitive recovery mutations use this stricter
// boundary.
func decodeStrictJSON(r *http.Request, dst any) error {
	if r.Body == nil {
		return io.EOF
	}
	const maxJSONBodyBytes = 2 << 20
	body, err := io.ReadAll(io.LimitReader(r.Body, maxJSONBodyBytes+1))
	if err != nil {
		return err
	}
	if len(body) > maxJSONBodyBytes {
		return errors.New("request body is too large")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	var raw json.RawMessage
	if err := decoder.Decode(&raw); err != nil {
		return err
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return errors.New("request body must be a JSON object")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return errors.New("request body must contain one JSON value")
		}
		return err
	}
	strict := json.NewDecoder(bytes.NewReader(trimmed))
	strict.DisallowUnknownFields()
	return strict.Decode(dst)
}

func tokenHash(v string) string { h := sha256.Sum256([]byte(v)); return hex.EncodeToString(h[:]) }

func randomToken() string { b := make([]byte, 24); _, _ = rand.Read(b); return hex.EncodeToString(b) }

// newCSRFKey derives a dedicated CSRF signing key from a configured secret.
// Persistent deployments already require TOTP_ENCRYPTION_KEY; deriving a
// separate key by domain separation avoids introducing another secret while
// keeping the CSRF construction independent from the TOTP ciphertext.
func newCSRFKey() []byte {
	for _, raw := range []string{os.Getenv("TOTP_ENCRYPTION_KEY"), os.Getenv("CONFIG_ENCRYPTION_KEY")} {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		key, err := base64.RawURLEncoding.DecodeString(raw)
		if err != nil || len(key) != 32 {
			key, err = base64.RawStdEncoding.DecodeString(raw)
		}
		if err == nil && len(key) == 32 {
			h := sha256.Sum256(append([]byte("timeblog/csrf/v1/"), key...))
			return h[:]
		}
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		h := sha256.Sum256([]byte("timeblog/csrf/fallback"))
		return h[:]
	}
	return key
}

func csrfToken(key []byte, sessionToken string) string {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte("session:"))
	_, _ = mac.Write([]byte(sessionToken))
	return hex.EncodeToString(mac.Sum(nil))
}
