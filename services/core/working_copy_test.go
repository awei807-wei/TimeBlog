package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"
)

func workingCopyMutation(t *testing.T, h http.Handler, method, path, cookie, csrf, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	req.AddCookie(&http.Cookie{Name: "timeline_session", Value: cookie})
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://localhost:3000")
	req.Header.Set("X-CSRF-Token", csrf)
	response := httptest.NewRecorder()
	h.ServeHTTP(response, req)
	return response
}

func setupWorkingCopyEditTest(t *testing.T) (*Server, http.Handler, string, string) {
	t.Helper()
	t.Setenv("ADMIN_PASSWORD", "test-password")
	t.Setenv("ADMIN_TOTP_SECRET", "JBSWY3DPEHPK3PXP")
	srv := NewServer(NewStore())
	srv.store.entries["entry-a"] = &Entry{
		ID:          "entry-a",
		Kind:        "article",
		Status:      "published",
		Visibility:  "public",
		Title:       "正式标题",
		Slug:        "formal-slug",
		Summary:     "正式摘要",
		Markdown:    "正式正文",
		JournalDate: "2026-08-19",
		Categories:  []string{"日常"},
		Tags:        []string{"时间线"},
		Revision:    7,
		UpdatedAt:   time.Date(2026, 8, 19, 10, 30, 0, 0, time.UTC),
	}
	h := srv.routes()
	_, session := loginForTest(t, h)
	parts := bytes.SplitN([]byte(session), []byte("\n"), 2)
	return srv, h, string(parts[0]), string(parts[1])
}

func decodeWorkingCopy(t *testing.T, response *httptest.ResponseRecorder) WorkingCopy {
	t.Helper()
	if response.Code != http.StatusCreated {
		t.Fatalf("working copy status=%d body=%s", response.Code, response.Body.String())
	}
	var wc WorkingCopy
	if err := json.Unmarshal(response.Body.Bytes(), &wc); err != nil {
		t.Fatalf("decode working copy: %v; body=%s", err, response.Body.String())
	}
	return wc
}

func TestMemoryEditWorkingCopyMetadataNoDiffAndResume(t *testing.T) {
	_, h, cookie, csrf := setupWorkingCopyEditTest(t)
	first := decodeWorkingCopy(t, workingCopyMutation(t, h, http.MethodPost, "/api/v1/admin/entries/entry-a/edit", cookie, csrf, ""))
	if first.Resumed || first.HasUnpublishedChanges {
		t.Fatalf("new edit has unexpected metadata: %+v", first)
	}
	if !strings.HasPrefix(first.ClientDraftID, "edit-entry-a-") {
		t.Fatalf("new edit did not receive a generation client draft id: %q", first.ClientDraftID)
	}
	if first.PublishedStatus != "published" || first.PublishedVisibility != "public" || first.PublishedSlug != "formal-slug" {
		t.Fatalf("missing formal publication metadata: %+v", first)
	}
	if first.PublishedRevision != 7 || first.PublishedUpdatedAt == nil {
		t.Fatalf("missing formal entry metadata: %+v", first)
	}

	second := decodeWorkingCopy(t, workingCopyMutation(t, h, http.MethodPost, "/api/v1/admin/entries/entry-a/edit", cookie, csrf, ""))
	if !second.Resumed || second.HasUnpublishedChanges {
		t.Fatalf("resumed unchanged edit metadata: %+v", second)
	}
	if second.ID != first.ID || second.BaseRevision != first.BaseRevision {
		t.Fatalf("resume created a different working copy: first=%+v second=%+v", first, second)
	}
}

func TestMemoryEditWorkingCopyMetadataDetectsJSONArrayDiff(t *testing.T) {
	srv, h, cookie, csrf := setupWorkingCopyEditTest(t)
	first := decodeWorkingCopy(t, workingCopyMutation(t, h, http.MethodPost, "/api/v1/admin/entries/entry-a/edit", cookie, csrf, ""))

	srv.store.mu.Lock()
	for _, wc := range srv.store.working {
		if wc.ID == first.ID {
			wc.Payload["markdown"] = "未提交正文"
			// JSON-decoded request payloads use []any; this must compare equal
			// to the formal entry's []string taxonomy until one value changes.
			wc.Payload["categories"] = []any{"日常"}
			wc.Payload["tags"] = []any{"时间线", "未发布"}
		}
	}
	srv.store.mu.Unlock()

	resumed := decodeWorkingCopy(t, workingCopyMutation(t, h, http.MethodPost, "/api/v1/admin/entries/entry-a/edit", cookie, csrf, ""))
	if !resumed.Resumed || !resumed.HasUnpublishedChanges {
		t.Fatalf("changed edit metadata: %+v", resumed)
	}
}

