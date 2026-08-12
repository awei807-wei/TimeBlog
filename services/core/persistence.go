package main

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

func queryEntries(ctx context.Context, db *sql.DB, publicOnly bool) ([]*Entry, error) {
	query := `SELECT id::text,kind,status,visibility,CASE WHEN visibility='public' THEN COALESCE(title,'') ELSE '' END,CASE WHEN visibility='public' THEN COALESCE(slug,'') ELSE '' END,CASE WHEN visibility='public' THEN COALESCE(summary,'') ELSE '' END,CASE WHEN visibility='public' THEN markdown ELSE '' END,CASE WHEN visibility='public' THEN rendered_html ELSE '' END,CASE WHEN visibility='public' THEN plain_text ELSE '' END,journal_date::text,journal_time::text,time_precision,day_position,created_at,updated_at,revision FROM entries`
	if publicOnly {
		query += ` WHERE status='published'`
	}
	query += ` ORDER BY journal_date DESC, journal_time ASC NULLS FIRST, day_position, created_at`
	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*Entry{}
	for rows.Next() {
		var e Entry
		var jt sql.NullString
		if err := rows.Scan(&e.ID, &e.Kind, &e.Status, &e.Visibility, &e.Title, &e.Slug, &e.Summary, &e.Markdown, &e.RenderedHTML, &e.PlainText, &e.JournalDate, &jt, &e.TimePrecision, &e.DayPosition, &e.CreatedAt, &e.UpdatedAt, &e.Revision); err != nil {
			return nil, err
		}
		if jt.Valid {
			e.JournalTime = &jt.String
		}
		out = append(out, &e)
	}
	for _, e := range out {
		if e.Visibility != "public" {
			continue
		}
		rows2, err := db.QueryContext(ctx, `SELECT c.name FROM entry_categories ec JOIN categories c ON c.id=ec.category_id WHERE ec.entry_id=$1::uuid ORDER BY c.name`, e.ID)
		if err == nil {
			for rows2.Next() {
				var name string
				if rows2.Scan(&name) == nil {
					e.Categories = append(e.Categories, name)
				}
			}
			rows2.Close()
		}
		rows3, err := db.QueryContext(ctx, `SELECT t.display_name FROM entry_tags et JOIN tags t ON t.id=et.tag_id WHERE et.entry_id=$1::uuid ORDER BY t.normalized_name`, e.ID)
		if err == nil {
			for rows3.Next() {
				var name string
				if rows3.Scan(&name) == nil {
					e.Tags = append(e.Tags, name)
				}
			}
			rows3.Close()
		}
	}
	return out, rows.Err()
}

func encodeCursor(date, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(date + "|" + id))
}

type entryCursor struct {
	Version     int    `json:"v"`
	Date        string `json:"date"`
	JournalTime string `json:"time,omitempty"`
	DayPosition int    `json:"position"`
	ID          string `json:"id"`
}

func encodeEntryCursor(e *Entry) string {
	value, _ := json.Marshal(entryCursor{Version: 2, Date: e.JournalDate, JournalTime: func() string {
		if e.JournalTime == nil {
			return ""
		}
		return *e.JournalTime
	}(), DayPosition: e.DayPosition, ID: e.ID})
	return base64.RawURLEncoding.EncodeToString(value)
}

func decodeEntryCursor(v string) (entryCursor, bool) {
	var cursor entryCursor
	b, err := base64.RawURLEncoding.DecodeString(v)
	if err == nil && json.Unmarshal(b, &cursor) == nil && cursor.Version == 2 && cursor.Date != "" && strings.TrimSpace(cursor.ID) != "" {
		return cursor, true
	}
	date, id, ok := decodeCursor(v)
	if !ok {
		return entryCursor{}, false
	}
	return entryCursor{Version: 1, Date: date, ID: id}, true
}
func decodeCursor(v string) (string, string, bool) {
	b, e := base64.RawURLEncoding.DecodeString(v)
	if e != nil {
		return "", "", false
	}
	p := strings.SplitN(string(b), "|", 2)
	if len(p) != 2 {
		return "", "", false
	}
	return p[0], p[1], true
}

