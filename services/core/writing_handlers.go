package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// commitWorkingRequest keeps taxonomy field presence separate from its value.
// An omitted categories/tags field inherits the working copy, while an
// explicitly supplied empty array clears the persisted relations.
type commitWorkingRequest struct {
	Kind         string   `json:"kind"`
	Status       string   `json:"status"`
	Visibility   string   `json:"visibility"`
	Title        string   `json:"title"`
	Slug         string   `json:"slug"`
	Summary      string   `json:"summary"`
	Markdown     string   `json:"markdown"`
	JournalDate  string   `json:"journalDate"`
	JournalTime  *string  `json:"journalTime"`
	Categories   []string `json:"categories"`
	Tags         []string `json:"tags"`
	BaseRevision int64    `json:"baseRevision"`

	categoriesPresent bool
	tagsPresent       bool
}

func (in *commitWorkingRequest) UnmarshalJSON(data []byte) error {
	type plainCommitWorkingRequest commitWorkingRequest
	var decoded plainCommitWorkingRequest
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	*in = commitWorkingRequest(decoded)
	_, in.categoriesPresent = fields["categories"]
	_, in.tagsPresent = fields["tags"]
	return nil
}

// commitTags keeps Markdown hashtag extraction as a compatibility behavior
// only for requests that omit tags. An explicit tags array is authoritative,
// including an empty array used to clear all tags.
func commitTags(in commitWorkingRequest) []string {
	if in.tagsPresent {
		return mergeTags(in.Tags, "")
	}
	return mergeTags(in.Tags, in.Markdown)
}

func (srv *Server) workingCopies(w http.ResponseWriter, r *http.Request) {
	if srv.store.persistent {
		if !srv.requirePersistent(w) {
			return
		}
		srv.workingCopiesDatabase(w, r)
		return
	}
	if r.Method != http.MethodGet && !srv.checkMutation(w, r) {
		return
	}
	if r.Method == http.MethodGet && !srv.requireAuth(w, r) {
		return
	}
	switch r.Method {
	case http.MethodGet:
		srv.store.mu.RLock()
		out := []*WorkingCopy{}
		for _, x := range srv.store.working {
			cp := *x
			out = append(out, &cp)
		}
		srv.store.mu.RUnlock()
		sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
		jsonResponse(w, 200, map[string]any{"workingCopies": out})
	case http.MethodPost:
		var in struct {
			ClientDraftID string         `json:"clientDraftId"`
			Payload       map[string]any `json:"payload"`
		}
		if decode(r, &in) != nil {
			problem(w, 400, "请求无效")
			return
		}
		if in.ClientDraftID == "" {
			in.ClientDraftID = newID()
		}
		srv.store.mu.Lock()
		var wc *WorkingCopy
		for _, existing := range srv.store.working {
			if existing.ClientDraftID == in.ClientDraftID {
				wc = existing
				break
			}
		}
		if wc == nil {
			wc = &WorkingCopy{ID: newID(), ClientDraftID: in.ClientDraftID}
			srv.store.working[wc.ID] = wc
		}
		wc.Payload = in.Payload
		wc.UpdatedAt = time.Now()
		srv.store.mu.Unlock()
		jsonResponse(w, 200, wc)
	default:
		problem(w, 405, "方法不允许")
	}
}

func (srv *Server) workingCopiesDatabase(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ownerID, err := srv.persistentUserID(r)
	if err != nil {
		problem(w, http.StatusUnauthorized, "需要登录")
		return
	}
	if r.Method == http.MethodGet {
		rows, err := srv.store.database.QueryContext(ctx, `SELECT id::text, client_draft_id, COALESCE(entry_id::text,''), base_revision, payload, updated_at FROM entry_working_copies WHERE owner_id=$1::uuid ORDER BY updated_at DESC`, ownerID)
		if err != nil {
			problem(w, 500, "读取草稿失败")
			return
		}
		defer rows.Close()
		out := []*WorkingCopy{}
		for rows.Next() {
			var x WorkingCopy
			var payload []byte
			if err := rows.Scan(&x.ID, &x.ClientDraftID, &x.EntryID, &x.BaseRevision, &payload, &x.UpdatedAt); err != nil {
				problem(w, 500, "读取草稿失败")
				return
			}
			_ = json.Unmarshal(payload, &x.Payload)
			out = append(out, &x)
		}
		jsonResponse(w, 200, map[string]any{"workingCopies": out})
		return
	}
	var in struct {
		ClientDraftID string         `json:"clientDraftId"`
		Payload       map[string]any `json:"payload"`
	}
	if decode(r, &in) != nil || in.ClientDraftID == "" {
		problem(w, 400, "请求无效")
		return
	}
	payload, _ := json.Marshal(in.Payload)
	var x WorkingCopy
	err = srv.store.database.QueryRowContext(ctx, `INSERT INTO entry_working_copies(id,owner_id,client_draft_id,payload) VALUES(gen_random_uuid(),$1::uuid,$2,$3) ON CONFLICT (client_draft_id) DO UPDATE SET payload=EXCLUDED.payload, updated_at=now() WHERE entry_working_copies.owner_id=EXCLUDED.owner_id RETURNING id::text,client_draft_id,COALESCE(entry_id::text,''),base_revision,payload,updated_at`, ownerID, in.ClientDraftID, payload).Scan(&x.ID, &x.ClientDraftID, &x.EntryID, &x.BaseRevision, &payload, &x.UpdatedAt)
	if err != nil {
		problem(w, 500, "保存草稿失败")
		return
	}
	_ = json.Unmarshal(payload, &x.Payload)
	jsonResponse(w, 200, &x)
}

