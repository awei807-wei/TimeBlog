package main

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

type Server struct {
	store     *Store
	mediaRoot string
}

func NewServer(store *Store) *Server {
	return &Server{store: store, mediaRoot: getenv("MEDIA_ROOT", filepath.Join(os.TempDir(), "timeline-media"))}
}

func (srv *Server) routes() http.Handler {
	mux := http.NewServeMux()
	admin := func(handler http.HandlerFunc) http.HandlerFunc {
		return srv.adminAuth(handler)
	}
	// Public representations are derived from mutable entries.  They must not
	// be retained by an intermediary after a recycle/restore/publish mutation;
	// the web client already keeps an offline shell separately.
	public := func(handler http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store, max-age=0")
			w.Header().Set("CDN-Cache-Control", "no-store")
			handler(w, r)
		}
	}
	mux.HandleFunc("/health/live", func(w http.ResponseWriter, _ *http.Request) { jsonResponse(w, 200, map[string]string{"status": "ok"}) })
	mux.HandleFunc("/health/ready", func(w http.ResponseWriter, r *http.Request) {
		if srv.store.persistent && srv.store.database != nil {
			if err := srv.store.database.PingContext(r.Context()); err != nil {
				problem(w, http.StatusServiceUnavailable, "数据库未就绪")
				return
			}
			if err := checkDatabaseReadiness(r.Context(), srv.store.database); err != nil {
				problem(w, http.StatusServiceUnavailable, err.Error())
				return
			}
		} else {
			jsonResponse(w, http.StatusServiceUnavailable, map[string]string{"status": "database-required"})
			return
		}
		for _, root := range []string{getenv("MEDIA_ROOT", filepath.Join(os.TempDir(), "timeline-media")), getenv("EXPORT_ROOT", filepath.Join(os.TempDir(), "timeline-exports"))} {
			if err := checkWritableDirectory(root); err != nil {
				problem(w, http.StatusServiceUnavailable, err.Error())
				return
			}
		}
		jsonResponse(w, 200, map[string]string{"status": "ready"})
	})
	mux.HandleFunc("/api/v1/public/timeline", public(srv.publicTimeline))
	mux.HandleFunc("/api/v1/public/days/", public(srv.publicDay))
	mux.HandleFunc("/api/v1/public/articles/", public(srv.publicArticle))
	mux.HandleFunc("/api/v1/public/calendar", public(srv.publicCalendar))
	mux.HandleFunc("/api/v1/public/categories", public(srv.publicCategories))
	mux.HandleFunc("/api/v1/public/categories/", public(srv.publicCategoryEntries))
	mux.HandleFunc("/api/v1/public/tags/", public(srv.publicTag))
	mux.HandleFunc("/api/v1/public/search", public(srv.publicSearch))
	mux.HandleFunc("/api/v1/public/feed", public(srv.publicFeed))
	mux.HandleFunc("/api/v1/auth/login/password", srv.loginPassword)
	mux.HandleFunc("/api/v1/auth/login/totp", srv.loginTOTP)
	mux.HandleFunc("/api/v1/auth/recovery/account", srv.recoverAccount)
	mux.HandleFunc("/api/v1/auth/logout", srv.logout)
	mux.HandleFunc("/api/v1/auth/session", srv.authSession)
	mux.HandleFunc("/api/v1/auth/session/status", srv.authSessionStatus)
	mux.HandleFunc("/api/v1/auth/sessions", srv.authSessions)
	mux.HandleFunc("/api/v1/auth/sessions/", srv.authSessionAction)
	mux.HandleFunc("/api/v1/admin/working-copies", admin(srv.workingCopies))
	mux.HandleFunc("/api/v1/admin/working-copies/", admin(srv.workingCopy))
	mux.HandleFunc("/api/v1/admin/entries", admin(srv.entries))
	mux.HandleFunc("/api/v1/admin/entries/", admin(srv.entry))
	mux.HandleFunc("/api/v1/admin/undo/", admin(srv.undoEntry))
	mux.HandleFunc("/api/v1/admin/media/upload-ticket", admin(srv.mediaTicket))
	mux.HandleFunc("/api/v1/admin/media/capability", admin(srv.mediaCapability))
	mux.HandleFunc("/api/v1/admin/runtime-status", admin(srv.runtimeStatus))
	mux.HandleFunc("/api/v1/admin/media/", admin(srv.mediaEndpoint))
	mux.HandleFunc("/api/v1/admin/media", admin(srv.mediaCollection))
	mux.HandleFunc("/api/v1/admin/categories", admin(srv.taxonomyCategories))
	mux.HandleFunc("/api/v1/admin/categories/", admin(srv.taxonomyCategory))
	mux.HandleFunc("/api/v1/admin/tags", admin(srv.taxonomyTags))
	mux.HandleFunc("/api/v1/admin/tags/", admin(srv.taxonomyTag))
	mux.HandleFunc("/api/v1/admin/embeds/resolve", admin(srv.resolveEmbed))
	mux.HandleFunc("/api/v1/admin/exports", admin(srv.exports))
	mux.HandleFunc("/api/v1/admin/exports/", admin(srv.exportDownload))
	mux.HandleFunc("/api/v1/admin/imports/dry-run", admin(srv.importDryRun))
	mux.HandleFunc("/api/v1/admin/imports", admin(srv.importEntries))
	mux.HandleFunc("/api/v1/admin/settings", admin(srv.settingsEndpoint))
	mux.HandleFunc("/api/v1/admin/calendar", admin(srv.adminCalendar))
	mux.HandleFunc("/api/v1/media/", srv.mediaContent)
	return withRequestID(withCORS(mux))
}

