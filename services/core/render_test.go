package main

import (
	"os"
	"strings"
	"testing"
)

func TestSharedGFMFixtureRendersAndSanitizes(t *testing.T) {
	data, err := os.ReadFile("../../tests/fixtures/markdown/gfm.md")
	if err != nil {
		t.Fatal(err)
	}
	html, _ := renderMarkdown(string(data))
	for _, want := range []string{"<table>", "<input", "data-media-id=\"00000000-0000-0000-0000-000000000001\"", "fnref:"} {
		if !strings.Contains(strings.ToLower(html), strings.ToLower(want)) {
			t.Fatalf("rendered html missing %q: %s", want, html)
		}
	}
	if strings.Contains(strings.ToLower(html), "<script") || strings.Contains(strings.ToLower(html), "<iframe") {
		t.Fatalf("unsafe HTML was not removed: %s", html)
	}
	if !strings.Contains(html, "id=\"中文标题\"") {
		t.Fatalf("Chinese heading id missing: %s", html)
	}
}

func TestRenderMermaidAndEmbedDirectivesAreSafePlaceholders(t *testing.T) {
	html, _ := renderMarkdown("```mermaid\ngraph TD\nA-->B\n```\n\n@embed youtube https://www.youtube.com/watch?v=abc\n@embed youtube https://evil.example/video")
	if !strings.Contains(html, `data-mermaid=`) || !strings.Contains(html, `data-provider="youtube"`) {
		t.Fatalf("expected mermaid/embed placeholders: %s", html)
	}
	if strings.Contains(html, "evil.example") || strings.Contains(html, "<iframe") || strings.Contains(html, "<script") {
		t.Fatalf("unsafe embed escaped: %s", html)
	}
}

func TestRenderKnownCodeLanguageHighlightsAndUnknownStaysText(t *testing.T) {
	html, _ := renderMarkdown("```go\nfunc main(){ return }\n```\n\n```unknown\n<script>bad</script>\n```")
	if !strings.Contains(html, `tok-keyword`) || !strings.Contains(html, `highlighted`) {
		t.Fatalf("known code language was not highlighted: %s", html)
	}
	if strings.Contains(html, "<script>") || !strings.Contains(html, "&lt;script&gt;") {
		t.Fatalf("unknown code was not safely escaped: %s", html)
	}
}
