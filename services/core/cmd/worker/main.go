package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

var mediaReferencePattern = regexp.MustCompile(`media://([A-Za-z0-9._~-]+)`)
var mediaSpanPattern = regexp.MustCompile(`(?s)<span\b[^>]*\bdata-media-id="([A-Za-z0-9._~-]+)"[^>]*>.*?</span>`)
var exportMermaidPlaceholderPattern = regexp.MustCompile(`(?s)<div\s+class="mermaid-placeholder"\s+data-mermaid="([^"]+)"[^>]*>.*?</div>`)
var exportEmbedPlaceholderPattern = regexp.MustCompile(`(?s)<div\s+class="embed-placeholder"\s+data-provider="([^"]+)"\s+data-embed-url="([^"]+)"[^>]*>.*?</div>`)

type exportEntry struct {
	ID            string    `json:"id"`
	Kind          string    `json:"kind"`
	Status        string    `json:"status"`
	Visibility    string    `json:"visibility"`
	Title         string    `json:"title,omitempty"`
	Slug          string    `json:"slug,omitempty"`
	Summary       string    `json:"summary,omitempty"`
	Markdown      string    `json:"markdown,omitempty"`
	RenderedHTML  string    `json:"renderedHtml,omitempty"`
	PlainText     string    `json:"plainText,omitempty"`
	JournalDate   string    `json:"journalDate"`
	JournalTime   string    `json:"journalTime,omitempty"`
	TimePrecision string    `json:"timePrecision"`
	DayPosition   int       `json:"dayPosition"`
	Revision      int64     `json:"revision"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

type exportMedia struct {
	ID         string
	Original   string
	MimeType   string
	Size       int64
	Visibility string
	Storage    string
	SHA256     string
}

func rewriteExportMediaReferences(text string, media map[string]exportMedia) string {
	return rewriteExportMediaReferencesMode(text, media, false)
}

func rewriteExportMediaReferencesMode(text string, media map[string]exportMedia, publicOnly bool) string {
	return rewriteExportMediaReferencesRelative(text, media, publicOnly, "")
}

func exportRelativeAssetPath(fromFile, assetPath string) string {
	if fromFile == "" {
		return filepath.ToSlash(filepath.Clean(assetPath))
	}
	rel, err := filepath.Rel(filepath.Dir(filepath.FromSlash(fromFile)), filepath.FromSlash(assetPath))
	if err != nil {
		return filepath.ToSlash(filepath.Clean(assetPath))
	}
	return filepath.ToSlash(rel)
}

func rewriteExportMediaReferencesRelative(text string, media map[string]exportMedia, publicOnly bool, fromFile string) string {
	text = mediaSpanPattern.ReplaceAllStringFunc(text, func(token string) string {
		match := mediaSpanPattern.FindStringSubmatch(token)
		if len(match) < 2 {
			return token
		}
		id := match[1]
		m, ok := media[id]
		if !ok || (publicOnly && m.Visibility != "public") {
			if publicOnly {
				return `<span class="media-unavailable">媒体不可用</span>`
			}
			return `<span class="media-unavailable">媒体不可用</span>`
		}
		target := exportRelativeAssetPath(fromFile, "assets/media/"+id+"/"+filepath.Base(m.Original))
		label := html.EscapeString(filepath.Base(m.Original))
		if strings.HasPrefix(strings.ToLower(m.MimeType), "image/") {
			return `<img src="` + html.EscapeString(target) + `" alt="` + label + `">`
		}
		return `<a href="` + html.EscapeString(target) + `">` + label + `</a>`
	})
	return mediaReferencePattern.ReplaceAllStringFunc(text, func(token string) string {
		id := strings.TrimPrefix(token, "media://")
		m, ok := media[id]
		if !ok || (publicOnly && m.Visibility != "public") {
			if publicOnly {
				return "[媒体不可用]"
			}
			return token
		}
		return exportRelativeAssetPath(fromFile, "assets/media/"+id+"/"+filepath.Base(m.Original))
	})
}

// rewriteExportMermaidPlaceholders turns the client-side Mermaid placeholder
// into a deterministic inline SVG. A Mermaid renderer is intentionally not a
// runtime dependency of the worker; the SVG explicitly labels the fallback
// and includes a short escaped source preview so an exported archive remains
// self-contained and understandable when opened offline.
func rewriteExportMermaidPlaceholders(text string) string {
	return exportMermaidPlaceholderPattern.ReplaceAllStringFunc(text, func(token string) string {
		match := exportMermaidPlaceholderPattern.FindStringSubmatch(token)
		if len(match) < 2 {
			return token
		}
		raw, err := base64.RawURLEncoding.DecodeString(match[1])
		if err != nil {
			return `<div class="mermaid-unavailable">Mermaid 图表不可用</div>`
		}
		source := strings.Join(strings.Fields(html.UnescapeString(string(raw))), " ")
		if len([]rune(source)) > 220 {
			source = string([]rune(source)[:220]) + "…"
		}
		return `<svg class="mermaid-fallback" viewBox="0 0 720 120" role="img" aria-label="Mermaid diagram fallback" xmlns="http://www.w3.org/2000/svg"><title>Mermaid renderer unavailable; source preview</title><rect width="720" height="120" rx="8" fill="#f4f1e8" stroke="#c8c0ad"/><text x="20" y="34" fill="#514b42" font-family="system-ui,sans-serif" font-size="16">Mermaid diagram unavailable (fallback)</text><text x="20" y="68" fill="#514b42" font-family="ui-monospace,monospace" font-size="12">` + html.EscapeString(source) + `</text></svg>`
	})
}

func exportEmbedProviderHost(provider, host string) bool {
	switch provider {
	case "youtube":
		return host == "youtube.com" || strings.HasSuffix(host, ".youtube.com") || host == "youtu.be"
	case "bilibili":
		return host == "bilibili.com" || strings.HasSuffix(host, ".bilibili.com")
	case "vimeo":
		return host == "vimeo.com" || strings.HasSuffix(host, ".vimeo.com")
	default:
		return false
	}
}

// rewriteExportEmbedPlaceholders deliberately emits a static card instead of
// an iframe. Exported archives must remain offline-safe and must not execute
// third-party content merely by opening an HTML page. The URL is parsed and
// checked against the same provider allowlist used by the renderer before it
// is copied into an escaped external link.
func rewriteExportEmbedPlaceholders(text string) string {
	return exportEmbedPlaceholderPattern.ReplaceAllStringFunc(text, func(token string) string {
		match := exportEmbedPlaceholderPattern.FindStringSubmatch(token)
		if len(match) < 3 {
			return token
		}
		provider := strings.ToLower(strings.TrimSpace(match[1]))
		raw := html.UnescapeString(strings.TrimSpace(match[2]))
		u, err := url.Parse(raw)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || !exportEmbedProviderHost(provider, strings.ToLower(u.Hostname())) {
			return `<div class="embed-unavailable">嵌入内容不可用</div>`
		}
		labels := map[string]string{"youtube": "YouTube", "bilibili": "哔哩哔哩", "vimeo": "Vimeo"}
		label := labels[provider]
		return `<article class="embed-card" data-provider="` + html.EscapeString(provider) + `"><p class="embed-card-title">嵌入内容 · ` + html.EscapeString(label) + `</p><a href="` + html.EscapeString(u.String()) + `" target="_blank" rel="noopener noreferrer">打开原链接</a><p class="embed-card-note">导出文件不嵌入第三方内容，请在网络可用时打开原链接。</p></article>`
	})
}

func rewriteExportPlaceholders(text string) string {
	return rewriteExportEmbedPlaceholders(rewriteExportMermaidPlaceholders(text))
}

func encodeExportEntryJSON(e exportEntry, publicOnly bool) ([]byte, bool) {
	if publicOnly && e.Visibility == "private" {
		placeholder := map[string]any{"visibility": "private", "journalDate": e.JournalDate, "journalTime": e.JournalTime, "placeholder": true, "text": "这是一条私人记录 🔒"}
		data, _ := json.MarshalIndent(placeholder, "", "  ")
		return data, true
	}
	data, _ := json.MarshalIndent(e, "", "  ")
	return data, false
}

// addExportEntryFiles writes the JSON representation and, for non-placeholder
// entries, the markdown and rendered HTML companions. Keeping this small
// helper pure with respect to the ZIP writer makes export privacy behavior
// straightforward to test without a database.
func addExportEntryFiles(zw *zip.Writer, e exportEntry, publicOnly bool) ([]string, error) {
	return addExportEntryFilesWithChecksums(zw, e, publicOnly, nil)
}

func addExportEntryFilesWithChecksums(zw *zip.Writer, e exportEntry, publicOnly bool, checksums map[string]string) ([]string, error) {
	data, isPlaceholder := encodeExportEntryJSON(e, publicOnly)
	files := []string{"entries/" + e.ID + ".json"}
	w, err := zw.Create(files[0])
	if err != nil {
		return nil, err
	}
	if _, err = w.Write(data); err != nil {
		return nil, err
	}
	if checksums != nil {
		sum := sha256.Sum256(data)
		checksums[files[0]] = hex.EncodeToString(sum[:])
	}
	if isPlaceholder {
		return files, nil
	}
	for _, companion := range []struct {
		ext  string
		data []byte
	}{
		{ext: ".md", data: []byte(e.Markdown)},
		{ext: ".html", data: []byte(e.RenderedHTML)},
	} {
		name := "entries/" + e.ID + companion.ext
		w, err := zw.Create(name)
		if err != nil {
			return nil, err
		}
		if _, err = w.Write(companion.data); err != nil {
			return nil, err
		}
		if checksums != nil {
			sum := sha256.Sum256(companion.data)
			checksums[name] = hex.EncodeToString(sum[:])
		}
		files = append(files, name)
	}
	return files, nil
}

func copyExportMedia(zw *zip.Writer, entryName, storagePath string) error {
	return copyExportMediaWithChecksums(zw, entryName, storagePath, nil)
}

func copyExportMediaWithChecksums(zw *zip.Writer, entryName, storagePath string, checksums map[string]string) error {
	in, err := os.Open(storagePath)
	if err != nil {
		return fmt.Errorf("media %s unavailable: %w", entryName, err)
	}
	defer in.Close()
	w, err := zw.Create(entryName)
	if err != nil {
		return err
	}
	h := sha256.New()
	if _, err = io.Copy(io.MultiWriter(w, h), in); err != nil {
		return err
	}
	if checksums != nil {
		checksums[entryName] = hex.EncodeToString(h.Sum(nil))
	}
	return nil
}

// appendExportJSONL appends one deterministic JSON object followed by a newline
// to an export metadata stream. Keeping JSONL assembly in one helper makes it
// impossible for a metadata row to be emitted without a trailing record
// delimiter or silently dropped on marshal failure.
func appendExportJSONL(buf *bytes.Buffer, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	buf.Write(data)
	buf.WriteByte('\n')
	return nil
}

type exportStatusIndexEntry struct {
	ID          string
	Title       string
	JournalDate string
	Href        string
}

func renderExportStatusIndex(title string, entries []exportStatusIndexEntry) []byte {
	var out bytes.Buffer
	fmt.Fprintf(&out, "<!doctype html><meta charset=\"utf-8\"><title>%s</title><h1>%s</h1><ul>", html.EscapeString(title), html.EscapeString(title))
	for _, entry := range entries {
		label := entry.Title
		if label == "" {
			label = entry.ID
		}
		href := entry.Href
		if href == "" {
			href = "../entries/" + entry.ID + ".html"
		}
		fmt.Fprintf(&out, "<li><a href=\"%s\">%s</a> <time>%s</time></li>\n", html.EscapeString(href), html.EscapeString(label), html.EscapeString(entry.JournalDate))
	}
	out.WriteString("</ul>")
	return out.Bytes()
}

func renderExportEntryPage(title, journalDate, body, pagePath string) []byte {
	cssPath := exportRelativeAssetPath(pagePath, "assets/css/export.css")
	return []byte(fmt.Sprintf("<!doctype html><meta charset=\"utf-8\"><link rel=\"stylesheet\" href=\"%s\"><article><h1>%s</h1><time>%s</time>%s</article>", html.EscapeString(cssPath), html.EscapeString(title), html.EscapeString(journalDate), body))
}

func renderExportLayerIndex(title, target string) []byte {
	return []byte(fmt.Sprintf("<!doctype html><meta charset=\"utf-8\"><title>%s</title><h1>%s</h1><p><a href=\"%s\">打开导出索引</a></p>", html.EscapeString(title), html.EscapeString(title), html.EscapeString(target)))
}

func verifyExportChecksums(files []*zip.File, checksums map[string]string) error {
	for _, file := range files {
		if file.Name == "manifest.json" || file.Name == "metadata/manifest.json" {
			continue
		}
		expected, ok := checksums[file.Name]
		if !ok {
			return fmt.Errorf("manifest missing checksum for %s", file.Name)
		}
		reader, err := file.Open()
		if err != nil {
			return err
		}
		h := sha256.New()
		_, copyErr := io.Copy(h, reader)
		closeErr := reader.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		if got := hex.EncodeToString(h.Sum(nil)); got != expected {
			return fmt.Errorf("checksum mismatch for %s", file.Name)
		}
	}
	return nil
}

func main() {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		log.Fatal("DATABASE_URL is required")
	}
	db, err := sql.Open("pgx", url)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	if len(os.Args) > 1 && os.Args[1] == "--healthcheck" {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := db.PingContext(ctx); err != nil {
			os.Exit(1)
		}
		var ready int
		if err := db.QueryRowContext(ctx, `SELECT 1 FROM schema_migrations LIMIT 1`).Scan(&ready); err != nil {
			os.Exit(1)
		}
		if err := db.QueryRowContext(ctx, `SELECT 1 FROM jobs LIMIT 1`).Scan(&ready); err != nil && err != sql.ErrNoRows {
			os.Exit(1)
		}
		return
	}
	workerID := os.Getenv("HOSTNAME")
	if workerID == "" {
		workerID = "worker"
	}
	log.Printf("timeline worker started; queue backend=postgres polling=%s", time.Second)
	for {
		if err := runJob(context.Background(), db, workerID); err != nil {
			log.Printf("job error: %v", err)
		}
		time.Sleep(time.Second)
	}
}

func runJob(ctx context.Context, db *sql.DB, workerID string) error {
	if err := cleanupAbandonedUploads(ctx, db); err != nil {
		log.Printf("cleanup abandoned uploads error: %v", err)
	}
	if err := purgeExpiredTrash(ctx, db); err != nil {
		log.Printf("purge expired trash error: %v", err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var id int64
	var typ string
	var payload []byte
	err = tx.QueryRowContext(ctx, `SELECT id,type,payload FROM jobs WHERE status='queued' AND run_at<=now() ORDER BY priority DESC,run_at,id FOR UPDATE SKIP LOCKED LIMIT 1`).Scan(&id, &typ, &payload)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE jobs SET status='running',locked_at=now(),locked_by=$1,attempts=attempts+1 WHERE id=$2`, workerID, id); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	var jobErr error
	switch typ {
	case "media_delete":
		var p struct {
			Path    string `json:"path"`
			MediaID string `json:"mediaId"`
		}
		_ = json.Unmarshal(payload, &p)
		jobErr = deleteMediaJob(ctx, db, p.MediaID, p.Path)
	case "export_public", "export_full":
		jobErr = generateExport(ctx, db, payload, typ)
	default:
		jobErr = nil
	}
	status := "done"
	if jobErr != nil {
		status = "queued"
	}
	_, err = db.ExecContext(ctx, `UPDATE jobs SET status=$1,run_at=CASE WHEN $1='queued' THEN now()+make_interval(secs => LEAST(3600, power(2, attempts)::int * 5)) ELSE run_at END,error=$2,locked_at=NULL,locked_by=NULL WHERE id=$3`, status, func() any {
		if jobErr != nil {
			return jobErr.Error()
		}
		return nil
	}(), id)
	return err
}

