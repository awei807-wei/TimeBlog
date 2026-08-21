package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"github.com/pquerna/otp/totp"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

func throttleAccountStage(account string) (string, string) {
	account = strings.ToLower(strings.TrimSpace(account))
	if strings.HasSuffix(account, "-totp") {
		return strings.TrimSuffix(account, "-totp"), "totp"
	}
	if strings.HasSuffix(account, "-recovery") {
		return strings.TrimSuffix(account, "-recovery"), "recovery"
	}
	return account, "password"
}

func requestRemoteIP(r *http.Request) string {
	remote := r.RemoteAddr
	if host, _, err := net.SplitHostPort(remote); err == nil {
		remote = host
	}
	remote = strings.TrimSpace(strings.Trim(remote, "[]"))
	if !trustedProxy(remote) {
		return remote
	}
	for _, value := range strings.Split(r.Header.Get("X-Forwarded-For"), ",") {
		candidate := strings.TrimSpace(value)
		if net.ParseIP(candidate) != nil {
			return candidate
		}
	}
	return remote
}

func trustedProxy(remote string) bool {
	ip := net.ParseIP(remote)
	if ip == nil {
		return false
	}
	for _, raw := range strings.Split(os.Getenv("TRUSTED_PROXY_CIDRS"), ",") {
		_, network, err := net.ParseCIDR(strings.TrimSpace(raw))
		if err == nil && network.Contains(ip) {
			return true
		}
	}
	return false
}

func loginThrottleKey(r *http.Request, account string) string {
	base, stage := throttleAccountStage(account)
	sum := sha256.Sum256([]byte(base + "|" + requestRemoteIP(r) + "|" + stage))
	return hex.EncodeToString(sum[:])
}

func (srv *Server) throttleAllows(r *http.Request, account string) bool {
	if srv.store.persistent && srv.store.database != nil {
		base, stage := throttleAccountStage(account)
		accountHash := hashLoginField(base)
		ipHash := hashLoginField(requestRemoteIP(r))
		var blocked sql.NullTime
		err := srv.store.database.QueryRowContext(r.Context(), `SELECT blocked_until FROM login_attempts WHERE account_hash=$1 AND ip_hash=$2 AND stage=$3`, accountHash, ipHash, stage).Scan(&blocked)
		if err != nil && err != sql.ErrNoRows {
			return false
		}
		return err == sql.ErrNoRows || !blocked.Valid || !time.Now().Before(blocked.Time)
	}
	key := loginThrottleKey(r, account)
	srv.store.mu.Lock()
	defer srv.store.mu.Unlock()
	state := srv.store.loginThrottle[key]
	if time.Now().Before(state.Until) {
		return false
	}
	return true
}

func (srv *Server) throttleFailure(r *http.Request, account string) {
	if srv.store.persistent && srv.store.database != nil {
		base, stage := throttleAccountStage(account)
		if _, err := srv.store.database.ExecContext(r.Context(), `
			INSERT INTO login_attempts(account_hash,ip_hash,stage,failures,blocked_until,updated_at)
			VALUES($1,$2,$3,1,CASE WHEN 1 >= 5 THEN now()+interval '30 seconds' ELSE NULL END,now())
			ON CONFLICT(account_hash,ip_hash,stage) DO UPDATE SET
				failures=login_attempts.failures+1,
				blocked_until=CASE WHEN login_attempts.failures+1 >= 5 THEN now()+interval '30 seconds' ELSE login_attempts.blocked_until END,
				updated_at=now()`, hashLoginField(base), hashLoginField(requestRemoteIP(r)), stage); err != nil {
			log.Printf("auth throttle failure update stage=%s: %v", stage, err)
		}
		return
	}
	key := loginThrottleKey(r, account)
	srv.store.mu.Lock()
	defer srv.store.mu.Unlock()
	state := srv.store.loginThrottle[key]
	state.Failures++
	if state.Failures >= 5 {
		backoff := time.Duration(1<<minInt(state.Failures-5, 5)) * time.Second
		state.Until = time.Now().Add(backoff)
	}
	srv.store.loginThrottle[key] = state
}

func (srv *Server) throttleSuccess(r *http.Request, account string) {
	if srv.store.persistent && srv.store.database != nil {
		base, stage := throttleAccountStage(account)
		if _, err := srv.store.database.ExecContext(r.Context(), `DELETE FROM login_attempts WHERE account_hash=$1 AND ip_hash=$2 AND stage=$3`, hashLoginField(base), hashLoginField(requestRemoteIP(r)), stage); err != nil {
			log.Printf("auth throttle success reset stage=%s: %v", stage, err)
		}
		return
	}
	key := loginThrottleKey(r, account)
	srv.store.mu.Lock()
	delete(srv.store.loginThrottle, key)
	srv.store.mu.Unlock()
}

