package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

var importUUIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type importManifest struct {
	SchemaVersion    string            `json:"schemaVersion"`
	SchemaVersionAlt string            `json:"schema_version"`
	Files            []string          `json:"files"`
	Checksums        map[string]string `json:"checksums"`
	SHA256           map[string]string `json:"sha256"`
}

type importEntryRecord struct {
	ID            string    `json:"id"`
	Kind          string    `json:"kind"`
	Status        string    `json:"status"`
	Visibility    string    `json:"visibility"`
	Title         string    `json:"title"`
	Slug          string    `json:"slug"`
	Summary       string    `json:"summary"`
	Markdown      string    `json:"markdown"`
	RenderedHTML  string    `json:"renderedHtml"`
	PlainText     string    `json:"plainText"`
	JournalDate   string    `json:"journalDate"`
	JournalTime   string    `json:"journalTime"`
	TimePrecision string    `json:"timePrecision"`
	DayPosition   int       `json:"dayPosition"`
	Revision      int64     `json:"revision"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
	Placeholder   bool      `json:"placeholder"`
}

type importMediaRecord struct {
	ID           string `json:"id"`
	OriginalName string `json:"originalName"`
	MimeType     string `json:"mimeType"`
	SizeBytes    int64  `json:"sizeBytes"`
	Visibility   string `json:"visibility"`
	Status       string `json:"status"`
	SHA256       string `json:"sha256"`
}

type importCategoryRecord struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Slug      string    `json:"slug"`
	CreatedAt time.Time `json:"createdAt"`
}

type importTagRecord struct {
	ID             string `json:"id"`
	DisplayName    string `json:"displayName"`
	NormalizedName string `json:"normalizedName"`
	Slug           string `json:"slug"`
}

type importRelationRecord struct {
	EntryID  string `json:"entryId"`
	Type     string `json:"type"`
	TargetID string `json:"targetId"`
}

type importWorkingCopyRecord struct {
	ID           string          `json:"id"`
	EntryID      string          `json:"entryId"`
	ClientDraft  string          `json:"clientDraftId"`
	BaseRevision int64           `json:"baseRevision"`
	Payload      json.RawMessage `json:"payload"`
	UpdatedAt    time.Time       `json:"updatedAt"`
}

type importEntryVersionRecord struct {
	ID        string          `json:"id"`
	EntryID   string          `json:"entryId"`
	VersionNo int             `json:"versionNo"`
	Snapshot  json.RawMessage `json:"snapshot"`
	CreatedAt time.Time       `json:"createdAt"`
}

func parseImportJSON[T any](archive *importArchive, path string, dst *[]T) error {
	raw, ok := archive.Files[path]
	if !ok || len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return fmt.Errorf("%s invalid: %w", path, err)
	}
	return nil
}

func parseImportJSONL[T any](archive *importArchive, path string, dst *[]T) error {
	raw, ok := archive.Files[path]
	if !ok || len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	for _, line := range bytes.Split(raw, []byte{'\n'}) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var item T
		if err := json.Unmarshal(line, &item); err != nil {
			return fmt.Errorf("%s invalid: %w", path, err)
		}
		*dst = append(*dst, item)
	}
	return nil
}

func importCategoryEquivalent(existing importCategoryRecord, incoming importCategoryRecord) bool {
	return strings.EqualFold(strings.TrimSpace(existing.Name), strings.TrimSpace(incoming.Name)) && strings.EqualFold(strings.TrimSpace(existing.Slug), strings.TrimSpace(incoming.Slug))
}

func importTagEquivalent(existing importTagRecord, incoming importTagRecord) bool {
	normalized := incoming.NormalizedName
	if normalized == "" {
		normalized = strings.ToLower(strings.TrimSpace(incoming.DisplayName))
	}
	return strings.EqualFold(strings.TrimSpace(existing.DisplayName), strings.TrimSpace(incoming.DisplayName)) && strings.EqualFold(strings.TrimSpace(existing.NormalizedName), strings.TrimSpace(normalized)) && strings.EqualFold(strings.TrimSpace(existing.Slug), strings.TrimSpace(incoming.Slug))
}

func parseImportMediaRecords(archive *importArchive) (map[string]importMediaRecord, error) {
	records := map[string]importMediaRecord{}
	raw, ok := archive.Files["metadata/media.jsonl"]
	if !ok || len(bytes.TrimSpace(raw)) == 0 {
		if len(archive.MediaFiles) > 0 {
			return nil, fmt.Errorf("metadata/media.jsonl missing")
		}
		return records, nil
	}
	for _, line := range bytes.Split(raw, []byte{'\n'}) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var record importMediaRecord
		if err := json.Unmarshal(line, &record); err != nil {
			return nil, fmt.Errorf("media metadata invalid: %w", err)
		}
		if !validImportUUID(record.ID) || record.OriginalName == "" || !allowedMediaMime(record.MimeType) || record.SizeBytes < 0 || record.SizeBytes > configuredMaxUploadBytes() || (record.Visibility != "public" && record.Visibility != "private") {
			return nil, fmt.Errorf("media metadata invalid: %s", record.ID)
		}
		if record.Status != "" && record.Status != "ready" {
			return nil, fmt.Errorf("media status invalid: %s", record.ID)
		}
		if _, exists := records[record.ID]; exists {
			return nil, fmt.Errorf("duplicate media metadata: %s", record.ID)
		}
		records[record.ID] = record
	}
	return records, nil
}

func importMediaBytes(archive *importArchive, id string) ([]byte, string, bool) {
	paths := make([]string, 0, 2)
	for _, prefix := range []string{"assets/media-originals/", "assets/media/", "media/"} {
		for _, name := range archive.MediaFiles {
			if !strings.HasPrefix(name, prefix) {
				continue
			}
			parts := strings.Split(strings.TrimPrefix(name, prefix), "/")
			if len(parts) == 2 && parts[0] == id {
				paths = append(paths, name)
			}
		}
	}
	if len(paths) == 0 {
		return nil, "", false
	}
	sort.Strings(paths)
	preferred := paths[0]
	for _, path := range paths {
		if strings.HasPrefix(path, "assets/media-originals/") {
			preferred = path
			break
		}
	}
	base := filepath.Base(preferred)
	content := archive.Files[preferred]
	for _, path := range paths {
		if filepath.Base(path) != base || !bytes.Equal(content, archive.Files[path]) {
			return nil, "", false
		}
	}
	return content, base, true
}

func rewriteImportedMediaReferences(text string, mapping map[string]string) string {
	return mediaReferencePattern.ReplaceAllStringFunc(text, func(token string) string {
		id := strings.TrimPrefix(token, "media://")
		if mapped, ok := mapping[id]; ok {
			return "media://" + mapped
		}
		return token
	})
}

func rewriteImportedJSONReferences(raw json.RawMessage, mediaMapping, entryMapping map[string]string) json.RawMessage {
	if len(raw) == 0 || !json.Valid(raw) {
		return raw
	}
	text := string(raw)
	text = rewriteImportedMediaReferences(text, mediaMapping)
	for oldID, newID := range entryMapping {
		if oldID != newID {
			text = strings.ReplaceAll(text, oldID, newID)
		}
	}
	return json.RawMessage(text)
}

const (
	maxImportArchiveBytes int64 = 256 << 20
	maxImportFileBytes    int64 = 32 << 20
)

// importArchive is the validated, in-memory representation consumed by an
// eventual import transaction. It deliberately contains only safe relative
// archive paths and verified file bytes; callers do not need to re-parse ZIP
// metadata or trust filenames before applying ownership checks.
type importArchive struct {
	Manifest     importManifest
	ManifestPath string
	Schema       string
	Files        map[string][]byte
	EntryFiles   []string
	MediaFiles   []string
	Checksums    map[string]string
}

func validImportArchivePath(name string) bool {
	if name == "" || filepath.IsAbs(name) || strings.Contains(name, "\\") {
		return false
	}
	normalized := filepath.ToSlash(name)
	if strings.HasPrefix(normalized, "/") || strings.Contains(normalized, "../") {
		return false
	}
	clean := filepath.ToSlash(filepath.Clean(filepath.FromSlash(normalized)))
	return clean == normalized && clean != "."
}

func importManifestPath(name string) bool {
	return name == "manifest.json" || name == "metadata/manifest.json"
}

func importArchiveMediaPath(name string) (string, bool) {
	for _, prefix := range []string{"assets/media/", "assets/media-originals/", "media/"} {
		if strings.HasPrefix(name, prefix) {
			parts := strings.Split(strings.TrimPrefix(name, prefix), "/")
			if len(parts) != 2 || !validImportUUID(parts[0]) || parts[1] == "" || parts[1] == "." {
				return "", false
			}
			return parts[0], true
		}
	}
	return "", false
}

func validateImportEntryFile(name string, content []byte) error {
	base := strings.TrimSuffix(strings.TrimPrefix(name, "entries/"), ".json")
	if !validImportUUID(base) {
		return fmt.Errorf("entry UUID invalid: %s", name)
	}
	var entry struct {
		ID          string `json:"id"`
		Kind        string `json:"kind"`
		Status      string `json:"status"`
		Visibility  string `json:"visibility"`
		JournalDate string `json:"journalDate"`
		TimePrec    string `json:"timePrecision"`
		Placeholder bool   `json:"placeholder"`
	}
	if err := json.Unmarshal(content, &entry); err != nil {
		return fmt.Errorf("entry JSON invalid: %s", name)
	}
	if entry.Placeholder {
		if entry.Visibility != "private" || entry.JournalDate == "" {
			return fmt.Errorf("private placeholder invalid: %s", name)
		}
		return nil
	}
	if entry.ID != base {
		return fmt.Errorf("entry ID mismatch: %s", name)
	}
	if entry.JournalDate == "" || (entry.Visibility != "public" && entry.Visibility != "private") {
		return fmt.Errorf("entry required fields missing: %s", name)
	}
	if entry.Kind != "" && entry.Kind != "note" && entry.Kind != "article" {
		return fmt.Errorf("entry kind invalid: %s", name)
	}
	if entry.Status != "" && entry.Status != "draft" && entry.Status != "published" && entry.Status != "trashed" {
		return fmt.Errorf("entry status invalid: %s", name)
	}
	if entry.TimePrec != "" && entry.TimePrec != "day" && entry.TimePrec != "minute" {
		return fmt.Errorf("entry time precision invalid: %s", name)
	}
	return nil
}

// readImportArchive validates a complete export ZIP without touching the
// filesystem or database. Both the legacy root manifest and the layered
// metadata manifest are accepted; all non-manifest files must have a matching
// SHA-256 checksum and safe relative paths.
func readImportArchive(data []byte) (*importArchive, error) {
	if int64(len(data)) > maxImportArchiveBytes {
		return nil, fmt.Errorf("import archive exceeds size limit")
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("invalid ZIP archive: %w", err)
	}
	archive := &importArchive{Files: map[string][]byte{}}
	total := int64(0)
	for _, file := range zr.File {
		if strings.HasSuffix(file.Name, "/") {
			continue
		}
		if !validImportArchivePath(file.Name) {
			return nil, fmt.Errorf("unsafe archive path: %s", file.Name)
		}
		if _, duplicate := archive.Files[file.Name]; duplicate {
			return nil, fmt.Errorf("duplicate archive path: %s", file.Name)
		}
		f, err := file.Open()
		if err != nil {
			return nil, fmt.Errorf("cannot read %s: %w", file.Name, err)
		}
		limit := maxImportFileBytes
		if _, mediaPath := importArchiveMediaPath(file.Name); mediaPath {
			limit = configuredMaxUploadBytes()
		}
		content, readErr := io.ReadAll(io.LimitReader(f, limit+1))
		closeErr := f.Close()
		if readErr != nil {
			return nil, fmt.Errorf("cannot read %s: %w", file.Name, readErr)
		}
		if closeErr != nil {
			return nil, fmt.Errorf("cannot close %s: %w", file.Name, closeErr)
		}
		if int64(len(content)) > limit {
			return nil, fmt.Errorf("archive file exceeds size limit: %s", file.Name)
		}
		total += int64(len(content))
		if total > maxImportArchiveBytes {
			return nil, fmt.Errorf("archive contents exceed size limit")
		}
		archive.Files[file.Name] = content
	}
	manifestRaw, ok := archive.Files["manifest.json"]
	manifestPath := "manifest.json"
	if !ok {
		manifestRaw, ok = archive.Files["metadata/manifest.json"]
		manifestPath = "metadata/manifest.json"
	}
	if !ok {
		return nil, fmt.Errorf("manifest.json missing")
	}
	if root, exists := archive.Files["manifest.json"]; exists {
		if layered, layeredExists := archive.Files["metadata/manifest.json"]; layeredExists && !bytes.Equal(root, layered) {
			return nil, fmt.Errorf("root and layered manifests differ")
		}
	}
	if err := json.Unmarshal(manifestRaw, &archive.Manifest); err != nil {
		return nil, fmt.Errorf("manifest JSON invalid: %w", err)
	}
	archive.Schema = archive.Manifest.SchemaVersion
	if archive.Schema == "" {
		archive.Schema = archive.Manifest.SchemaVersionAlt
	}
	if archive.Schema != "1" {
		return nil, fmt.Errorf("unsupported schema version: %s", archive.Schema)
	}
	archive.ManifestPath = manifestPath
	archive.Checksums = archive.Manifest.Checksums
	if len(archive.Checksums) == 0 {
		archive.Checksums = archive.Manifest.SHA256
	}
	if len(archive.Checksums) == 0 {
		return nil, fmt.Errorf("manifest checksums missing")
	}
	for name, content := range archive.Files {
		if importManifestPath(name) {
			continue
		}
		expected, listed := archive.Checksums[name]
		if !listed || strings.TrimSpace(expected) == "" || !strings.EqualFold(strings.TrimSpace(expected), importSHA256(content)) {
			return nil, fmt.Errorf("checksum mismatch: %s", name)
		}
	}
	for name := range archive.Checksums {
		if importManifestPath(name) {
			continue
		}
		if _, exists := archive.Files[name]; !exists {
			return nil, fmt.Errorf("checksum references missing file: %s", name)
		}
	}
	for _, listed := range archive.Manifest.Files {
		if !validImportArchivePath(listed) {
			return nil, fmt.Errorf("manifest file path unsafe: %s", listed)
		}
		if _, exists := archive.Files[listed]; !exists {
			return nil, fmt.Errorf("manifest references missing file: %s", listed)
		}
	}
	for name, content := range archive.Files {
		switch {
		case strings.HasPrefix(name, "entries/") && strings.HasSuffix(name, ".json"):
			if err := validateImportEntryFile(name, content); err != nil {
				return nil, err
			}
			archive.EntryFiles = append(archive.EntryFiles, name)
		default:
			if _, ok := importArchiveMediaPath(name); ok {
				archive.MediaFiles = append(archive.MediaFiles, name)
			}
		}
	}
	sort.Strings(archive.EntryFiles)
	sort.Strings(archive.MediaFiles)
	mediaRecords, mediaErr := parseImportMediaRecords(archive)
	if mediaErr != nil {
		return nil, mediaErr
	}
	mediaIDs := map[string]struct{}{}
	for _, name := range archive.MediaFiles {
		id, ok := importArchiveMediaPath(name)
		if !ok {
			return nil, fmt.Errorf("media path invalid: %s", name)
		}
		mediaIDs[id] = struct{}{}
	}
	for id := range mediaIDs {
		if _, ok := mediaRecords[id]; !ok {
			return nil, fmt.Errorf("media metadata missing: %s", id)
		}
		if _, _, ok := importMediaBytes(archive, id); !ok {
			return nil, fmt.Errorf("media duplicate bytes/name mismatch: %s", id)
		}
	}
	for id := range mediaRecords {
		if _, ok := mediaIDs[id]; !ok {
			return nil, fmt.Errorf("media metadata references missing file: %s", id)
		}
	}
	return archive, nil
}

func importEntryHash(entry importEntryRecord) (string, error) {
	data, err := json.Marshal(entry)
	if err != nil {
		return "", err
	}
	return importSHA256(data), nil
}

func equivalentImportEntry(a, b importEntryRecord) bool {
	return a.ID == b.ID && a.Kind == b.Kind && a.Status == b.Status && a.Visibility == b.Visibility &&
		a.Title == b.Title && a.Slug == b.Slug && a.Summary == b.Summary && a.Markdown == b.Markdown &&
		a.RenderedHTML == b.RenderedHTML && a.PlainText == b.PlainText && a.JournalDate == b.JournalDate &&
		a.JournalTime == b.JournalTime && a.TimePrecision == b.TimePrecision && a.DayPosition == b.DayPosition &&
		a.Revision == b.Revision
}

func (srv *Server) importEntries(w http.ResponseWriter, r *http.Request) {
	if !srv.store.persistent || srv.store.database == nil {
		problem(w, http.StatusServiceUnavailable, "导入需要数据库")
		return
	}
	ownerID, err := srv.persistentUserID(r)
	if err != nil {
		problem(w, http.StatusUnauthorized, "需要登录")
		return
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, maxImportArchiveBytes+1))
	if err != nil {
		problem(w, http.StatusBadRequest, "导入文件读取失败")
		return
	}
	archive, err := readImportArchive(data)
	if err != nil {
		problem(w, http.StatusBadRequest, err.Error())
		return
	}
	mediaRecords, err := parseImportMediaRecords(archive)
	if err != nil {
		problem(w, http.StatusBadRequest, err.Error())
		return
	}
	var categories []importCategoryRecord
	var tags []importTagRecord
	var relations []importRelationRecord
	var workingCopies []importWorkingCopyRecord
	var entryVersions []importEntryVersionRecord
	if err := parseImportJSON(archive, "metadata/categories.json", &categories); err != nil {
		problem(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := parseImportJSON(archive, "metadata/tags.json", &tags); err != nil {
		problem(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := parseImportJSONL(archive, "metadata/relations.jsonl", &relations); err != nil {
		problem(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := parseImportJSONL(archive, "metadata/working_copies.jsonl", &workingCopies); err != nil {
		problem(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := parseImportJSONL(archive, "metadata/entry_versions.jsonl", &entryVersions); err != nil {
		problem(w, http.StatusBadRequest, err.Error())
		return
	}
	policy := strings.TrimSpace(r.URL.Query().Get("conflictPolicy"))
	if policy == "" {
		policy = strings.TrimSpace(r.Header.Get("X-Conflict-Policy"))
	}
	if policy != "" && policy != "skip" && policy != "replace" && policy != "remap" {
		problem(w, http.StatusBadRequest, "冲突策略无效")
		return
	}
	tx, err := srv.store.database.BeginTx(r.Context(), nil)
	if err != nil {
		problem(w, http.StatusInternalServerError, "导入事务创建失败")
		return
	}
	defer tx.Rollback()
	imported, skipped := 0, 0
	mapping := map[string]string{}
	mediaMapping := map[string]string{}
	entryTargetIDs := map[string]string{}
	categoryMapping := map[string]string{}
	tagMapping := map[string]string{}
	entryImportIDs := make([]string, 0)
	mediaRoot := getenv("MEDIA_ROOT", filepath.Join(os.TempDir(), "timeline-media"))
	if err := os.MkdirAll(mediaRoot, 0750); err != nil {
		problem(w, http.StatusInternalServerError, "媒体目录创建失败")
		return
	}
	stagingRoot, err := os.MkdirTemp(mediaRoot, ".import-")
	if err != nil {
		problem(w, http.StatusInternalServerError, "导入临时目录创建失败")
		return
	}
	defer os.RemoveAll(stagingRoot)
	movedMedia := make([]string, 0)
	type mediaBackup struct {
		originalPath string
		backupPath   string
		finalPath    string
	}
	mediaBackups := make([]mediaBackup, 0)
	committed := false
	defer func() {
		if !committed {
			for _, path := range movedMedia {
				_ = os.Remove(path)
			}
			for i := len(mediaBackups) - 1; i >= 0; i-- {
				backup := mediaBackups[i]
				_ = os.Remove(backup.finalPath)
				if _, statErr := os.Stat(backup.backupPath); statErr == nil {
					_ = os.Rename(backup.backupPath, backup.originalPath)
				}
			}
			return
		}
		for _, backup := range mediaBackups {
			_ = os.Remove(backup.backupPath)
		}
	}()
	// Resolve and persist media first. This makes all remapped media IDs
	// available before entry markdown/rendered_html are rewritten.
	mediaIDs := make([]string, 0, len(mediaRecords))
	for mediaID := range mediaRecords {
		mediaIDs = append(mediaIDs, mediaID)
	}
	sort.Strings(mediaIDs)
	for _, mediaID := range mediaIDs {
		record := mediaRecords[mediaID]
		content, filename, ok := importMediaBytes(archive, mediaID)
		if !ok || int64(len(content)) != record.SizeBytes {
			problem(w, http.StatusBadRequest, "媒体文件缺失或大小不匹配")
			return
		}
		if filepath.Base(record.OriginalName) != filename {
			problem(w, http.StatusBadRequest, "媒体原始文件名与归档不一致")
			return
		}
		contentSHA := importSHA256(content)
		if record.SHA256 != "" && !strings.EqualFold(record.SHA256, contentSHA) {
			problem(w, http.StatusBadRequest, "媒体校验失败")
			return
		}
		targetID := mediaID
		var existingSHA, existingPath, existingOwner string
		lookupErr := tx.QueryRowContext(r.Context(), `SELECT COALESCE(sha256,''),COALESCE(storage_path,''),owner_id::text FROM media WHERE id=$1::uuid AND owner_id=$2::uuid FOR UPDATE`, mediaID, ownerID).Scan(&existingSHA, &existingPath, &existingOwner)
		if lookupErr == nil {
			if strings.EqualFold(existingSHA, contentSHA) {
				mediaMapping[mediaID] = mediaID
				skipped++
				continue
			}
			if policy == "skip" {
				mediaMapping[mediaID] = mediaID
				skipped++
				continue
			}
			if policy == "remap" {
				targetID = newID()
			} else if policy != "replace" {
				jsonResponse(w, http.StatusConflict, map[string]any{"imported": imported, "skipped": skipped, "conflicts": []string{"media conflict: " + mediaID}})
				return
			}
		} else if lookupErr == sql.ErrNoRows {
			// A UUID owned by another account must never be treated as an
			// absent row (the subsequent ON CONFLICT would otherwise leak a
			// confusing generic error).
			if err := tx.QueryRowContext(r.Context(), `SELECT owner_id::text FROM media WHERE id=$1::uuid FOR KEY SHARE`, mediaID).Scan(&existingOwner); err == nil && existingOwner != ownerID {
				if policy != "remap" {
					jsonResponse(w, http.StatusConflict, map[string]any{"imported": imported, "skipped": skipped, "conflicts": []string{"media belongs to another owner: " + mediaID}})
					return
				}
				targetID = newID()
			} else if err != nil && err != sql.ErrNoRows {
				problem(w, http.StatusInternalServerError, "读取媒体归属失败")
				return
			}
			if policy == "remap" {
				targetID = newID()
			}
		} else {
			problem(w, http.StatusInternalServerError, "读取媒体失败")
			return
		}
		if !validImportUUID(targetID) {
			problem(w, http.StatusInternalServerError, "媒体ID生成失败")
			return
		}
		stagedPath := filepath.Join(stagingRoot, targetID)
		if err := os.WriteFile(stagedPath, content, 0600); err != nil {
			problem(w, http.StatusInternalServerError, "媒体临时写入失败")
			return
		}
		finalPath := filepath.Join(mediaRoot, targetID)
		if !mediaPathWithinRoot(mediaRoot, finalPath) {
			problem(w, http.StatusInternalServerError, "媒体路径无效")
			return
		}
		if lookupErr == nil && policy == "replace" && existingPath != "" && mediaPathWithinRoot(mediaRoot, existingPath) {
			if _, statErr := os.Stat(existingPath); statErr == nil {
				backupPath := existingPath + ".import-backup-" + randomToken()
				if err := os.Rename(existingPath, backupPath); err != nil {
					problem(w, http.StatusInternalServerError, "媒体旧文件备份失败")
					return
				}
				mediaBackups = append(mediaBackups, mediaBackup{originalPath: existingPath, backupPath: backupPath, finalPath: finalPath})
			}
		}
		if err := os.Rename(stagedPath, finalPath); err != nil {
			problem(w, http.StatusInternalServerError, "媒体原子移动失败")
			return
		}
		movedMedia = append(movedMedia, finalPath)
		originalName := record.OriginalName
		if originalName == "" {
			originalName = filename
		}
		result, err := tx.ExecContext(r.Context(), `INSERT INTO media(id,owner_id,provider,visibility,storage_path,original_name,mime_type,size_bytes,sha256,status) VALUES($1::uuid,$2::uuid,'local_private',$3,$4,$5,$6,$7,$8,'ready') ON CONFLICT (id) DO UPDATE SET visibility=EXCLUDED.visibility,storage_path=EXCLUDED.storage_path,original_name=EXCLUDED.original_name,mime_type=EXCLUDED.mime_type,size_bytes=EXCLUDED.size_bytes,sha256=EXCLUDED.sha256,status='ready' WHERE media.owner_id=$2::uuid`, targetID, ownerID, record.Visibility, finalPath, originalName, record.MimeType, record.SizeBytes, contentSHA)
		if err != nil {
			problem(w, http.StatusConflict, "保存媒体失败")
			return
		}
		if affected, affectedErr := result.RowsAffected(); affectedErr != nil || affected != 1 {
			problem(w, http.StatusConflict, "媒体未写入")
			return
		}
		mediaMapping[mediaID] = targetID
		imported++
	}
	for _, name := range archive.EntryFiles {
		var entry importEntryRecord
		if err := json.Unmarshal(archive.Files[name], &entry); err != nil {
			problem(w, http.StatusBadRequest, "entry JSON invalid")
			return
		}
		if entry.Placeholder {
			// Public placeholders carry no writable content and are intentionally
			// ignored by full-account import.
			skipped++
			continue
		}
		if !validImportUUID(entry.ID) {
			problem(w, http.StatusBadRequest, "entry UUID invalid")
			return
		}
		targetID := entry.ID
		var existing importEntryRecord
		var existingJournalTime sql.NullString
		lookupErr := tx.QueryRowContext(r.Context(), `SELECT id::text,kind,status,visibility,COALESCE(title,''),COALESCE(slug,''),COALESCE(summary,''),markdown,rendered_html,plain_text,journal_date::text,journal_time::text,time_precision,day_position,revision,created_at,updated_at FROM entries WHERE id=$1::uuid AND author_id=$2::uuid FOR UPDATE`, entry.ID, ownerID).Scan(&existing.ID, &existing.Kind, &existing.Status, &existing.Visibility, &existing.Title, &existing.Slug, &existing.Summary, &existing.Markdown, &existing.RenderedHTML, &existing.PlainText, &existing.JournalDate, &existingJournalTime, &existing.TimePrecision, &existing.DayPosition, &existing.Revision, &existing.CreatedAt, &existing.UpdatedAt)
		if existingJournalTime.Valid {
			existing.JournalTime = existingJournalTime.String
		}
		if lookupErr == nil {
			existingHash, hashErr := importEntryHash(existing)
			incomingHash, incomingHashErr := importEntryHash(entry)
			if hashErr != nil || incomingHashErr != nil {
				problem(w, http.StatusBadRequest, "entry hash failed")
				return
			}
			if equivalentImportEntry(existing, entry) || existingHash == incomingHash || policy == "skip" {
				entryTargetIDs[entry.ID] = entry.ID
				skipped++
				continue
			}
			if policy == "remap" {
				targetID = newID()
				mapping[entry.ID] = targetID
			} else if policy != "replace" {
				jsonResponse(w, http.StatusConflict, map[string]any{"imported": imported, "skipped": skipped, "conflicts": []string{"entry conflict: " + entry.ID}})
				return
			} else {
				existingJSON, marshalErr := json.Marshal(existing)
				if marshalErr != nil {
					problem(w, http.StatusInternalServerError, "导入版本备份失败")
					return
				}
				if _, err := tx.ExecContext(r.Context(), `INSERT INTO entry_versions(id,entry_id,version_no,snapshot) VALUES(gen_random_uuid(),$1::uuid,COALESCE((SELECT max(version_no)+1 FROM entry_versions WHERE entry_id=$1::uuid),1),$2)`, entry.ID, existingJSON); err != nil {
					problem(w, http.StatusInternalServerError, "导入版本备份失败")
					return
				}
			}
		} else if lookupErr == sql.ErrNoRows {
			var foreignOwner string
			foreignErr := tx.QueryRowContext(r.Context(), `SELECT author_id::text FROM entries WHERE id=$1::uuid FOR KEY SHARE`, entry.ID).Scan(&foreignOwner)
			if foreignErr == nil && foreignOwner != ownerID {
				jsonResponse(w, http.StatusConflict, map[string]any{"imported": imported, "skipped": skipped, "conflicts": []string{"entry belongs to another owner: " + entry.ID}})
				return
			}
			if foreignErr != nil && foreignErr != sql.ErrNoRows {
				problem(w, http.StatusInternalServerError, "读取内容归属失败")
				return
			}
			if policy == "remap" {
				targetID = newID()
				mapping[entry.ID] = targetID
			}
		} else {
			problem(w, http.StatusInternalServerError, "读取现有内容失败")
			return
		}
		if entry.Kind == "" {
			entry.Kind = "note"
		}
		if entry.Status == "" {
			entry.Status = "draft"
		}
		if entry.Visibility == "" {
			entry.Visibility = "private"
		}
		if entry.TimePrecision == "" {
			entry.TimePrecision = "day"
		}
		entry.Markdown = rewriteImportedMediaReferences(entry.Markdown, mediaMapping)
		entry.RenderedHTML = rewriteImportedMediaReferences(entry.RenderedHTML, mediaMapping)
		entryTargetIDs[entry.ID] = targetID
		result, err := tx.ExecContext(r.Context(), `INSERT INTO entries(id,author_id,kind,status,visibility,title,slug,summary,markdown,rendered_html,plain_text,journal_date,journal_time,time_precision,day_position,revision,created_at,updated_at) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULLIF($13,''),$14,$15,$16,COALESCE(NULLIF($17::timestamptz,'epoch'::timestamptz),now()),COALESCE(NULLIF($18::timestamptz,'epoch'::timestamptz),now())) ON CONFLICT (id) DO UPDATE SET kind=EXCLUDED.kind,status=EXCLUDED.status,visibility=EXCLUDED.visibility,title=EXCLUDED.title,slug=EXCLUDED.slug,summary=EXCLUDED.summary,markdown=EXCLUDED.markdown,rendered_html=EXCLUDED.rendered_html,plain_text=EXCLUDED.plain_text,journal_date=EXCLUDED.journal_date,journal_time=EXCLUDED.journal_time,time_precision=EXCLUDED.time_precision,day_position=EXCLUDED.day_position,revision=EXCLUDED.revision,updated_at=now() WHERE entries.author_id=$2::uuid`, targetID, ownerID, entry.Kind, entry.Status, entry.Visibility, entry.Title, entry.Slug, entry.Summary, entry.Markdown, entry.RenderedHTML, entry.PlainText, entry.JournalDate, entry.JournalTime, entry.TimePrecision, entry.DayPosition, entry.Revision, entry.CreatedAt, entry.UpdatedAt)
		if err != nil {
			problem(w, http.StatusConflict, "导入内容冲突")
			return
		}
		if affected, affectedErr := result.RowsAffected(); affectedErr != nil || affected != 1 {
			problem(w, http.StatusConflict, "导入内容未写入")
			return
		}
		imported++
		entryImportIDs = append(entryImportIDs, targetID)
		if _, err := tx.ExecContext(r.Context(), `DELETE FROM media_refs WHERE entry_id=$1::uuid`, targetID); err != nil {
			problem(w, http.StatusInternalServerError, "媒体引用清理失败")
			return
		}
		for _, mediaID := range extractMediaReferences(entry.Markdown + "\n" + entry.RenderedHTML) {
			targetMediaID := mediaID
			if mapped, ok := mediaMapping[mediaID]; ok {
				targetMediaID = mapped
			}
			result, err := tx.ExecContext(r.Context(), `INSERT INTO media_refs(entry_id,media_id) SELECT $1::uuid,$2::uuid WHERE EXISTS (SELECT 1 FROM media WHERE id=$2::uuid AND owner_id=$3::uuid AND status='ready') ON CONFLICT DO NOTHING`, targetID, targetMediaID, ownerID)
			if err != nil {
				problem(w, http.StatusInternalServerError, "媒体引用保存失败")
				return
			}
			if affected, affectedErr := result.RowsAffected(); affectedErr != nil || affected != 1 {
				problem(w, http.StatusBadRequest, "媒体引用无效或媒体未就绪")
				return
			}
		}
	}
	// Taxonomy is global, so IDs and unique names/slugs can collide across
	// accounts. Preserve equivalent rows, reject ambiguous conflicts by
	// default, and make remap deterministic with a generated UUID.
	for _, category := range categories {
		if !validImportUUID(category.ID) || strings.TrimSpace(category.Name) == "" || strings.TrimSpace(category.Slug) == "" {
			problem(w, http.StatusBadRequest, "分类元数据无效")
			return
		}
		category.Name = strings.TrimSpace(category.Name)
		category.Slug = strings.TrimSpace(category.Slug)
		originalCategoryID := category.ID
		var existing importCategoryRecord
		idErr := tx.QueryRowContext(r.Context(), `SELECT id::text,name,slug,created_at FROM categories WHERE id=$1::uuid`, category.ID).Scan(&existing.ID, &existing.Name, &existing.Slug, &existing.CreatedAt)
		if idErr == nil {
			if importCategoryEquivalent(existing, category) {
				categoryMapping[originalCategoryID] = existing.ID
				continue
			}
			if policy == "skip" {
				categoryMapping[originalCategoryID] = existing.ID
				skipped++
				continue
			}
			if policy != "replace" && policy != "remap" {
				jsonResponse(w, http.StatusConflict, map[string]any{"imported": imported, "skipped": skipped, "conflicts": []string{"category conflict: " + category.ID}})
				return
			}
			if policy == "replace" {
				if _, err := tx.ExecContext(r.Context(), `UPDATE categories SET name=$1,slug=$2 WHERE id=$3::uuid`, category.Name, category.Slug, existing.ID); err != nil {
					problem(w, http.StatusConflict, "分类替换失败")
					return
				}
				categoryMapping[originalCategoryID] = existing.ID
				continue
			}
			category.ID = newID()
		}
		var slugID string
		slugErr := tx.QueryRowContext(r.Context(), `SELECT id::text FROM categories WHERE lower(slug)=lower($1)`, category.Slug).Scan(&slugID)
		if slugErr == nil {
			categoryMapping[originalCategoryID] = slugID
			if policy == "skip" || policy == "remap" || policy == "replace" {
				skipped++
				continue
			}
			jsonResponse(w, http.StatusConflict, map[string]any{"imported": imported, "skipped": skipped, "conflicts": []string{"category slug conflict: " + category.Slug}})
			return
		}
		if slugErr != sql.ErrNoRows {
			problem(w, http.StatusInternalServerError, "读取分类失败")
			return
		}
		result, err := tx.ExecContext(r.Context(), `INSERT INTO categories(id,name,slug,created_at) VALUES($1::uuid,$2,$3,$4)`, category.ID, category.Name, category.Slug, category.CreatedAt)
		if err != nil {
			problem(w, http.StatusConflict, "保存分类失败")
			return
		}
		if affected, affectedErr := result.RowsAffected(); affectedErr != nil || affected != 1 {
			problem(w, http.StatusConflict, "分类未写入")
			return
		}
		categoryMapping[originalCategoryID] = category.ID
	}
	for _, tag := range tags {
		if !validImportUUID(tag.ID) || strings.TrimSpace(tag.DisplayName) == "" {
			problem(w, http.StatusBadRequest, "标签元数据无效")
			return
		}
		originalTagID := tag.ID
		tag.DisplayName = strings.TrimSpace(tag.DisplayName)
		if tag.NormalizedName == "" {
			tag.NormalizedName = strings.ToLower(tag.DisplayName)
		} else {
			tag.NormalizedName = strings.ToLower(strings.TrimSpace(tag.NormalizedName))
		}
		if tag.Slug == "" {
			tag.Slug = slugify(tag.DisplayName)
		}
		var existing importTagRecord
		idErr := tx.QueryRowContext(r.Context(), `SELECT id::text,display_name,normalized_name,slug FROM tags WHERE id=$1::uuid`, tag.ID).Scan(&existing.ID, &existing.DisplayName, &existing.NormalizedName, &existing.Slug)
		if idErr == nil {
			if importTagEquivalent(existing, tag) {
				tagMapping[originalTagID] = existing.ID
				continue
			}
			if policy == "skip" {
				tagMapping[originalTagID] = existing.ID
				skipped++
				continue
			}
			if policy != "replace" && policy != "remap" {
				jsonResponse(w, http.StatusConflict, map[string]any{"imported": imported, "skipped": skipped, "conflicts": []string{"tag conflict: " + tag.ID}})
				return
			}
			if policy == "replace" {
				if _, err := tx.ExecContext(r.Context(), `UPDATE tags SET display_name=$1,normalized_name=$2,slug=$3 WHERE id=$4::uuid`, tag.DisplayName, tag.NormalizedName, tag.Slug, existing.ID); err != nil {
					problem(w, http.StatusConflict, "标签替换失败")
					return
				}
				tagMapping[originalTagID] = existing.ID
				continue
			}
			tag.ID = newID()
		}
		var normalizedID string
		normalizedErr := tx.QueryRowContext(r.Context(), `SELECT id::text FROM tags WHERE lower(normalized_name)=lower($1)`, tag.NormalizedName).Scan(&normalizedID)
		if normalizedErr == nil {
			tagMapping[originalTagID] = normalizedID
			if policy == "skip" || policy == "remap" || policy == "replace" {
				skipped++
				continue
			}
			jsonResponse(w, http.StatusConflict, map[string]any{"imported": imported, "skipped": skipped, "conflicts": []string{"tag normalized name conflict: " + tag.NormalizedName}})
			return
		}
		if normalizedErr != sql.ErrNoRows {
			problem(w, http.StatusInternalServerError, "读取标签失败")
			return
		}
		result, err := tx.ExecContext(r.Context(), `INSERT INTO tags(id,display_name,normalized_name,slug) VALUES($1::uuid,$2,$3,$4)`, tag.ID, tag.DisplayName, tag.NormalizedName, tag.Slug)
		if err != nil {
			problem(w, http.StatusConflict, "保存标签失败")
			return
		}
		if affected, affectedErr := result.RowsAffected(); affectedErr != nil || affected != 1 {
			problem(w, http.StatusConflict, "标签未写入")
			return
		}
		tagMapping[originalTagID] = tag.ID
	}
	for _, relation := range relations {
		if !validImportUUID(relation.EntryID) || !validImportUUID(relation.TargetID) || (relation.Type != "category" && relation.Type != "tag") {
			problem(w, http.StatusBadRequest, "关系元数据无效")
			return
		}
		entryID := relation.EntryID
		if mapped, ok := entryTargetIDs[entryID]; ok {
			entryID = mapped
		}
		var targetID string
		if relation.Type == "category" {
			targetID = categoryMapping[relation.TargetID]
		} else {
			targetID = tagMapping[relation.TargetID]
		}
		if targetID == "" {
			continue
		}
		var owner string
		if err := tx.QueryRowContext(r.Context(), `SELECT author_id::text FROM entries WHERE id=$1::uuid`, entryID).Scan(&owner); err != nil {
			continue
		}
		if owner != ownerID {
			problem(w, http.StatusConflict, "关系内容归属无效")
			return
		}
		if relation.Type == "category" {
			result, execErr := tx.ExecContext(r.Context(), `INSERT INTO entry_categories(entry_id,category_id) VALUES($1::uuid,$2::uuid) ON CONFLICT DO NOTHING`, entryID, targetID)
			err = execErr
			_ = result
		} else {
			result, execErr := tx.ExecContext(r.Context(), `INSERT INTO entry_tags(entry_id,tag_id) VALUES($1::uuid,$2::uuid) ON CONFLICT DO NOTHING`, entryID, targetID)
			err = execErr
			_ = result
		}
		if err != nil {
			problem(w, http.StatusConflict, "关系保存失败")
			return
		}
	}
	for _, version := range entryVersions {
		if !validImportUUID(version.ID) || !validImportUUID(version.EntryID) || version.VersionNo < 1 || !json.Valid(version.Snapshot) {
			problem(w, http.StatusBadRequest, "版本元数据无效")
			return
		}
		version.Snapshot = rewriteImportedJSONReferences(version.Snapshot, mediaMapping, mapping)
		entryID := version.EntryID
		if mapped, ok := entryTargetIDs[entryID]; ok {
			entryID = mapped
		}
		var owner string
		if err := tx.QueryRowContext(r.Context(), `SELECT author_id::text FROM entries WHERE id=$1::uuid`, entryID).Scan(&owner); err != nil || owner != ownerID {
			continue
		}
		var existingSnapshot []byte
		versionErr := tx.QueryRowContext(r.Context(), `SELECT snapshot FROM entry_versions WHERE entry_id=$1::uuid AND version_no=$2`, entryID, version.VersionNo).Scan(&existingSnapshot)
		if versionErr == nil {
			if bytes.Equal(existingSnapshot, version.Snapshot) || policy == "skip" {
				skipped++
				continue
			}
			if policy != "replace" && policy != "remap" {
				jsonResponse(w, http.StatusConflict, map[string]any{"imported": imported, "skipped": skipped, "conflicts": []string{"entry version conflict: " + entryID}})
				return
			}
			if policy == "replace" {
				result, err := tx.ExecContext(r.Context(), `UPDATE entry_versions SET snapshot=$1,created_at=$2 WHERE entry_id=$3::uuid AND version_no=$4`, version.Snapshot, version.CreatedAt, entryID, version.VersionNo)
				if err != nil {
					problem(w, http.StatusConflict, "版本替换失败")
					return
				}
				if affected, affectedErr := result.RowsAffected(); affectedErr != nil || affected != 1 {
					problem(w, http.StatusConflict, "版本未替换")
					return
				}
				continue
			}
			version.ID = newID()
		}
		if versionErr != nil && versionErr != sql.ErrNoRows {
			problem(w, http.StatusInternalServerError, "读取版本失败")
			return
		}
		var existingID string
		idErr := tx.QueryRowContext(r.Context(), `SELECT id::text FROM entry_versions WHERE id=$1::uuid`, version.ID).Scan(&existingID)
		if idErr == nil {
			if policy == "skip" {
				skipped++
				continue
			}
			if policy != "remap" {
				jsonResponse(w, http.StatusConflict, map[string]any{"imported": imported, "skipped": skipped, "conflicts": []string{"entry version id conflict: " + version.ID}})
				return
			}
			version.ID = newID()
		} else if idErr != sql.ErrNoRows {
			problem(w, http.StatusInternalServerError, "读取版本 ID 失败")
			return
		}
		result, err := tx.ExecContext(r.Context(), `INSERT INTO entry_versions(id,entry_id,version_no,snapshot,created_at) VALUES($1::uuid,$2::uuid,$3,$4,$5)`, version.ID, entryID, version.VersionNo, version.Snapshot, version.CreatedAt)
		if err != nil {
			problem(w, http.StatusConflict, "保存版本失败")
			return
		}
		if affected, affectedErr := result.RowsAffected(); affectedErr != nil || affected != 1 {
			problem(w, http.StatusConflict, "版本未写入")
			return
		}
	}
	for _, working := range workingCopies {
		if !validImportUUID(working.ID) || working.ClientDraft == "" || !json.Valid(working.Payload) {
			problem(w, http.StatusBadRequest, "工作副本元数据无效")
			return
		}
		working.Payload = rewriteImportedJSONReferences(working.Payload, mediaMapping, mapping)
		entryID := working.EntryID
		if entryID != "" {
			if mapped, ok := entryTargetIDs[entryID]; ok {
				entryID = mapped
			}
		}
		var existingID, existingPayload string
		var existingEntry sql.NullString
		workingErr := tx.QueryRowContext(r.Context(), `SELECT id::text,COALESCE(entry_id::text,''),payload::text FROM entry_working_copies WHERE client_draft_id=$1 AND owner_id=$2::uuid`, working.ClientDraft, ownerID).Scan(&existingID, &existingEntry, &existingPayload)
		if workingErr == sql.ErrNoRows {
			var foreignOwner string
			foreignErr := tx.QueryRowContext(r.Context(), `SELECT owner_id::text FROM entry_working_copies WHERE client_draft_id=$1 FOR KEY SHARE`, working.ClientDraft).Scan(&foreignOwner)
			if foreignErr == nil && foreignOwner != ownerID {
				if policy != "remap" {
					jsonResponse(w, http.StatusConflict, map[string]any{"imported": imported, "skipped": skipped, "conflicts": []string{"working copy belongs to another owner: " + working.ClientDraft}})
					return
				}
				working.ClientDraft += "-" + randomToken()[:8]
			} else if foreignErr != nil && foreignErr != sql.ErrNoRows {
				problem(w, http.StatusInternalServerError, "读取工作副本归属失败")
				return
			}
		}
		if workingErr == nil {
			if existingPayload == string(working.Payload) || policy == "skip" {
				skipped++
				continue
			}
			if policy != "replace" && policy != "remap" {
				jsonResponse(w, http.StatusConflict, map[string]any{"imported": imported, "skipped": skipped, "conflicts": []string{"working copy conflict: " + working.ClientDraft}})
				return
			}
			if policy == "replace" {
				result, err := tx.ExecContext(r.Context(), `UPDATE entry_working_copies SET entry_id=NULLIF($1,'')::uuid,payload=$2,base_revision=$3,updated_at=$4 WHERE id=$5::uuid AND owner_id=$6::uuid`, entryID, working.Payload, working.BaseRevision, working.UpdatedAt, existingID, ownerID)
				if err != nil {
					problem(w, http.StatusConflict, "工作副本替换失败")
					return
				}
				if affected, affectedErr := result.RowsAffected(); affectedErr != nil || affected != 1 {
					problem(w, http.StatusConflict, "工作副本未替换")
					return
				}
				continue
			}
			working.ID = newID()
			working.ClientDraft += "-" + working.ID[:8]
		}
		if workingErr != nil && workingErr != sql.ErrNoRows {
			problem(w, http.StatusInternalServerError, "读取工作副本失败")
			return
		}
		result, err := tx.ExecContext(r.Context(), `INSERT INTO entry_working_copies(id,owner_id,entry_id,client_draft_id,base_revision,payload,updated_at) VALUES($1::uuid,$2::uuid,NULLIF($3,'')::uuid,$4,$5,$6,$7)`, working.ID, ownerID, entryID, working.ClientDraft, working.BaseRevision, working.Payload, working.UpdatedAt)
		if err != nil {
			problem(w, http.StatusConflict, "保存工作副本失败")
			return
		}
		if affected, affectedErr := result.RowsAffected(); affectedErr != nil || affected != 1 {
			problem(w, http.StatusConflict, "工作副本未写入")
			return
		}
	}
	if err := tx.Commit(); err != nil {
		problem(w, http.StatusInternalServerError, "导入提交失败")
		return
	}
	committed = true
	jsonResponse(w, http.StatusCreated, map[string]any{"imported": imported, "skipped": skipped, "mapping": mapping, "mediaMapping": mediaMapping, "categoryMapping": categoryMapping, "tagMapping": tagMapping, "schemaVersion": archive.Schema, "mediaImported": len(mediaRecords)})
}

func validImportUUID(value string) bool {
	return importUUIDPattern.MatchString(strings.TrimSpace(value))
}

func importSHA256(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func (srv *Server) taxonomyCategories(w http.ResponseWriter, r *http.Request) {
	if srv.store.persistent && srv.store.database != nil {
		if r.Method == http.MethodGet {
			rows, err := srv.store.database.QueryContext(r.Context(), `SELECT id::text,name,slug FROM categories ORDER BY name`)
			if err != nil {
				problem(w, 500, "读取分类失败")
				return
			}
			defer rows.Close()
			out := []map[string]any{}
			for rows.Next() {
				var id, name, slug string
				if rows.Scan(&id, &name, &slug) != nil {
					problem(w, 500, "读取分类失败")
					return
				}
				out = append(out, map[string]any{"id": id, "name": name, "slug": slug})
			}
			jsonResponse(w, 200, map[string]any{"categories": out})
			return
		}
		if r.Method == http.MethodPost {
			var in struct {
				Name string `json:"name"`
				Slug string `json:"slug"`
			}
			if decode(r, &in) != nil || strings.TrimSpace(in.Name) == "" {
				problem(w, 400, "分类名称不能为空")
				return
			}
			if in.Slug == "" {
				in.Slug = slugify(in.Name)
			}
			var id string
			if err := srv.store.database.QueryRowContext(r.Context(), `INSERT INTO categories(id,name,slug) VALUES(gen_random_uuid(),$1,$2) ON CONFLICT(slug) DO UPDATE SET name=EXCLUDED.name RETURNING id::text`, in.Name, in.Slug).Scan(&id); err != nil {
				problem(w, 409, "分类已存在或无效")
				return
			}
			jsonResponse(w, http.StatusCreated, map[string]any{"id": id, "name": in.Name, "slug": in.Slug})
			return
		}
		problem(w, 405, "方法不允许")
		return
	}
	if r.Method != http.MethodGet {
		problem(w, 501, "内存模式不支持分类写入")
		return
	}
	counts := map[string]int{}
	srv.store.mu.RLock()
	for _, e := range srv.store.entries {
		for _, c := range e.Categories {
			counts[c]++
		}
	}
	srv.store.mu.RUnlock()
	jsonResponse(w, 200, map[string]any{"categories": counts})
}

func (srv *Server) taxonomyCategory(w http.ResponseWriter, r *http.Request) {
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/admin/categories/"), "/")
	if !srv.store.persistent || srv.store.database == nil {
		problem(w, 501, "内存模式不支持分类写入")
		return
	}
	switch r.Method {
	case http.MethodPatch:
		var in struct {
			Name string `json:"name"`
			Slug string `json:"slug"`
		}
		if decode(r, &in) != nil || in.Name == "" {
			problem(w, 400, "分类名称不能为空")
			return
		}
		if in.Slug == "" {
			in.Slug = slugify(in.Name)
		}
		res, err := srv.store.database.ExecContext(r.Context(), `UPDATE categories SET name=$1,slug=$2 WHERE id=$3::uuid`, in.Name, in.Slug, id)
		if err != nil {
			problem(w, 409, "分类更新失败")
			return
		}
		if n, _ := res.RowsAffected(); n != 1 {
			problem(w, 404, "分类不存在")
			return
		}
		jsonResponse(w, 200, map[string]any{"id": id, "name": in.Name, "slug": in.Slug})
	case http.MethodDelete:
		res, err := srv.store.database.ExecContext(r.Context(), `DELETE FROM categories WHERE id=$1::uuid`, id)
		if err != nil {
			problem(w, 500, "删除分类失败")
			return
		}
		if n, _ := res.RowsAffected(); n != 1 {
			problem(w, 404, "分类不存在")
			return
		}
		jsonResponse(w, 200, map[string]bool{"ok": true})
	default:
		problem(w, 405, "方法不允许")
	}
}

func (srv *Server) taxonomyTags(w http.ResponseWriter, r *http.Request) {
	if srv.store.persistent && srv.store.database != nil {
		if r.Method == http.MethodGet {
			rows, err := srv.store.database.QueryContext(r.Context(), `SELECT id::text,display_name,normalized_name,slug FROM tags ORDER BY normalized_name`)
			if err != nil {
				problem(w, 500, "读取标签失败")
				return
			}
			defer rows.Close()
			out := []map[string]any{}
			for rows.Next() {
				var id, display, normalized, slug string
				if rows.Scan(&id, &display, &normalized, &slug) != nil {
					problem(w, 500, "读取标签失败")
					return
				}
				out = append(out, map[string]any{"id": id, "displayName": display, "normalizedName": normalized, "slug": slug})
			}
			jsonResponse(w, 200, map[string]any{"tags": out})
			return
		}
		if r.Method == http.MethodPost {
			var in struct {
				DisplayName string `json:"displayName"`
				Slug        string `json:"slug"`
			}
			if decode(r, &in) != nil || strings.TrimSpace(in.DisplayName) == "" {
				problem(w, 400, "标签不能为空")
				return
			}
			normalized := strings.ToLower(strings.TrimSpace(in.DisplayName))
			if in.Slug == "" {
				in.Slug = slugify(in.DisplayName)
			}
			var id string
			if err := srv.store.database.QueryRowContext(r.Context(), `INSERT INTO tags(id,display_name,normalized_name,slug) VALUES(gen_random_uuid(),$1,$2,$3) ON CONFLICT(normalized_name) DO UPDATE SET display_name=EXCLUDED.display_name,slug=EXCLUDED.slug RETURNING id::text`, in.DisplayName, normalized, in.Slug).Scan(&id); err != nil {
				problem(w, 409, "标签已存在或无效")
				return
			}
			jsonResponse(w, http.StatusCreated, map[string]any{"id": id, "displayName": in.DisplayName, "normalizedName": normalized, "slug": in.Slug})
			return
		}
		problem(w, 405, "方法不允许")
		return
	}
	if r.Method != http.MethodGet {
		problem(w, 501, "内存模式不支持标签写入")
		return
	}
	counts := map[string]int{}
	srv.store.mu.RLock()
	for _, e := range srv.store.entries {
		for _, tag := range e.Tags {
			counts[tag]++
		}
	}
	srv.store.mu.RUnlock()
	jsonResponse(w, 200, map[string]any{"tags": counts})
}

func (srv *Server) taxonomyTag(w http.ResponseWriter, r *http.Request) {
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/admin/tags/"), "/")
	if !srv.store.persistent || srv.store.database == nil {
		problem(w, 501, "内存模式不支持标签写入")
		return
	}
	switch r.Method {
	case http.MethodPatch:
		var in struct {
			DisplayName string `json:"displayName"`
			Slug        string `json:"slug"`
		}
		if decode(r, &in) != nil || in.DisplayName == "" {
			problem(w, 400, "标签不能为空")
			return
		}
		normalized := strings.ToLower(strings.TrimSpace(in.DisplayName))
		if in.Slug == "" {
			in.Slug = slugify(in.DisplayName)
		}
		res, err := srv.store.database.ExecContext(r.Context(), `UPDATE tags SET display_name=$1,normalized_name=$2,slug=$3 WHERE id=$4::uuid`, in.DisplayName, normalized, in.Slug, id)
		if err != nil {
			problem(w, 409, "标签更新失败")
			return
		}
		if n, _ := res.RowsAffected(); n != 1 {
			problem(w, 404, "标签不存在")
			return
		}
		jsonResponse(w, 200, map[string]any{"id": id, "displayName": in.DisplayName, "normalizedName": normalized, "slug": in.Slug})
	case http.MethodDelete:
		res, err := srv.store.database.ExecContext(r.Context(), `DELETE FROM tags WHERE id=$1::uuid`, id)
		if err != nil {
			problem(w, 500, "删除标签失败")
			return
		}
		if n, _ := res.RowsAffected(); n != 1 {
			problem(w, 404, "标签不存在")
			return
		}
		jsonResponse(w, 200, map[string]bool{"ok": true})
	default:
		problem(w, 405, "方法不允许")
	}
}

func (srv *Server) adminCalendar(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		problem(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	if !srv.store.persistent || srv.store.database == nil {
		problem(w, http.StatusServiceUnavailable, "日历统计需要数据库")
		return
	}
	ownerID, err := srv.persistentUserID(r)
	if err != nil {
		problem(w, http.StatusUnauthorized, "需要登录")
		return
	}
	year := strings.TrimSpace(r.URL.Query().Get("year"))
	if year == "" {
		year = time.Now().Format("2006")
	}
	includeDrafts := r.URL.Query().Get("includeDrafts") == "true"
	statusFilter := `status IN ('published','trashed')`
	if includeDrafts {
		statusFilter = `status IN ('draft','published','trashed')`
	}
	query := `SELECT journal_date::text,status,visibility,count(*) FROM entries WHERE author_id=$1::uuid AND journal_date::text LIKE $2 AND ` + statusFilter + ` GROUP BY journal_date,status,visibility ORDER BY journal_date`
	rows, err := srv.store.database.QueryContext(r.Context(), query, ownerID, year+"-%")
	if err != nil {
		problem(w, http.StatusInternalServerError, "读取日历统计失败")
		return
	}
	defer rows.Close()
	type dayCounts struct {
		Public  int `json:"public"`
		Private int `json:"private"`
		Draft   int `json:"draft"`
		Trashed int `json:"trashed"`
	}
	counts := map[string]dayCounts{}
	for rows.Next() {
		var date, status, visibility string
		var count int
		if err := rows.Scan(&date, &status, &visibility, &count); err != nil {
			problem(w, http.StatusInternalServerError, "读取日历统计失败")
			return
		}
		item := counts[date]
		switch {
		case status == "draft":
			item.Draft += count
		case status == "trashed":
			item.Trashed += count
		case visibility == "public":
			item.Public += count
		default:
			item.Private += count
		}
		counts[date] = item
	}
	if err := rows.Err(); err != nil {
		problem(w, http.StatusInternalServerError, "读取日历统计失败")
		return
	}
	jsonResponse(w, http.StatusOK, map[string]any{"year": year, "includeDrafts": includeDrafts, "days": counts})
}

func (srv *Server) settingsEndpoint(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store, max-age=0")
	allowed := map[string]bool{"siteTitle": true, "siteDescription": true, "timezone": true, "defaultVisibility": true, "feedEnabled": true, "theme": true}
	if r.Method != http.MethodGet && r.Method != http.MethodPatch {
		problem(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	if srv.store.persistent && srv.store.database != nil {
		if r.Method == http.MethodGet {
			rows, err := srv.store.database.QueryContext(r.Context(), `SELECT key,value FROM site_settings ORDER BY key`)
			if err != nil {
				problem(w, 500, "读取设置失败")
				return
			}
			defer rows.Close()
			out := map[string]any{}
			for rows.Next() {
				var key string
				var value []byte
				if rows.Scan(&key, &value) != nil {
					problem(w, 500, "读取设置失败")
					return
				}
				var v any
				_ = json.Unmarshal(value, &v)
				if allowed[key] {
					out[key] = v
				}
			}
			jsonResponse(w, 200, out)
			return
		}
		if r.Method == http.MethodPatch {
			var values map[string]any
			if decode(r, &values) != nil {
				problem(w, 400, "设置无效")
				return
			}
			if err := validateSiteSettings(values, allowed); err != nil {
				problem(w, http.StatusBadRequest, err.Error())
				return
			}
			tx, err := srv.store.database.BeginTx(r.Context(), nil)
			if err != nil {
				problem(w, 500, "保存设置失败")
				return
			}
			for key, value := range values {
				data, _ := json.Marshal(value)
				if _, err = tx.ExecContext(r.Context(), `INSERT INTO site_settings(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, key, data); err != nil {
					_ = tx.Rollback()
					problem(w, 500, "保存设置失败")
					return
				}
			}
			if err = tx.Commit(); err != nil {
				problem(w, 500, "保存设置失败")
				return
			}
			jsonResponse(w, 200, values)
			return
		}
	}
	if r.Method == http.MethodGet {
		srv.store.mu.RLock()
		v := map[string]any{}
		for k, x := range srv.store.settings {
			v[k] = x
		}
		srv.store.mu.RUnlock()
		jsonResponse(w, 200, v)
		return
	}
	var values map[string]any
	if decode(r, &values) != nil {
		problem(w, 400, "设置无效")
		return
	}
	if err := validateSiteSettings(values, allowed); err != nil {
		problem(w, http.StatusBadRequest, err.Error())
		return
	}
	srv.store.mu.Lock()
	for key, value := range values {
		srv.store.settings[key] = value
	}
	srv.store.mu.Unlock()
	jsonResponse(w, 200, values)
}