func mediaPathWithinRoot(root, path string) bool {
	if root == "" || path == "" {
		return false
	}
	cleanRoot, errRoot := filepath.Abs(root)
	cleanPath, errPath := filepath.Abs(path)
	if errRoot != nil || errPath != nil {
		return false
	}
	return cleanPath != cleanRoot && strings.HasPrefix(cleanPath, cleanRoot+string(os.PathSeparator))
}

func deleteMediaJob(ctx context.Context, db *sql.DB, mediaID, path string) error {
	if mediaID == "" {
		return fmt.Errorf("media id missing")
	}
	root := getenvWorker("MEDIA_ROOT", "")
	if !mediaPathWithinRoot(root, path) {
		return fmt.Errorf("media path outside root")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var storedPath, status string
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(storage_path,''),status FROM media WHERE id=$1::uuid FOR UPDATE`, mediaID).Scan(&storedPath, &status); err == sql.ErrNoRows {
		return tx.Commit()
	} else if err != nil {
		return err
	}
	if status != "deleting" {
		return tx.Commit()
	}
	var referenced bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM media_refs WHERE media_id=$1::uuid)`, mediaID).Scan(&referenced); err != nil {
		return err
	}
	if referenced {
		if _, err := tx.ExecContext(ctx, `UPDATE media SET status='ready' WHERE id=$1::uuid AND status='deleting'`, mediaID); err != nil {
			return err
		}
		return tx.Commit()
	}
	if storedPath == "" {
		storedPath = path
	}
	if !mediaPathWithinRoot(root, storedPath) {
		return fmt.Errorf("stored media path outside root")
	}
	if err := os.Remove(storedPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM media WHERE id=$1::uuid AND status='deleting' AND NOT EXISTS (SELECT 1 FROM media_refs WHERE media_id=$1::uuid)`, mediaID); err != nil {
		return err
	}
	return tx.Commit()
}

func cleanupAbandonedUploads(ctx context.Context, db *sql.DB) error {
	root := getenvWorker("MEDIA_ROOT", "")
	if root == "" {
		return nil
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT id::text FROM media WHERE status='uploading' AND created_at < now() - interval '24 hours' ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED`)
	if err != nil {
		return err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, id := range ids {
		if _, err := tx.ExecContext(ctx, `UPDATE media SET status='deleting' WHERE id=$1::uuid AND status='uploading'`, id); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	for _, id := range ids {
		path := filepath.Join(root, id+"-upload")
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			continue
		}
		if _, err := db.ExecContext(ctx, `DELETE FROM media WHERE id=$1::uuid AND status='deleting'`, id); err != nil {
			return err
		}
	}
	return nil
}

func purgeExpiredTrash(ctx context.Context, db *sql.DB) error {
	rows, err := db.QueryContext(ctx, `SELECT id::text,author_id::text FROM entries WHERE status='trashed' AND deleted_at IS NOT NULL AND deleted_at <= now() - interval '30 days' ORDER BY deleted_at LIMIT 50`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var entryID, ownerID string
		if err := rows.Scan(&entryID, &ownerID); err != nil {
			return err
		}
		if err := purgeOneEntry(ctx, db, entryID, ownerID); err != nil {
			continue
		}
	}
	return rows.Err()
}

func purgeOneEntry(ctx context.Context, db *sql.DB, entryID, ownerID string) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var currentStatus string
	var deletedAt sql.NullTime
	if err := tx.QueryRowContext(ctx, `SELECT status,deleted_at FROM entries WHERE id=$1::uuid AND author_id=$2::uuid FOR UPDATE`, entryID, ownerID).Scan(&currentStatus, &deletedAt); err == sql.ErrNoRows {
		return tx.Commit()
	} else if err != nil {
		return err
	}
	if currentStatus != "trashed" || !deletedAt.Valid || deletedAt.Time.After(time.Now().Add(-30*24*time.Hour)) {
		return tx.Commit()
	}
	rows, err := tx.QueryContext(ctx, `SELECT media_id::text FROM media_refs WHERE entry_id=$1::uuid FOR UPDATE`, entryID)
	if err != nil {
		return err
	}
	mediaIDs := []string{}
	for rows.Next() {
		var mediaID string
		if err := rows.Scan(&mediaID); err != nil {
			rows.Close()
			return err
		}
		mediaIDs = append(mediaIDs, mediaID)
	}
	rows.Close()
	res, err := tx.ExecContext(ctx, `DELETE FROM entries WHERE id=$1::uuid AND author_id=$2::uuid AND status='trashed' AND deleted_at <= now() - interval '30 days'`, entryID, ownerID)
	if err != nil {
		return err
	}
	if affected, err := res.RowsAffected(); err != nil {
		return err
	} else if affected != 1 {
		return tx.Commit()
	}
	for _, mediaID := range mediaIDs {
		var path sql.NullString
		if err := tx.QueryRowContext(ctx, `UPDATE media SET status='deleting' WHERE id=$1::uuid AND status='ready' AND NOT EXISTS (SELECT 1 FROM media_refs WHERE media_id=$1::uuid) RETURNING storage_path`, mediaID).Scan(&path); err == nil && path.Valid && path.String != "" {
			payload, _ := json.Marshal(map[string]any{"path": path.String, "mediaId": mediaID})
			if _, err := tx.ExecContext(ctx, `INSERT INTO jobs(type,payload) VALUES('media_delete',$1)`, payload); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

func generateExport(ctx context.Context, db *sql.DB, payload []byte, typ string) error {
	var p struct {
		ExportID string `json:"exportId"`
		Type     string `json:"type"`
	}
	if err := json.Unmarshal(payload, &p); err != nil || p.ExportID == "" {
		return fmt.Errorf("invalid export payload")
	}
	if p.Type == "" {
		p.Type = strings.TrimPrefix(typ, "export_")
	}
	var ownerID, exportType string
	if err := db.QueryRowContext(ctx, `UPDATE exports SET status='running',updated_at=now() WHERE id=$1::uuid RETURNING owner_id::text,export_type`, p.ExportID).Scan(&ownerID, &exportType); err != nil {
		return err
	}
	if exportType != "" {
		p.Type = exportType
	}
	mediaIndex := map[string]exportMedia{}
	mediaRows, err := db.QueryContext(ctx, `SELECT id::text,original_name,mime_type,size_bytes,visibility,COALESCE(storage_path,'') FROM media WHERE owner_id=$1::uuid AND status='ready' AND ($2 <> 'public' OR visibility='public')`, ownerID, p.Type)
	if err != nil {
		return err
	}
	for mediaRows.Next() {
		var m exportMedia
		if err := mediaRows.Scan(&m.ID, &m.Original, &m.MimeType, &m.Size, &m.Visibility, &m.Storage); err != nil {
			mediaRows.Close()
			return err
		}
		if m.Visibility != "public" && m.Visibility != "private" {
			mediaRows.Close()
			return fmt.Errorf("media %s has unknown visibility", m.ID)
		}
		mediaIndex[m.ID] = m
	}
	if err := mediaRows.Err(); err != nil {
		mediaRows.Close()
		return err
	}
	mediaRows.Close()
	fail := func(err error) error {
		_, _ = db.ExecContext(ctx, `UPDATE exports SET status='failed',error=$1,updated_at=now() WHERE id=$2::uuid`, err.Error(), p.ExportID)
		return err
	}
	root := os.Getenv("EXPORT_ROOT")
	if root == "" {
		root = filepath.Join(getenvWorker("MEDIA_ROOT", os.TempDir()), "exports")
	}
	if err := os.MkdirAll(root, 0750); err != nil {
		return fail(err)
	}
	tmpPath := filepath.Join(root, p.ExportID+".tmp")
	finalPath := filepath.Join(root, p.ExportID+".zip")
	f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return fail(err)
	}
	zw := zip.NewWriter(f)
	files := []string{}
	checksums := map[string]string{}
	entryLines := &bytes.Buffer{}
	dayPages := map[string]*bytes.Buffer{}
	articlePages := map[string]*bytes.Buffer{}
	dayMarkdown := map[string][]byte{}
	articleMarkdown := map[string][]byte{}
	draftIndexEntries := make([]exportStatusIndexEntry, 0)
	trashIndexEntries := make([]exportStatusIndexEntry, 0)
	publicIndexEntries := make([]exportStatusIndexEntry, 0)
	privateIndexEntries := make([]exportStatusIndexEntry, 0)
	addBytes := func(name string, data []byte) error {
		w, e := zw.Create(name)
		if e != nil {
			return e
		}
		if _, e = w.Write(data); e != nil {
			return e
		}
		files = append(files, name)
		sum := sha256.Sum256(data)
		checksums[name] = hex.EncodeToString(sum[:])
		return nil
	}
	rows, err := db.QueryContext(ctx, `SELECT id::text,kind,status,visibility,COALESCE(title,''),COALESCE(slug,''),COALESCE(summary,''),markdown,rendered_html,plain_text,journal_date::text,COALESCE(journal_time::text,''),time_precision,day_position,revision,created_at,updated_at FROM entries WHERE author_id=$1::uuid AND ($2='full' OR status='published') ORDER BY journal_date DESC,journal_time ASC NULLS FIRST,day_position,id`, ownerID, p.Type)
	if err != nil {
		_ = zw.Close()
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fail(err)
	}
	for rows.Next() {
		var e exportEntry
		if err := rows.Scan(&e.ID, &e.Kind, &e.Status, &e.Visibility, &e.Title, &e.Slug, &e.Summary, &e.Markdown, &e.RenderedHTML, &e.PlainText, &e.JournalDate, &e.JournalTime, &e.TimePrecision, &e.DayPosition, &e.Revision, &e.CreatedAt, &e.UpdatedAt); err != nil {
			rows.Close()
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return fail(err)
		}
		rawMarkdown := e.Markdown
		rawRenderedHTML := e.RenderedHTML
		if p.Type == "full" {
			statusEntry := exportStatusIndexEntry{ID: e.ID, Title: e.Title, JournalDate: e.JournalDate}
			switch e.Status {
			case "draft":
				draftIndexEntries = append(draftIndexEntries, statusEntry)
			case "trashed":
				trashIndexEntries = append(trashIndexEntries, statusEntry)
			}
			if e.Visibility == "public" {
				publicIndexEntries = append(publicIndexEntries, statusEntry)
			} else {
				privateIndexEntries = append(privateIndexEntries, statusEntry)
			}
		}
		entryJSONEntry := e
		entryJSONEntry.Markdown = rewriteExportPlaceholders(rewriteExportMediaReferencesRelative(rawMarkdown, mediaIndex, p.Type == "public", "metadata/entries.jsonl"))
		entryJSONEntry.RenderedHTML = rewriteExportPlaceholders(rewriteExportMediaReferencesRelative(rawRenderedHTML, mediaIndex, p.Type == "public", "metadata/entries.jsonl"))
		entryJSON, _ := encodeExportEntryJSON(entryJSONEntry, p.Type == "public")
		if len(entryJSON) == 0 {
			rows.Close()
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return fail(fmt.Errorf("entry %s metadata encoding failed", e.ID))
		}
		entryLines.Write(entryJSON)
		entryLines.WriteByte('\n')
		body := rawRenderedHTML
		markdown := rawMarkdown
		if p.Type == "public" && e.Visibility == "private" {
			body = "<p>这是一条私人记录 🔒</p>"
			markdown = "# 私人记录\n\n这是一条私人记录 🔒\n"
		}
		dayKey := strings.ReplaceAll(e.JournalDate, "-", "/")
		dayPath := "days/" + dayKey + "/index.html"
		body = rewriteExportPlaceholders(rewriteExportMediaReferencesRelative(body, mediaIndex, p.Type == "public", dayPath))
		pageTitle := e.Title
		if p.Type == "public" && e.Visibility == "private" {
			pageTitle = ""
		}
		page := renderExportEntryPage(pageTitle, e.JournalDate, body, dayPath)
		if dayPages[dayPath] == nil {
			dayPages[dayPath] = &bytes.Buffer{}
		}
		dayPages[dayPath].Write(page)
		dayMarkdownPath := "markdown/days/" + dayKey + ".md"
		dayMarkdown[dayMarkdownPath] = []byte(rewriteExportPlaceholders(rewriteExportMediaReferencesRelative(markdown, mediaIndex, p.Type == "public", dayMarkdownPath)))
		if e.Kind == "article" && !(p.Type == "public" && e.Visibility == "private") {
			slug := e.Slug
			if slug == "" {
				slug = e.ID
			}
			articlePath := "articles/" + slug + "/index.html"
			articleBody := rewriteExportPlaceholders(rewriteExportMediaReferencesRelative(rawRenderedHTML, mediaIndex, p.Type == "public", articlePath))
			articlePage := renderExportEntryPage(e.Title, e.JournalDate, articleBody, articlePath)
			if articlePages[articlePath] == nil {
				articlePages[articlePath] = &bytes.Buffer{}
			}
			articlePages[articlePath].Write(articlePage)
			articleMarkdownPath := "markdown/articles/" + slug + ".md"
			articleMarkdown[articleMarkdownPath] = []byte(rewriteExportPlaceholders(rewriteExportMediaReferencesRelative(markdown, mediaIndex, p.Type == "public", articleMarkdownPath)))
		}
		entryExport := entryJSONEntry
		entryExport.Markdown = rewriteExportPlaceholders(rewriteExportMediaReferencesRelative(rawMarkdown, mediaIndex, p.Type == "public", "entries/"+e.ID+".md"))
		entryExport.RenderedHTML = rewriteExportPlaceholders(rewriteExportMediaReferencesRelative(rawRenderedHTML, mediaIndex, p.Type == "public", "entries/"+e.ID+".html"))
		if p.Type == "public" && e.Visibility == "private" {
			entryExport.Title = ""
			entryExport.Slug = ""
			entryExport.Kind = "note"
		}
		entryFiles, err := addExportEntryFilesWithChecksums(zw, entryExport, p.Type == "public", checksums)
		if err != nil {
			rows.Close()
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return fail(err)
		}
		files = append(files, entryFiles...)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		_ = zw.Close()
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fail(err)
	}
	rows.Close()
	if err := addBytes("metadata/entries.jsonl", entryLines.Bytes()); err != nil {
		_ = zw.Close()
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fail(err)
	}
	for name, page := range dayPages {
		if err := addBytes(name, page.Bytes()); err != nil {
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return fail(err)
		}
	}
	for name, page := range articlePages {
		if err := addBytes(name, page.Bytes()); err != nil {
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return fail(err)
		}
	}
	for name, data := range dayMarkdown {
		if err := addBytes(name, data); err != nil {
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return fail(err)
		}
	}
	for name, data := range articleMarkdown {
		if err := addBytes(name, data); err != nil {
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return fail(err)
		}
	}
	index := []byte("<!doctype html><meta charset=\"utf-8\"><title>Personal Timeline Export</title><h1>Personal Timeline Export</h1><ul>")
	for _, name := range files {
		if strings.HasPrefix(name, "entries/") && strings.HasSuffix(name, ".html") {
			index = append(index, []byte("<li><a href=\""+strings.TrimSuffix(name, ".html")+".html\">"+strings.TrimPrefix(strings.TrimSuffix(name, ".html"), "entries/")+"</a></li>\n")...)
		}
	}
	index = append(index, []byte("</ul>")...)
	if err := addBytes("index.html", index); err != nil {
		_ = zw.Close()
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fail(err)
	}
	calendarIndex := []byte("<!doctype html><meta charset=\"utf-8\"><title>Calendar</title><h1>Calendar</h1><p><a href=\"../index.html\">返回首页</a></p><ul>")
	for name := range dayPages {
		calendarIndex = append(calendarIndex, []byte("<li><a href=\"../"+html.EscapeString(name)+"\">"+html.EscapeString(strings.TrimPrefix(name, "days/"))+"</a></li>\n")...)
	}
	calendarIndex = append(calendarIndex, []byte("</ul>")...)
	if err := addBytes("calendar/index.html", calendarIndex); err != nil {
		_ = zw.Close()
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fail(err)
	}
	// Taxonomy is scoped through the owner's exported entries. Public exports
	// intentionally exclude categories/tags attached only to private entries.
	type exportCategory struct {
		ID        string    `json:"id"`
		Name      string    `json:"name"`
		Slug      string    `json:"slug"`
		CreatedAt time.Time `json:"createdAt"`
	}
	type exportTag struct {
		ID             string `json:"id"`
		DisplayName    string `json:"displayName"`
		NormalizedName string `json:"normalizedName"`
		Slug           string `json:"slug"`
	}
	categories := make([]exportCategory, 0)
	categoryRows, err := db.QueryContext(ctx, `
		SELECT c.id::text,c.name,c.slug,c.created_at
		FROM categories c
		WHERE EXISTS (
			SELECT 1
			FROM entry_categories ec
			JOIN entries e ON e.id=ec.entry_id
			WHERE ec.category_id=c.id
			  AND e.author_id=$1::uuid
			  AND ($2='full' OR (e.status='published' AND e.visibility='public'))
		)
		ORDER BY c.name,c.id`, ownerID, p.Type)
	if err != nil {
		_ = zw.Close()
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fail(err)
	}
	for categoryRows.Next() {
		var category exportCategory
		if err := categoryRows.Scan(&category.ID, &category.Name, &category.Slug, &category.CreatedAt); err != nil {
			categoryRows.Close()
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return fail(err)
		}
		categories = append(categories, category)
	}
	if err := categoryRows.Err(); err != nil {
		categoryRows.Close()
		_ = zw.Close()
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fail(err)
	}
	categoryRows.Close()
	categoryData, err := json.Marshal(categories)
	if err != nil {
		_ = zw.Close()
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fail(err)
	}
	if err := addBytes("metadata/categories.json", categoryData); err != nil {
		_ = zw.Close()
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fail(err)
	}
	tags := make([]exportTag, 0)
	tagRows, err := db.QueryContext(ctx, `
		SELECT t.id::text,t.display_name,t.normalized_name,t.slug
		FROM tags t
		WHERE EXISTS (
			SELECT 1
			FROM entry_tags et
			JOIN entries e ON e.id=et.entry_id
			WHERE et.tag_id=t.id
			  AND e.author_id=$1::uuid
			  AND ($2='full' OR (e.status='published' AND e.visibility='public'))
		)
		ORDER BY t.display_name,t.id`, ownerID, p.Type)
	if err != nil {
		_ = zw.Close()
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fail(err)
	}
	for tagRows.Next() {
		var tag exportTag
		if err := tagRows.Scan(&tag.ID, &tag.DisplayName, &tag.NormalizedName, &tag.Slug); err != nil {
			tagRows.Close()
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return fail(err)
		}
		tags = append(tags, tag)
	}
	if err := tagRows.Err(); err != nil {
		tagRows.Close()
		_ = zw.Close()
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fail(err)
	}
	tagRows.Close()
	tagData, err := json.Marshal(tags)
	if err != nil {
		_ = zw.Close()
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fail(err)
	}
	if err := addBytes("metadata/tags.json", tagData); err != nil {
		_ = zw.Close()
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fail(err)
	}
	const exportCSS = `:root{color-scheme:light;--ink:#2f302c;--muted:#6f716a;--line:#d9d8cf;--surface:#f6f5ef;--accent:#176b5e}*{box-sizing:border-box}body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:#fbfaf6;max-width:72rem;margin:2rem auto;padding:0 1rem;line-height:1.6}a{color:var(--accent);text-underline-offset:.15em}article{max-width:52rem;margin:0 auto}article>h1{line-height:1.2;margin-bottom:.3rem}time{color:var(--muted);font-size:.9rem}.embed-card{margin:1.5rem 0;padding:1rem 1.2rem;border:1px solid var(--line);border-radius:.8rem;background:var(--surface);box-shadow:0 4px 20px #2f302c0d}.embed-card-title{font-weight:650;margin:0 0 .35rem}.embed-card-note{color:var(--muted);font-size:.88rem;margin:.5rem 0 0}.embed-unavailable,.media-unavailable{padding:.75rem 1rem;border:1px dashed #b7b4a8;border-radius:.6rem;color:var(--muted);background:#f5f3ec}.mermaid-fallback{display:block;width:100%;height:auto;margin:1rem 0;border:1px solid var(--line);border-radius:.6rem;background:#f4f1e8}pre{overflow:auto;padding:1rem;border-radius:.6rem;background:#f1f0ea}`
	if err := addBytes("assets/css/export.css", []byte(exportCSS)); err != nil {
		_ = zw.Close()
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fail(err)
	}
	if err := addBytes("README.txt", []byte("Personal Timeline export schema v1.\n\nOpen index.html for navigation. All paths are relative and media files live under assets/media/.\n")); err != nil {
		_ = zw.Close()
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fail(err)
	}
	relations := &bytes.Buffer{}
	relationRows, err := db.QueryContext(ctx, `
		SELECT ec.entry_id::text,'category',ec.category_id::text
		FROM entry_categories ec
		JOIN entries e ON e.id=ec.entry_id
		WHERE e.author_id=$1::uuid
		  AND ($2='full' OR (e.status='published' AND e.visibility='public'))
		UNION ALL
		SELECT et.entry_id::text,'tag',et.tag_id::text
		FROM entry_tags et
		JOIN entries e ON e.id=et.entry_id
		WHERE e.author_id=$1::uuid
		  AND ($2='full' OR (e.status='published' AND e.visibility='public'))
		ORDER BY 1,2,3`, ownerID, p.Type)
	if err != nil {
		_ = zw.Close()
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fail(err)
	}
	for relationRows.Next() {
		var entryID, relationType, targetID string
		if err := relationRows.Scan(&entryID, &relationType, &targetID); err != nil {
			relationRows.Close()
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return fail(err)
		}
		line, err := json.Marshal(map[string]string{"entryId": entryID, "type": relationType, "targetId": targetID})
		if err != nil {
			relationRows.Close()
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return fail(err)
		}
		relations.Write(line)
		relations.WriteByte('\n')
	}
	if err := relationRows.Err(); err != nil {
		relationRows.Close()
		_ = zw.Close()
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fail(err)
	}
	relationRows.Close()
	if err := addBytes("metadata/relations.jsonl", relations.Bytes()); err != nil {
		_ = zw.Close()
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fail(err)
	}
	mediaMetadata := &bytes.Buffer{}
	if p.Type == "full" || p.Type == "public" {
		mediaRows, e := db.QueryContext(ctx, `SELECT id::text,original_name,mime_type,size_bytes,visibility,status,COALESCE(storage_path,''),COALESCE(sha256,'') FROM media WHERE owner_id=$1::uuid AND status='ready' AND storage_path IS NOT NULL AND ($2='full' OR visibility='public')`, ownerID, p.Type)
		if e != nil {
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return fail(e)
		}
		for mediaRows.Next() {
			var id, name, mimeType, visibility, status, storage, sha256sum string
			var size int64
			if e := mediaRows.Scan(&id, &name, &mimeType, &size, &visibility, &status, &storage, &sha256sum); e != nil {
				mediaRows.Close()
				_ = zw.Close()
				_ = f.Close()
				_ = os.Remove(tmpPath)
				return fail(e)
			}
			if visibility != "public" && visibility != "private" {
				mediaRows.Close()
				_ = zw.Close()
				_ = f.Close()
				_ = os.Remove(tmpPath)
				return fail(fmt.Errorf("media %s has unknown visibility", id))
			}
			if !mediaPathWithinRoot(getenvWorker("MEDIA_ROOT", ""), storage) {
				mediaRows.Close()
				_ = zw.Close()
				_ = f.Close()
				_ = os.Remove(tmpPath)
				return fail(fmt.Errorf("media %s path outside root", id))
			}
			entryName := filepath.ToSlash(filepath.Join("assets", "media", id, filepath.Base(name)))
			if e := copyExportMediaWithChecksums(zw, entryName, storage, checksums); e != nil {
				mediaRows.Close()
				_ = zw.Close()
				_ = f.Close()
				_ = os.Remove(tmpPath)
				return fail(e)
			}
			files = append(files, entryName)
			if p.Type == "full" {
				originalEntryName := filepath.ToSlash(filepath.Join("assets", "media-originals", id, filepath.Base(name)))
				if e := copyExportMediaWithChecksums(zw, originalEntryName, storage, checksums); e != nil {
					mediaRows.Close()
					_ = zw.Close()
					_ = f.Close()
					_ = os.Remove(tmpPath)
					return fail(e)
				}
				files = append(files, originalEntryName)
			}
			if e := appendExportJSONL(mediaMetadata, map[string]any{
				"id": id, "originalName": name, "mimeType": mimeType,
				"sizeBytes": size, "visibility": visibility, "status": status,
				"sha256": sha256sum,
			}); e != nil {
				mediaRows.Close()
				_ = zw.Close()
				_ = f.Close()
				_ = os.Remove(tmpPath)
				return fail(e)
			}
		}
		if e := mediaRows.Err(); e != nil {
			mediaRows.Close()
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return fail(e)
		}
		mediaRows.Close()
		if p.Type == "public" {
			if err := addBytes("metadata/media.jsonl", mediaMetadata.Bytes()); err != nil {
				_ = zw.Close()
				_ = f.Close()
				_ = os.Remove(tmpPath)
				return fail(err)
			}
		}
	}
	if p.Type == "full" {
		workingCopies := &bytes.Buffer{}
		workingRows, e := db.QueryContext(ctx, `SELECT id::text,COALESCE(entry_id::text,''),client_draft_id,base_revision,payload,updated_at FROM entry_working_copies WHERE owner_id=$1::uuid ORDER BY updated_at DESC,id`, ownerID)
		if e != nil {
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return fail(e)
		}
		for workingRows.Next() {
			var id, entryID, clientDraftID string
			var baseRevision int64
			var payloadJSON []byte
			var updatedAt time.Time
			if e := workingRows.Scan(&id, &entryID, &clientDraftID, &baseRevision, &payloadJSON, &updatedAt); e != nil {
				workingRows.Close()
				_ = zw.Close()
				_ = f.Close()
				_ = os.Remove(tmpPath)
				return fail(e)
			}
			if !json.Valid(payloadJSON) {
				workingRows.Close()
				_ = zw.Close()
				_ = f.Close()
				_ = os.Remove(tmpPath)
				return fail(fmt.Errorf("working copy %s has invalid payload", id))
			}
			if e := appendExportJSONL(workingCopies, map[string]any{
				"id": id, "entryId": entryID, "clientDraftId": clientDraftID,
				"baseRevision": baseRevision, "payload": json.RawMessage(payloadJSON), "updatedAt": updatedAt,
			}); e != nil {
				workingRows.Close()
				_ = zw.Close()
				_ = f.Close()
				_ = os.Remove(tmpPath)
				return fail(e)
			}
		}
		if e := workingRows.Err(); e != nil {
			workingRows.Close()
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return fail(e)
		}
		workingRows.Close()
		entryVersions := &bytes.Buffer{}
		versionIndexEntries := make([]exportStatusIndexEntry, 0)
		versionRows, e := db.QueryContext(ctx, `
			WITH ranked AS (
				SELECT ev.id::text,ev.entry_id::text,ev.version_no,ev.snapshot,ev.created_at,
				       row_number() OVER (PARTITION BY ev.entry_id ORDER BY ev.version_no DESC,ev.id DESC) AS rn
				FROM entry_versions ev
				JOIN entries e ON e.id=ev.entry_id
				WHERE e.author_id=$1::uuid
			)
			SELECT id,entry_id,version_no,snapshot,created_at
			FROM ranked WHERE rn<=20
			ORDER BY entry_id,version_no DESC,id`, ownerID)
		if e != nil {
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return fail(e)
		}
		for versionRows.Next() {
			var id, entryID string
			var versionNo int
			var snapshotJSON []byte
			var createdAt time.Time
			if e := versionRows.Scan(&id, &entryID, &versionNo, &snapshotJSON, &createdAt); e != nil {
				versionRows.Close()
				_ = zw.Close()
				_ = f.Close()
				_ = os.Remove(tmpPath)
				return fail(e)
			}
			if !json.Valid(snapshotJSON) {
				versionRows.Close()
				_ = zw.Close()
				_ = f.Close()
				_ = os.Remove(tmpPath)
				return fail(fmt.Errorf("entry version %s has invalid snapshot", id))
			}
			if e := appendExportJSONL(entryVersions, map[string]any{
				"id": id, "entryId": entryID, "versionNo": versionNo,
				"snapshot": json.RawMessage(snapshotJSON), "createdAt": createdAt,
			}); e != nil {
				versionRows.Close()
				_ = zw.Close()
				_ = f.Close()
				_ = os.Remove(tmpPath)
				return fail(e)
			}
			versionIndexEntries = append(versionIndexEntries, exportStatusIndexEntry{ID: entryID, Title: fmt.Sprintf("Entry %s · v%d", entryID, versionNo)})
		}
		if e := versionRows.Err(); e != nil {
			versionRows.Close()
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return fail(e)
		}
		versionRows.Close()
		if err := addBytes("metadata/working_copies.jsonl", workingCopies.Bytes()); err != nil {
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return fail(err)
		}
		if err := addBytes("metadata/entry_versions.jsonl", entryVersions.Bytes()); err != nil {
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return fail(err)
		}
		if err := addBytes("metadata/media.jsonl", mediaMetadata.Bytes()); err != nil {
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return fail(err)
		}
		if err := addBytes("versions/index.jsonl", entryVersions.Bytes()); err != nil {
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return fail(err)
		}
		if err := addBytes("versions/index.html", renderExportStatusIndex("Versions", versionIndexEntries)); err != nil {
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return fail(err)
		}
		if err := addBytes("drafts/index.html", renderExportStatusIndex("Drafts", draftIndexEntries)); err != nil {
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return fail(err)
		}
		if err := addBytes("trash/index.html", renderExportStatusIndex("Trash", trashIndexEntries)); err != nil {
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return fail(err)
		}
		for name, target := range map[string]string{
			"drafts/README.html":   "index.html",
			"trash/README.html":    "index.html",
			"versions/README.html": "index.html",
		} {
			if err := addBytes(name, renderExportLayerIndex(strings.TrimSuffix(strings.TrimPrefix(name, "assets/media-originals/"), "/index.html"), target)); err != nil {
				_ = zw.Close()
				_ = f.Close()
				_ = os.Remove(tmpPath)
				return fail(err)
			}
		}
		if err := addBytes("public/index.html", renderExportStatusIndex("Public", publicIndexEntries)); err != nil {
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return fail(err)
		}
		if err := addBytes("private/index.html", renderExportStatusIndex("Private", privateIndexEntries)); err != nil {
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return fail(err)
		}
		mediaOriginalEntries := make([]exportStatusIndexEntry, 0)
		for id, media := range mediaIndex {
			if media.Visibility != "public" && p.Type == "public" {
				continue
			}
			mediaOriginalEntries = append(mediaOriginalEntries, exportStatusIndexEntry{ID: id, Title: filepath.Base(media.Original), Href: "../../assets/media-originals/" + id + "/" + filepath.Base(media.Original)})
		}
		if err := addBytes("assets/media-originals/index.html", renderExportStatusIndex("Media originals", mediaOriginalEntries)); err != nil {
			_ = zw.Close()
			_ = f.Close()
			_ = os.Remove(tmpPath)
			return fail(err)
		}
	}
	manifest := map[string]any{"schemaVersion": "1", "type": p.Type, "generatedAt": time.Now().UTC(), "files": files, "checksums": checksums, "exportId": p.ExportID}
	manifestData, _ := json.MarshalIndent(manifest, "", "  ")
	if err := addBytes("manifest.json", manifestData); err != nil {
		_ = zw.Close()
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fail(err)
	}
	if err := addBytes("metadata/manifest.json", manifestData); err != nil {
		_ = zw.Close()
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fail(err)
	}
	if err := zw.Close(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fail(err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return fail(err)
	}
	h := sha256.New()
	rf, err := os.Open(tmpPath)
	if err != nil {
		_ = os.Remove(tmpPath)
		return fail(err)
	}
	_, err = io.Copy(h, rf)
	_ = rf.Close()
	if err != nil {
		_ = os.Remove(tmpPath)
		return fail(err)
	}
	sum := hex.EncodeToString(h.Sum(nil))
	if err := os.Rename(tmpPath, finalPath); err != nil {
		_ = os.Remove(tmpPath)
		return fail(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE exports SET status='ready',storage_path=$1,sha256=$2,error=NULL,updated_at=now() WHERE id=$3::uuid`, finalPath, sum, p.ExportID); err != nil {
		return err
	}
	return nil
}

func getenvWorker(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
