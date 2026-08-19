package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

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
