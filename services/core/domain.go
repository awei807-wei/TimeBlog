package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"
)

type Entry struct {
	ID                 string    `json:"id"`
	Kind               string    `json:"kind"`
	Status             string    `json:"status"`
	Visibility         string    `json:"visibility"`
	Title              string    `json:"title,omitempty"`
	Slug               string    `json:"slug,omitempty"`
	Summary            string    `json:"summary,omitempty"`
	Markdown           string    `json:"markdown"`
	RenderedHTML       string    `json:"renderedHtml,omitempty"`
	PlainText          string    `json:"plainText,omitempty"`
	JournalDate        string    `json:"journalDate"`
	JournalTime        *string   `json:"journalTime,omitempty"`
	TimePrecision      string    `json:"timePrecision"`
	DayPosition        int       `json:"dayPosition"`
	CreatedAt          time.Time `json:"createdAt"`
	UpdatedAt          time.Time `json:"updatedAt"`
	Revision           int64     `json:"revision"`
	Categories         []string  `json:"categories,omitempty"`
	Tags               []string  `json:"tags,omitempty"`
	PreviousStatus     string    `json:"-"`
	PreviousVisibility string    `json:"-"`
}

type WorkingCopy struct {
	ID                    string         `json:"id"`
	ClientDraftID         string         `json:"clientDraftId"`
	EntryID               string         `json:"entryId,omitempty"`
	BaseRevision          int64          `json:"baseRevision"`
	Payload               map[string]any `json:"payload"`
	UpdatedAt             time.Time      `json:"updatedAt"`
	Resumed               bool           `json:"resumed"`
	HasUnpublishedChanges bool           `json:"hasUnpublishedChanges"`
	PublishedRevision     int64          `json:"publishedRevision"`
	PublishedUpdatedAt    *time.Time     `json:"publishedUpdatedAt,omitempty"`
	PublishedStatus       string         `json:"publishedStatus"`
	PublishedVisibility   string         `json:"publishedVisibility"`
	PublishedSlug         string         `json:"publishedSlug"`
}

type Media struct {
	ID                    string    `json:"id"`
	OriginalName          string    `json:"originalName"`
	MimeType              string    `json:"mimeType"`
	SizeBytes             int64     `json:"sizeBytes"`
	Visibility            string    `json:"visibility"`
	Status                string    `json:"status"`
	StoragePath           string    `json:"-"`
	SHA256                string    `json:"sha256,omitempty"`
	Provider              string    `json:"provider,omitempty"`
	ProviderKey           string    `json:"providerKey,omitempty"`
	PublicURL             string    `json:"publicUrl,omitempty"`
	ExternalPublishStatus string    `json:"externalPublishStatus,omitempty"`
	ExternalPublishError  string    `json:"externalPublishError,omitempty"`
	CreatedAt             time.Time `json:"createdAt"`
}

type Session struct {
	ID              string
	TokenHash       string
	CreatedAt       time.Time
	LastSeen        time.Time
	IdleExpires     time.Time
	AbsoluteExpires time.Time
	RevokedAt       *time.Time
	CSRFToken       string
}

type undoRecord struct {
	EntryID   string
	ExpiresAt time.Time
}

type loginThrottle struct {
	Failures int
	Until    time.Time
}

type Store struct {
	mu              sync.RWMutex
	entries         map[string]*Entry
	working         map[string]*WorkingCopy
	media           map[string]*Media
	sessions        map[string]*Session
	undo            map[string]undoRecord
	userPassword    string
	userTOTP        string
	mfaChallenges   map[string]time.Time
	challengeStore  map[string]time.Time
	loginThrottle   map[string]loginThrottle
	recoveryKeyHash string
	recoveryKeyUsed bool
	nextPosition    int
	database        *sql.DB
	persistent      bool
	ownerID         string
	settings        map[string]any
	// csrfKey is process-local in memory mode and derived from the stable
	// encryption key in persistent mode.  CSRF tokens are deterministic for a
	// session cookie, so repeated session reads cannot invalidate a mutation
	// request that is still using the same token.
	csrfKey []byte
}

func NewStore() *Store {
	s := &Store{entries: map[string]*Entry{}, working: map[string]*WorkingCopy{}, media: map[string]*Media{}, sessions: map[string]*Session{}, undo: map[string]undoRecord{}, mfaChallenges: map[string]time.Time{}, loginThrottle: map[string]loginThrottle{}, settings: map[string]any{}, userPassword: getenv("ADMIN_PASSWORD", ""), userTOTP: getenv("ADMIN_TOTP_SECRET", ""), recoveryKeyHash: getenv("ACCOUNT_RECOVERY_KEY_HASH", ""), csrfKey: newCSRFKey()}
	return s
}

func NewPersistentStore(db *sql.DB) *Store {
	s := NewStore()
	s.database = db
	s.persistent = true
	return s
}

func getenv(k, fallback string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return fallback
}

func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return fmt.Sprintf("%s-%s-%s-%s-%s", hex.EncodeToString(b[:4]), hex.EncodeToString(b[4:6]), hex.EncodeToString(b[6:8]), hex.EncodeToString(b[8:10]), hex.EncodeToString(b[10:]))
}

func nowShanghaiDate() string {
	return time.Now().In(time.FixedZone("UTC+8", 8*60*60)).Format("2006-01-02")
}

func (s *Store) authenticated(r *http.Request) bool {
	c, err := r.Cookie("timeline_session")
	if err != nil || c.Value == "" {
		return false
	}
	if s.persistent && s.database != nil {
		var id string
		err := s.database.QueryRowContext(r.Context(), `UPDATE sessions SET last_seen=now(), idle_expires=LEAST(idle_expires + interval '30 days', absolute_expires) WHERE token_hash=$1 AND revoked_at IS NULL AND idle_expires>now() AND absolute_expires>now() RETURNING id::text`, tokenHash(c.Value)).Scan(&id)
		return err == nil && id != ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ss := s.sessions[tokenHash(c.Value)]
	if ss == nil || ss.RevokedAt != nil || time.Now().After(ss.IdleExpires) || time.Now().After(ss.AbsoluteExpires) {
		return false
	}
	ss.LastSeen = time.Now()
	ss.IdleExpires = time.Now().Add(30 * 24 * time.Hour)
	return true
}
