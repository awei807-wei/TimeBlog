package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"time"
)

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
			out = append(out, normalizedWorkingCopyForEntry(x, srv.store.entries[x.EntryID]))
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
			if strings.HasPrefix(in.ClientDraftID, "edit-") {
				srv.store.mu.Unlock()
				problem(w, http.StatusConflict, "编辑工作副本已失效，请重新载入")
				return
			}
			wc = &WorkingCopy{ID: newID(), ClientDraftID: in.ClientDraftID}
			srv.store.working[wc.ID] = wc
		}
		wc.Payload = in.Payload
		wc.UpdatedAt = time.Now()
		response := normalizedWorkingCopyForEntry(wc, srv.store.entries[wc.EntryID])
		srv.store.mu.Unlock()
		jsonResponse(w, 200, response)
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
		rows, err := srv.store.database.QueryContext(ctx, `SELECT wc.id::text,wc.client_draft_id,COALESCE(wc.entry_id::text,''),wc.base_revision,wc.payload,wc.updated_at,e.journal_time::text FROM entry_working_copies wc LEFT JOIN entries e ON e.id=wc.entry_id AND e.author_id=wc.owner_id WHERE wc.owner_id=$1::uuid ORDER BY wc.updated_at DESC`, ownerID)
		if err != nil {
			problem(w, 500, "读取草稿失败")
			return
		}
		defer rows.Close()
		out := []*WorkingCopy{}
		for rows.Next() {
			var x WorkingCopy
			var payload []byte
			var journalTime sql.NullString
			if err := rows.Scan(&x.ID, &x.ClientDraftID, &x.EntryID, &x.BaseRevision, &payload, &x.UpdatedAt, &journalTime); err != nil {
				problem(w, 500, "读取草稿失败")
				return
			}
			_ = json.Unmarshal(payload, &x.Payload)
			var entry *Entry
			if x.EntryID != "" {
				entry = &Entry{ID: x.EntryID}
				if journalTime.Valid {
					value := journalTime.String
					entry.JournalTime = &value
				}
			}
			out = append(out, normalizedWorkingCopyForEntry(&x, entry))
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
	if strings.HasPrefix(in.ClientDraftID, "edit-") {
		// Edit generations are update-only.  A stale autosave arriving after
		// commit/discard must not recreate an orphan or overwrite the fresh
		// generation created by the recovery action.
		err = srv.store.database.QueryRowContext(ctx, `UPDATE entry_working_copies SET payload=$1,updated_at=now() WHERE owner_id=$2::uuid AND client_draft_id=$3 RETURNING id::text,client_draft_id,COALESCE(entry_id::text,''),base_revision,payload,updated_at`, payload, ownerID, in.ClientDraftID).Scan(&x.ID, &x.ClientDraftID, &x.EntryID, &x.BaseRevision, &payload, &x.UpdatedAt)
		if err == sql.ErrNoRows {
			problem(w, http.StatusConflict, "编辑工作副本已失效，请重新载入")
			return
		}
		if err != nil {
			problem(w, 500, "保存草稿失败")
			return
		}
		_ = json.Unmarshal(payload, &x.Payload)
		response, normalizeErr := normalizedPersistentWorkingCopy(ctx, srv.store.database, ownerID, &x)
		if normalizeErr != nil {
			problem(w, 500, "读取正式内容时间失败")
			return
		}
		jsonResponse(w, 200, response)
		return
	}
	err = srv.store.database.QueryRowContext(ctx, `INSERT INTO entry_working_copies(id,owner_id,client_draft_id,payload) VALUES(gen_random_uuid(),$1::uuid,$2,$3) ON CONFLICT (client_draft_id) DO UPDATE SET payload=EXCLUDED.payload, updated_at=now() WHERE entry_working_copies.owner_id=EXCLUDED.owner_id RETURNING id::text,client_draft_id,COALESCE(entry_id::text,''),base_revision,payload,updated_at`, ownerID, in.ClientDraftID, payload).Scan(&x.ID, &x.ClientDraftID, &x.EntryID, &x.BaseRevision, &payload, &x.UpdatedAt)
	if err != nil {
		problem(w, 500, "保存草稿失败")
		return
	}
	_ = json.Unmarshal(payload, &x.Payload)
	response, normalizeErr := normalizedPersistentWorkingCopy(ctx, srv.store.database, ownerID, &x)
	if normalizeErr != nil {
		problem(w, 500, "读取正式内容时间失败")
		return
	}
	jsonResponse(w, 200, response)
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
		if r.Method == http.MethodPost && len(parts) > 1 && parts[1] == "commit" {
			problem(w, http.StatusConflict, "编辑工作副本已失效，请重新载入")
			return
		}
		problem(w, 404, "草稿不存在")
		return
	}
	switch r.Method {
	case http.MethodGet:
		srv.store.mu.RLock()
		response := normalizedWorkingCopyForEntry(wc, srv.store.entries[wc.EntryID])
		srv.store.mu.RUnlock()
		jsonResponse(w, 200, response)
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
		response := normalizedWorkingCopyForEntry(wc, srv.store.entries[wc.EntryID])
		srv.store.mu.Unlock()
		jsonResponse(w, 200, response)
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
		// Reload and lock the working copy inside commitWorkingDatabase.  The
		// previous preflight SELECT raced with discard: discard could delete and
		// recreate the row after this read, allowing an old request to overwrite
		// the fresh generation.
		srv.commitWorkingDatabase(w, r, &WorkingCopy{ID: id})
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
		response, normalizeErr := normalizedPersistentWorkingCopy(r.Context(), srv.store.database, ownerID, &wc)
		if normalizeErr != nil {
			problem(w, 500, "读取正式内容时间失败")
			return
		}
		jsonResponse(w, 200, response)
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
