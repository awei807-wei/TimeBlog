package main

import (
	"database/sql"
	"net/http"
	"sort"
)

func (srv *Server) entries(w http.ResponseWriter, r *http.Request) {
	if srv.store.persistent {
		if !srv.requirePersistent(w) {
			return
		}
		srv.entriesDatabase(w, r)
		return
	}
	if r.Method != http.MethodGet && !srv.checkMutation(w, r) {
		return
	}
	if r.Method == http.MethodGet && !srv.requireAuth(w, r) {
		return
	}
	if r.Method == http.MethodGet {
		srv.store.mu.RLock()
		out := []*Entry{}
		for _, e := range srv.store.entries {
			cp := *e
			out = append(out, &cp)
		}
		srv.store.mu.RUnlock()
		sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
		jsonResponse(w, 200, map[string]any{"entries": out})
		return
	}
	problem(w, 405, "方法不允许")
}

func (srv *Server) entriesDatabase(w http.ResponseWriter, r *http.Request) {
	ownerID, err := srv.persistentUserID(r)
	if err != nil {
		problem(w, http.StatusUnauthorized, "需要登录")
		return
	}
	rows, err := srv.store.database.QueryContext(r.Context(), `SELECT id::text,kind,status,visibility,COALESCE(title,''),COALESCE(slug,''),COALESCE(summary,''),markdown,rendered_html,plain_text,journal_date::text,journal_time::text,time_precision,day_position,created_at,updated_at,revision FROM entries WHERE author_id=$1::uuid ORDER BY updated_at DESC`, ownerID)
	if err != nil {
		problem(w, 500, "读取内容失败")
		return
	}
	defer rows.Close()
	out := []*Entry{}
	for rows.Next() {
		var e Entry
		var jt sql.NullString
		if err := rows.Scan(&e.ID, &e.Kind, &e.Status, &e.Visibility, &e.Title, &e.Slug, &e.Summary, &e.Markdown, &e.RenderedHTML, &e.PlainText, &e.JournalDate, &jt, &e.TimePrecision, &e.DayPosition, &e.CreatedAt, &e.UpdatedAt, &e.Revision); err != nil {
			problem(w, 500, "读取内容失败")
			return
		}
		if jt.Valid {
			e.JournalTime = &jt.String
		}
		if err := loadEntryTaxonomy(r.Context(), srv.store.database, &e); err != nil {
			problem(w, 500, "读取内容分类失败")
			return
		}
		out = append(out, &e)
	}
	jsonResponse(w, 200, map[string]any{"entries": out})
}