func validateSiteSettings(values map[string]any, allowed map[string]bool) error {
	for key, value := range values {
		if !allowed[key] {
			return fmt.Errorf("不支持的设置项: %s", key)
		}
		switch key {
		case "siteTitle", "siteDescription", "timezone", "theme":
			if _, ok := value.(string); !ok {
				return fmt.Errorf("设置项 %s 类型无效", key)
			}
		case "defaultVisibility":
			v, ok := value.(string)
			if !ok || (v != "public" && v != "private") {
				return fmt.Errorf("设置项 %s 类型无效", key)
			}
		case "feedEnabled":
			if _, ok := value.(bool); !ok {
				return fmt.Errorf("设置项 %s 类型无效", key)
			}
		}
	}
	return nil
}

func configuredEnv(name string) bool {
	value, ok := os.LookupEnv(name)
	return ok && strings.TrimSpace(value) != ""
}

// runtimeStatus exposes only safe operational metadata. It intentionally does
// not return environment values, credentials, filesystem paths or DB errors.
func (srv *Server) runtimeStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		problem(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	w.Header().Set("Cache-Control", "no-store, max-age=0")
	adminPassword := configuredEnv("ADMIN_PASSWORD")
	adminTOTP := configuredEnv("ADMIN_TOTP_SECRET")
	recoveryHash := configuredEnv("ACCOUNT_RECOVERY_KEY_HASH")
	databaseURL := configuredEnv("DATABASE_URL")
	if srv.store.persistent && srv.store.database != nil {
		databaseURL = true
		var exists bool
		if err := srv.store.database.QueryRowContext(r.Context(), `SELECT EXISTS (SELECT 1 FROM users WHERE username='owner' AND password_hash <> '')`).Scan(&exists); err == nil {
			adminPassword = exists
			var totpConfigured bool
			if err := srv.store.database.QueryRowContext(r.Context(), `SELECT EXISTS (SELECT 1 FROM users WHERE username='owner' AND totp_secret_encrypted <> '')`).Scan(&totpConfigured); err == nil {
				adminTOTP = totpConfigured
			}
		}
	}
	externalStatus := map[string]any{"provider": "custom_public", "configured": false, "enabled": false, "protocolStatus": "ou_image_hosting_v1", "status": "未配置"}
	nasStatus := map[string]any{"configured": false, "enabled": false, "applyStatus": "not_configured", "status": "未配置"}
	if srv.store.persistent && srv.store.database != nil {
		if record, err := integrationRecordByName(r.Context(), srv.store.database, externalImageHostName); err == nil {
			config := externalImageHostConfig{}
			_ = json.Unmarshal(record.Config, &config)
			provider := customPublicProvider{config: config, tokenConfigured: encryptedSecretConfigured(record.SecretEncrypted), verified: record.TestStatus == "verified" || record.TestStatus == "scope_limited"}
			externalStatus = map[string]any{"provider": "custom_public", "configured": encryptedSecretConfigured(record.SecretEncrypted), "enabled": config.Enabled, "protocolStatus": "ou_image_hosting_v1", "probeStatus": record.TestStatus, "publishEnabled": provider.PublishEnabled(), "status": record.TestStatus}
		}
		if record, err := integrationRecordByName(r.Context(), srv.store.database, nasBackupName); err == nil {
			config := nasBackupConfig{}
			_ = json.Unmarshal(record.Config, &config)
			nasStatus = map[string]any{"configured": true, "enabled": config.Enabled, "applyStatus": "pending_export", "status": record.TestStatus}
		}
	}
	jsonResponse(w, http.StatusOK, map[string]any{
		"updatedAt":         time.Now().UTC().Format(time.RFC3339),
		"media":             srv.mediaCapabilityStatus(),
		"externalImageHost": externalStatus,
		"security": map[string]any{
			"adminPassword":      map[string]any{"configured": adminPassword, "managedBy": "account_recovery"},
			"adminTotpSecret":    map[string]any{"configured": adminTOTP, "managedBy": "account_recovery"},
			"totpEncryptionKey":  map[string]any{"configured": configuredEnv("TOTP_ENCRYPTION_KEY"), "managedBy": "vps_environment"},
			"databaseConnection": map[string]any{"configured": databaseURL, "managedBy": "vps_environment"},
			"accountRecoveryKey": map[string]any{"configured": recoveryHash, "managedBy": "account_recovery"},
		},
		"nasBackup": nasStatus,
	})
}