func TestMemoryLegacyWorkingCopyResponseFillsJournalTimeThroughAutosaveAndCommit(t *testing.T) {
	srv, h, cookie, csrf := setupWorkingCopyEditTest(t)
	formalTime := "09:15:00"
	srv.store.mu.Lock()
	entry := srv.store.entries["entry-a"]
	entry.JournalTime = &formalTime
	entry.TimePrecision = "minute"
	legacyPayload := workingCopyPayloadFromEntry(entry)
	delete(legacyPayload, "journalTime")
	legacy := &WorkingCopy{
		ID: "legacy-working-copy", EntryID: entry.ID, BaseRevision: entry.Revision,
		ClientDraftID: "edit-entry-a-legacy", Payload: legacyPayload, UpdatedAt: time.Now(),
	}
	srv.store.working[legacy.ID] = legacy
	srv.store.mu.Unlock()

	resumed := decodeWorkingCopy(t, workingCopyMutation(t, h, http.MethodPost, "/api/v1/admin/entries/entry-a/edit", cookie, csrf, ""))
	if resumed.Payload["journalTime"] != formalTime || resumed.HasUnpublishedChanges {
		t.Fatalf("legacy response did not inherit formal journalTime: %+v", resumed)
	}
	loaded := workingCopyMutation(t, h, http.MethodGet, "/api/v1/admin/working-copies/"+resumed.ID, cookie, csrf, "")
	if loaded.Code != http.StatusOK {
		t.Fatalf("working-copy load status=%d body=%s", loaded.Code, loaded.Body.String())
	}
	var loadedCopy WorkingCopy
	if err := json.Unmarshal(loaded.Body.Bytes(), &loadedCopy); err != nil {
		t.Fatal(err)
	}
	if loadedCopy.Payload["journalTime"] != formalTime {
		t.Fatalf("working-copy load did not normalize journalTime: %+v", loadedCopy.Payload)
	}

	payloadJSON, err := json.Marshal(resumed.Payload)
	if err != nil {
		t.Fatal(err)
	}
	autosaveBody, err := json.Marshal(map[string]any{"clientDraftId": resumed.ClientDraftID, "payload": json.RawMessage(payloadJSON)})
	if err != nil {
		t.Fatal(err)
	}
	autosave := workingCopyMutation(t, h, http.MethodPost, "/api/v1/admin/working-copies", cookie, csrf, string(autosaveBody))
	if autosave.Code != http.StatusOK {
		t.Fatalf("autosave status=%d body=%s", autosave.Code, autosave.Body.String())
	}
	var autosaved WorkingCopy
	if err := json.Unmarshal(autosave.Body.Bytes(), &autosaved); err != nil {
		t.Fatal(err)
	}
	if autosaved.Payload["journalTime"] != formalTime {
		t.Fatalf("autosave response lost inherited journalTime: %+v", autosaved.Payload)
	}

	commit := workingCopyMutation(t, h, http.MethodPost, "/api/v1/admin/working-copies/"+resumed.ID+"/commit", cookie, csrf, `{"markdown":"正式正文","status":"published","visibility":"public","journalDate":"2026-08-19","baseRevision":7}`)
	if commit.Code != http.StatusOK {
		t.Fatalf("commit status=%d body=%s", commit.Code, commit.Body.String())
	}
	var committed struct {
		Entry Entry `json:"entry"`
	}
	if err := json.Unmarshal(commit.Body.Bytes(), &committed); err != nil {
		t.Fatal(err)
	}
	if committed.Entry.JournalTime == nil || *committed.Entry.JournalTime != formalTime || committed.Entry.TimePrecision != "minute" {
		t.Fatalf("autosave/commit cleared inherited journalTime: %+v", committed.Entry)
	}
}