func scanWorkingCopy(row *sql.Row) (*WorkingCopy, error) {
	var x WorkingCopy
	var payload []byte
	if err := row.Scan(&x.ID, &x.ClientDraftID, &x.EntryID, &x.BaseRevision, &payload, &x.UpdatedAt); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(payload, &x.Payload); err != nil {
		return nil, err
	}
	return &x, nil
}

func openPersistentDatabase(ctx context.Context, databaseURL string) (*sql.DB, error) {
	if databaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required for the API process")
	}
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(20)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(30 * time.Minute)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := applyMigrations(ctx, db); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := ensureOwner(ctx, db, getenv("ADMIN_PASSWORD", "")); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := ensureRecoveryKey(ctx, db); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

// ensureRecoveryKey accepts a bootstrap secret only when the database has no
// active recovery key. Once provisioned, ACCOUNT_RECOVERY_KEY_BOOTSTRAP can be
// removed from the environment and startup continues using the DB hash.
func ensureRecoveryKey(ctx context.Context, db *sql.DB) error {
	var active bool
	if err := db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM account_recovery_keys WHERE used_at IS NULL AND expires_at>now())`).Scan(&active); err != nil {
		return err
	}
	if active {
		return nil
	}
	secret := getenv("ACCOUNT_RECOVERY_KEY_BOOTSTRAP", "")
	if secret == "" {
		return fmt.Errorf("no active account recovery key; set ACCOUNT_RECOVERY_KEY_BOOTSTRAP once or provision a hash with the recovery CLI")
	}
	hash, err := hashPassword(secret)
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, `INSERT INTO account_recovery_keys(id,key_hash,expires_at) VALUES(gen_random_uuid(),$1,now()+interval '90 days')`, hash)
	return err
}

func ensureOwner(ctx context.Context, db *sql.DB, password string) error {
	if password == "" {
		return fmt.Errorf("ADMIN_PASSWORD is required when DATABASE_URL is configured")
	}
	if getenv("TOTP_ENCRYPTION_KEY", "") == "" {
		return fmt.Errorf("TOTP_ENCRYPTION_KEY is required when DATABASE_URL is configured")
	}
	hash, err := hashPassword(password)
	if err != nil {
		return err
	}
	totp, err := encryptSecret(getenv("ADMIN_TOTP_SECRET", ""))
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, `INSERT INTO users(id,username,password_hash,totp_secret_encrypted) VALUES (gen_random_uuid(),'owner',$1,$2) ON CONFLICT (username) DO NOTHING`, hash, totp)
	return err
}

func persistChallenge(ctx context.Context, db *sql.DB, challenge string, expires time.Time) error {
	_, err := db.ExecContext(ctx, `INSERT INTO mfa_challenges(token_hash,expires_at) VALUES($1,$2)`, tokenHash(challenge), expires)
	return err
}

// challengeValid checks a challenge without consuming it. The challenge is
// consumed only after the submitted TOTP has been validated.
func challengeValid(ctx context.Context, db *sql.DB, challenge string) (bool, error) {
	var valid bool
	err := db.QueryRowContext(ctx, `SELECT expires_at>now() FROM mfa_challenges WHERE token_hash=$1`, tokenHash(challenge)).Scan(&valid)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return valid, err
}

func consumeChallenge(ctx context.Context, db *sql.DB, challenge string) (bool, error) {
	var ok bool
	err := db.QueryRowContext(ctx, `DELETE FROM mfa_challenges WHERE token_hash=$1 AND expires_at>now() RETURNING true`, tokenHash(challenge)).Scan(&ok)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return ok, err
}
func persistUndo(ctx context.Context, db *sql.DB, token, entryID string, payload []byte, expires time.Time) error {
	_, err := db.ExecContext(ctx, `INSERT INTO undo_tokens(token_hash,entry_id,payload,expires_at) VALUES($1,$2::uuid,$3,$4)`, tokenHash(token), entryID, payload, expires)
	return err
}

func persistUndoTx(ctx context.Context, tx *sql.Tx, token, entryID string, payload []byte, expires time.Time) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO undo_tokens(token_hash,entry_id,payload,expires_at) VALUES($1,$2::uuid,$3,$4)`, tokenHash(token), entryID, payload, expires)
	return err
}