func hashLoginField(value string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(value))))
	return hex.EncodeToString(sum[:])
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func (srv *Server) loginPassword(w http.ResponseWriter, r *http.Request) {
	if !srv.throttleAllows(r, "owner") {
		w.Header().Set("Retry-After", "30")
		problem(w, http.StatusTooManyRequests, "登录失败次数过多，请稍后重试")
		return
	}
	var in struct {
		Password string `json:"password"`
	}
	if decode(r, &in) != nil {
		problem(w, 401, "密码错误")
		return
	}
	if srv.store.persistent && srv.store.database != nil {
		var encoded string
		if err := srv.store.database.QueryRowContext(r.Context(), `SELECT password_hash FROM users WHERE username='owner'`).Scan(&encoded); err != nil || !verifyPassword(in.Password, encoded) {
			srv.throttleFailure(r, "owner")
			problem(w, http.StatusUnauthorized, "密码错误")
			return
		}
	} else if srv.store.userPassword == "" || in.Password != srv.store.userPassword {
		srv.throttleFailure(r, "owner")
		problem(w, 401, "密码错误")
		return
	}
	srv.throttleSuccess(r, "owner")
	challenge := randomToken()
	expiresAt := time.Now().Add(5 * time.Minute)
	if srv.store.persistent && srv.store.database != nil {
		if err := persistChallenge(r.Context(), srv.store.database, challenge, expiresAt); err != nil {
			problem(w, 500, "MFA challenge 创建失败")
			return
		}
	} else {
		srv.store.mu.Lock()
		srv.store.mfaChallenges[challenge] = expiresAt
		srv.store.mu.Unlock()
	}
	jsonResponse(w, 200, map[string]any{"challenge": challenge, "requiresTotp": true})
}

func (srv *Server) loginTOTP(w http.ResponseWriter, r *http.Request) {
	if !srv.throttleAllows(r, "owner-totp") {
		w.Header().Set("Retry-After", "30")
		problem(w, http.StatusTooManyRequests, "登录失败次数过多，请稍后重试")
		return
	}
	var in struct {
		Code      string `json:"code"`
		Challenge string `json:"challenge"`
	}
	if decode(r, &in) != nil {
		problem(w, 401, "验证码错误")
		return
	}
	ok := false
	var err error
	if srv.store.persistent && srv.store.database != nil {
		ok, err = challengeValid(r.Context(), srv.store.database, in.Challenge)
		if err != nil {
			ok = false
		}
	} else {
		srv.store.mu.Lock()
		expires, exists := srv.store.mfaChallenges[in.Challenge]
		srv.store.mu.Unlock()
		ok = exists && time.Now().Before(expires)
	}
	if !ok {
		srv.throttleFailure(r, "owner-totp")
		problem(w, http.StatusUnauthorized, "MFA challenge 无效或已过期")
		return
	}
	validCode := false
	if srv.store.persistent && srv.store.database != nil {
		var secret string
		if err := srv.store.database.QueryRowContext(r.Context(), `SELECT totp_secret_encrypted FROM users WHERE username='owner'`).Scan(&secret); err == nil {
			if plain, err := decryptSecret(secret); err == nil {
				validCode = totp.Validate(in.Code, plain)
			}
		}
	} else {
		validCode = srv.store.userTOTP != "" && totp.Validate(in.Code, srv.store.userTOTP)
	}
	if !validCode {
		srv.throttleFailure(r, "owner-totp")
		problem(w, http.StatusUnauthorized, "验证码错误")
		return
	}
	// Consume the challenge only after TOTP validation. This keeps a challenge
	// usable after a mistyped code while retaining one-time replay protection.
	if srv.store.persistent && srv.store.database != nil {
		ok, err = consumeChallenge(r.Context(), srv.store.database, in.Challenge)
	} else {
		srv.store.mu.Lock()
		expires, exists := srv.store.mfaChallenges[in.Challenge]
		if exists && time.Now().Before(expires) {
			delete(srv.store.mfaChallenges, in.Challenge)
			ok = true
		} else {
			ok = false
		}
		srv.store.mu.Unlock()
	}
	if err != nil || !ok {
		srv.throttleFailure(r, "owner-totp")
		problem(w, http.StatusUnauthorized, "MFA challenge 无效或已过期")
		return
	}
	srv.throttleSuccess(r, "owner-totp")
	token := randomToken()
	now := time.Now()
	// Bind the CSRF token to the session cookie with a server-only key.  The
	// value is stable for the lifetime of this session, so parallel page reads
	// cannot invalidate a mutation request that already captured the token.
	csrf := csrfToken(srv.store.csrfKey, token)
	if srv.store.persistent && srv.store.database != nil {
		var uid string
		if err := srv.store.database.QueryRowContext(r.Context(), `SELECT id::text FROM users WHERE username='owner'`).Scan(&uid); err != nil {
			problem(w, 500, "用户不存在")
			return
		}
		_, err := srv.store.database.ExecContext(r.Context(), `INSERT INTO sessions(id,user_id,token_hash,csrf_token_hash,last_seen,idle_expires,absolute_expires) VALUES(gen_random_uuid(),$1::uuid,$2,$3,$4,$5,$6)`, uid, tokenHash(token), tokenHash(csrf), now, now.Add(30*24*time.Hour), now.Add(90*24*time.Hour))
		if err != nil {
			problem(w, 500, "会话创建失败")
			return
		}
	} else {
		srv.store.mu.Lock()
		srv.store.sessions[tokenHash(token)] = &Session{ID: newID(), TokenHash: tokenHash(token), CreatedAt: now, LastSeen: now, IdleExpires: now.Add(30 * 24 * time.Hour), AbsoluteExpires: now.Add(90 * 24 * time.Hour), CSRFToken: csrf}
		srv.store.mu.Unlock()
	}
	secure := os.Getenv("APP_ENV") == "production"
	http.SetCookie(w, &http.Cookie{Name: "timeline_session", Value: token, HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode, Path: "/", MaxAge: 90 * 24 * 3600})
	jsonResponse(w, 200, map[string]any{"authenticated": true, "csrfToken": csrf})
}