func (srv *Server) resolveEmbed(w http.ResponseWriter, r *http.Request) {
	var in struct {
		URL string `json:"url"`
	}
	if decode(r, &in) != nil {
		problem(w, 400, "URL 无效")
		return
	}
	u, err := url.Parse(strings.TrimSpace(in.URL))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		problem(w, 400, "仅支持 HTTP(S) URL")
		return
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if ip := net.ParseIP(host); ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()) {
		problem(w, 403, "禁止访问内网地址")
		return
	}
	provider := ""
	switch {
	case host == "youtube.com" || strings.HasSuffix(host, ".youtube.com") || host == "youtu.be":
		provider = "youtube"
	case host == "bilibili.com" || strings.HasSuffix(host, ".bilibili.com"):
		provider = "bilibili"
	case host == "vimeo.com" || strings.HasSuffix(host, ".vimeo.com"):
		provider = "vimeo"
	default:
		problem(w, 422, "不支持的嵌入来源")
		return
	}
	jsonResponse(w, 200, map[string]any{"provider": provider, "url": u.String(), "title": host, "safe": true})
}

func (srv *Server) mediaCollection(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		problem(w, http.StatusMethodNotAllowed, "方法不允许")
		return
	}
	if srv.store.persistent && srv.store.database != nil {
		ownerID, err := srv.persistentUserID(r)
		if err != nil {
			problem(w, http.StatusUnauthorized, "需要登录")
			return
		}
		limit := publicLimit(r)
		cursor := strings.TrimSpace(r.URL.Query().Get("cursor"))
		cursorID := ""
		if cursor != "" {
			var ok bool
			_, cursorID, ok = decodeCursor(cursor)
			if !ok {
				problem(w, http.StatusBadRequest, "cursor 无效")
				return
			}
		}
		query := `SELECT id::text,original_name,mime_type,size_bytes,visibility,status,COALESCE(storage_path,''),COALESCE(sha256,''),created_at,provider,COALESCE(provider_key,''),COALESCE(public_url,''),external_publish_status,COALESCE(external_publish_error,'') FROM media WHERE owner_id=$1::uuid`
		args := []any{ownerID}
		if cursorID != "" {
			query += ` AND (created_at,id) < ($2::timestamptz,$3::uuid)`
			var cursorTime time.Time
			if err := srv.store.database.QueryRowContext(r.Context(), `SELECT created_at FROM media WHERE id=$1::uuid AND owner_id=$2::uuid`, cursorID, ownerID).Scan(&cursorTime); err != nil {
				problem(w, http.StatusBadRequest, "cursor 无效")
				return
			}
			args = append(args, cursorTime, cursorID)
		}
		query += ` ORDER BY created_at DESC,id DESC LIMIT $` + fmt.Sprint(len(args)+1)
		args = append(args, limit+1)
		rows, err := srv.store.database.QueryContext(r.Context(), query, args...)
		if err != nil {
			problem(w, 500, "读取媒体失败")
			return
		}
		defer rows.Close()
		out := []*Media{}
		for rows.Next() {
			var m Media
			if err := rows.Scan(&m.ID, &m.OriginalName, &m.MimeType, &m.SizeBytes, &m.Visibility, &m.Status, &m.StoragePath, &m.SHA256, &m.CreatedAt, &m.Provider, &m.ProviderKey, &m.PublicURL, &m.ExternalPublishStatus, &m.ExternalPublishError); err != nil {
				problem(w, 500, "读取媒体失败")
				return
			}
			out = append(out, &m)
		}
		next := ""
		if len(out) > limit {
			last := out[limit-1]
			next = encodeCursor(last.CreatedAt.UTC().Format(time.RFC3339Nano), last.ID)
			out = out[:limit]
		}
		jsonResponse(w, 200, map[string]any{"media": out, "nextCursor": next})
		return
	}
	srv.store.mu.RLock()
	out := make([]*Media, 0, len(srv.store.media))
	for _, m := range srv.store.media {
		cp := *m
		out = append(out, &cp)
	}
	srv.store.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].ID > out[j].ID
		}
		return out[i].CreatedAt.After(out[j].CreatedAt)
	})
	start := 0
	if cursor := strings.TrimSpace(r.URL.Query().Get("cursor")); cursor != "" {
		_, cursorID, ok := decodeCursor(cursor)
		if !ok {
			problem(w, http.StatusBadRequest, "cursor 无效")
			return
		}
		found := false
		for i, m := range out {
			if m.ID == cursorID {
				start = i + 1
				found = true
				break
			}
		}
		if !found {
			problem(w, http.StatusBadRequest, "cursor 无效")
			return
		}
	}
	if start > len(out) {
		start = len(out)
	}
	out = out[start:]
	next := ""
	limit := publicLimit(r)
	if len(out) > limit {
		next = encodeCursor(out[limit-1].CreatedAt.UTC().Format(time.RFC3339Nano), out[limit-1].ID)
		out = out[:limit]
	}
	jsonResponse(w, 200, map[string]any{"media": out, "nextCursor": next})
}