func checkDatabaseReadiness(ctx context.Context, db *sql.DB) error {
	var exists bool
	if err := db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM schema_migrations)`).Scan(&exists); err != nil {
		return fmt.Errorf("迁移状态不可用")
	}
	if !exists {
		return fmt.Errorf("数据库迁移未完成")
	}
	var current, expected string
	if err := db.QueryRowContext(ctx, `SELECT COALESCE(max(version),'') FROM schema_migrations`).Scan(&current); err != nil {
		return fmt.Errorf("迁移版本不可用")
	}
	expected = latestMigrationVersion()
	if expected != "" && current != expected {
		return fmt.Errorf("数据库迁移版本落后")
	}
	if err := db.QueryRowContext(ctx, `SELECT 1 FROM jobs LIMIT 1`).Scan(new(int)); err != nil && err != sql.ErrNoRows {
		return fmt.Errorf("任务队列不可用")
	}
	return nil
}

func checkWritableDirectory(root string) error {
	if err := os.MkdirAll(root, 0750); err != nil {
		return fmt.Errorf("目录不可用: %s", root)
	}
	f, err := os.CreateTemp(root, ".readiness-")
	if err != nil {
		return fmt.Errorf("目录不可写: %s", root)
	}
	name := f.Name()
	if _, err := io.WriteString(f, "ready"); err != nil {
		_ = f.Close()
		_ = os.Remove(name)
		return fmt.Errorf("目录不可写: %s", root)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(name)
		return fmt.Errorf("目录不可写: %s", root)
	}
	_ = os.Remove(name)
	return nil
}

// adminAuth protects every /admin endpoint. Persistent stores use the database
// session as the source of truth; memory mode keeps the same semantics for
// local tests and development.
func (srv *Server) adminAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet || r.Method == http.MethodHead {
			if srv.store.persistent && srv.store.database != nil {
				if !srv.authenticatedPersistent(r) {
					problem(w, http.StatusUnauthorized, "需要登录")
					return
				}
			} else if !srv.store.authenticated(r) {
				problem(w, http.StatusUnauthorized, "需要登录")
				return
			}
		} else if !srv.checkMutation(w, r) {
			return
		}
		next(w, r)
	}
}

func (srv *Server) persistentUserID(r *http.Request) (string, error) {
	c, err := r.Cookie("timeline_session")
	if err != nil || c.Value == "" {
		return "", fmt.Errorf("session cookie missing")
	}
	var userID string
	err = srv.store.database.QueryRowContext(r.Context(), `SELECT user_id::text FROM sessions WHERE token_hash=$1 AND revoked_at IS NULL AND idle_expires>now() AND absolute_expires>now()`, tokenHash(c.Value)).Scan(&userID)
	return userID, err
}

func (srv *Server) requirePersistent(w http.ResponseWriter) bool {
	if srv.store.persistent && srv.store.database != nil {
		return true
	}
	problem(w, http.StatusServiceUnavailable, "数据库未配置；此接口不支持内存模式")
	return false
}

func (srv *Server) authenticatedPersistent(r *http.Request) bool {
	c, err := r.Cookie("timeline_session")
	if err != nil || c.Value == "" || srv.store.database == nil {
		return false
	}
	var id string
	err = srv.store.database.QueryRowContext(r.Context(), `UPDATE sessions SET last_seen=now(), idle_expires=LEAST(idle_expires + interval '30 days', absolute_expires) WHERE token_hash=$1 AND revoked_at IS NULL AND idle_expires>now() AND absolute_expires>now() RETURNING id::text`, tokenHash(c.Value)).Scan(&id)
	return err == nil && id != ""
}

func (srv *Server) checkMutation(w http.ResponseWriter, r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin != "" && origin != getenv("APP_ORIGIN", "http://localhost:3000") && origin != "http://127.0.0.1:3000" {
		problem(w, http.StatusForbidden, "来源不被允许")
		return false
	}
	if srv.store.persistent && srv.store.database != nil {
		if !srv.authenticatedPersistent(r) {
			problem(w, http.StatusUnauthorized, "需要登录")
			return false
		}
		c, _ := r.Cookie("timeline_session")
		var csrfHash string
		if err := srv.store.database.QueryRowContext(r.Context(), `SELECT csrf_token_hash FROM sessions WHERE token_hash=$1 AND revoked_at IS NULL`, tokenHash(c.Value)).Scan(&csrfHash); err != nil || csrfHash != tokenHash(r.Header.Get("X-CSRF-Token")) {
			problem(w, http.StatusForbidden, "CSRF 校验失败")
			return false
		}
		return true
	}
	if !srv.store.authenticated(r) {
		problem(w, http.StatusUnauthorized, "需要登录")
		return false
	}
	c, _ := r.Cookie("timeline_session")
	srv.store.mu.RLock()
	ss := srv.store.sessions[tokenHash(c.Value)]
	srv.store.mu.RUnlock()
	valid := ss != nil && r.Header.Get("X-CSRF-Token") != "" && r.Header.Get("X-CSRF-Token") == ss.CSRFToken
	if srv.store.persistent && srv.store.database != nil {
		var hash string
		err := srv.store.database.QueryRowContext(r.Context(), `SELECT csrf_token_hash FROM sessions WHERE token_hash=$1 AND revoked_at IS NULL AND idle_expires>now() AND absolute_expires>now()`, tokenHash(c.Value)).Scan(&hash)
		valid = err == nil && hash == tokenHash(r.Header.Get("X-CSRF-Token"))
	}
	if !valid {
		problem(w, http.StatusForbidden, "CSRF 校验失败")
		return false
	}
	return true
}

func withRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if id == "" {
			id = "req_" + randomToken()[:12]
		}
		w.Header().Set("X-Request-ID", id)
		next.ServeHTTP(w, r)
	})
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Vary", "Origin")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'")
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		if os.Getenv("APP_ENV") == "production" {
			w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		origin := r.Header.Get("Origin")
		configuredOrigin := getenv("APP_ORIGIN", "http://localhost:3000")
		if origin == configuredOrigin || origin == "http://localhost:3000" || origin == "http://127.0.0.1:3000" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token, Idempotency-Key, X-Request-ID")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			if origin != configuredOrigin && origin != "http://localhost:3000" && origin != "http://127.0.0.1:3000" {
				problem(w, http.StatusForbidden, "来源不被允许")
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (srv *Server) requireAuth(w http.ResponseWriter, r *http.Request) bool {
	if !srv.store.authenticated(r) {
		problem(w, 401, "需要登录")
		return false
	}
	return true
}
