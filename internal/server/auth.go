package server

// auth.go — thin compat shim during the Phase-1/2 cutover.
//
// The legacy HMAC cookie flow is retired and no longer accepted as an
// authentication signal. A small amount of signing code remains only so tests
// can construct an old-format cookie and prove it is rejected.

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"net/http"
	"strings"
	"time"
)

const sessionCookieName = "floffi_session"

type AuthConfig struct {
	Username string
	Password string
	Secret   string
}

func DefaultAuthConfig() AuthConfig {
	return AuthConfig{}
}

func (c AuthConfig) withDefaults() AuthConfig {
	return c
}

func (c AuthConfig) validCredentials(username, password string) bool {
	return subtle.ConstantTimeCompare([]byte(c.Username), []byte(username)) == 1 &&
		subtle.ConstantTimeCompare([]byte(c.Password), []byte(password)) == 1
}

func (c AuthConfig) signedValue(username string) string {
	mac := hmac.New(sha256.New, []byte(c.Secret))
	mac.Write([]byte(username))
	sum := mac.Sum(nil)
	return username + ":" + base64.RawURLEncoding.EncodeToString(sum)
}

func (c AuthConfig) authenticated(r *http.Request) bool {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil {
		return false
	}

	parts := strings.Split(cookie.Value, ":")
	if len(parts) != 2 {
		return false
	}

	if subtle.ConstantTimeCompare([]byte(parts[0]), []byte(c.Username)) != 1 {
		return false
	}

	expected := c.signedValue(parts[0])
	return subtle.ConstantTimeCompare([]byte(expected), []byte(cookie.Value)) == 1
}

func (c AuthConfig) setSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    c.signedValue(c.Username),
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int((12 * time.Hour).Seconds()),
	})
}

func clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}

// authed validates the request against the new JWT access cookie. The
// legacy HMAC `floffi_session` cookie is NO LONGER honored as an
// authentication signal — it provided no server-side revocation, which
// silently defeated the single_session toggle. Any caller still
// shipping the old cookie has to re-authenticate via /api/auth/login.
func (s *Server) authed(r *http.Request) bool {
	if s.authHandler == nil {
		return false
	}
	_, _, err := s.authHandler.Authenticate(r)
	return err == nil
}

// requireAuth wraps a handler so any request without a valid auth cookie
// is rejected with 401 JSON. Used by handlers that want middleware-style
// composition instead of an inline guard.
func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.authed(r) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
			return
		}
		next.ServeHTTP(w, r)
	})
}