func (srv *Server) importDryRun(w http.ResponseWriter, r *http.Request) {
	data, err := io.ReadAll(io.LimitReader(r.Body, maxImportArchiveBytes+1))
	if err != nil {
		problem(w, 400, "导入文件读取失败")
		return
	}
	archive, archiveErr := readImportArchive(data)
	if archiveErr != nil {
		// Preserve the useful schema value for clients even when a strict
		// validation error (for example traversal or an unsupported schema)
		// prevents constructing the archive representation.
		schemaVersion := "unknown"
		if zr, zipErr := zip.NewReader(bytes.NewReader(data), int64(len(data))); zipErr == nil {
			for _, file := range zr.File {
				if !importManifestPath(file.Name) {
					continue
				}
				f, openErr := file.Open()
				if openErr != nil {
					continue
				}
				manifestData, readErr := io.ReadAll(io.LimitReader(f, maxImportFileBytes))
				_ = f.Close()
				if readErr == nil {
					var manifest importManifest
					if json.Unmarshal(manifestData, &manifest) == nil {
						schemaVersion = manifest.SchemaVersion
						if schemaVersion == "" {
							schemaVersion = manifest.SchemaVersionAlt
						}
					}
				}
				break
			}
		}
		conflicts := []string{archiveErr.Error()}
		if zr, zipErr := zip.NewReader(bytes.NewReader(data), int64(len(data))); zipErr == nil {
			for _, file := range zr.File {
				if !validImportArchivePath(file.Name) {
					conflicts = append(conflicts, "unsafe archive path: "+file.Name)
					continue
				}
				if strings.HasPrefix(file.Name, "entries/") && strings.HasSuffix(file.Name, ".json") {
					base := strings.TrimSuffix(strings.TrimPrefix(file.Name, "entries/"), ".json")
					if !validImportUUID(base) {
						conflicts = append(conflicts, "entry UUID invalid: "+file.Name)
					}
				}
			}
		}
		jsonResponse(w, http.StatusOK, map[string]any{"schemaVersion": schemaVersion, "conflicts": conflicts, "counts": map[string]int{}})
		return
	}
	counts := map[string]int{"entries": len(archive.EntryFiles), "media": len(archive.MediaFiles)}
	conflicts := []string{}
	if _, hasMediaMetadata := archive.Files["metadata/media.jsonl"]; hasMediaMetadata {
		if _, err := parseImportMediaRecords(archive); err != nil {
			conflicts = append(conflicts, err.Error())
		}
	}
	mediaIDs := map[string]struct{}{}
	for _, path := range archive.MediaFiles {
		id, ok := importArchiveMediaPath(path)
		if !ok {
			conflicts = append(conflicts, "media path invalid: "+path)
			continue
		}
		mediaIDs[id] = struct{}{}
	}
	for id := range mediaIDs {
		if _, _, ok := importMediaBytes(archive, id); !ok {
			conflicts = append(conflicts, "media duplicate bytes/name mismatch: "+id)
		}
	}
	jsonResponse(w, 200, map[string]any{"schemaVersion": archive.Schema, "conflicts": conflicts, "counts": counts})
}

