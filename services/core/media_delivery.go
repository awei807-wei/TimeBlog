package main

import (
	"net/http"
	"net/url"
	"strings"
)

// Keep canonical originals and media:// references. Only a verified published
// public image may leave the same-origin content endpoint; HEAD and fallback
// requests remain local so metadata probes never depend on host CORS support.
func redirectPublishedImage(w http.ResponseWriter, r *http.Request, m *Media) bool {
	if r.Method != http.MethodGet || r.URL.Query().Get("local") == "1" || r.Header.Get("Range") != "" {
		return false
	}
	if m.Status != "ready" || m.Visibility != "public" || m.Provider != "custom_public" || m.ExternalPublishStatus != "published" || !strings.HasPrefix(m.MimeType, "image/") {
		return false
	}
	target, err := url.Parse(m.PublicURL)
	if err != nil || target.Scheme != "https" || target.Hostname() == "" || target.User != nil || target.Fragment != "" {
		return false
	}
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, target.String(), http.StatusTemporaryRedirect)
	return true
}
