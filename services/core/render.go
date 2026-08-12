package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	stdhtml "html"
	"net/url"
	"regexp"
	"sort"
	"strings"

	"github.com/microcosm-cc/bluemonday"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	gmparser "github.com/yuin/goldmark/parser"
	gmhtml "github.com/yuin/goldmark/renderer/html"
)

func stringSlice(v any) []string {
	values, ok := v.([]any)
	if !ok {
		if valuesString, ok := v.([]string); ok {
			return valuesString
		}
		return nil
	}
	out := make([]string, 0, len(values))
	for _, item := range values {
		if value, ok := item.(string); ok && strings.TrimSpace(value) != "" {
			out = append(out, value)
		}
	}
	return out
}

var markdownRenderer = goldmark.New(
	goldmark.WithExtensions(extension.GFM, extension.Footnote, extension.Typographer),
	goldmark.WithParserOptions(gmparser.WithAutoHeadingID()),
	goldmark.WithRendererOptions(gmhtml.WithXHTML(), gmhtml.WithHardWraps()),
)
var htmlPolicy = func() *bluemonday.Policy {
	p := bluemonday.UGCPolicy()
	// Goldmark's GFM task-list extension renders disabled checkbox inputs.
	p.AllowElements("input", "span")
	p.AllowAttrs("checked", "disabled", "type").OnElements("input")
	// media:// references are deliberately represented as inert spans. The
	// browser client resolves them only after the media endpoint authorizes
	// access, so Markdown rendering never emits a media URL or executable tag.
	p.AllowAttrs("class", "data-media-id", "data-media-label").OnElements("span")
	p.AllowAttrs("class", "data-mermaid", "data-provider", "data-embed-url").OnElements("div")
	p.AllowAttrs("class").OnElements("pre", "code", "span")
	p.AllowAttrs("id").Matching(regexp.MustCompile(`^[\p{L}\p{N}_:-]+$`)).OnElements("h1", "h2", "h3", "h4", "h5", "h6", "sup", "li")
	return p
}()

// unicodeHeadingIDs aligns Goldmark heading IDs with the frontend slugger,
// while retaining deterministic suffixes for repeated headings.
type unicodeHeadingIDs struct {
	used map[string]int
}

func (s *unicodeHeadingIDs) Generate(value []byte, _ ast.NodeKind) []byte {
	if s.used == nil {
		s.used = map[string]int{}
	}
	base := slugify(string(value))
	if base == "" {
		base = "heading"
	}
	count := s.used[base]
	s.used[base] = count + 1
	if count == 0 {
		return []byte(base)
	}
	return []byte(fmt.Sprintf("%s-%d", base, count+1))
}

func (s *unicodeHeadingIDs) Put(value []byte) {
	if s.used == nil {
		s.used = map[string]int{}
	}
	key := string(value)
	if _, exists := s.used[key]; !exists {
		s.used[key] = 1
	}
}

func renderMarkdown(md string) (string, string) {
	md = normalizeEmbedDirectives(md)
	mediaToken := regexp.MustCompile(`media://([A-Za-z0-9._~-]+)`)
	// Use a private, non-fetchable origin while Goldmark parses links/images;
	// it is replaced with a data-media-id span before sanitization.
	source := mediaToken.ReplaceAllString(md, "https://media.invalid/media/$1")
	var rendered bytes.Buffer
	ctx := gmparser.NewContext(gmparser.WithIDs(&unicodeHeadingIDs{}))
	if err := markdownRenderer.Convert([]byte(strings.ReplaceAll(source, "\r\n", "\n")), &rendered, gmparser.WithContext(ctx)); err != nil {
		return "", stripMarkdown(md)
	}
	html := rendered.String()
	html = normalizeMermaidBlocks(html)
	html = normalizeRenderedEmbeds(html)
	html = highlightRenderedCode(html)
	mediaImage := regexp.MustCompile(`<img src="https://media\.invalid/media/([A-Za-z0-9._~-]+)" alt="([^"]*)"[^>]*/?>`)
	html = mediaImage.ReplaceAllString(html, `<span class="media-reference" data-media-id="$1" data-media-label="$2">媒体：$2</span>`)
	mediaLink := regexp.MustCompile(`<a href="https://media\.invalid/media/([A-Za-z0-9._~-]+)"[^>]*>[^<]*</a>`)
	html = mediaLink.ReplaceAllString(html, `<span class="media-reference" data-media-id="$1" data-media-label="媒体引用：$1">媒体引用：$1</span>`)
	html = regexp.MustCompile(`https://media\.invalid/media/([A-Za-z0-9._~-]+)`).ReplaceAllString(html, `<span class="media-reference" data-media-id="$1" data-media-label="媒体引用：$1">媒体引用：$1</span>`)
	clean := htmlPolicy.Sanitize(html)
	return clean, stripMarkdown(md)
}