func (srv *Server) workingCopy(w http.ResponseWriter, r *http.Request) {
	if srv.store.persistent {
		if !srv.requirePersistent(w) {
			return
		}
		srv.workingCopyDatabase(w, r)
		return
	}
	if r.Method != http.MethodGet && !srv.checkMutation(w, r) {
		return
	}
	if r.Method == http.MethodGet && !srv.requireAuth(w, r) {
		return
	}
	pathID := strings.TrimPrefix(r.URL.Path, "/api/v1/admin/working-copies/")
	parts := strings.Split(strings.Trim(pathID, "/"), "/")
	id := parts[0]
	srv.store.mu.RLock()
	wc := srv.store.working[id]
	srv.store.mu.RUnlock()
	if wc == nil {
		problem(w, 404, "草稿不存在")
		return
	}
	switch r.Method {
	case http.MethodGet:
		jsonResponse(w, 200, wc)
	case http.MethodPatch:
		var in struct {
			BaseRevision int64          `json:"baseRevision"`
			Payload      map[string]any `json:"payload"`
		}
		if decode(r, &in) != nil {
			problem(w, 400, "请求无效")
			return
		}
		srv.store.mu.Lock()
		wc.Payload = in.Payload
		wc.BaseRevision = in.BaseRevision
		wc.UpdatedAt = time.Now()
		srv.store.mu.Unlock()
		jsonResponse(w, 200, wc)
	case http.MethodPost:
		if len(parts) > 1 && parts[1] == "commit" {
			srv.commitWorking(w, r, wc)
			return
		}
		problem(w, 404, "操作不存在")
	case http.MethodDelete:
		srv.store.mu.Lock()
		delete(srv.store.working, id)
		srv.store.mu.Unlock()
		jsonResponse(w, 200, map[string]bool{"ok": true})
	default:
		problem(w, 405, "方法不允许")
	}
}

func (srv *Server) workingCopyDatabase(w http.ResponseWriter, r *http.Request) {
	ownerID, err := srv.persistentUserID(r)
	if err != nil {
		problem(w, http.StatusUnauthorized, "需要登录")
		return
	}
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/admin/working-copies/"), "/")
	parts := strings.Split(id, "/")
	id = parts[0]
	if len(parts) > 1 && parts[1] == "commit" {
		var wc WorkingCopy
		var payload []byte
		err := srv.store.database.QueryRowContext(r.Context(), `SELECT id::text,client_draft_id,COALESCE(entry_id::text,''),base_revision,payload,updated_at FROM entry_working_copies WHERE id=$1::uuid AND owner_id=$2::uuid`, id, ownerID).Scan(&wc.ID, &wc.ClientDraftID, &wc.EntryID, &wc.BaseRevision, &payload, &wc.UpdatedAt)
		if err != nil {
			problem(w, 404, "草稿不存在")
			return
		}
		_ = json.Unmarshal(payload, &wc.Payload)
		srv.commitWorkingDatabase(w, r, &wc)
		return
	}
	switch r.Method {
	case http.MethodGet:
		var wc WorkingCopy
		var payload []byte
		err := srv.store.database.QueryRowContext(r.Context(), `SELECT id::text,client_draft_id,COALESCE(entry_id::text,''),base_revision,payload,updated_at FROM entry_working_copies WHERE id=$1::uuid AND owner_id=$2::uuid`, id, ownerID).Scan(&wc.ID, &wc.ClientDraftID, &wc.EntryID, &wc.BaseRevision, &payload, &wc.UpdatedAt)
		if err != nil {
			problem(w, 404, "草稿不存在")
			return
		}
		_ = json.Unmarshal(payload, &wc.Payload)
		jsonResponse(w, 200, &wc)
	case http.MethodPatch:
		var in struct {
			BaseRevision int64          `json:"baseRevision"`
			Payload      map[string]any `json:"payload"`
		}
		if decode(r, &in) != nil {
			problem(w, 400, "请求无效")
			return
		}
		res, err := srv.store.database.ExecContext(r.Context(), `UPDATE entry_working_copies SET payload=$1,base_revision=$2,updated_at=now() WHERE id=$3::uuid AND owner_id=$4::uuid`, func() []byte { b, _ := json.Marshal(in.Payload); return b }(), in.BaseRevision, id, ownerID)
		if err != nil || func() bool { n, _ := res.RowsAffected(); return n != 1 }() {
			problem(w, 409, "草稿已不存在或发生冲突")
			return
		}
		jsonResponse(w, 200, map[string]bool{"ok": true})
	case http.MethodDelete:
		res, err := srv.store.database.ExecContext(r.Context(), `DELETE FROM entry_working_copies WHERE id=$1::uuid AND owner_id=$2::uuid`, id, ownerID)
		if err != nil {
			problem(w, 500, "删除草稿失败")
			return
		}
		if n, _ := res.RowsAffected(); n != 1 {
			problem(w, 404, "草稿不存在")
			return
		}
		jsonResponse(w, 200, map[string]bool{"ok": true})
	default:
		problem(w, 405, "方法不允许")
	}
}

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