func TestWorkingCopyResponseKeepsExplicitNullJournalTime(t *testing.T) {
	formalTime := "09:15:00"
	entry := &Entry{ID: "entry-a", JournalTime: &formalTime}
	wc := &WorkingCopy{Payload: map[string]any{"journalTime": nil}}
	response := normalizedWorkingCopyForEntry(wc, entry)
	value, present := response.Payload["journalTime"]
	if !present || value != nil {
		t.Fatalf("explicit null journalTime was overwritten: %#v", response.Payload)
	}
	if !workingCopyDiffersFromEntry(response.Payload, entry) {
		t.Fatal("explicit null should remain an unpublished change")
	}
}

func TestMemoryDiscardEditRecreatesFormalCopyWithoutTouchingOtherEntries(t *testing.T) {
	srv, h, cookie, csrf := setupWorkingCopyEditTest(t)
	srv.store.entries["entry-b"] = &Entry{ID: "entry-b", Kind: "note", Status: "published", Visibility: "public", Markdown: "其他正文", JournalDate: "2026-08-19", Revision: 2}
	srv.store.working["other-entry-wc"] = &WorkingCopy{ID: "other-entry-wc", EntryID: "entry-b", ClientDraftID: "edit-entry-b", Payload: map[string]any{"markdown": "其他未提交"}, UpdatedAt: time.Now()}
	srv.store.working["orphan-edit-wc"] = &WorkingCopy{ID: "orphan-edit-wc", ClientDraftID: "edit-entry-a", Payload: map[string]any{"markdown": "历史竞态孤儿"}, UpdatedAt: time.Now()}
	srv.store.working["orphan-generation-wc"] = &WorkingCopy{ID: "orphan-generation-wc", ClientDraftID: "edit-entry-a-old-generation", Payload: map[string]any{"markdown": "历史代际孤儿"}, UpdatedAt: time.Now()}
	srv.store.working["unbound-wc"] = &WorkingCopy{ID: "unbound-wc", ClientDraftID: "draft-unrelated", Payload: map[string]any{"markdown": "独立草稿"}, UpdatedAt: time.Now()}
	first := decodeWorkingCopy(t, workingCopyMutation(t, h, http.MethodPost, "/api/v1/admin/entries/entry-a/edit", cookie, csrf, ""))
	srv.store.mu.Lock()
	srv.store.working[first.ID].Payload["markdown"] = "丢弃这份正文"
	srv.store.mu.Unlock()

	reset := decodeWorkingCopy(t, workingCopyMutation(t, h, http.MethodPost, "/api/v1/admin/entries/entry-a/edit?discard=1", cookie, csrf, ""))
	if reset.Resumed || reset.HasUnpublishedChanges || reset.PublishedRevision != 7 {
		t.Fatalf("discard response metadata: %+v", reset)
	}
	if reset.ClientDraftID == first.ClientDraftID {
		t.Fatalf("discard reused the old client draft generation: %q", reset.ClientDraftID)
	}
	if reset.Payload["markdown"] != "正式正文" || reset.Payload["title"] != "正式标题" {
		t.Fatalf("discard did not restore formal payload: %#v", reset.Payload)
	}
	if reset.ID == first.ID {
		t.Fatalf("discard reused the old working copy id: %s", reset.ID)
	}

	srv.store.mu.RLock()
	if _, ok := srv.store.working["other-entry-wc"]; !ok {
		srv.store.mu.RUnlock()
		t.Fatal("discard removed another entry's working copy")
	}
	if _, ok := srv.store.working["orphan-edit-wc"]; ok {
		srv.store.mu.RUnlock()
		t.Fatal("discard kept the legacy orphan for this entry")
	}
	if _, ok := srv.store.working["orphan-generation-wc"]; ok {
		srv.store.mu.RUnlock()
		t.Fatal("discard kept the legacy generation orphan for this entry")
	}
	if _, ok := srv.store.working["unbound-wc"]; !ok {
		srv.store.mu.RUnlock()
		t.Fatal("discard removed an unrelated draft")
	}
	if _, ok := srv.store.working[reset.ID]; !ok {
		srv.store.mu.RUnlock()
		t.Fatal("discard did not persist the recreated working copy")
	}
	srv.store.mu.RUnlock()

	stale := workingCopyMutation(t, h, http.MethodPost, "/api/v1/admin/working-copies", cookie, csrf, `{"clientDraftId":"`+first.ClientDraftID+`","payload":{"markdown":"旧请求覆盖"}}`)
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale autosave after discard status=%d body=%s", stale.Code, stale.Body.String())
	}
	if srv.store.working[reset.ID].Payload["markdown"] != "正式正文" {
		t.Fatal("stale autosave changed the recreated working copy")
	}
}

