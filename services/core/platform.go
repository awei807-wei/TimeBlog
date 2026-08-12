package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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
	jsonResponse(w, status, map[string]any{"type": "about:blank", "title": http.StatusText(status), "status": status, "detail": detail})
}

func decode(r *http.Request, dst any) error {
	if r.Body == nil {
		return io.EOF
	}
	return json.NewDecoder(io.LimitReader(r.Body, 2<<20)).Decode(dst)
}

func tokenHash(v string) string { h := sha256.Sum256([]byte(v)); return hex.EncodeToString(h[:]) }

func randomToken() string { b := make([]byte, 24); _, _ = rand.Read(b); return hex.EncodeToString(b) }