func (srv *Server) entry(w http.ResponseWriter, r *http.Request) {
	if srv.store.persistent && srv.store.database != nil {
		srv.entryDatabase(w, r)
		return
	}
	if r.Method != http.MethodGet && !srv.checkMutation(w, r) {
		return
	}
	if r.Method == http.MethodGet && !srv.requireAuth(w, r) {
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v1/admin/entries/"), "/")
	id := parts[0]
	srv.store.mu.RLock()
	e := srv.store.entries[id]
	srv.store.mu.RUnlock()
	if e == nil {
		problem(w, 404, "内容不存在")
		return
	}
	if len(parts) > 1 && parts[1] == "edit" && r.Method == http.MethodPost {
		wc := &WorkingCopy{ID: newID(), EntryID: e.ID, BaseRevision: e.Revision, ClientDraftID: "edit-" + e.ID, Payload: map[string]any{"markdown": e.Markdown, "title": e.Title, "slug": e.Slug, "summary": e.Summary, "journalDate": e.JournalDate, "journalTime": e.JournalTime, "visibility": e.Visibility, "status": e.Status, "kind": e.Kind, "categories": e.Categories, "tags": e.Tags}, UpdatedAt: time.Now()}
		srv.store.mu.Lock()
		srv.store.working[wc.ID] = wc
		srv.store.mu.Unlock()
		jsonResponse(w, 201, wc)
		return
	}
	switch r.Method {
	case http.MethodGet:
		jsonResponse(w, 200, e)
	case http.MethodDelete:
		srv.store.mu.Lock()
		e.PreviousStatus = e.Status
		e.PreviousVisibility = e.Visibility
		e.Status = "trashed"
		e.UpdatedAt = time.Now()
		srv.store.mu.Unlock()
		jsonResponse(w, 200, e)
	case http.MethodPost:
		if len(parts) > 1 && parts[1] == "restore" {
			srv.store.mu.Lock()
			if e.Status == "trashed" {
				e.Status = e.PreviousStatus
				if e.Status == "" {
					e.Status = "draft"
				}
				if e.PreviousVisibility != "" {
					e.Visibility = e.PreviousVisibility
				}
			}
			e.UpdatedAt = time.Now()
			srv.store.mu.Unlock()
			jsonResponse(w, 200, e)
			return
		}
		if len(parts) > 1 && parts[1] == "purge" {
			srv.store.mu.Lock()
			delete(srv.store.entries, id)
			srv.store.mu.Unlock()
			jsonResponse(w, 200, map[string]bool{"ok": true})
			return
		}
		problem(w, 404, "操作不存在")
	default:
		problem(w, 405, "方法不允许")
	}
}

func (srv *Server) entryDatabase(w http.ResponseWriter, r *http.Request) {
	ownerID, err := srv.persistentUserID(r)
	if err != nil {
		problem(w, http.StatusUnauthorized, "需要登录")
		return
	}
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/admin/entries/"), "/"), "/")
	entryID := parts[0]
	if len(parts) > 1 && parts[1] == "versions" {
		srv.entryVersionsDatabase(w, r, ownerID, entryID, parts[2:])
		return
	}
	var e Entry
	var jt sql.NullString
	err = srv.store.database.QueryRowContext(r.Context(), `SELECT id::text,kind,status,visibility,COALESCE(title,''),COALESCE(slug,''),COALESCE(summary,''),markdown,rendered_html,plain_text,journal_date::text,journal_time::text,time_precision,day_position,created_at,updated_at,revision FROM entries WHERE id=$1::uuid AND author_id=$2::uuid`, entryID, ownerID).Scan(&e.ID, &e.Kind, &e.Status, &e.Visibility, &e.Title, &e.Slug, &e.Summary, &e.Markdown, &e.RenderedHTML, &e.PlainText, &e.JournalDate, &jt, &e.TimePrecision, &e.DayPosition, &e.CreatedAt, &e.UpdatedAt, &e.Revision)
	if err != nil {
		problem(w, http.StatusNotFound, "内容不存在")
		return
	}
	if jt.Valid {
		e.JournalTime = &jt.String
	}
	if err := loadEntryTaxonomy(r.Context(), srv.store.database, &e); err != nil {
		problem(w, 500, "读取内容分类失败")
		return
	}
	switch {
	case len(parts) > 1 && parts[1] == "edit" && r.Method == http.MethodPost:
		payload := map[string]any{"kind": e.Kind, "status": e.Status, "visibility": e.Visibility, "title": e.Title, "slug": e.Slug, "summary": e.Summary, "markdown": e.Markdown, "journalDate": e.JournalDate, "journalTime": e.JournalTime, "categories": e.Categories, "tags": e.Tags}
		data, _ := json.Marshal(payload)
		var wc WorkingCopy
		err = srv.store.database.QueryRowContext(r.Context(), `INSERT INTO entry_working_copies(id,owner_id,entry_id,client_draft_id,base_revision,payload) VALUES(gen_random_uuid(),$1::uuid,$2::uuid,$3,$4,$5) RETURNING id::text,client_draft_id,COALESCE(entry_id::text,''),base_revision,payload,updated_at`, ownerID, e.ID, "edit-"+e.ID, e.Revision, data).Scan(&wc.ID, &wc.ClientDraftID, &wc.EntryID, &wc.BaseRevision, &data, &wc.UpdatedAt)
		if err != nil {
			// Reopening the same entry should resume its existing private
			// working copy instead of creating a second record or discarding
			// unsaved edits from a previous browser tab.
			err = srv.store.database.QueryRowContext(r.Context(), `SELECT id::text,client_draft_id,COALESCE(entry_id::text,''),base_revision,payload,updated_at FROM entry_working_copies WHERE owner_id=$1::uuid AND entry_id=$2::uuid`, ownerID, e.ID).Scan(&wc.ID, &wc.ClientDraftID, &wc.EntryID, &wc.BaseRevision, &data, &wc.UpdatedAt)
			if err != nil {
				problem(w, http.StatusConflict, "编辑草稿已存在")
				return
			}
		}
		_ = json.Unmarshal(data, &wc.Payload)
		jsonResponse(w, http.StatusCreated, &wc)
	case len(parts) > 1 && parts[1] == "restore" && r.Method == http.MethodPost:
		res, err := srv.store.database.ExecContext(r.Context(), `UPDATE entries SET status=COALESCE(previous_status,'draft'),visibility=COALESCE(previous_visibility,'private'),previous_status=NULL,previous_visibility=NULL,deleted_at=NULL,updated_at=now() WHERE id=$1::uuid AND author_id=$2::uuid AND status='trashed'`, entryID, ownerID)
		if err != nil {
			problem(w, 500, "恢复失败")
			return
		}
		if n, _ := res.RowsAffected(); n != 1 {
			problem(w, 409, "内容不在回收站")
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"id": entryID, "restored": true})
	case len(parts) > 1 && parts[1] == "purge" && r.Method == http.MethodPost:
		tx, err := srv.store.database.BeginTx(r.Context(), nil)
		if err != nil {
			problem(w, 500, "永久删除失败")
			return
		}
		defer tx.Rollback()
		var trashedAt sql.NullTime
		if err := tx.QueryRowContext(r.Context(), `SELECT deleted_at FROM entries WHERE id=$1::uuid AND author_id=$2::uuid AND status='trashed' FOR UPDATE`, entryID, ownerID).Scan(&trashedAt); err != nil || !trashedAt.Valid || time.Since(trashedAt.Time) < 30*24*time.Hour {
			problem(w, http.StatusConflict, "内容需在回收站保留至少30天")
			return
		}
		var mediaIDs []string
		rows, _ := tx.QueryContext(r.Context(), `SELECT media_id::text FROM media_refs WHERE entry_id=$1::uuid`, entryID)
		for rows != nil && rows.Next() {
			var mediaID string
			if rows.Scan(&mediaID) == nil {
				mediaIDs = append(mediaIDs, mediaID)
			}
		}
		if rows != nil {
			rows.Close()
		}
		res, err := tx.ExecContext(r.Context(), `DELETE FROM entries WHERE id=$1::uuid AND author_id=$2::uuid AND status='trashed'`, entryID, ownerID)
		if err != nil {
			problem(w, 500, "永久删除失败")
			return
		}
		if n, _ := res.RowsAffected(); n != 1 {
			problem(w, 409, "内容不存在")
			return
		}
		for _, mediaID := range mediaIDs {
			if err := queueMediaDeleteTx(r.Context(), tx, mediaID); err != nil {
				problem(w, 500, "排队清理媒体失败")
				return
			}
		}
		if err := tx.Commit(); err != nil {
			problem(w, 500, "永久删除失败")
			return
		}
		jsonResponse(w, http.StatusOK, map[string]bool{"ok": true})
	case r.Method == http.MethodGet:
		jsonResponse(w, http.StatusOK, &e)
	case r.Method == http.MethodDelete:
		res, err := srv.store.database.ExecContext(r.Context(), `UPDATE entries SET previous_status=status,previous_visibility=visibility,status='trashed',deleted_at=now(),updated_at=now() WHERE id=$1::uuid AND author_id=$2::uuid AND status<>'trashed'`, entryID, ownerID)
		if err != nil {
			problem(w, 500, "移入回收站失败")
			return
		}
		if n, _ := res.RowsAffected(); n != 1 {
			problem(w, 409, "内容已在回收站")
			return
		}
		jsonResponse(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		problem(w, http.StatusMethodNotAllowed, "方法不允许")
	}
}

func (srv *Server) entryVersionsDatabase(w http.ResponseWriter, r *http.Request, ownerID, entryID string, suffix []string) {
	if len(suffix) == 0 && r.Method == http.MethodGet {
		rows, err := srv.store.database.QueryContext(r.Context(), `SELECT v.version_no,v.created_at,v.snapshot FROM entry_versions v JOIN entries e ON e.id=v.entry_id WHERE v.entry_id=$1::uuid AND e.author_id=$2::uuid ORDER BY v.version_no DESC LIMIT 20`, entryID, ownerID)
		if err != nil {
			problem(w, 500, "读取版本失败")
			return
		}
		defer rows.Close()
		versions := []map[string]any{}
		for rows.Next() {
			var version int
			var created time.Time
			var snapshot []byte
			if err := rows.Scan(&version, &created, &snapshot); err != nil {
				problem(w, 500, "读取版本失败")
				return
			}
			var data map[string]any
			_ = json.Unmarshal(snapshot, &data)
			versions = append(versions, map[string]any{"version": version, "createdAt": created, "snapshot": data})
		}
		jsonResponse(w, http.StatusOK, map[string]any{"versions": versions})
		return
	}
	if len(suffix) == 2 && suffix[1] == "restore" && r.Method == http.MethodPost {
		version, err := strconv.Atoi(suffix[0])
		if err != nil || version < 1 {
			problem(w, 400, "版本号无效")
			return
		}
		var snapshot []byte
		if err := srv.store.database.QueryRowContext(r.Context(), `SELECT v.snapshot FROM entry_versions v JOIN entries e ON e.id=v.entry_id WHERE v.entry_id=$1::uuid AND e.author_id=$2::uuid AND v.version_no=$3`, entryID, ownerID, version).Scan(&snapshot); err != nil {
			problem(w, 404, "版本不存在")
			return
		}
		var data struct {
			Title    string `json:"title"`
			Summary  string `json:"summary"`
			Markdown string `json:"markdown"`
			Slug     string `json:"slug"`
		}
		if json.Unmarshal(snapshot, &data) != nil {
			problem(w, 500, "版本数据无效")
			return
		}
		htmlOut, plain := renderMarkdown(data.Markdown)
		res, err := srv.store.database.ExecContext(r.Context(), `UPDATE entries SET title=$1,summary=$2,markdown=$3,rendered_html=$4,plain_text=$5,slug=$6,revision=revision+1,updated_at=now() WHERE id=$7::uuid AND author_id=$8::uuid`, data.Title, data.Summary, data.Markdown, htmlOut, plain, data.Slug, entryID, ownerID)
		if err != nil {
			problem(w, 500, "恢复版本失败")
			return
		}
		if n, _ := res.RowsAffected(); n != 1 {
			problem(w, 404, "内容不存在")
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"entryId": entryID, "restoredVersion": version})
		return
	}
	problem(w, http.StatusMethodNotAllowed, "方法不允许")
}