func (srv *Server) logout(w http.ResponseWriter, r *http.Request) {
	if !srv.checkMutation(w, r) {
		return
	}
	if c, err := r.Cookie("timeline_session"); err == nil {
		if srv.store.persistent && srv.store.database != nil {
			res, err := srv.store.database.ExecContext(r.Context(), `UPDATE sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL`, tokenHash(c.Value))
			if err != nil {
				problem(w, 500, "注销失败")
				return
			}
			if n, _ := res.RowsAffected(); n != 1 {
				problem(w, 401, "未登录")
				return
			}
		}
		srv.store.mu.Lock()
		if ss := srv.store.sessions[tokenHash(c.Value)]; ss != nil {
			t := time.Now()
			ss.RevokedAt = &t
		}
		srv.store.mu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{Name: "timeline_session", MaxAge: -1, Path: "/", HttpOnly: true, Secure: os.Getenv("APP_ENV") == "production", SameSite: http.SameSiteLaxMode})
	jsonResponse(w, 200, map[string]bool{"ok": true})
}

func (srv *Server) authSession(w http.ResponseWriter, r *http.Request) {
	if srv.store.persistent && srv.store.database != nil {
		if !srv.authenticatedPersistent(r) {
			problem(w, 401, "未登录")
			return
		}
		c, _ := r.Cookie("timeline_session")
		csrf := csrfToken(srv.store.csrfKey, c.Value)
		if _, err := srv.store.database.ExecContext(r.Context(), `UPDATE sessions SET csrf_token_hash=$1 WHERE token_hash=$2`, tokenHash(csrf), tokenHash(c.Value)); err != nil {
			problem(w, 500, "CSRF token 同步失败")
			return
		}
		var idle, absolute time.Time
		if err := srv.store.database.QueryRowContext(r.Context(), `SELECT idle_expires,absolute_expires FROM sessions WHERE token_hash=$1`, tokenHash(c.Value)).Scan(&idle, &absolute); err != nil {
			problem(w, 401, "未登录")
			return
		}
		jsonResponse(w, 200, map[string]any{"authenticated": true, "username": "owner", "csrfToken": csrf, "idleExpiresAt": idle, "absoluteExpiresAt": absolute})
		return
	}
	if !srv.store.authenticated(r) {
		problem(w, 401, "未登录")
		return
	}
	c, _ := r.Cookie("timeline_session")
	srv.store.mu.RLock()
	csrf := csrfToken(srv.store.csrfKey, c.Value)
	srv.store.mu.RUnlock()
	jsonResponse(w, 200, map[string]any{"authenticated": true, "username": "owner", "idleExpiresInDays": 30, "absoluteExpiresInDays": 90, "csrfToken": csrf})
}

