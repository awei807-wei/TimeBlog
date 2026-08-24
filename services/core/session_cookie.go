package main

import (
	"errors"
	"net"
	"net/http"
	"os"
	"strings"
)

const (
	secureSessionCookieName = "__Host-timeline_session"
	legacySessionCookieName = "timeline_session"
)

func sessionCookieName(secure bool) string {
	if secure {
		return secureSessionCookieName
	}
	return legacySessionCookieName
}

func requestPeerIP(r *http.Request) string {
	if r == nil {
		return ""
	}
	remote := strings.TrimSpace(r.RemoteAddr)
	if host, _, err := net.SplitHostPort(remote); err == nil {
		remote = host
	}
	return strings.Trim(strings.TrimSpace(remote), "[]")
}

func sessionCookieSecure(r *http.Request) bool {
	if strings.EqualFold(strings.TrimSpace(os.Getenv("APP_ENV")), "production") {
		return true
	}
	if strings.EqualFold(strings.TrimSpace(os.Getenv("SESSION_COOKIE_SECURE")), "true") {
		return true
	}
	if r != nil && r.TLS != nil {
		return true
	}
	if r != nil && trustedProxy(requestPeerIP(r)) {
		forwardedProto := strings.TrimSpace(strings.SplitN(r.Header.Get("X-Forwarded-Proto"), ",", 2)[0])
		return strings.EqualFold(forwardedProto, "https")
	}
	return false
}

func writeSessionCookie(w http.ResponseWriter, r *http.Request, token string) {
	secure := sessionCookieSecure(r)
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName(secure),
		Value:    token,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		Path:     "/",
		MaxAge:   90 * 24 * 3600,
	})
}

func clearSessionCookies(w http.ResponseWriter, r *http.Request) {
	// A __Host- cookie must always be cleared with Secure and Path=/, even if
	// the current request is an HTTP development request.
	http.SetCookie(w, &http.Cookie{
		Name:     secureSessionCookieName,
		MaxAge:   -1,
		Path:     "/",
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	})
	http.SetCookie(w, &http.Cookie{
		Name:     legacySessionCookieName,
		MaxAge:   -1,
		Path:     "/",
		HttpOnly: true,
		Secure:   sessionCookieSecure(r),
		SameSite: http.SameSiteLaxMode,
	})
}

func requestSessionCookie(r *http.Request) (*http.Cookie, error) {
	if r == nil {
		return nil, http.ErrNoCookie
	}
	var lastErr error = http.ErrNoCookie
	for _, name := range []string{secureSessionCookieName, legacySessionCookieName} {
		cookie, err := r.Cookie(name)
		if err == nil && cookie.Value != "" {
			return cookie, nil
		}
		if err != nil && !errors.Is(err, http.ErrNoCookie) {
			lastErr = err
		} else if err == nil {
			lastErr = http.ErrNoCookie
		}
	}
	return nil, lastErr
}
