package main

import (
	"strings"
	"testing"
)

func TestNormalizeImportedEntryContentIgnoresArchivedHTMLAndPlainText(t *testing.T) {
	entry := importEntryRecord{
		Markdown:     "# 安全标题\n\n<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>",
		RenderedHTML: `<script>archive_payload()</script><img src=x onerror="archive_payload()">`,
		PlainText:    "archive_payload",
	}
	normalizeImportedEntryContent(&entry, nil)
	lowerHTML := strings.ToLower(entry.RenderedHTML)
	if strings.Contains(lowerHTML, "<script") || strings.Contains(lowerHTML, "onerror") {
		t.Fatalf("rendered HTML retained unsafe archived/content markup: %s", entry.RenderedHTML)
	}
	if entry.PlainText == "archive_payload" || !strings.Contains(entry.PlainText, "安全标题") {
		t.Fatalf("plain text was not derived from markdown: %q", entry.PlainText)
	}
}

func TestNormalizeMediaNameKeepsUnicodeBasenameAndStripsControls(t *testing.T) {
	name := "../目录\\报告\r\n\x00-最终版.txt"
	got := normalizeMediaName(name, "fallback.txt")
	if got != "报告-最终版.txt" {
		t.Fatalf("normalized media name=%q", got)
	}
	if strings.ContainsAny(got, "\r\n") || strings.ContainsRune(got, '\x00') {
		t.Fatalf("normalized name contains controls: %q", got)
	}
	if strings.Contains(got, "/") || strings.Contains(got, "\\") {
		t.Fatalf("normalized name is not a basename: %q", got)
	}
}

func TestMediaContentDispositionIsHeaderSafe(t *testing.T) {
	value := safeMediaContentDisposition("报告\r\n\".txt")
	if strings.ContainsAny(value, "\r\n") {
		t.Fatalf("content disposition contains header controls: %q", value)
	}
	if !strings.Contains(value, "filename") || !strings.Contains(value, "%E6%8A%A5%E5%91%8A") {
		t.Fatalf("content disposition lost the safe Unicode filename: %q", value)
	}
}