var renderedCodePattern = regexp.MustCompile(`(?s)<pre><code class="language-([A-Za-z0-9_-]+)">(.*?)</code></pre>`)

var supportedHighlightLanguages = map[string]struct{}{
	"go": {}, "golang": {}, "js": {}, "javascript": {}, "ts": {}, "typescript": {}, "json": {}, "bash": {}, "sh": {}, "shell": {}, "sql": {}, "python": {}, "py": {}, "html": {}, "css": {},
}

func highlightRenderedCode(html string) string {
	return renderedCodePattern.ReplaceAllStringFunc(html, func(block string) string {
		match := renderedCodePattern.FindStringSubmatch(block)
		if len(match) < 3 {
			return block
		}
		language := strings.ToLower(match[1])
		if _, ok := supportedHighlightLanguages[language]; !ok || language == "mermaid" {
			return block
		}
		code := match[2]
		// Goldmark has already HTML-escaped code text. Highlight only lexical
		// tokens and never reintroduce markup from the source document.
		keywords := map[string]struct{}{}
		switch language {
		case "go", "golang", "js", "javascript", "ts", "typescript", "python", "py":
			for _, key := range []string{"func", "return", "const", "let", "var", "if", "else", "for", "range", "package", "import", "class", "def", "async", "await", "new", "true", "false", "nil", "null"} {
				keywords[key] = struct{}{}
			}
		case "json":
			for _, key := range []string{"true", "false", "null"} {
				keywords[key] = struct{}{}
			}
		case "sql":
			for _, key := range []string{"select", "from", "where", "insert", "update", "delete", "join", "and", "or", "order", "by", "limit"} {
				keywords[key] = struct{}{}
			}
		}
		keywordNames := make([]string, 0, len(keywords))
		for keyword := range keywords {
			keywordNames = append(keywordNames, regexp.QuoteMeta(keyword))
		}
		pattern := `(&quot;[^&]*&quot;|&#39;[^&#39;]*&#39;)`
		if len(keywordNames) > 0 {
			pattern += `|\b(` + strings.Join(keywordNames, `|`) + `)\b`
		}
		tokenPattern := regexp.MustCompile(pattern)
		code = tokenPattern.ReplaceAllStringFunc(code, func(token string) string {
			if strings.HasPrefix(token, `&quot;`) || strings.HasPrefix(token, `&#39;`) {
				return `<span class="tok-string">` + token + `</span>`
			}
			return `<span class="tok-keyword">` + token + `</span>`
		})
		return `<pre><code class="language-` + match[1] + ` highlighted">` + code + `</code></pre>`
	})
}

var mermaidBlockPattern = regexp.MustCompile(`(?s)<pre><code class="language-mermaid">(.*?)</code></pre>`)

func normalizeMermaidBlocks(html string) string {
	return mermaidBlockPattern.ReplaceAllStringFunc(html, func(block string) string {
		match := mermaidBlockPattern.FindStringSubmatch(block)
		if len(match) < 2 {
			return block
		}
		source := stdhtml.UnescapeString(match[1])
		encoded := base64.RawURLEncoding.EncodeToString([]byte(source))
		return `<div class="mermaid-placeholder" data-mermaid="` + stdhtml.EscapeString(encoded) + `"><pre><code>` + match[1] + `</code></pre></div>`
	})
}