func (srv *Server) commitWorking(w http.ResponseWriter, r *http.Request, wc *WorkingCopy) {
	if srv.store.persistent && srv.store.database != nil {
		srv.commitWorkingDatabase(w, r, wc)
		return
	}
	var in commitWorkingRequest
	if decode(r, &in) != nil {
		problem(w, 400, "请求无效")
		return
	}
	if in.Kind == "" {
		if v, ok := wc.Payload["kind"].(string); ok && v != "" {
			in.Kind = v
		} else if wc.EntryID != "" {
			srv.store.mu.RLock()
			if current := srv.store.entries[wc.EntryID]; current != nil {
				in.Kind = current.Kind
			}
			srv.store.mu.RUnlock()
		}
	}
	if wc.EntryID != "" && in.BaseRevision > 0 {
		srv.store.mu.RLock()
		current := srv.store.entries[wc.EntryID]
		srv.store.mu.RUnlock()
		if current != nil && current.Revision != in.BaseRevision {
			problem(w, http.StatusConflict, "内容已在其他位置修改")
			return
		}
	}
	if in.Kind == "" {
		in.Kind = "note"
	}
	if in.Status == "" {
		in.Status = "draft"
	}
	if in.Visibility == "" {
		in.Visibility = "public"
	}
	if in.JournalDate == "" {
		in.JournalDate = nowShanghaiDate()
	}
	if in.Markdown == "" {
		if v, ok := wc.Payload["markdown"].(string); ok {
			in.Markdown = v
		}
	}
	if in.Slug == "" {
		if v, ok := wc.Payload["slug"].(string); ok {
			in.Slug = v
		}
	}
	if in.Summary == "" {
		if v, ok := wc.Payload["summary"].(string); ok {
			in.Summary = v
		}
	}
	if in.Title == "" {
		if v, ok := wc.Payload["title"].(string); ok {
			in.Title = v
		}
	}
	if !in.categoriesPresent {
		in.Categories = stringSlice(wc.Payload["categories"])
	}
	if !in.tagsPresent {
		in.Tags = stringSlice(wc.Payload["tags"])
	}
	htmlOut, plain := renderMarkdown(in.Markdown)
	e := &Entry{ID: wc.EntryID, Kind: in.Kind, Status: in.Status, Visibility: in.Visibility, Title: in.Title, Slug: in.Slug, Summary: in.Summary, Markdown: in.Markdown, RenderedHTML: htmlOut, PlainText: plain, JournalDate: in.JournalDate, JournalTime: in.JournalTime, TimePrecision: "day", DayPosition: srv.store.nextPosition, CreatedAt: time.Now(), UpdatedAt: time.Now(), Revision: 1, Categories: in.Categories, Tags: commitTags(in)}
	if e.JournalTime != nil {
		e.TimePrecision = "minute"
	}
	srv.store.mu.Lock()
	if e.ID != "" {
		if old := srv.store.entries[e.ID]; old != nil {
			e.CreatedAt = old.CreatedAt
			e.Revision = old.Revision + 1
			if e.Kind == "article" && e.Slug == "" {
				e.Slug = old.Slug
			}
		}
	} else {
		e.ID = newID()
		srv.store.nextPosition++
	}
	if e.Kind == "article" {
		e.Slug = uniqueMemoryArticleSlug(srv.store.entries, e.Slug, e.Title, e.ID)
	}
	srv.store.entries[e.ID] = e
	delete(srv.store.working, wc.ID)
	srv.store.mu.Unlock()
	if e.Kind == "note" && e.Status == "published" {
		u := randomToken()
		srv.store.mu.Lock()
		srv.store.undo[u] = undoRecord{EntryID: e.ID, ExpiresAt: time.Now().Add(15 * time.Second)}
		srv.store.mu.Unlock()
		jsonResponse(w, 200, map[string]any{"entry": e, "undoToken": u})
		return
	}
	jsonResponse(w, 200, map[string]any{"entry": e})
}

