package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

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
		discard := r.URL.Query().Get("discard") == "1"
		srv.store.mu.Lock()
		if discard {
			// The discard action is deliberately scoped to this formal entry.
			// A legacy autosave may have the edit clientDraftID but no entry_id;
			// remove that orphan too, while preserving every other independent
			// draft without an entry association.
			for workingID, existing := range srv.store.working {
				if existing.EntryID == e.ID || (existing.EntryID == "" && isEntryEditClientDraftID(existing.ClientDraftID, e.ID)) {
					delete(srv.store.working, workingID)
				}
			}
			wc := newEntryWorkingCopy(e)
			srv.store.working[wc.ID] = wc
			response := workingCopyResponse(wc, e, false)
			srv.store.mu.Unlock()
			jsonResponse(w, http.StatusCreated, response)
			return
		}

		var wc *WorkingCopy
		resumed := false
		for _, existing := range srv.store.working {
			if existing.EntryID == e.ID && existing.ClientDraftID == "edit-"+e.ID {
				wc = existing
				resumed = true
				break
			}
		}
		if wc == nil {
			for _, existing := range srv.store.working {
				if existing.EntryID == e.ID {
					wc = existing
					resumed = true
					break
				}
			}
		}
		if wc == nil {
			wc = newEntryWorkingCopy(e)
			srv.store.working[wc.ID] = wc
		}
		response := workingCopyResponse(wc, e, resumed)
		srv.store.mu.Unlock()
		jsonResponse(w, http.StatusCreated, response)
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
		payload := workingCopyPayloadFromEntry(&e)
		data, _ := json.Marshal(payload)
		var wc WorkingCopy
		resumed := false
		if r.URL.Query().Get("discard") == "1" {
			// Delete and recreate in one transaction.  Lock the current working
			// generation before the formal row so commit and discard serialize in
			// the same order.
			tx, txErr := srv.store.database.BeginTx(r.Context(), nil)
			if txErr != nil {
				problem(w, 500, "重建编辑草稿失败")
				return
			}
			defer tx.Rollback()
			if txErr = lockEntryWorkingCopies(r.Context(), tx, ownerID, entryID); txErr != nil {
				problem(w, 500, "锁定编辑草稿失败")
				return
			}
			latest, loadErr := loadEntryForUpdate(r.Context(), tx, entryID, ownerID)
			if loadErr == sql.ErrNoRows {
				problem(w, http.StatusNotFound, "内容不存在")
				return
			}
			if loadErr != nil {
				problem(w, 500, "读取内容分类失败")
				return
			}
			e = latest
			payload = workingCopyPayloadFromEntry(&e)
			data, _ = json.Marshal(payload)
			// The second predicate handles legacy races where the generic
			// autosave created edit-<entryID> before entry_id was attached.
			// Both owner and entry/client-draft scopes are mandatory.
			clientDraftPrefix := "edit-" + e.ID + "-"
			if _, txErr = tx.ExecContext(r.Context(), `DELETE FROM entry_working_copies WHERE owner_id=$1::uuid AND (entry_id=$2::uuid OR (entry_id IS NULL AND (client_draft_id=$3 OR client_draft_id LIKE $4)))`, ownerID, e.ID, "edit-"+e.ID, clientDraftPrefix+"%"); txErr != nil {
				problem(w, 500, "丢弃编辑草稿失败")
				return
			}
			clientDraftID := clientDraftPrefix + newID()
			if txErr = tx.QueryRowContext(r.Context(), `INSERT INTO entry_working_copies(id,owner_id,entry_id,client_draft_id,base_revision,payload) VALUES(gen_random_uuid(),$1::uuid,$2::uuid,$3,$4,$5) RETURNING id::text,client_draft_id,COALESCE(entry_id::text,''),base_revision,payload,updated_at`, ownerID, e.ID, clientDraftID, e.Revision, data).Scan(&wc.ID, &wc.ClientDraftID, &wc.EntryID, &wc.BaseRevision, &data, &wc.UpdatedAt); txErr != nil {
				problem(w, 500, "重建编辑草稿失败")
				return
			}
			if txErr = tx.Commit(); txErr != nil {
				problem(w, 500, "重建编辑草稿失败")
				return
			}
		} else {
			// Lock existing working generations before the formal row.  This keeps
			// edit-open, commit, and discard on one lock order even though the
			// working-copy table has no owner_id+entry_id unique index.
			tx, txErr := srv.store.database.BeginTx(r.Context(), nil)
			if txErr != nil {
				problem(w, 500, "创建编辑事务失败")
				return
			}
			defer tx.Rollback()
			if txErr = lockEntryWorkingCopies(r.Context(), tx, ownerID, entryID); txErr != nil {
				problem(w, 500, "锁定编辑草稿失败")
				return
			}
			latest, loadErr := loadEntryForUpdate(r.Context(), tx, entryID, ownerID)
			if loadErr == sql.ErrNoRows {
				problem(w, http.StatusNotFound, "内容不存在")
				return
			}
			if loadErr != nil {
				problem(w, 500, "读取内容分类失败")
				return
			}
			e = latest
			payload = workingCopyPayloadFromEntry(&e)
			data, _ = json.Marshal(payload)
			err = tx.QueryRowContext(r.Context(), entryEditWorkingCopySQL, ownerID, e.ID).Scan(&wc.ID, &wc.ClientDraftID, &wc.EntryID, &wc.BaseRevision, &data, &wc.UpdatedAt)
			if err == nil {
				resumed = true
			} else if err == sql.ErrNoRows {
				clientDraftID := "edit-" + e.ID + "-" + newID()
				err = tx.QueryRowContext(r.Context(), `INSERT INTO entry_working_copies(id,owner_id,entry_id,client_draft_id,base_revision,payload) VALUES(gen_random_uuid(),$1::uuid,$2::uuid,$3,$4,$5) RETURNING id::text,client_draft_id,COALESCE(entry_id::text,''),base_revision,payload,updated_at`, ownerID, e.ID, clientDraftID, e.Revision, data).Scan(&wc.ID, &wc.ClientDraftID, &wc.EntryID, &wc.BaseRevision, &data, &wc.UpdatedAt)
				if err != nil {
					problem(w, http.StatusConflict, "编辑草稿已存在")
					return
				}
			} else {
				problem(w, 500, "读取编辑草稿失败")
				return
			}
			if txErr = tx.Commit(); txErr != nil {
				problem(w, 500, "提交编辑事务失败")
				return
			}
		}
		_ = json.Unmarshal(data, &wc.Payload)
		jsonResponse(w, http.StatusCreated, workingCopyResponse(&wc, &e, resumed))
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
