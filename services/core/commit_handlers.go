package main

import (
	"net/http"
	"strings"
	"time"
)

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
	// A route lookup may have captured a pointer just before discard removed
	// that generation.  Snapshot the currently registered row under the store
	// lock; the same generation is checked again immediately before mutation.
	srv.store.mu.RLock()
	currentWC := srv.store.working[wc.ID]
	if currentWC == nil {
		srv.store.mu.RUnlock()
		problem(w, http.StatusConflict, "编辑工作副本已失效，请重新载入")
		return
	}
	workingSnapshot := *currentWC
	workingSnapshot.Payload = cloneWorkingCopyPayload(currentWC.Payload)
	var formalJournalTime *string
	if currentWC.EntryID != "" {
		if currentEntry := srv.store.entries[currentWC.EntryID]; currentEntry != nil && currentEntry.JournalTime != nil {
			value := *currentEntry.JournalTime
			formalJournalTime = &value
		}
	}
	srv.store.mu.RUnlock()
	wc = &workingSnapshot
	if strings.HasPrefix(wc.ClientDraftID, "edit-") && (wc.EntryID == "" || !isEntryEditClientDraftID(wc.ClientDraftID, wc.EntryID)) {
		problem(w, http.StatusConflict, "编辑工作副本已失效，请重新载入")
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
	if in.JournalTime == nil && !in.journalTimePresent {
		if v, ok := wc.Payload["journalTime"].(string); ok && v != "" {
			in.JournalTime = &v
		} else if _, present := wc.Payload["journalTime"]; !present && formalJournalTime != nil {
			in.JournalTime = formalJournalTime
		}
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
	currentWC, stillCurrent := srv.store.working[wc.ID]
	if !stillCurrent || currentWC.ClientDraftID != wc.ClientDraftID || currentWC.EntryID != wc.EntryID {
		srv.store.mu.Unlock()
		problem(w, http.StatusConflict, "编辑工作副本已失效，请重新载入")
		return
	}
	if e.ID != "" {
		if old := srv.store.entries[e.ID]; old != nil {
			if in.BaseRevision > 0 && old.Revision != in.BaseRevision {
				srv.store.mu.Unlock()
				problem(w, http.StatusConflict, "内容已在其他位置修改")
				return
			}
			e.CreatedAt = old.CreatedAt
			e.Revision = old.Revision + 1
			if e.JournalTime == nil && !in.journalTimePresent {
				if _, present := wc.Payload["journalTime"]; !present && old.JournalTime != nil {
					value := *old.JournalTime
					e.JournalTime = &value
					e.TimePrecision = "minute"
				}
			}
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