var embedDirectivePattern = regexp.MustCompile(`(?m)^@embed\s+(youtube|bilibili|vimeo)\s+(https?://[^\s]+)\s*$`)

func normalizeEmbedDirectives(md string) string {
	return embedDirectivePattern.ReplaceAllStringFunc(md, func(line string) string {
		match := embedDirectivePattern.FindStringSubmatch(line)
		if len(match) < 3 {
			return line
		}
		provider, rawURL := match[1], match[2]
		u, err := url.Parse(rawURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || !embedProviderHost(provider, strings.ToLower(u.Hostname())) {
			return "嵌入内容不可用（来源不受支持）"
		}
		return `[嵌入内容：` + provider + `](https://embed.invalid/` + provider + `?url=` + url.QueryEscape(u.String()) + `)`
	})
}

var renderedEmbedPattern = regexp.MustCompile(`<a href="https://embed\.invalid/(youtube|bilibili|vimeo)\?url=([^\"]+)">嵌入内容：[^<]+</a>`)

func normalizeRenderedEmbeds(html string) string {
	return renderedEmbedPattern.ReplaceAllStringFunc(html, func(token string) string {
		match := renderedEmbedPattern.FindStringSubmatch(token)
		if len(match) < 3 {
			return token
		}
		raw, err := url.QueryUnescape(match[2])
		if err != nil {
			return `<span class="embed-unavailable">嵌入内容不可用</span>`
		}
		return `<div class="embed-placeholder" data-provider="` + match[1] + `" data-embed-url="` + stdhtml.EscapeString(raw) + `">嵌入内容：` + match[1] + `</div>`
	})
}

func embedProviderHost(provider, host string) bool {
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

func stripMarkdown(v string) string {
	v = regexp.MustCompile("(?s)```.*?```").ReplaceAllString(v, "")
	v = regexp.MustCompile(`!\[[^]]*\]\([^)]*\)`).ReplaceAllString(v, "")
	v = regexp.MustCompile(`\[([^]]+)\]\([^)]*\)`).ReplaceAllString(v, "$1")
	v = strings.TrimSpace(regexp.MustCompile(`[*_~`+"`"+`>#-]`).ReplaceAllString(v, ""))
	return strings.Join(strings.Fields(stdhtml.UnescapeString(v)), " ")
}

func mergeTags(tags []string, md string) []string {
	seen := map[string]string{}
	for _, t := range tags {
		t = strings.TrimSpace(strings.TrimPrefix(t, "#"))
		if t != "" {
			seen[strings.ToLower(t)] = t
		}
	}
	for _, t := range extractTags(md) {
		seen[strings.ToLower(t)] = t
	}
	out := []string{}
	for _, v := range seen {
		out = append(out, v)
	}
	sort.Strings(out)
	return out
}

func extractTags(md string) []string {
	var out []string
	inCode := false
	for _, line := range strings.Split(md, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			inCode = !inCode
			continue
		}
		if inCode || strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		line = regexp.MustCompile("`[^`]*`").ReplaceAllString(line, "")
		line = regexp.MustCompile(`https?://[^ ]+`).ReplaceAllStringFunc(line, func(v string) string { return regexp.MustCompile(`#.*$`).ReplaceAllString(v, "") })
		for _, m := range regexp.MustCompile(`(?:^|[^\w])#([\p{L}\p{N}_-]+)`).FindAllStringSubmatch(line, -1) {
			if len(m) > 1 {
				out = append(out, m[1])
			}
		}
	}
	return out
}

func slugify(v string) string {
	v = strings.ToLower(strings.TrimSpace(v))
	v = regexp.MustCompile(`[^a-z0-9\p{L}]+`).ReplaceAllString(v, "-")
	return strings.Trim(v, "-")
}
