package main

import (
	"context"
	"database/sql"
	"encoding/json"
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

	categoriesPresent  bool
	tagsPresent        bool
	journalTimePresent bool
}

// workingCopyPayloadFromEntry creates the canonical editable representation of
// a formal entry. Keeping this in one place prevents the memory and persistent
// edit endpoints from drifting apart as fields are added.
func workingCopyPayloadFromEntry(e *Entry) map[string]any {
	categories := append([]string(nil), e.Categories...)
	tags := append([]string(nil), e.Tags...)
	var journalTime any
	if e.JournalTime != nil {
		journalTime = *e.JournalTime
	}
	return map[string]any{
		"markdown":    e.Markdown,
		"title":       e.Title,
		"slug":        e.Slug,
		"summary":     e.Summary,
		"journalDate": e.JournalDate,
		"journalTime": journalTime,
		"visibility":  e.Visibility,
		"status":      e.Status,
		"kind":        e.Kind,
		"categories":  categories,
		"tags":        tags,
	}
}

func workingCopyString(payload map[string]any, key string) string {
	value, ok := payload[key]
	if !ok || value == nil {
		return ""
	}
	valueString, _ := value.(string)
	return valueString
}

func workingCopyStrings(value any) []string {
	values := stringSlice(value)
	if len(values) == 0 {
		return []string{}
	}
	return append([]string(nil), values...)
}

func equalWorkingCopyStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

// workingCopyDiffersFromEntry compares the editable fields against the latest
// formal entry. JSON decoding represents arrays as []any, while in-memory
// fixtures and some callers use []string; workingCopyStrings normalizes both.
func workingCopyDiffersFromEntry(payload map[string]any, e *Entry) bool {
	for key, formal := range map[string]string{
		"markdown":    e.Markdown,
		"title":       e.Title,
		"slug":        e.Slug,
		"summary":     e.Summary,
		"kind":        e.Kind,
		"status":      e.Status,
		"visibility":  e.Visibility,
		"journalDate": e.JournalDate,
	} {
		if workingCopyString(payload, key) != formal {
			return true
		}
	}
	formalJournalTime := ""
	if e.JournalTime != nil {
		formalJournalTime = *e.JournalTime
	}
	if _, present := payload["journalTime"]; present && workingCopyString(payload, "journalTime") != formalJournalTime {
		return true
	}
	if !equalWorkingCopyStrings(workingCopyStrings(payload["categories"]), workingCopyStrings(e.Categories)) {
		return true
	}
	if !equalWorkingCopyStrings(workingCopyStrings(payload["tags"]), workingCopyStrings(e.Tags)) {
		return true
	}
	return false
}

func workingCopyResponse(wc *WorkingCopy, e *Entry, resumed bool) *WorkingCopy {
	response := normalizedWorkingCopyForEntry(wc, e)
	response.Resumed = resumed
	response.HasUnpublishedChanges = workingCopyDiffersFromEntry(response.Payload, e)
	response.PublishedRevision = e.Revision
	updatedAt := e.UpdatedAt
	response.PublishedUpdatedAt = &updatedAt
	response.PublishedStatus = e.Status
	response.PublishedVisibility = e.Visibility
	response.PublishedSlug = e.Slug
	return response
}

// normalizedWorkingCopyForEntry preserves the semantic difference between a
// legacy payload that predates journalTime and an explicit null chosen by the
// editor. Only the missing field inherits the current formal value.
func normalizedWorkingCopyForEntry(wc *WorkingCopy, e *Entry) *WorkingCopy {
	response := *wc
	response.Payload = cloneWorkingCopyPayload(wc.Payload)
	if e == nil {
		return &response
	}
	if response.Payload == nil {
		response.Payload = map[string]any{}
	}
	if _, present := response.Payload["journalTime"]; present {
		return &response
	}
	if e.JournalTime == nil {
		response.Payload["journalTime"] = nil
	} else {
		response.Payload["journalTime"] = *e.JournalTime
	}
	return &response
}

func cloneWorkingCopyPayload(payload map[string]any) map[string]any {
	if payload == nil {
		return nil
	}
	clone := make(map[string]any, len(payload))
	for key, value := range payload {
		switch values := value.(type) {
		case []string:
			clone[key] = append([]string(nil), values...)
		case []any:
			clone[key] = append([]any(nil), values...)
		default:
			clone[key] = value
		}
	}
	return clone
}

func normalizedPersistentWorkingCopy(ctx context.Context, db *sql.DB, ownerID string, wc *WorkingCopy) (*WorkingCopy, error) {
	if wc.EntryID == "" {
		return normalizedWorkingCopyForEntry(wc, nil), nil
	}
	var journalTime sql.NullString
	err := db.QueryRowContext(ctx, `SELECT journal_time::text FROM entries WHERE id=$1::uuid AND author_id=$2::uuid`, wc.EntryID, ownerID).Scan(&journalTime)
	if err == sql.ErrNoRows {
		return normalizedWorkingCopyForEntry(wc, nil), nil
	}
	if err != nil {
		return nil, err
	}
	entry := &Entry{ID: wc.EntryID}
	if journalTime.Valid {
		value := journalTime.String
		entry.JournalTime = &value
	}
	return normalizedWorkingCopyForEntry(wc, entry), nil
}