// authSessionStatus validates the HttpOnly session cookie without rotating
// the CSRF token. Navigation can safely call this endpoint without racing
// with page mutations that use /auth/session for their CSRF token.
func (srv *Server) authSessionStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store, max-age=0")
	var cookie *http.Cookie
	var err error
	if cookie, err = r.Cookie("timeline_session"); err != nil || cookie.Value == "" {
		problem(w, http.StatusUnauthorized, "未登录")
		return
	}
	if srv.store.persistent && srv.store.database != nil {
		if !srv.authenticatedPersistent(r) {
			problem(w, http.StatusUnauthorized, "未登录")
			return
		}
	} else if !srv.store.authenticated(r) {
		problem(w, http.StatusUnauthorized, "未登录")
		return
	}
	csrf := csrfToken(srv.store.csrfKey, cookie.Value)
	if srv.store.persistent && srv.store.database != nil {
		// Keep legacy sessions created before deterministic CSRF tokens were
		// introduced usable while converging them to the stable token exactly
		// once.  Repeating this idempotent update is safe under concurrency.
		if _, err := srv.store.database.ExecContext(r.Context(), `UPDATE sessions SET csrf_token_hash=$1 WHERE token_hash=$2 AND revoked_at IS NULL`, tokenHash(csrf), tokenHash(cookie.Value)); err != nil {
			problem(w, http.StatusInternalServerError, "CSRF token 同步失败")
			return
		}
	}
	jsonResponse(w, http.StatusOK, map[string]any{"authenticated": true, "username": "owner", "csrfToken": csrf})
}

func (srv *Server) authSessions(w http.ResponseWriter, r *http.Request) {
	if srv.store.persistent && srv.store.database != nil {
		if !srv.authenticatedPersistent(r) {
			problem(w, 401, "未登录")
			return
		}
		rows, err := srv.store.database.QueryContext(r.Context(), `SELECT id::text,created_at,last_seen FROM sessions WHERE revoked_at IS NULL ORDER BY last_seen DESC`)
		if err != nil {
			problem(w, 500, "读取会话失败")
			return
		}
		defer rows.Close()
		out := []any{}
		for rows.Next() {
			var id string
			var created, last time.Time
			if err := rows.Scan(&id, &created, &last); err != nil {
				problem(w, 500, "读取会话失败")
				return
			}
			out = append(out, map[string]any{"id": id, "createdAt": created, "lastSeen": last})
		}
		jsonResponse(w, 200, map[string]any{"sessions": out})
		return
	}
	if !srv.store.authenticated(r) {
		problem(w, 401, "未登录")
		return
	}
	srv.store.mu.RLock()
	defer srv.store.mu.RUnlock()
	out := []any{}
	for _, ss := range srv.store.sessions {
		if ss.RevokedAt == nil {
			out = append(out, map[string]any{"id": ss.ID, "createdAt": ss.CreatedAt, "lastSeen": ss.LastSeen})
		}
	}
	jsonResponse(w, 200, map[string]any{"sessions": out})
}

func (srv *Server) authSessionAction(w http.ResponseWriter, r *http.Request) {
	if !srv.checkMutation(w, r) {
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/auth/sessions/")
	if path == "revoke-others" {
		c, _ := r.Cookie("timeline_session")
		if srv.store.persistent && srv.store.database != nil {
			if _, err := srv.store.database.ExecContext(r.Context(), `UPDATE sessions SET revoked_at=now() WHERE token_hash<>$1 AND revoked_at IS NULL`, tokenHash(c.Value)); err != nil {
				problem(w, 500, "会话撤销失败")
				return
			}
			jsonResponse(w, 200, map[string]bool{"ok": true})
			return
		}
		jsonResponse(w, 200, map[string]bool{"ok": true})
		return
	}
	if srv.store.persistent && srv.store.database != nil {
		res, err := srv.store.database.ExecContext(r.Context(), `UPDATE sessions SET revoked_at=now() WHERE id=$1::uuid AND revoked_at IS NULL`, path)
		if err != nil {
			problem(w, 404, "会话不存在")
			return
		}
		if n, _ := res.RowsAffected(); n != 1 {
			problem(w, 404, "会话不存在")
			return
		}
		jsonResponse(w, 200, map[string]bool{"ok": true})
		return
	}
	problem(w, 501, "内存模式不支持会话撤销")
}
