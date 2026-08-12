package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestConfiguredMaxUploadBytes(t *testing.T) {
	t.Setenv("MAX_UPLOAD_BYTES", "1234567")
	if got := configuredMaxUploadBytes(); got != 1234567 {
		t.Fatalf("configured limit=%d", got)
	}
	t.Setenv("MAX_UPLOAD_BYTES", "0")
	if got := configuredMaxUploadBytes(); got != defaultMaxUploadBytes {
		t.Fatalf("invalid limit should use default, got=%d", got)
	}
	t.Setenv("MAX_UPLOAD_BYTES", "999999999999")
	if got := configuredMaxUploadBytes(); got != defaultMaxUploadBytes {
		t.Fatalf("oversized limit should use default, got=%d", got)
	}
}

func buildImportZIP(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, data := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func importJSON(t *testing.T, body []byte) map[string]any {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/imports/dry-run", bytes.NewReader(body))
	rr := httptest.NewRecorder()
	NewServer(NewStore()).importDryRun(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("dry-run status=%d body=%s", rr.Code, rr.Body.String())
	}
	var result map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestImportDryRunRejectsTraversalAndInvalidManifest(t *testing.T) {
	result := importJSON(t, buildImportZIP(t, map[string][]byte{
		"manifest.json":  []byte(`{"schemaVersion":"9"}`),
		"../escape.json": []byte(`{}`),
	}))
	if result["schemaVersion"] != "9" {
		t.Fatalf("schema version=%#v", result["schemaVersion"])
	}
	conflicts, _ := result["conflicts"].([]any)
	if len(conflicts) == 0 {
		t.Fatalf("expected traversal/schema conflict: %#v", result)
	}
}

func TestImportDryRunValidatesUUIDAndSHA256Manifest(t *testing.T) {
	validID := "00000000-0000-0000-0000-000000000001"
	entry := []byte(`{"id":"` + validID + `","journalDate":"2026-08-12","visibility":"public"}`)
	wrong := []byte("wrong")
	manifest := []byte(`{"schemaVersion":"1","checksums":{"entries/` + validID + `.json":"` + hex.EncodeToString(sha256.New().Sum(nil)) + `"}}`)
	result := importJSON(t, buildImportZIP(t, map[string][]byte{
		"manifest.json":                manifest,
		"entries/not-a-uuid.json":      entry,
		"entries/" + validID + ".json": wrong,
	}))
	conflicts, _ := result["conflicts"].([]any)
	if len(conflicts) < 2 {
		t.Fatalf("expected UUID and checksum conflicts: %#v", result)
	}
}

func TestImportDryRunAcceptsMetadataManifestAndLayeredMedia(t *testing.T) {
	validID := "00000000-0000-0000-0000-000000000001"
	entryName := "entries/" + validID + ".json"
	entry := []byte(`{"id":"` + validID + `","journalDate":"2026-08-12","visibility":"public"}`)
	mediaName := "assets/media/" + validID + "/asset.txt"
	media := []byte("asset")
	mediaMeta := []byte(`{"id":"` + validID + `","originalName":"asset.txt","mimeType":"text/plain","sizeBytes":5,"visibility":"public","status":"ready","sha256":"` + importSHA256(media) + `"}` + "\n")
	checksums := map[string]string{entryName: importSHA256(entry), mediaName: importSHA256(media), "metadata/media.jsonl": importSHA256(mediaMeta)}
	manifest, err := json.Marshal(map[string]any{"schemaVersion": "1", "checksums": checksums})
	if err != nil {
		t.Fatal(err)
	}
	result := importJSON(t, buildImportZIP(t, map[string][]byte{
		"metadata/manifest.json": manifest,
		"metadata/media.jsonl":   mediaMeta,
		entryName:                entry,
		mediaName:                media,
	}))
	conflicts, _ := result["conflicts"].([]any)
	if len(conflicts) != 0 {
		t.Fatalf("layered export should import cleanly: %#v", result)
	}
	counts, _ := result["counts"].(map[string]any)
	if counts["entries"] != float64(1) || counts["media"] != float64(1) {
		t.Fatalf("unexpected layered counts: %#v", result)
	}
}

func TestReadImportArchiveValidatesLayeredExport(t *testing.T) {
	validID := "00000000-0000-0000-0000-000000000001"
	entryName := "entries/" + validID + ".json"
	entry := []byte(`{"id":"` + validID + `","kind":"note","status":"published","visibility":"public","journalDate":"2026-08-12","timePrecision":"day"}`)
	mediaName := "assets/media-originals/" + validID + "/asset.txt"
	media := []byte("asset")
	mediaMeta := []byte(`{"id":"` + validID + `","originalName":"asset.txt","mimeType":"text/plain","sizeBytes":5,"visibility":"public","status":"ready","sha256":"` + importSHA256(media) + `"}` + "\n")
	checksums := map[string]string{entryName: importSHA256(entry), mediaName: importSHA256(media), "metadata/media.jsonl": importSHA256(mediaMeta)}
	manifest := map[string]any{"schemaVersion": "1", "files": []string{entryName, mediaName}, "checksums": checksums}
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	archive, err := readImportArchive(buildImportZIP(t, map[string][]byte{
		"manifest.json":          manifestBytes,
		"metadata/manifest.json": manifestBytes,
		"metadata/media.jsonl":   mediaMeta,
		entryName:                entry,
		mediaName:                media,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if archive.Schema != "1" || archive.ManifestPath != "manifest.json" || len(archive.EntryFiles) != 1 || len(archive.MediaFiles) != 1 {
		t.Fatalf("unexpected validated archive: %#v", archive)
	}
}

func TestReadImportArchiveRejectsTraversalAndChecksumTampering(t *testing.T) {
	validID := "00000000-0000-0000-0000-000000000001"
	entryName := "entries/" + validID + ".json"
	entry := []byte(`{"id":"` + validID + `","visibility":"public","journalDate":"2026-08-12"}`)
	manifestBytes, err := json.Marshal(map[string]any{"schemaVersion": "1", "checksums": map[string]string{entryName: importSHA256([]byte("tampered"))}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := readImportArchive(buildImportZIP(t, map[string][]byte{
		"manifest.json": manifestBytes,
		entryName:       entry,
	})); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("checksum tampering should fail: %v", err)
	}
	if _, err := readImportArchive(buildImportZIP(t, map[string][]byte{
		"manifest.json": manifestBytes,
		"../escape":     []byte("x"),
	})); err == nil || !strings.Contains(err.Error(), "unsafe archive path") {
		t.Fatalf("path traversal should fail: %v", err)
	}
}

func TestReadImportArchiveRejectsDuplicatePaths(t *testing.T) {
	validID := "00000000-0000-0000-0000-000000000001"
	entryName := "entries/" + validID + ".json"
	entry := []byte(`{"id":"` + validID + `","visibility":"public","journalDate":"2026-08-12"}`)
	manifestBytes, err := json.Marshal(map[string]any{"schemaVersion": "1", "checksums": map[string]string{entryName: importSHA256(entry)}})
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, item := range []struct {
		name string
		data []byte
	}{{"manifest.json", manifestBytes}, {entryName, entry}, {entryName, entry}} {
		w, err := zw.Create(item.name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(item.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := readImportArchive(buf.Bytes()); err == nil || !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("duplicate path should fail: %v", err)
	}
}

func TestMediaContentRangeETagAndPrivateAuth(t *testing.T) {
	root := t.TempDir()
	t.Setenv("MEDIA_ROOT", root)
	path := filepath.Join(root, "asset.txt")
	if err := os.WriteFile(path, []byte("0123456789"), 0600); err != nil {
		t.Fatal(err)
	}
	s := NewStore()
	s.media["public"] = &Media{ID: "public", OriginalName: "asset.txt", MimeType: "text/plain", Status: "ready", Visibility: "public", StoragePath: path}
	s.media["private"] = &Media{ID: "private", OriginalName: "asset.txt", MimeType: "text/plain", Status: "ready", Visibility: "private", StoragePath: path}
	h := NewServer(s).routes()

	first := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/media/public/content", nil)
	req.Header.Set("Range", "bytes=2-5")
	h.ServeHTTP(first, req)
	if first.Code != http.StatusPartialContent || first.Body.String() != "2345" || first.Header().Get("ETag") == "" {
		t.Fatalf("range response status=%d body=%q headers=%v", first.Code, first.Body.String(), first.Header())
	}
	etag := first.Header().Get("ETag")
	notModified := httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/media/public/content", nil)
	req.Header.Set("If-None-Match", etag)
	h.ServeHTTP(notModified, req)
	if notModified.Code != http.StatusNotModified {
		t.Fatalf("if-none-match status=%d body=%s", notModified.Code, notModified.Body.String())
	}

	private := httptest.NewRecorder()
	h.ServeHTTP(private, httptest.NewRequest(http.MethodGet, "/api/v1/media/private/content", nil))
	if private.Code != http.StatusNotFound {
		t.Fatalf("private unauthenticated status=%d", private.Code)
	}
}

func TestExtractMediaReferencesDeduplicates(t *testing.T) {
	refs := extractMediaReferences("media://one media://two media://one")
	if len(refs) != 2 || refs[0] != "one" || refs[1] != "two" {
		t.Fatalf("refs=%v", refs)
	}
}

func TestValidateMediaFileChecksSizeAndMIME(t *testing.T) {
	path := filepath.Join(t.TempDir(), "asset.txt")
	if err := os.WriteFile(path, []byte("hello\n"), 0600); err != nil {
		t.Fatal(err)
	}
	sum, size, err := validateMediaFile(path, 6, "text/plain")
	if err != nil || size != 6 || len(sum) != 64 {
		t.Fatalf("valid media sum=%q size=%d err=%v", sum, size, err)
	}
	if _, _, err := validateMediaFile(path, 5, "text/plain"); err == nil {
		t.Fatal("size mismatch must fail")
	}
	if _, _, err := validateMediaFile(path, 6, "image/png"); err == nil {
		t.Fatal("MIME mismatch must fail")
	}
}

func TestMemoryMediaResumableUploadAndFinalize(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", "123456")
	root := t.TempDir()
	s := NewStore()
	s.media["upload-1"] = &Media{ID: "upload-1", OriginalName: "asset.txt", MimeType: "text/plain", SizeBytes: 6, Visibility: "private", Status: "uploading", CreatedAt: time.Now()}
	srv := NewServer(s)
	srv.mediaRoot = root
	h := srv.routes()
	_, raw := loginForTest(t, h)
	parts := strings.SplitN(raw, "\n", 2)
	patch := func(offset string, payload string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPatch, "/api/v1/admin/media/upload-1/upload", strings.NewReader(payload))
		req.AddCookie(&http.Cookie{Name: "timeline_session", Value: parts[0]})
		req.Header.Set("X-CSRF-Token", parts[1])
		req.Header.Set("Origin", "http://localhost:3000")
		req.Header.Set("Upload-Offset", offset)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		return rr
	}
	if rr := patch("0", "abc"); rr.Code != http.StatusNoContent || rr.Header().Get("Upload-Offset") != "3" {
		t.Fatalf("first chunk status=%d headers=%v", rr.Code, rr.Header())
	}
	if rr := patch("0", "def"); rr.Code != http.StatusConflict {
		t.Fatalf("stale offset status=%d body=%s", rr.Code, rr.Body.String())
	}
	if rr := patch("3", "def"); rr.Code != http.StatusNoContent || rr.Header().Get("Upload-Offset") != "6" {
		t.Fatalf("second chunk status=%d headers=%v", rr.Code, rr.Header())
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/media/upload-1/finalize", nil)
	req.AddCookie(&http.Cookie{Name: "timeline_session", Value: parts[0]})
	req.Header.Set("X-CSRF-Token", parts[1])
	req.Header.Set("Origin", "http://localhost:3000")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), `"status":"ready"`) {
		t.Fatalf("finalize status=%d body=%s", rr.Code, rr.Body.String())
	}
}
