package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func commitMemoryArticleForTest(t *testing.T, srv *Server, wc *WorkingCopy, body string) Entry {
	t.Helper()
	srv.store.mu.Lock()
	srv.store.working[wc.ID] = wc
	srv.store.mu.Unlock()
	r := httptest.NewRequest(http.MethodPost, "/api/v1/admin/working-copies/"+wc.ID+"/commit", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	srv.commitWorking(rr, r, wc)
	if rr.Code != http.StatusOK {
		t.Fatalf("commit status=%d body=%s", rr.Code, rr.Body.String())
	}
	var response struct {
		Entry Entry `json:"entry"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode commit response: %v", err)
	}
	return response.Entry
}

func TestMemoryArticleCommitGeneratesStableSlugForEmptyTitle(t *testing.T) {
	srv := NewServer(NewStore())
	first := commitMemoryArticleForTest(t, srv, &WorkingCopy{ID: "wc-new"}, `{"kind":"article","status":"published","visibility":"public","markdown":"正文","journalDate":"2026-08-15"}`)
	if first.ID == "" || !strings.HasPrefix(first.Slug, "article-") {
		t.Fatalf("expected ID-derived canonical slug, entry=%+v", first)
	}
	second := commitMemoryArticleForTest(t, srv, &WorkingCopy{ID: "wc-update", EntryID: first.ID}, `{"status":"published","visibility":"public","markdown":"更新","journalDate":"2026-08-15"}`)
	if second.Slug != first.Slug {
		t.Fatalf("slug changed on edit: first=%q second=%q", first.Slug, second.Slug)
	}
}

func TestMemoryArticleCommitResolvesSlugConflict(t *testing.T) {
	srv := NewServer(NewStore())
	srv.store.entries["existing"] = &Entry{ID: "existing", Kind: "article", Status: "published", Visibility: "public", Title: "Same title", Slug: "same-title"}
	entry := commitMemoryArticleForTest(t, srv, &WorkingCopy{ID: "wc-conflict"}, `{"kind":"article","status":"published","visibility":"public","title":"Same title","markdown":"正文","journalDate":"2026-08-15"}`)
	if entry.Slug == "same-title" || !strings.HasPrefix(entry.Slug, "same-title-") {
		t.Fatalf("expected conflict suffix, slug=%q", entry.Slug)
	}
}

func TestPublicArticleUsesSlugFirstAndUUIDFallback(t *testing.T) {
	srv := NewServer(NewStore())
	legacyID := "00000000-0000-0000-0000-000000000042"
	slugOwnerID := "00000000-0000-0000-0000-000000000043"
	srv.store.entries[legacyID] = &Entry{ID: legacyID, Kind: "article", Status: "published", Visibility: "public", Title: "Legacy", Markdown: "legacy", JournalDate: "2026-08-15"}
	// This UUID-shaped slug must win over the legacy entry's ID fallback.
	srv.store.entries[slugOwnerID] = &Entry{ID: slugOwnerID, Kind: "article", Status: "published", Visibility: "public", Title: "Slug owner", Slug: legacyID, Markdown: "canonical", JournalDate: "2026-08-15"}
	// Notes with a UUID ID are not readable through the article endpoint.
	noteID := "00000000-0000-0000-0000-000000000044"
	srv.store.entries[noteID] = &Entry{ID: noteID, Kind: "note", Status: "published", Visibility: "public", Title: "Note", Markdown: "note", JournalDate: "2026-08-15"}
	h := srv.routes()

	req := func(identifier string) *httptest.ResponseRecorder {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/v1/public/articles/"+identifier, nil))
		return rr
	}
	bySlug := req(legacyID)
	if bySlug.Code != http.StatusOK || !strings.Contains(bySlug.Body.String(), `"id":"00000000-0000-0000-0000-000000000043"`) {
		t.Fatalf("slug lookup did not win: status=%d body=%s", bySlug.Code, bySlug.Body.String())
	}
	srv.store.mu.Lock()
	delete(srv.store.entries, slugOwnerID)
	srv.store.mu.Unlock()
	legacy := req("00000000-0000-0000-0000-000000000042")
	if legacy.Code != http.StatusOK || !strings.Contains(legacy.Body.String(), `"title":"Legacy"`) {
		t.Fatalf("legacy UUID fallback failed: status=%d body=%s", legacy.Code, legacy.Body.String())
	}
	note := req(noteID)
	if note.Code != http.StatusNotFound {
		t.Fatalf("note became readable as article: status=%d body=%s", note.Code, note.Body.String())
	}
	arbitrary := req("not-a-uuid")
	if arbitrary.Code != http.StatusNotFound {
		t.Fatalf("arbitrary identifier accepted: status=%d body=%s", arbitrary.Code, arbitrary.Body.String())
	}
}

func TestPublicFeedOnlyLinksArticles(t *testing.T) {
	srv := NewServer(NewStore())
	srv.store.entries["article-entry"] = &Entry{ID: "article-entry", Kind: "article", Status: "published", Visibility: "public", Slug: "hello", Title: "Article", Markdown: "article", JournalDate: "2026-08-15"}
	srv.store.entries["note-entry"] = &Entry{ID: "note-entry", Kind: "note", Status: "published", Visibility: "public", Title: "Note", Markdown: "note", JournalDate: "2026-08-15"}
	rr := httptest.NewRecorder()
	srv.routes().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/v1/public/feed", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("feed status=%d body=%s", rr.Code, rr.Body.String())
	}
	body := rr.Body.String()
	if !strings.Contains(body, "/api/v1/public/articles/hello") || !strings.Contains(body, "note-entry") || strings.Contains(body, "/api/v1/public/articles/note-entry") {
		t.Fatalf("feed contains inconsistent article links: %s", body)
	}
}