func newEntryWorkingCopy(e *Entry) *WorkingCopy {
	return &WorkingCopy{
		ID:            newID(),
		EntryID:       e.ID,
		BaseRevision:  e.Revision,
		ClientDraftID: "edit-" + e.ID + "-" + newID(),
		Payload:       workingCopyPayloadFromEntry(e),
		UpdatedAt:     time.Now(),
	}
}

func isEntryEditClientDraftID(clientDraftID, entryID string) bool {
	base := "edit-" + entryID
	return clientDraftID == base || strings.HasPrefix(clientDraftID, base+"-")
}

type workingCopyTaxonomyQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

const entryEditForUpdateSQL = `SELECT id::text,kind,status,visibility,COALESCE(title,''),COALESCE(slug,''),COALESCE(summary,''),markdown,rendered_html,plain_text,journal_date::text,journal_time::text,time_precision,day_position,created_at,updated_at,revision FROM entries WHERE id=$1::uuid AND author_id=$2::uuid FOR UPDATE`

const entryEditWorkingCopySQL = `SELECT id::text,client_draft_id,COALESCE(entry_id::text,''),base_revision,payload,updated_at FROM entry_working_copies WHERE owner_id=$1::uuid AND entry_id=$2::uuid ORDER BY updated_at DESC LIMIT 1`

// All persistent edit operations take locks in working-copy -> formal-entry
// order.  Commit and discard must use the same order; otherwise one request
// can hold the working-copy row while the other holds the entry row and both
// wait forever for the other lock.
const entryEditWorkingCopiesForUpdateSQL = `SELECT id::text FROM entry_working_copies WHERE owner_id=$1::uuid AND (entry_id=$2::uuid OR (entry_id IS NULL AND (client_draft_id=$3 OR client_draft_id LIKE $4))) FOR UPDATE`

const workingCopyCommitForUpdateSQL = `SELECT id::text,client_draft_id,COALESCE(entry_id::text,''),base_revision,payload,updated_at FROM entry_working_copies WHERE id=$1::uuid AND owner_id=$2::uuid FOR UPDATE`

const entryCommitForUpdateSQL = `SELECT id::text,kind,revision,status,visibility,COALESCE(title,''),COALESCE(slug,''),journal_time::text FROM entries WHERE id=$1::uuid AND author_id=$2::uuid FOR UPDATE`

// loadWorkingCopyTaxonomy reads taxonomy through the caller's query context.
// The discard path uses a transaction so taxonomy is read alongside the
// formally locked entry rather than from the pre-transaction snapshot.
func loadWorkingCopyTaxonomy(ctx context.Context, queryer workingCopyTaxonomyQueryer, e *Entry) error {
	rows, err := queryer.QueryContext(ctx, `SELECT c.name FROM entry_categories ec JOIN categories c ON c.id=ec.category_id WHERE ec.entry_id=$1::uuid ORDER BY c.name`, e.ID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return err
		}
		e.Categories = append(e.Categories, name)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	rows, err = queryer.QueryContext(ctx, `SELECT t.display_name FROM entry_tags et JOIN tags t ON t.id=et.tag_id WHERE et.entry_id=$1::uuid ORDER BY t.normalized_name`, e.ID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return err
		}
		e.Tags = append(e.Tags, name)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	return nil
}

func loadEntryForUpdate(ctx context.Context, tx *sql.Tx, entryID, ownerID string) (Entry, error) {
	var e Entry
	var journalTime sql.NullString
	err := tx.QueryRowContext(ctx, entryEditForUpdateSQL, entryID, ownerID).Scan(&e.ID, &e.Kind, &e.Status, &e.Visibility, &e.Title, &e.Slug, &e.Summary, &e.Markdown, &e.RenderedHTML, &e.PlainText, &e.JournalDate, &journalTime, &e.TimePrecision, &e.DayPosition, &e.CreatedAt, &e.UpdatedAt, &e.Revision)
	if err != nil {
		return Entry{}, err
	}
	if journalTime.Valid {
		e.JournalTime = &journalTime.String
	}
	if err := loadWorkingCopyTaxonomy(ctx, tx, &e); err != nil {
		return Entry{}, err
	}
	return e, nil
}

func lockEntryWorkingCopies(ctx context.Context, tx *sql.Tx, ownerID, entryID string) error {
	prefix := "edit-" + entryID + "-"
	rows, err := tx.QueryContext(ctx, entryEditWorkingCopiesForUpdateSQL, ownerID, entryID, "edit-"+entryID, prefix+"%")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
	}
	return rows.Err()
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
	_, in.journalTimePresent = fields["journalTime"]
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
