package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEncodeExportEntryJSONPublicPlaceholder(t *testing.T) {
	e := exportEntry{ID: "entry-1", Visibility: "private", JournalDate: "2026-08-12", JournalTime: "09:30", Title: "机密标题", Markdown: "机密正文", RenderedHTML: "<p>机密正文</p>"}
	data, placeholder := encodeExportEntryJSON(e, true)
	if !placeholder {
		t.Fatal("private public export must be a placeholder")
	}
	var got map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if got["placeholder"] != true || got["visibility"] != "private" {
		t.Fatalf("unexpected placeholder: %#v", got)
	}
	for _, key := range []string{"id", "title", "markdown", "renderedHtml"} {
		if _, ok := got[key]; ok {
			t.Fatalf("private field leaked: %s", key)
		}
	}

	e.Visibility = "public"
	data, placeholder = encodeExportEntryJSON(e, true)
	if placeholder {
		t.Fatal("public entry must not be a placeholder")
	}
	if !strings.Contains(string(data), `"id": "entry-1"`) || !strings.Contains(string(data), "机密正文") {
		t.Fatalf("public export missing content: %s", data)
	}
}

func TestExportEntryFilesPublicPlaceholderZIP(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	files, err := addExportEntryFiles(zw, exportEntry{ID: "entry-1", Visibility: "private", JournalDate: "2026-08-12", Markdown: "secret", RenderedHTML: "<p>secret</p>"}, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 || files[0] != "entries/entry-1.json" {
		t.Fatalf("private placeholder files=%v", files)
	}
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range zr.File {
		if strings.HasSuffix(file.Name, ".md") || strings.HasSuffix(file.Name, ".html") {
			t.Fatalf("private export leaked companion file %s", file.Name)
		}
	}

	buf.Reset()
	zw = zip.NewWriter(&buf)
	files, err = addExportEntryFiles(zw, exportEntry{ID: "entry-2", Visibility: "public", JournalDate: "2026-08-12", Markdown: "public", RenderedHTML: "<p>public</p>"}, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if len(files) != 3 {
		t.Fatalf("public export files=%v", files)
	}
}

func TestCopyExportMediaMissingFileFails(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	err := copyExportMedia(zw, "media/missing/file.bin", "/definitely/missing/media.bin")
	_ = zw.Close()
	if err == nil {
		t.Fatal("missing media must fail export")
	}
	if !strings.Contains(err.Error(), "media") {
		t.Fatalf("unexpected missing media error: %v", err)
	}
	if _, err := io.ReadAll(&buf); err != nil {
		t.Fatal(err)
	}
}

func TestRewriteExportMediaReferencesUsesRelativeAssets(t *testing.T) {
	got := rewriteExportMediaReferences("![x](media://m1) media://missing", map[string]exportMedia{"m1": {ID: "m1", Original: "photo.png"}})
	if !strings.Contains(got, "assets/media/m1/photo.png") || !strings.Contains(got, "media://missing") {
		t.Fatalf("rewritten=%q", got)
	}
}

func TestRewriteExportMediaReferencesRelativePathsAndRenderedSpans(t *testing.T) {
	media := map[string]exportMedia{"m1": {ID: "m1", Original: "photo.png", MimeType: "image/png", Visibility: "public"}}
	got := rewriteExportMediaReferencesRelative(`<span class="media-reference" data-media-id="m1">媒体：photo.png</span> media://m1`, media, true, "days/2026/08/12/index.html")
	want, err := filepath.Rel(filepath.Dir("days/2026/08/12/index.html"), "assets/media/m1/photo.png")
	if err != nil {
		t.Fatal(err)
	}
	want = filepath.ToSlash(want)
	if !strings.Contains(got, `src="`+want+`"`) || !strings.Contains(got, want) {
		t.Fatalf("relative media path missing: %q", got)
	}
	if strings.Contains(got, "media://") || strings.Contains(got, "data-media-id") {
		t.Fatalf("inert media reference leaked: %q", got)
	}
}

func TestRewriteExportMediaReferencesDoesNotMutateSourceAcrossOutputs(t *testing.T) {
	media := map[string]exportMedia{"m1": {ID: "m1", Original: "photo.png", MimeType: "image/png", Visibility: "public"}}
	raw := "media://m1"
	day := rewriteExportMediaReferencesRelative(raw, media, false, "days/2026/08/12/index.html")
	article := rewriteExportMediaReferencesRelative(raw, media, false, "articles/story/index.html")
	markdown := rewriteExportMediaReferencesRelative(raw, media, false, "markdown/articles/story.md")
	if raw != "media://m1" {
		t.Fatalf("source was mutated: %q", raw)
	}
	for name, value := range map[string]string{"day": day, "article": article, "markdown": markdown} {
		if strings.Contains(value, "media://") || !strings.Contains(value, "assets/media/m1/photo.png") {
			t.Fatalf("%s output not rewritten independently: %q", name, value)
		}
	}
}

func TestRenderExportStatusIndexEscapesAndRelativeLinks(t *testing.T) {
	data := renderExportStatusIndex("Drafts", []exportStatusIndexEntry{{ID: "entry-1", Title: "<secret>", JournalDate: "2026-08-12"}})
	text := string(data)
	if !strings.Contains(text, "../entries/entry-1.html") || strings.Contains(text, "<secret>") {
		t.Fatalf("unsafe status index: %s", text)
	}
}

func TestRewriteExportMediaReferencesPublicHidesPrivateMedia(t *testing.T) {
	media := map[string]exportMedia{
		"public":  {ID: "public", Original: "visible.png", Visibility: "public"},
		"private": {ID: "private", Original: "secret.pdf", Visibility: "private"},
	}
	got := rewriteExportMediaReferencesMode("media://public media://private media://unknown", media, true)
	if !strings.Contains(got, "assets/media/public/visible.png") {
		t.Fatalf("public media should be rewritten: %q", got)
	}
	if strings.Contains(got, "private") || strings.Contains(got, "secret.pdf") || strings.Contains(got, "unknown") || strings.Contains(got, "media://") {
		t.Fatalf("private or unknown media leaked: %q", got)
	}
	if strings.Count(got, "[媒体不可用]") != 2 {
		t.Fatalf("expected two placeholders, got %q", got)
	}
}

func TestRewriteExportMermaidPlaceholdersFallbackSVG(t *testing.T) {
	source := base64.RawURLEncoding.EncodeToString([]byte("graph TD\nA-->B"))
	got := rewriteExportMermaidPlaceholders(`<div class="mermaid-placeholder" data-mermaid="` + source + `"><pre><code>graph</code></pre></div>`)
	if !strings.Contains(got, "<svg") || !strings.Contains(got, "Mermaid diagram unavailable") || !strings.Contains(got, "graph TD A--&gt;B") {
		t.Fatalf("unexpected Mermaid fallback: %s", got)
	}
}

func TestRewriteExportEmbedPlaceholdersStaticSafeCard(t *testing.T) {
	got := rewriteExportPlaceholders(`<div class="embed-placeholder" data-provider="youtube" data-embed-url="https://www.youtube.com/watch?v=abc&amp;x=1">嵌入内容：youtube</div>`)
	if !strings.Contains(got, `class="embed-card"`) || !strings.Contains(got, `target="_blank"`) || !strings.Contains(got, "https://www.youtube.com/watch?v=abc&amp;x=1") {
		t.Fatalf("unexpected embed card: %s", got)
	}
	if strings.Contains(got, "iframe") || strings.Contains(got, "embed-placeholder") {
		t.Fatalf("export must not retain executable embed: %s", got)
	}
}

func TestRewriteExportEmbedPlaceholdersRejectsUntrustedURL(t *testing.T) {
	got := rewriteExportPlaceholders(`<div class="embed-placeholder" data-provider="youtube" data-embed-url="https://evil.example/video">x</div>`)
	if !strings.Contains(got, `class="embed-unavailable"`) || strings.Contains(got, "evil.example") {
		t.Fatalf("untrusted embed URL leaked: %s", got)
	}
}

func TestCopyExportMediaAssetsPath(t *testing.T) {
	root := t.TempDir()
	path := root + "/photo.txt"
	if err := os.WriteFile(path, []byte("asset"), 0600); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	checksums := map[string]string{}
	if err := copyExportMediaWithChecksums(zw, "assets/media/m1/photo.txt", path, checksums); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil || len(zr.File) != 1 || zr.File[0].Name != "assets/media/m1/photo.txt" {
		t.Fatalf("zip entries=%v err=%v", zr.File, err)
	}
	if checksums["assets/media/m1/photo.txt"] == "" {
		t.Fatal("missing asset checksum")
	}
}

func TestAppendExportJSONLProducesNonEmptyValidFixture(t *testing.T) {
	var buf bytes.Buffer
	if err := appendExportJSONL(&buf, map[string]any{
		"id": "entry-1", "type": "category", "targetId": "cat-1",
	}); err != nil {
		t.Fatal(err)
	}
	if buf.Len() == 0 || buf.Bytes()[buf.Len()-1] != '\n' {
		t.Fatalf("JSONL fixture must be non-empty and newline terminated: %q", buf.String())
	}
	line := strings.TrimSpace(buf.String())
	var got map[string]string
	if err := json.Unmarshal([]byte(line), &got); err != nil {
		t.Fatal(err)
	}
	if got["id"] != "entry-1" || got["targetId"] != "cat-1" {
		t.Fatalf("unexpected JSONL fixture: %#v", got)
	}
}

func TestRenderExportStatusIndexLinksEntries(t *testing.T) {
	data := renderExportStatusIndex("Drafts", []exportStatusIndexEntry{{ID: "entry-1", Title: "草稿", JournalDate: "2026-08-12"}})
	text := string(data)
	if !strings.Contains(text, "../entries/entry-1.html") || !strings.Contains(text, "草稿") || !strings.Contains(text, "2026-08-12") {
		t.Fatalf("status index missing link/content: %s", text)
	}
}

func TestVerifyExportChecksums(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	data := []byte("fixture")
	entryWriter, err := zw.Create("metadata/entries.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := entryWriter.Write(data); err != nil {
		t.Fatal(err)
	}
	w, err := zw.Create("metadata/categories.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	checksums := map[string]string{"metadata/entries.jsonl": hex.EncodeToString(sum[:]), "metadata/categories.json": hex.EncodeToString(sum[:])}
	if err := verifyExportChecksums(zr.File, checksums); err != nil {
		t.Fatal(err)
	}
	checksums["metadata/categories.json"] = strings.Repeat("0", sha256.Size*2)
	if err := verifyExportChecksums(zr.File, checksums); err == nil {
		t.Fatal("checksum mismatch must fail")
	}
}

func TestRenderExportLayerIndexUsesRelativeTarget(t *testing.T) {
	data := renderExportLayerIndex("public", "../index.html")
	text := string(data)
	if !strings.Contains(text, `href="../index.html"`) || strings.Contains(text, "media://") {
		t.Fatalf("layer index invalid: %s", text)
	}
}
