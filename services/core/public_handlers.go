package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

func (srv *Server) feedDisabled(ctx context.Context) bool {
	if srv.store.persistent && srv.store.database != nil {
		var value []byte
		if err := srv.store.database.QueryRowContext(ctx, `SELECT value FROM site_settings WHERE key='feedEnabled'`).Scan(&value); err == nil {
			var enabled bool
			if json.Unmarshal(value, &enabled) == nil {
				return !enabled
			}
		}
		return false
	}
	srv.store.mu.RLock()
	value, exists := srv.store.settings["feedEnabled"]
	srv.store.mu.RUnlock()
	if !exists {
		return false
	}
	enabled, ok := value.(bool)
	return ok && !enabled
}

func publicView(e *Entry) map[string]any {
	if e.Status != "published" {
		return nil
	}
	if e.Visibility == "private" {
		out := map[string]any{"visibility": "private", "journalDate": e.JournalDate, "journalTime": e.JournalTime, "placeholder": true, "text": "这是一条私人记录 🔒"}
		return out
	}
	return map[string]any{"id": e.ID, "kind": e.Kind, "visibility": "public", "title": e.Title, "slug": e.Slug, "summary": choose(e.Summary, summarize(e.PlainText)), "markdown": e.Markdown, "renderedHtml": e.RenderedHTML, "journalDate": e.JournalDate, "journalTime": e.JournalTime, "timePrecision": e.TimePrecision, "categories": e.Categories, "tags": e.Tags}
}

