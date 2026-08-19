package main

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

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
	tx, err := srv.store.database.BeginTx(r.Context(), nil)
	if err != nil {
		problem(w, 500, "提交事务失败")
		return
	}
	defer tx.Rollback()

	// Reload and lock the working copy before touching the formal entry.  The
	// caller may have read an older generation before discard replaced it; the
	// row lock plus owner check makes that stale commit fail with 409 instead of
	// applying its payload to the newly recreated copy's entry.
	var payload []byte
	if err = tx.QueryRowContext(r.Context(), workingCopyCommitForUpdateSQL, wc.ID, ownerID).Scan(&wc.ID, &wc.ClientDraftID, &wc.EntryID, &wc.BaseRevision, &payload, &wc.UpdatedAt); err != nil {
		if err == sql.ErrNoRows {
			problem(w, http.StatusConflict, "编辑工作副本已失效，请重新载入")
		} else {
			problem(w, 500, "读取工作副本失败")
		}
		return
	}
	if err = json.Unmarshal(payload, &wc.Payload); err != nil {
		problem(w, 500, "读取工作副本失败")
		return
	}
	if strings.HasPrefix(wc.ClientDraftID, "edit-") && (wc.EntryID == "" || !isEntryEditClientDraftID(wc.ClientDraftID, wc.EntryID)) {
		problem(w, http.StatusConflict, "编辑工作副本已失效，请重新载入")
		return
	}

	var entryID string
	var revision int64
	var createdAt, updatedAt time.Time
	var existingKind, existingTitle, existingSlug string
	var existingJournalTime sql.NullString
	previousStatus := "draft"
	previousVisibility := "private"
	isNewEntry := wc.EntryID == ""
	if !isNewEntry {
		// The working-copy lock is held while this formal row is locked.  The
		// matching lock order is also used by discard/edit-open below.
		err = tx.QueryRowContext(r.Context(), entryCommitForUpdateSQL, wc.EntryID, ownerID).Scan(&entryID, &existingKind, &revision, &previousStatus, &previousVisibility, &existingTitle, &existingSlug, &existingJournalTime)
		if err == sql.ErrNoRows {
			problem(w, http.StatusNotFound, "内容不存在")
			return
		}
		if err != nil {
			problem(w, 500, "读取内容失败")
			return
		}
		if in.BaseRevision == 0 {
			in.BaseRevision = wc.BaseRevision
		}
		if in.BaseRevision > 0 && revision != in.BaseRevision {
			problem(w, http.StatusConflict, "内容已在其他位置修改")
			return
		}
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
	if in.JournalTime == nil && !in.journalTimePresent {
		if v, ok := wc.Payload["journalTime"].(string); ok && v != "" {
			in.JournalTime = &v
		} else if _, present := wc.Payload["journalTime"]; !present && existingJournalTime.Valid && existingJournalTime.String != "" {
			// Older working copies predate journalTime.  Missing is different from
			// an explicit empty value: preserve the formal timestamp only for the
			// former so legacy edits cannot silently erase it.
			v := existingJournalTime.String
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
	if !isNewEntry {
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
		err = tx.QueryRowContext(r.Context(), `INSERT INTO entries(id,author_id,kind,status,visibility,title,slug,summary,markdown,rendered_html,plain_text,journal_date,journal_time,time_precision,day_position) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,COALESCE((SELECT max(day_position)+1 FROM entries WHERE journal_date=$12),0)) RETURNING id::text,revision,created_at,updated_at`, entryID, ownerID, in.Kind, in.Status, in.Visibility, in.Title, in.Slug, in.Summary, in.Markdown, htmlOut, plain, in.JournalDate, in.JournalTime, func() string {
			if in.JournalTime != nil {
				return "minute"
			}
			return "day"
		}()).Scan(&entryID, &revision, &createdAt, &updatedAt)
	} else {
		err = tx.QueryRowContext(r.Context(), `UPDATE entries SET kind=$2,status=$3,visibility=$4,title=$5,slug=$6,summary=$7,markdown=$8,rendered_html=$9,plain_text=$10,journal_date=$11,journal_time=$12,time_precision=$13,revision=revision+1,updated_at=now() WHERE id=$1::uuid RETURNING revision,created_at,updated_at`, entryID, in.Kind, in.Status, in.Visibility, in.Title, in.Slug, in.Summary, in.Markdown, htmlOut, plain, in.JournalDate, in.JournalTime, func() string {
			if in.JournalTime != nil {
				return "minute"
			}
			return "day"
		}()).Scan(&revision, &createdAt, &updatedAt)
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
	}(), CreatedAt: createdAt, UpdatedAt: updatedAt, Revision: revision, Categories: in.Categories, Tags: commitTags(in)}
	resp := map[string]any{"entry": e}
	if undoToken != "" {
		resp["undoToken"] = undoToken
	}
	jsonResponse(w, 200, resp)
}