func TestMemoryCommitGenerationRejectsStaleAutosave(t *testing.T) {
	_, h, cookie, csrf := setupWorkingCopyEditTest(t)
	first := decodeWorkingCopy(t, workingCopyMutation(t, h, http.MethodPost, "/api/v1/admin/entries/entry-a/edit", cookie, csrf, ""))
	commit := workingCopyMutation(t, h, http.MethodPost, "/api/v1/admin/working-copies/"+first.ID+"/commit", cookie, csrf, `{"markdown":"已提交正文","status":"published","visibility":"public","journalDate":"2026-08-19","baseRevision":7}`)
	if commit.Code != http.StatusOK {
		t.Fatalf("commit status=%d body=%s", commit.Code, commit.Body.String())
	}
	stale := workingCopyMutation(t, h, http.MethodPost, "/api/v1/admin/working-copies", cookie, csrf, `{"clientDraftId":"`+first.ClientDraftID+`","payload":{"markdown":"提交后的旧请求"}}`)
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale autosave after commit status=%d body=%s", stale.Code, stale.Body.String())
	}
}

func TestMemoryCommitAfterDiscardRejectsOldGeneration(t *testing.T) {
	srv, h, cookie, csrf := setupWorkingCopyEditTest(t)
	first := decodeWorkingCopy(t, workingCopyMutation(t, h, http.MethodPost, "/api/v1/admin/entries/entry-a/edit", cookie, csrf, ""))
	reset := decodeWorkingCopy(t, workingCopyMutation(t, h, http.MethodPost, "/api/v1/admin/entries/entry-a/edit?discard=1", cookie, csrf, ""))
	if reset.ClientDraftID == first.ClientDraftID {
		t.Fatalf("discard did not advance edit generation: old=%q new=%q", first.ClientDraftID, reset.ClientDraftID)
	}
	stale := workingCopyMutation(t, h, http.MethodPost, "/api/v1/admin/working-copies/"+first.ID+"/commit", cookie, csrf, `{"markdown":"旧请求覆盖","status":"published","visibility":"public","journalDate":"2026-08-19","baseRevision":7}`)
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale commit after discard status=%d body=%s", stale.Code, stale.Body.String())
	}
	srv.store.mu.RLock()
	formal := srv.store.entries["entry-a"]
	current := srv.store.working[reset.ID]
	if formal.Markdown != "正式正文" || current.Payload["markdown"] != "正式正文" {
		srv.store.mu.RUnlock()
		t.Fatalf("stale commit changed formal or recreated generation: formal=%+v current=%+v", formal, current)
	}
	srv.store.mu.RUnlock()
}