func choose(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func anySlice(v any) []any {
	if values, ok := v.([]any); ok {
		return values
	}
	return nil
}

func summarize(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if len([]rune(s)) > 180 {
		return string([]rune(s)[:180]) + "…"
	}
	return s
}

func (srv *Server) publicEntries() []*Entry {
	if srv.store.persistent && srv.store.database != nil {
		out, err := queryEntries(context.Background(), srv.store.database, true)
		if err == nil {
			return out
		}
		return []*Entry{}
	}
	srv.store.mu.RLock()
	defer srv.store.mu.RUnlock()
	out := make([]*Entry, 0)
	for _, e := range srv.store.entries {
		if e.Status == "published" {
			cp := *e
			out = append(out, &cp)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].JournalDate != out[j].JournalDate {
			return out[i].JournalDate > out[j].JournalDate
		}
		ti, tj := "", ""
		if out[i].JournalTime != nil {
			ti = *out[i].JournalTime
		}
		if out[j].JournalTime != nil {
			tj = *out[j].JournalTime
		}
		if ti != tj {
			return ti < tj
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func entryAfterCursor(e *Entry, cursorDate, cursorID string) bool {
	if cursorDate == "" {
		return true
	}
	if e.JournalDate != cursorDate {
		return e.JournalDate < cursorDate
	}
	return e.ID > cursorID
}

func publicLimit(r *http.Request) int {
	limit := 20
	if v, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && v > 0 && v <= 100 {
		limit = v
	}
	return limit
}

// paginateEntriesByWholeDay keeps public list pages stable around the day
// boundary: once a day is included, all matching entries for that day are
// returned even when the requested limit is exceeded. The cursor points at the
// last entry of the complete day, so subsequent pages cannot duplicate items.
func paginateEntriesByWholeDay(entries []*Entry, limit int, rawCursor string) ([]*Entry, string, error) {
	start := 0
	if rawCursor != "" {
		cursor, ok := decodeEntryCursor(rawCursor)
		if !ok {
			return nil, "", fmt.Errorf("invalid cursor")
		}
		found := false
		for i, e := range entries {
			if e.ID == cursor.ID {
				start = i + 1
				found = true
				break
			}
		}
		if !found {
			return nil, "", fmt.Errorf("invalid cursor")
		}
	}
	if start >= len(entries) {
		return []*Entry{}, "", nil
	}
	selected := make([]*Entry, 0)
	last := ""
	for i := start; i < len(entries); {
		date := entries[i].JournalDate
		dayStart := i
		for i < len(entries) && entries[i].JournalDate == date {
			i++
		}
		selected = append(selected, entries[dayStart:i]...)
		last = entries[i-1].ID
		if len(selected) >= limit {
			break
		}
	}
	if last == "" || start+len(selected) >= len(entries) {
		return selected, "", nil
	}
	return selected, encodeEntryCursor(entries[start+len(selected)-1]), nil
}

func (srv *Server) publicTimeline(w http.ResponseWriter, r *http.Request) {
	limit := publicLimit(r)
	cursorID := ""
	if raw := strings.TrimSpace(r.URL.Query().Get("cursor")); raw != "" {
		var ok bool
		cursor, ok := decodeEntryCursor(raw)
		cursorID = cursor.ID
		if !ok {
			problem(w, http.StatusBadRequest, "cursor 无效")
			return
		}
	}
	entries := srv.publicEntries()
	start := 0
	if cursorID != "" {
		found := false
		for i, e := range entries {
			if e.ID == cursorID {
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
	days := []map[string]any{}
	actual := 0
	lastIncluded := -1
	for i := start; i < len(entries); {
		d := entries[i].JournalDate
		untimed, timed := []any{}, []any{}
		for i < len(entries) && entries[i].JournalDate == d {
			e := entries[i]
			view := publicView(e)
			if e.JournalTime == nil {
				untimed = append(untimed, view)
			} else {
				timed = append(timed, view)
			}
			actual++
			lastIncluded = i
			i++
		}
		days = append(days, map[string]any{"date": d, "untimed": untimed, "timed": timed})
		if actual >= limit {
			break
		}
	}
	nextCursor := ""
	if lastIncluded >= 0 && lastIncluded+1 < len(entries) {
		nextCursor = encodeEntryCursor(entries[lastIncluded])
	}
	jsonResponse(w, 200, map[string]any{"days": days, "nextCursor": nextCursor, "targetLimit": limit, "actualCount": actual})
}

func (srv *Server) publicDay(w http.ResponseWriter, r *http.Request) {
	date := strings.TrimPrefix(r.URL.Path, "/api/v1/public/days/")
	items := []any{}
	for _, e := range srv.publicEntries() {
		if e.JournalDate == date {
			items = append(items, publicView(e))
		}
	}
	untimed, timed := []any{}, []any{}
	for _, it := range items {
		m := it.(map[string]any)
		if m["journalTime"] == nil {
			untimed = append(untimed, it)
		} else {
			timed = append(timed, it)
		}
	}
	jsonResponse(w, 200, map[string]any{"date": date, "untimed": untimed, "timed": timed})
}

func (srv *Server) publicArticle(w http.ResponseWriter, r *http.Request) {
	slug := strings.TrimPrefix(r.URL.Path, "/api/v1/public/articles/")
	for _, e := range srv.publicEntries() {
		if e.Kind == "article" && e.Slug == slug && e.Visibility == "public" {
			jsonResponse(w, 200, publicView(e))
			return
		}
	}
	problem(w, 404, "文章不存在")
}

func (srv *Server) publicCalendar(w http.ResponseWriter, r *http.Request) {
	if srv.store.persistent && srv.store.database != nil {
		var month string = r.URL.Query().Get("month")
		rows, err := srv.store.database.QueryContext(r.Context(), `SELECT journal_date::text,count(*) FROM entries WHERE status='published' AND journal_date::text LIKE $1 GROUP BY journal_date`, month+"%")
		if err != nil {
			problem(w, 500, "读取日历失败")
			return
		}
		defer rows.Close()
		days := map[string]int{}
		for rows.Next() {
			var d string
			var n int
			_ = rows.Scan(&d, &n)
			days[d] = n
		}
		jsonResponse(w, 200, map[string]any{"month": month, "days": days})
		return
	}
	month := r.URL.Query().Get("month")
	counts := map[string]int{}
	private := map[string]int{}
	srv.store.mu.RLock()
	for _, e := range srv.store.entries {
		if e.Status == "published" && strings.HasPrefix(e.JournalDate, month) {
			if e.Visibility == "private" {
				private[e.JournalDate]++
			} else {
				counts[e.JournalDate]++
			}
		}
	}
	srv.store.mu.RUnlock()
	for day, n := range private {
		counts[day] += n
	}
	jsonResponse(w, 200, map[string]any{"month": month, "days": counts})
}

func (srv *Server) publicCategories(w http.ResponseWriter, _ *http.Request) {
	counts := map[string]int{}
	for _, e := range srv.publicEntries() {
		if e.Visibility != "public" {
			continue
		}
		for _, c := range e.Categories {
			counts[c]++
		}
	}
	jsonResponse(w, 200, map[string]any{"categories": counts})
}

func (srv *Server) publicTag(w http.ResponseWriter, r *http.Request) {
	tag := strings.TrimPrefix(r.URL.Path, "/api/v1/public/tags/")
	tag = strings.TrimSuffix(tag, "/entries")
	filtered := make([]*Entry, 0)
	for _, e := range srv.publicEntries() {
		if e.Visibility != "public" {
			continue
		}
		for _, t := range e.Tags {
			if strings.EqualFold(t, tag) {
				filtered = append(filtered, e)
				break
			}
		}
	}
	items, next, err := paginateEntriesByWholeDay(filtered, publicLimit(r), r.URL.Query().Get("cursor"))
	if err != nil {
		problem(w, http.StatusBadRequest, "cursor 无效")
		return
	}
	views := make([]any, 0, len(items))
	for _, e := range items {
		views = append(views, publicView(e))
	}
	jsonResponse(w, 200, map[string]any{"tag": tag, "entries": views, "nextCursor": next})
}

func (srv *Server) publicCategoryEntries(w http.ResponseWriter, r *http.Request) {
	slug := strings.TrimPrefix(r.URL.Path, "/api/v1/public/categories/")
	slug = strings.TrimSuffix(slug, "/entries")
	filtered := make([]*Entry, 0)
	for _, e := range srv.publicEntries() {
		if e.Visibility != "public" {
			continue
		}
		for _, c := range e.Categories {
			if strings.EqualFold(slugify(c), slug) || strings.EqualFold(c, slug) {
				filtered = append(filtered, e)
				break
			}
		}
	}
	items, next, err := paginateEntriesByWholeDay(filtered, publicLimit(r), r.URL.Query().Get("cursor"))
	if err != nil {
		problem(w, http.StatusBadRequest, "cursor 无效")
		return
	}
	views := make([]any, 0, len(items))
	for _, e := range items {
		views = append(views, publicView(e))
	}
	jsonResponse(w, 200, map[string]any{"category": slug, "entries": views, "nextCursor": next})
}

func (srv *Server) publicSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(strings.ToLower(r.URL.Query().Get("q")))
	if q == "" {
		jsonResponse(w, 200, map[string]any{"query": q, "entries": []any{}, "nextCursor": ""})
		return
	}
	if srv.store.persistent && srv.store.database != nil {
		limit := publicLimit(r)
		cursor := strings.TrimSpace(r.URL.Query().Get("cursor"))
		args := []any{q, limit + 1}
		query := `SELECT id::text,kind,status,visibility,COALESCE(title,''),COALESCE(slug,''),COALESCE(summary,''),markdown,rendered_html,plain_text,journal_date::text,journal_time::text,time_precision,day_position,created_at,updated_at,revision FROM entries WHERE status='published' AND visibility='public' AND (search_vector @@ websearch_to_tsquery('simple',$1) OR title ILIKE '%'||$1||'%' OR summary ILIKE '%'||$1||'%' OR plain_text ILIKE '%'||$1||'%' OR EXISTS (SELECT 1 FROM entry_categories ec JOIN categories c ON c.id=ec.category_id WHERE ec.entry_id=entries.id AND c.name ILIKE '%'||$1||'%') OR EXISTS (SELECT 1 FROM entry_tags et JOIN tags t ON t.id=et.tag_id WHERE et.entry_id=entries.id AND t.display_name ILIKE '%'||$1||'%'))`
		if cursor != "" {
			decoded, ok := decodeEntryCursor(cursor)
			cursorDate, cursorID := decoded.Date, decoded.ID
			if !ok {
				problem(w, http.StatusBadRequest, "cursor 无效")
				return
			}
			query += ` AND (journal_date,id) < ($3::date,$4::uuid)`
			args = []any{q, cursorDate, cursorID, limit + 1}
		}
		query += ` ORDER BY journal_date DESC,journal_time ASC NULLS FIRST,day_position,id LIMIT $` + strconv.Itoa(len(args))
		rows, err := srv.store.database.QueryContext(r.Context(), query, args...)
		if err != nil {
			problem(w, http.StatusInternalServerError, "搜索失败")
			return
		}
		defer rows.Close()
		entries := make([]*Entry, 0, limit+1)
		for rows.Next() {
			var e Entry
			var jt sql.NullString
			if err := rows.Scan(&e.ID, &e.Kind, &e.Status, &e.Visibility, &e.Title, &e.Slug, &e.Summary, &e.Markdown, &e.RenderedHTML, &e.PlainText, &e.JournalDate, &jt, &e.TimePrecision, &e.DayPosition, &e.CreatedAt, &e.UpdatedAt, &e.Revision); err != nil {
				problem(w, http.StatusInternalServerError, "搜索失败")
				return
			}
			if jt.Valid {
				e.JournalTime = &jt.String
			}
			entries = append(entries, &e)
		}
		if err := rows.Err(); err != nil {
			problem(w, http.StatusInternalServerError, "搜索失败")
			return
		}
		next := ""
		if len(entries) > limit {
			entries = entries[:limit]
			last := entries[len(entries)-1]
			next = encodeEntryCursor(last)
		}
		views := make([]any, 0, len(entries))
		for _, e := range entries {
			views = append(views, publicView(e))
		}
		jsonResponse(w, 200, map[string]any{"query": q, "entries": views, "nextCursor": next})
		return
	}
	filtered := make([]*Entry, 0)
	for _, e := range srv.publicEntries() {
		if e.Visibility != "public" {
			continue
		}
		hay := strings.ToLower(strings.Join([]string{e.Title, e.Summary, e.PlainText, strings.Join(e.Categories, " "), strings.Join(e.Tags, " ")}, " "))
		if strings.Contains(hay, q) {
			filtered = append(filtered, e)
		}
	}
	items, next, err := paginateEntriesByWholeDay(filtered, publicLimit(r), r.URL.Query().Get("cursor"))
	if err != nil {
		problem(w, http.StatusBadRequest, "cursor 无效")
		return
	}
	views := make([]any, 0, len(items))
	for _, e := range items {
		views = append(views, publicView(e))
	}
	jsonResponse(w, 200, map[string]any{"query": q, "entries": views, "nextCursor": next})
}

func (srv *Server) publicFeed(w http.ResponseWriter, r *http.Request) {
	if srv.feedDisabled(r.Context()) {
		problem(w, http.StatusNotFound, "Feed 未启用")
		return
	}
	w.Header().Set("Content-Type", "application/atom+xml; charset=utf-8")
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>个人时间线</title><id>urn:personal-timeline:feed</id><link rel="self" href="/api/v1/public/feed"/>`)
	for _, e := range srv.publicEntries() {
		if e.Visibility != "public" {
			continue
		}
		slug := e.Slug
		if slug == "" {
			slug = e.ID
		}
		fmt.Fprintf(&b, `<entry><id>urn:personal-timeline:entry:%s</id><title>%s</title><updated>%s</updated><link href="/api/v1/public/articles/%s"/><summary>%s</summary></entry>`, html.EscapeString(e.ID), html.EscapeString(e.Title), e.UpdatedAt.Format(time.RFC3339), url.PathEscape(slug), html.EscapeString(choose(e.Summary, e.PlainText)))
	}
	b.WriteString("</feed>")
	w.Write([]byte(b.String()))
}
