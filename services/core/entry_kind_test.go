package main

import "testing"

func TestMemoryPublishedEntryDefaultsToNoteUnlessArticle(t *testing.T) {
	tests := []struct {
		name string
		id   string
		kind string
		want string
	}{
		{name: "missing kind", id: "missing", want: "note"},
		{name: "draft kind from legacy working copy", id: "legacy", kind: "draft", want: "note"},
		{name: "explicit article", id: "article", kind: "article", want: "article"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := NewServer(NewStore())
			body := `{"status":"published","visibility":"public","markdown":"正文","journalDate":"2026-09-28"}`
			if tt.kind != "" {
				body = `{"kind":"` + tt.kind + `","status":"published","visibility":"public","markdown":"正文","journalDate":"2026-09-28"}`
			}
			entry := commitMemoryArticleForTest(t, srv, &WorkingCopy{ID: "wc-kind-" + tt.id}, body)
			if entry.Kind != tt.want {
				t.Fatalf("published entry kind=%q, want %q", entry.Kind, tt.want)
			}
		})
	}
}