func (srv *Server) commitWorkingDatabase(w http.ResponseWriter, r *http.Request, wc *WorkingCopy) {
	ownerID, err := srv.persistentUserID(r)
	if err != nil {
		problem(w, http.StatusUnauthorized, "需要登录")
		return
	}
	var in commitWorkingRequest
	if decode(r, &in) != nil {
		problem(w, 400, "请求无效")
		return
	}
	// The working copy is authoritative. Request fields are optional overlays
	// so an omitted field never silently clears persisted draft content.
	if v, ok := wc.Payload["kind"].(string); ok && in.Kind == "" {
		in.Kind = v
	}
	if v, ok := wc.Payload["status"].(string); ok && in.Status == "" {
		in.Status = v
	}
	if v, ok := wc.Payload["visibility"].(string); ok && in.Visibility == "" {
		in.Visibility = v
	}
	if v, ok := wc.Payload["title"].(string); ok && in.Title == "" {
		in.Title = v
	}
	if v, ok := wc.Payload["slug"].(string); ok && in.Slug == "" {
		in.Slug = v
	}
	if v, ok := wc.Payload["summary"].(string); ok && in.Summary == "" {
		in.Summary = v
	}
	if v, ok := wc.Payload["journalDate"].(string); ok && in.JournalDate == "" {
		in.JournalDate = v
	}
	if in.JournalTime == nil {
		if v, ok := wc.Payload["journalTime"].(string); ok {
			in.JournalTime = &v
		}
	}
	if !in.categoriesPresent {
		in.Categories = stringSlice(wc.Payload["categories"])
	}
	if !in.tagsPresent {
		in.Tags = stringSlice(wc.Payload["tags"])
	}
	if in.Status == "private" {
		in.Status = "published"
		if in.Visibility == "" || in.Visibility == "public" {
			in.Visibility = "private"
		}
	}
	if in.Status == "" {
		in.Status = "draft"
	}
	if in.Visibility == "" {
		in.Visibility = "public"
	}
	if in.JournalDate == "" {
		in.JournalDate = nowShanghaiDate()
	}
	if in.Markdown == "" {
		if v, ok := wc.Payload["markdown"].(string); ok {
			in.Markdown = v
		}
	}
	htmlOut, plain := renderMarkdown(in.Markdown)
	tx, err := srv.store.database.BeginTx(r.Context(), nil)
	if err != nil {
		problem(w, 500, "提交事务失败")
		return
	}
	defer tx.Rollback()
	var entryID string
	var revision int64
	var existingKind, existingTitle, existingSlug string
	previousStatus := "draft"
	previousVisibility := "private"
	isNewEntry := wc.EntryID == ""
	if wc.EntryID != "" {
		err = tx.QueryRowContext(r.Context(), `SELECT id::text,kind,revision,status,visibility,COALESCE(title,''),COALESCE(slug,'') FROM entries WHERE id=$1::uuid AND author_id=$2::uuid FOR UPDATE`, wc.EntryID, ownerID).Scan(&entryID, &existingKind, &revision, &previousStatus, &previousVisibility, &existingTitle, &existingSlug)
		if err != nil {
			problem(w, 404, "内容不存在")
			return
		}
		if in.BaseRevision > 0 && revision != in.BaseRevision {
			problem(w, 409, "内容已在其他位置修改")
			return
		}
		if in.Kind == "" {
			in.Kind = existingKind
		}
		if in.Title == "" {
			in.Title = existingTitle
		}
		if in.Slug == "" {
			in.Slug = existingSlug
		}
	} else {
		entryID = newID()
		err = nil
	}
	if in.Kind == "" {
		in.Kind = "note"
	}
	if in.Kind == "article" {
		in.Slug, err = uniqueDatabaseArticleSlug(r.Context(), tx, in.Slug, in.Title, entryID)
		if err != nil {
			problem(w, 500, "生成文章地址失败")
			return
		}
	}
	if wc.EntryID == "" {
		err = tx.QueryRowContext(r.Context(), `INSERT INTO entries(id,author_id,kind,status,visibility,title,slug,summary,markdown,rendered_html,plain_text,journal_date,journal_time,time_precision,day_position) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,COALESCE((SELECT max(day_position)+1 FROM entries WHERE journal_date=$12),0)) RETURNING id::text,revision`, entryID, ownerID, in.Kind, in.Status, in.Visibility, in.Title, in.Slug, in.Summary, in.Markdown, htmlOut, plain, in.JournalDate, in.JournalTime, func() string {
			if in.JournalTime != nil {
				return "minute"
			}
			return "day"
		}()).Scan(&entryID, &revision)
	} else {
		_, err = tx.ExecContext(r.Context(), `UPDATE entries SET kind=$2,status=$3,visibility=$4,title=$5,slug=$6,summary=$7,markdown=$8,rendered_html=$9,plain_text=$10,journal_date=$11,journal_time=$12,time_precision=$13,revision=revision+1,updated_at=now() WHERE id=$1::uuid`, entryID, in.Kind, in.Status, in.Visibility, in.Title, in.Slug, in.Summary, in.Markdown, htmlOut, plain, in.JournalDate, in.JournalTime, func() string {
			if in.JournalTime != nil {
				return "minute"
			}
			return "day"
		}())
	}
	if err != nil {
		problem(w, 500, "提交内容失败")
		return
	}
	// Validate the complete reference set before changing rows.  This keeps an
	// invalid media:// token from ever turning a valid existing draft into an
	// entry with silently dropped references.
	mediaIDs := extractMediaReferences(in.Markdown)
	for _, mediaID := range mediaIDs {
		if !validImportUUID(mediaID) {
			problem(w, http.StatusBadRequest, "媒体引用无效")
			return
		}
	}
	previousMediaIDs, err := entryMediaIDsTx(r.Context(), tx, entryID)
	if err != nil {
		problem(w, 500, "读取媒体引用失败")
		return
	}
	// Rebuild media references atomically with the entry so cleanup workers can
	// safely distinguish referenced files from orphaned uploads.
	if _, err := tx.ExecContext(r.Context(), `DELETE FROM media_refs WHERE entry_id=$1::uuid`, entryID); err != nil {
		problem(w, 500, "清理媒体引用失败")
		return
	}
	for _, mediaID := range mediaIDs {
		res, err := tx.ExecContext(r.Context(), `INSERT INTO media_refs(entry_id,media_id) SELECT $1::uuid,id FROM media WHERE id=$2::uuid AND owner_id=$3::uuid AND status='ready' ON CONFLICT DO NOTHING`, entryID, mediaID, ownerID)
		if err != nil {
			problem(w, 500, "保存媒体引用失败")
			return
		}
		if n, _ := res.RowsAffected(); n != 1 {
			problem(w, http.StatusBadRequest, "媒体不存在或无权引用")
			return
		}
	}
	currentMediaSet := make(map[string]struct{}, len(mediaIDs))
	for _, mediaID := range mediaIDs {
		currentMediaSet[mediaID] = struct{}{}
	}
	for _, mediaID := range previousMediaIDs {
		if _, retained := currentMediaSet[mediaID]; retained {
			continue
		}
		if err := queueMediaDeleteTx(r.Context(), tx, mediaID); err != nil {
			problem(w, 500, "排队清理未引用媒体失败")
			return
		}
	}
	// Article history is immutable and bounded to the latest twenty snapshots.
	if in.Kind == "article" {
		snapshot, _ := json.Marshal(map[string]any{"title": in.Title, "summary": in.Summary, "markdown": in.Markdown, "slug": in.Slug})
		if _, err := tx.ExecContext(r.Context(), `INSERT INTO entry_versions(id,entry_id,version_no,snapshot) VALUES(gen_random_uuid(),$1::uuid,COALESCE((SELECT max(version_no)+1 FROM entry_versions WHERE entry_id=$1::uuid),1),$2)`, entryID, snapshot); err != nil {
			problem(w, 500, "保存版本失败")
			return
		}
		if _, err := tx.ExecContext(r.Context(), `DELETE FROM entry_versions WHERE entry_id=$1::uuid AND version_no <= COALESCE((SELECT max(version_no)-20 FROM entry_versions WHERE entry_id=$1::uuid),0)`, entryID); err != nil {
			problem(w, 500, "清理版本失败")
			return
		}
	}
	undoToken := ""
	if in.Categories != nil {
		if _, err := tx.ExecContext(r.Context(), `DELETE FROM entry_categories WHERE entry_id=$1::uuid`, entryID); err != nil {
			problem(w, 500, "更新分类失败")
			return
		}
		for _, name := range in.Categories {
			slug := slugify(name)
			_, _ = tx.ExecContext(r.Context(), `INSERT INTO categories(id,name,slug) VALUES(gen_random_uuid(),$1,$2) ON CONFLICT(slug) DO NOTHING`, name, slug)
			_, _ = tx.ExecContext(r.Context(), `INSERT INTO entry_categories(entry_id,category_id) SELECT $1::uuid,id FROM categories WHERE slug=$2 ON CONFLICT DO NOTHING`, entryID, slug)
		}
	}
	if in.Kind == "note" && in.Status == "published" {
		b, _ := json.Marshal(map[string]any{"markdown": in.Markdown, "title": in.Title, "summary": in.Summary, "journalDate": in.JournalDate, "journalTime": in.JournalTime, "visibility": in.Visibility, "previousStatus": previousStatus, "previousVisibility": previousVisibility, "workingPayload": wc.Payload, "newEntry": isNewEntry})
		undoToken = randomToken()
		if err := persistUndoTx(r.Context(), tx, undoToken, entryID, b, time.Now().Add(15*time.Second)); err != nil {
			problem(w, 500, "撤销令牌创建失败")
			return
		}
	}
	if in.Tags != nil {
		if _, err := tx.ExecContext(r.Context(), `DELETE FROM entry_tags WHERE entry_id=$1::uuid`, entryID); err != nil {
			problem(w, 500, "更新标签失败")
			return
		}
	}
	for _, tag := range commitTags(in) {
		norm := strings.ToLower(tag)
		_, _ = tx.ExecContext(r.Context(), `INSERT INTO tags(id,display_name,normalized_name,slug) VALUES(gen_random_uuid(),$1,$2,$3) ON CONFLICT(normalized_name) DO NOTHING`, tag, norm, slugify(tag))
		_, _ = tx.ExecContext(r.Context(), `INSERT INTO entry_tags(entry_id,tag_id) SELECT $1::uuid,id FROM tags WHERE normalized_name=$2 ON CONFLICT DO NOTHING`, entryID, norm)
	}
	if _, err = tx.ExecContext(r.Context(), `DELETE FROM entry_working_copies WHERE id=$1::uuid AND owner_id=$2::uuid`, wc.ID, ownerID); err != nil {
		problem(w, 500, "清理草稿失败")
		return
	}
	if err = tx.Commit(); err != nil {
		problem(w, 500, "提交事务失败")
		return
	}
	e := &Entry{ID: entryID, Kind: in.Kind, Status: in.Status, Visibility: in.Visibility, Title: in.Title, Slug: in.Slug, Summary: in.Summary, Markdown: in.Markdown, RenderedHTML: htmlOut, PlainText: plain, JournalDate: in.JournalDate, JournalTime: in.JournalTime, TimePrecision: func() string {
		if in.JournalTime != nil {
			return "minute"
		}
		return "day"
	}(), Revision: revision, Categories: in.Categories, Tags: commitTags(in)}
	resp := map[string]any{"entry": e}
	if undoToken != "" {
		resp["undoToken"] = undoToken
	}
	jsonResponse(w, 200, resp)
}

