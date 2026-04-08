package server

import (
	"encoding/json"
	"net/http"
)

func (s *Server) handleLoginPage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if s.authed(r) {
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}

	s.serveAppShell(w, r)
}

// handleInvitePage — /invite?token=… 진입점. 인증 여부와 무관하게 SPA
// 셸을 반환해서 프론트(InviteAcceptView) 가 토큰 처리 + (필요시) 로그인
// 유도를 책임지게 한다. /login 처럼 인증된 사용자를 강제 redirect 하면
// query string 의 토큰이 누락되므로 redirect 하지 않는다.
func (s *Server) handleInvitePage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.serveAppShell(w, r)
}

// handleAPILogin used to issue a stateless HMAC `floffi_session` cookie.
// It's now retired because that cookie format had no server-side revocation,
// which let it silently bypass the single_session toggle. Callers should hit
// /api/auth/login instead.
func (s *Server) handleAPILogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// Clear any stale legacy cookie the caller might still be carrying.
	clearSessionCookie(w)
	writeJSON(w, http.StatusGone, map[string]any{
		"error":       "endpoint_retired",
		"replacement": "/api/auth/login",
		"message":     "Legacy /api/login was removed because its cookie format had no server-side revocation. Use /api/auth/login.",
	})
}

func (s *Server) handleAPILogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	clearSessionCookie(w)
	writeJSON(w, http.StatusOK, map[string]any{
		"authenticated": false,
	})
}

func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	authenticated := s.authed(r)
	username := ""
	if authenticated && s.authHandler != nil {
		if u, _, err := s.authHandler.Authenticate(r); err == nil && u != nil {
			username = u.Username
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"authenticated": authenticated,
		"username":      username,
	})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