func (srv *Server) exports(w http.ResponseWriter, r *http.Request) {
	if !srv.store.persistent || srv.store.database == nil {
		problem(w, http.StatusServiceUnavailable, "导出需要数据库")
		return
	}
	ownerID, err := srv.persistentUserID(r)
	if err != nil {
		problem(w, 401, "需要登录")
		return
	}
	if r.Method == http.MethodGet {
		rows, err := srv.store.database.QueryContext(r.Context(), `SELECT id::text,export_type,status,COALESCE(storage_path,''),COALESCE(sha256,''),created_at FROM exports WHERE owner_id=$1::uuid ORDER BY created_at DESC`, ownerID)
		if err != nil {
			problem(w, 500, "读取导出失败")
			return
		}
		defer rows.Close()
		out := []map[string]any{}
		for rows.Next() {
			var id, typ, status, path, sum string
			var created time.Time
			if rows.Scan(&id, &typ, &status, &path, &sum, &created) != nil {
				problem(w, 500, "读取导出失败")
				return
			}
			item := map[string]any{"id": id, "type": typ, "status": status, "sha256": sum, "createdAt": created}
			if status == "ready" {
				item["downloadUrl"] = "/api/v1/admin/exports/" + id + "/download"
			}
			out = append(out, item)
		}
		jsonResponse(w, 200, map[string]any{"exports": out})
		return
	}
	if r.Method != http.MethodPost {
		problem(w, 405, "方法不允许")
		return
	}
	var in struct {
		Type string `json:"type"`
	}
	if decode(r, &in) != nil || (in.Type != "public" && in.Type != "full") {
		problem(w, 400, "导出类型无效")
		return
	}
	var id string
	if err := srv.store.database.QueryRowContext(r.Context(), `INSERT INTO exports(id,owner_id,export_type,status) VALUES(gen_random_uuid(),$1::uuid,$2,'queued') RETURNING id::text`, ownerID, in.Type).Scan(&id); err != nil {
		problem(w, 500, "创建导出失败")
		return
	}
	typ := "export_" + in.Type
	payload, _ := json.Marshal(map[string]any{"exportId": id, "type": in.Type})
	if _, err := srv.store.database.ExecContext(r.Context(), `INSERT INTO jobs(type,payload) VALUES($1,$2)`, typ, payload); err != nil {
		problem(w, 500, "排队导出失败")
		return
	}
	jsonResponse(w, http.StatusAccepted, map[string]any{"id": id, "type": in.Type, "status": "queued"})
}

func (srv *Server) exportDownload(w http.ResponseWriter, r *http.Request) {
	if !srv.store.persistent || srv.store.database == nil {
		problem(w, 503, "导出需要数据库")
		return
	}
	ownerID, err := srv.persistentUserID(r)
	if err != nil {
		problem(w, 401, "需要登录")
		return
	}
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/admin/exports/"), "/")
	path = strings.TrimSuffix(path, "/download")
	var filePath string
	if err := srv.store.database.QueryRowContext(r.Context(), `SELECT storage_path FROM exports WHERE id=$1::uuid AND owner_id=$2::uuid AND status='ready'`, path, ownerID).Scan(&filePath); err != nil {
		problem(w, 404, "导出不存在")
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	http.ServeFile(w, r, filePath)
}

// Keep imports used by static analysis when SQL drivers are excluded in tests.
var _ = sql.ErrNoRows
var _ = fmt.Sprintf
var _ = filepath.Base