func entryMediaIDsTx(ctx context.Context, tx *sql.Tx, entryID string) ([]string, error) {
	rows, err := tx.QueryContext(ctx, `SELECT media_id::text FROM media_refs WHERE entry_id=$1::uuid`, entryID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func queueMediaDeleteTx(ctx context.Context, tx *sql.Tx, mediaID string) error {
	var path string
	err := tx.QueryRowContext(ctx, `
		UPDATE media
		SET status='deleting'
		WHERE id=$1::uuid
		  AND status='ready'
		  AND COALESCE(storage_path,'') <> ''
		  AND NOT EXISTS (SELECT 1 FROM media_refs WHERE media_id=$1::uuid)
		RETURNING storage_path`, mediaID).Scan(&path)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	payload, err := json.Marshal(map[string]any{"path": path, "mediaId": mediaID})
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO jobs(type,payload) VALUES('media_delete',$1)`, payload)
	return err
}

func (srv *Server) undoEntry(w http.ResponseWriter, r *http.Request) {
	if srv.store.persistent && srv.store.database != nil {
		srv.undoEntryDatabase(w, r)
		return
	}
	if !srv.checkMutation(w, r) {
		return
	}
	token := strings.TrimPrefix(r.URL.Path, "/api/v1/admin/undo/")
	srv.store.mu.Lock()
	record := srv.store.undo[token]
	delete(srv.store.undo, token)
	var e *Entry
	if time.Now().Before(record.ExpiresAt) {
		e = srv.store.entries[record.EntryID]
	}
	if e != nil {
		e.Status = "draft"
		e.UpdatedAt = time.Now()
	}
	srv.store.mu.Unlock()
	if e == nil {
		problem(w, 404, "撤销令牌无效或已过期")
		return
	}
	jsonResponse(w, 200, map[string]any{"entry": e})
}

// undoEntryForResponse adapts the persisted undo snapshot to the same
// editor-facing entry shape returned by the in-memory implementation.  The
// working payload is preferred because it contains the draft the editor had
// before publishing; the top-level snapshot remains a compatibility fallback
// for older undo tokens that predate workingPayload.
func undoEntryForResponse(data map[string]any, entryID, status, visibility string) map[string]any {
	source := data
	if payload, ok := data["workingPayload"].(map[string]any); ok {
		source = payload
	}
	entry := map[string]any{
		"id":         entryID,
		"kind":       "note",
		"status":     status,
		"visibility": visibility,
	}
	for _, key := range []string{"kind", "title", "slug", "summary", "markdown", "journalDate", "journalTime", "categories", "tags"} {
		if value, ok := source[key]; ok {
			entry[key] = value
			continue
		}
		if value, ok := data[key]; ok {
			entry[key] = value
		}
	}
	return entry
}

func (srv *Server) undoEntryDatabase(w http.ResponseWriter, r *http.Request) {
	ownerID, err := srv.persistentUserID(r)
	if err != nil {
		problem(w, http.StatusUnauthorized, "需要登录")
		return
	}
	token := strings.TrimPrefix(r.URL.Path, "/api/v1/admin/undo/")
	tx, err := srv.store.database.BeginTx(r.Context(), nil)
	if err != nil {
		problem(w, 500, "撤销失败")
		return
	}
	defer tx.Rollback()
	var entryID string
	var payload []byte
	if err := tx.QueryRowContext(r.Context(), `DELETE FROM undo_tokens u WHERE u.token_hash=$1 AND u.expires_at>now() AND u.consumed_at IS NULL AND EXISTS (SELECT 1 FROM entries e WHERE e.id=u.entry_id AND e.author_id=$2::uuid) RETURNING u.entry_id::text,u.payload`, tokenHash(token), ownerID).Scan(&entryID, &payload); err != nil {
		problem(w, 404, "撤销令牌无效或已过期")
		return
	}
	var data map[string]any
	_ = json.Unmarshal(payload, &data)
	status := "draft"
	visibility := "private"
	if value, ok := data["previousStatus"].(string); ok && value != "" {
		status = value
	}
	if value, ok := data["previousVisibility"].(string); ok && value != "" {
		visibility = value
	}
	if newEntry, ok := data["newEntry"].(bool); ok && newEntry {
		if _, err = tx.ExecContext(r.Context(), `DELETE FROM entries WHERE id=$1::uuid AND author_id=$2::uuid`, entryID, ownerID); err != nil {
			problem(w, 500, "撤销失败")
			return
		}
	} else if payloadValue, ok := data["workingPayload"].(map[string]any); ok {
		workingBytes, _ := json.Marshal(payloadValue)
		if _, err = tx.ExecContext(r.Context(), `INSERT INTO entry_working_copies(id,owner_id,entry_id,client_draft_id,base_revision,payload) VALUES(gen_random_uuid(),$1::uuid,$2::uuid,$3,$4,$5) ON CONFLICT(client_draft_id) DO UPDATE SET payload=EXCLUDED.payload,base_revision=EXCLUDED.base_revision,updated_at=now()`, ownerID, entryID, "undo-"+entryID, 0, workingBytes); err != nil {
			problem(w, 500, "恢复草稿失败")
			return
		}
	}
	if newEntry, ok := data["newEntry"].(bool); !ok || !newEntry {
		if _, err = tx.ExecContext(r.Context(), `UPDATE entries SET status=$1,visibility=$2,updated_at=now() WHERE id=$3::uuid AND author_id=$4::uuid`, status, visibility, entryID, ownerID); err != nil {
			problem(w, 500, "撤销失败")
			return
		}
	}
	if err = tx.Commit(); err != nil {
		problem(w, 500, "撤销失败")
		return
	}
	jsonResponse(w, 200, map[string]any{"entryId": entryID, "entry": undoEntryForResponse(data, entryID, status, visibility), "payload": data, "status": status, "visibility": visibility})
}