func TestMemoryCommitPreservesJournalTimeAndReturnsRevisionMetadata(t *testing.T) {
	srv := NewServer(NewStore())
	oldUpdatedAt := time.Now().Add(-time.Minute)
	journalTime := "09:15:00"
	srv.store.entries["entry-time"] = &Entry{
		ID:            "entry-time",
		Kind:          "note",
		Status:        "draft",
		Visibility:    "public",
		Markdown:      "旧正文",
		JournalDate:   "2026-08-19",
		JournalTime:   &journalTime,
		TimePrecision: "minute",
		CreatedAt:     oldUpdatedAt.Add(-time.Hour),
		UpdatedAt:     oldUpdatedAt,
		Revision:      4,
	}
	wc := &WorkingCopy{ID: "wc-time", EntryID: "entry-time", BaseRevision: 4, Payload: map[string]any{
		"kind": "note", "status": "draft", "visibility": "public", "markdown": "新正文", "journalDate": "2026-08-19", "journalTime": journalTime,
	}}
	srv.store.working[wc.ID] = wc
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/working-copies/wc-time/commit", bytes.NewBufferString(`{"markdown":"新正文","status":"draft","visibility":"public","journalDate":"2026-08-19","baseRevision":4}`))
	rr := httptest.NewRecorder()
	srv.commitWorking(rr, req, wc)
	if rr.Code != http.StatusOK {
		t.Fatalf("commit status=%d body=%s", rr.Code, rr.Body.String())
	}
	var body struct {
		Entry Entry `json:"entry"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Entry.Revision != 5 || body.Entry.UpdatedAt.IsZero() || !body.Entry.UpdatedAt.After(oldUpdatedAt) {
		t.Fatalf("memory commit metadata is stale: %+v", body.Entry)
	}
	if body.Entry.JournalTime == nil || *body.Entry.JournalTime != journalTime || body.Entry.TimePrecision != "minute" {
		t.Fatalf("memory commit cleared journal time: %+v", body.Entry)
	}
}

func TestMemoryLegacyWorkingCopyFallsBackToFormalJournalTime(t *testing.T) {
	srv := NewServer(NewStore())
	formalTime := "09:15:00"
	srv.store.entries["entry-legacy-time"] = &Entry{
		ID: "entry-legacy-time", Kind: "note", Status: "draft", Visibility: "public",
		Markdown: "旧正文", JournalDate: "2026-08-19", JournalTime: &formalTime,
		TimePrecision: "minute", Revision: 3, CreatedAt: time.Now().Add(-time.Hour), UpdatedAt: time.Now().Add(-time.Minute),
	}
	wc := &WorkingCopy{ID: "wc-legacy-time", EntryID: "entry-legacy-time", BaseRevision: 3, Payload: map[string]any{
		"kind": "note", "status": "draft", "visibility": "public", "markdown": "新正文", "journalDate": "2026-08-19",
	}}
	srv.store.working[wc.ID] = wc
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/working-copies/wc-legacy-time/commit", bytes.NewBufferString(`{"markdown":"新正文","status":"draft","visibility":"public","journalDate":"2026-08-19","baseRevision":3}`))
	rr := httptest.NewRecorder()
	srv.commitWorking(rr, req, wc)
	if rr.Code != http.StatusOK {
		t.Fatalf("legacy journalTime commit status=%d body=%s", rr.Code, rr.Body.String())
	}
	var body struct {
		Entry Entry `json:"entry"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Entry.JournalTime == nil || *body.Entry.JournalTime != formalTime || body.Entry.TimePrecision != "minute" {
		t.Fatalf("legacy working copy cleared formal journalTime: %+v", body.Entry)
	}
}

func TestMemoryExplicitNullJournalTimeClearsFormalValue(t *testing.T) {
	srv := NewServer(NewStore())
	formalTime := "09:15:00"
	srv.store.entries["entry-clear-time"] = &Entry{
		ID: "entry-clear-time", Kind: "note", Status: "draft", Visibility: "public",
		Markdown: "旧正文", JournalDate: "2026-08-19", JournalTime: &formalTime,
		TimePrecision: "minute", Revision: 2, CreatedAt: time.Now().Add(-time.Hour), UpdatedAt: time.Now().Add(-time.Minute),
	}
	wc := &WorkingCopy{ID: "wc-clear-time", EntryID: "entry-clear-time", BaseRevision: 2, Payload: map[string]any{
		"kind": "note", "status": "draft", "visibility": "public", "markdown": "新正文", "journalDate": "2026-08-19",
	}}
	srv.store.working[wc.ID] = wc
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/working-copies/wc-clear-time/commit", bytes.NewBufferString(`{"markdown":"新正文","status":"draft","visibility":"public","journalDate":"2026-08-19","journalTime":null,"baseRevision":2}`))
	rr := httptest.NewRecorder()
	srv.commitWorking(rr, req, wc)
	if rr.Code != http.StatusOK {
		t.Fatalf("explicit null commit status=%d body=%s", rr.Code, rr.Body.String())
	}
	var body struct {
		Entry Entry `json:"entry"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Entry.JournalTime != nil || body.Entry.TimePrecision != "day" {
		t.Fatalf("explicit null did not clear journalTime: %+v", body.Entry)
	}
}

func TestWorkingCopyDiffTreatsFormalJSONArraysAsEquivalent(t *testing.T) {
	entry := &Entry{Markdown: "正文", Title: "标题", Kind: "note", Status: "published", Visibility: "public", JournalDate: "2026-08-19", Categories: []string{"日常"}, Tags: []string{"一个"}}
	payload := workingCopyPayloadFromEntry(entry)
	payload["categories"] = []any{"日常"}
	payload["tags"] = []any{"一个"}
	if workingCopyDiffersFromEntry(payload, entry) {
		t.Fatal("JSON array representation was reported as a diff")
	}
	payload["tags"] = []any{"另一个"}
	if !workingCopyDiffersFromEntry(payload, entry) {
		t.Fatal("changed JSON array was not reported as a diff")
	}
}

func TestPersistentWorkingCopySQLLocksAllEditGenerationsBeforeFormalEntry(t *testing.T) {
	if !strings.Contains(entryEditForUpdateSQL, "FOR UPDATE") {
		t.Fatal("edit entry query must lock the formal entry row")
	}
	if !strings.Contains(entryEditForUpdateSQL, "author_id=$2::uuid") {
		t.Fatal("edit entry lock must be owner scoped")
	}
	if !strings.Contains(entryEditWorkingCopySQL, "owner_id=$1::uuid AND entry_id=$2::uuid") {
		t.Fatal("working-copy lookup must be scoped to the current owner and entry")
	}
	if !strings.Contains(entryEditWorkingCopySQL, "ORDER BY updated_at DESC LIMIT 1") {
		t.Fatal("working-copy lookup must deterministically resume the latest copy")
	}
	if !strings.Contains(entryEditWorkingCopiesForUpdateSQL, "FOR UPDATE") || !strings.Contains(entryEditWorkingCopiesForUpdateSQL, "owner_id=$1::uuid") {
		t.Fatal("edit/discard working-copy lock must be owner scoped and transactional")
	}
	if !strings.Contains(workingCopyCommitForUpdateSQL, "owner_id=$2::uuid") || !strings.Contains(workingCopyCommitForUpdateSQL, "FOR UPDATE") {
		t.Fatal("commit must lock the current working copy in the same transaction")
	}
	if !strings.Contains(entryCommitForUpdateSQL, "author_id=$2::uuid") || !strings.Contains(entryCommitForUpdateSQL, "journal_time::text") || !strings.Contains(entryCommitForUpdateSQL, "FOR UPDATE") {
		t.Fatal("commit must lock the owner-scoped formal entry and read journalTime")
	}
}

func TestOpenAPIWorkingCopyEditDocumentsIdempotencyAndGenerationConflict(t *testing.T) {
	data, err := os.ReadFile("api/openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	contract := string(data)
	if !strings.Contains(contract, "clientDraftId 以 edit- 开头时仅允许更新仍存在的当前编辑代际") {
		t.Fatal("OpenAPI does not document edit-* update-only semantics")
	}
	editPath := strings.TrimPrefix(strings.Split(contract, "  /admin/entries/{id}/edit:")[1], "")
	if !strings.Contains(editPath, "'#/components/parameters/IdempotencyKey'") || !strings.Contains(editPath, "'409': {$ref: '#/components/responses/Conflict'}") {
		t.Fatal("OpenAPI edit/discard operation is missing idempotency or conflict contract")
	}
}

func TestOpenAPIEntryJournalTimeMatchesRuntimeFormats(t *testing.T) {
	data, err := os.ReadFile("api/openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	contract := string(data)
	const pattern = `^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?$`
	if !strings.Contains(contract, "pattern: '"+pattern+"'") {
		t.Fatal("OpenAPI Entry.journalTime does not match the runtime response formats")
	}

	responsePattern := regexp.MustCompile(pattern)
	for _, value := range []string{"09:15", "09:15:00", "09:15:00.123456", "23:59:59"} {
		if !responsePattern.MatchString(value) {
			t.Fatalf("valid journalTime response %q does not match the contract", value)
		}
	}
	for _, value := range []string{"9:15", "24:00", "09:60", "09:15:000"} {
		if responsePattern.MatchString(value) {
			t.Fatalf("invalid journalTime response %q matches the contract", value)
		}
	}
}
