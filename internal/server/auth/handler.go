package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Cookie names. Exported so the outer server package can clear them on
// signup edge cases (e.g. legacy floffi_session cookie cleanup).
//
// LegacyHMACCookieName mirrors the const in internal/server/auth.go for
// the retired stateless cookie. Every time we issue or clear modern
// session cookies we also clear this one so a brand-new login on a
// machine that has been hanging onto the old cookie since before the
// cutover can't keep using it. Duplicated (rather than imported) to
// avoid an import cycle with the outer server package.
const (
	AccessCookieName     = "floffi_at"
	RefreshCookieName    = "floffi_rt"
	LegacyHMACCookieName = "floffi_session"
)

// Handler bundles the auth routes. It's mounted by the outer server under
// /api/auth/.
type Handler struct {
	Store *Store
	// Email sender. nil falls back to StdoutSender so tests / fresh dev
	// checkouts still exercise the verify/reset flows without env vars.
	Email EmailSender
	// PublicBaseURL is used to build user-facing links in emails. nil/""
	// falls back to PublicBaseURL() via env.
	PublicBaseURL string
	// Issuer for otpauth URIs. Defaults to "floffi".
	TOTPIssuer string

	// Rate limiters. nil disables enforcement for that scope, which the
	// test handlers exploit so they don't have to thread a wall clock
	// through every request. Real callers go through NewHandler which
	// wires all four up.
	LoginIPLimiter       *RateLimiter // 1m / 10 — IP-level burst on /login
	LoginAcctFailLimiter *RateLimiter // 15m / 5 — per-account, only on FAILED login (success resets)
	SignupIPLimiter      *RateLimiter // 1h / 5 — anti account-spam
	RefreshIPLimiter     *RateLimiter // 1m / 60 — guards refresh storm bugs
	CheckEmailIPLimiter  *RateLimiter // 1m / 60 — gated for signup-form email availability lookup

	// OnSessionRevoked, when set, is invoked synchronously right after
	// the auth handler runs RevokeAllUserSessions for `userID`. The
	// outer server wires this to its SSE broadcaster so any live
	// stream owned by that user gets pushed a session-revoked event
	// in the same tick the new login completes — 0s latency vs. the
	// SSE heartbeat fallback's ~30s. Best-effort: callback errors /
	// panics must not block the auth flow, so the call site wraps it.
	OnSessionRevoked func(userID string)

	// OnUserSignedUp, when set, fires right after a successful signup
	// (user row inserted, session minted). The outer server wires this
	// to bootstrapping a fresh workspace for the new account so the
	// switcher UI is non-empty on first login. The callback is invoked
	// synchronously but errors / panics must not roll back the signup
	// — the call site wraps it in a recover and logs the error.
	OnUserSignedUp func(userID string)

	// emailWG tracks in-flight background email sends spawned via
	// sendEmailAsync. Tests call WaitEmail() to synchronize before
	// asserting on a captureEmailSender; production code can call it
	// during graceful shutdown if it wants to drain pending mails.
	emailWG sync.WaitGroup
}

// WaitEmail blocks until every background email send started via
// sendEmailAsync has completed. Used by tests that capture mails into
// an in-memory sender — without this they'd race the goroutine.
func (h *Handler) WaitEmail() { h.emailWG.Wait() }

func NewHandler(store *Store) *Handler {
	return &Handler{
		Store:         store,
		Email:         SenderFromEnv(),
		PublicBaseURL: PublicBaseURL(),
		TOTPIssuer:    "floffi",
		// Window/cap rationale documented in docs/auth-policy.md §13.
		LoginIPLimiter:       NewRateLimiter(1*time.Minute, 10),
		LoginAcctFailLimiter: NewRateLimiter(15*time.Minute, 5),
		SignupIPLimiter:      NewRateLimiter(1*time.Hour, 5),
		RefreshIPLimiter:     NewRateLimiter(1*time.Minute, 60),
		// check-email is fired on every debounce of the signup email
		// input, so it needs a much higher ceiling than /signup itself.
		// 1m / 60 is enough headroom for normal typing without inviting
		// an enumeration scraper to harvest the user table.
		CheckEmailIPLimiter: NewRateLimiter(1*time.Minute, 60),
	}
}

// StartRateLimitGC runs a periodic prune of the limiter maps so a steady
// trickle of distinct IPs can't pin memory forever. Returns when ctx is
// done. Real callers wire this into the server lifecycle; tests can
// skip it entirely — Allow() prunes its own key on every call so the
// loop is purely a memory-bound safeguard, not correctness.
func (h *Handler) StartRateLimitGC(ctx context.Context) {
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()
	limiters := []*RateLimiter{h.LoginIPLimiter, h.LoginAcctFailLimiter, h.SignupIPLimiter, h.RefreshIPLimiter, h.CheckEmailIPLimiter}
	for {
		select {
		case <-t.C:
			for _, rl := range limiters {
				if rl != nil {
					rl.GC()
				}
			}
		case <-ctx.Done():
			return
		}
	}
}

// rateLimit429 writes a 429 response and records an audit row. userID may
// be empty when we don't know the account yet (pre-lookup IP throttle).
// Best-effort audit — never blocks the response.
func (h *Handler) rateLimit429(w http.ResponseWriter, r *http.Request, userID, scope, route string) {
	w.Header().Set("Retry-After", "60")
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	_ = h.Store.LogAuditEvent(ctx, userID, "rate_limited", clientIP(r), r.UserAgent(),
		fmt.Sprintf("route=%s scope=%s", route, scope))
	writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "rate_limited", "scope": scope})
}

func (h *Handler) emailSender() EmailSender {
	if h.Email != nil {
		return h.Email
	}
	return StdoutSender{}
}

// sendEmailAsync dispatches a notification email in the background so the
// caller can return its HTTP response immediately. Use this for emails
// that are side-channel notifications (reset link, new-device alert,
// kick notification) where blocking the request on SMTP latency adds no
// user value and risks hanging the request when the relay misbehaves.
// Errors are logged with a tag so they're greppable, not silently
// dropped — that was the prior "_ = ...Send()" smell.
//
// Do NOT use this for the verify-email-resend flow: that handler maps
// Send errors to a 5xx so the user can retry, which requires a sync
// call. sendEmailAsync is for fire-and-forget paths only.
func (h *Handler) sendEmailAsync(tag, to, subject, body string) {
	sender := h.emailSender()
	h.emailWG.Add(1)
	go func() {
		defer h.emailWG.Done()
		// Independent context — we explicitly want the send to outlive
		// the HTTP request, but with its own ceiling so a stuck relay
		// doesn't leak a goroutine forever. The SMTPSender ignores
		// the ctx for the dial itself (net/smtp limitation) and uses
		// smtpDialTimeout there; this ceiling is the belt to that
		// suspenders, covering future ctx-aware senders.
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := sender.Send(ctx, to, subject, body); err != nil {
			log.Printf("email send failed [%s] to=%s: %v", tag, to, err)
		}
	}()
}

func (h *Handler) baseURL() string {
	if h.PublicBaseURL != "" {
		return h.PublicBaseURL
	}
	return PublicBaseURL()
}

func (h *Handler) totpIssuer() string {
	if h.TOTPIssuer != "" {
		return h.TOTPIssuer
	}
	return "floffi"
}

// Mount registers all /api/auth/* routes on the given mux. The mux is
// expected to already strip the /api/auth prefix, so we register on bare
// subpaths.
func (h *Handler) Mount(mux *http.ServeMux) {
	mux.HandleFunc("/api/auth/signup", h.handleSignup)
	// 가입 폼에서 이메일 입력 즉시 사용 가능 여부 확인용. IP 기반 rate-limit
	// 은 signup limiter 와 별도 — 키 입력마다 호출되므로 더 관대해야 한다.
	mux.HandleFunc("/api/auth/check-email", h.handleCheckEmail)
	mux.HandleFunc("/api/auth/login", h.handleLogin)
	mux.HandleFunc("/api/auth/refresh", h.handleRefresh)
	mux.HandleFunc("/api/auth/logout", h.handleLogout)
	mux.HandleFunc("/api/auth/session", h.handleSession)
	// Phase 7 — user-editable nickname (displayed in topbar, distinct from
	// workspace.displayName which feeds the LLM honorific).
	mux.HandleFunc("/api/auth/profile/nickname", h.handleUpdateNickname)
	// Avatar override (single emoji), editable independently of nickname.
	mux.HandleFunc("/api/auth/profile/avatar", h.handleUpdateAvatar)
	// 회원 탈퇴 — 비밀번호 + (TOTP 활성 시) TOTP 코드 + "탈퇴" 타이핑 확인.
	// 즉시 hard delete, FK CASCADE 로 세션/토큰 일괄 정리.
	mux.HandleFunc("/api/auth/account/delete", h.handleDeleteAccount)
	// /sessions       — GET list of the current user's active sessions
	// /sessions/<id>/revoke — POST revoke a specific session (own)
	// /sessions/revoke-others — POST revoke all but the calling session
	// The trailing-slash subtree dispatches the last two by path suffix.
	mux.HandleFunc("/api/auth/sessions", h.handleSessions)
	mux.HandleFunc("/api/auth/sessions/", h.handleSessionsSubtree)
	mux.HandleFunc("/api/auth/security", h.handleSecurity)
	mux.HandleFunc("/api/auth/audit", h.handleAudit)

	// Phase 3 — email verification + password reset.
	mux.HandleFunc("/api/auth/verify-email/start", h.handleVerifyEmailStart)
	mux.HandleFunc("/api/auth/verify-email/complete", h.handleVerifyEmailComplete)
	mux.HandleFunc("/api/auth/reset-password/start", h.handleResetPasswordStart)
	mux.HandleFunc("/api/auth/reset-password/complete", h.handleResetPasswordComplete)

	// Phase 4 — TOTP 2FA + recovery codes.
	mux.HandleFunc("/api/auth/totp/setup", h.handleTOTPSetup)
	mux.HandleFunc("/api/auth/totp/enable", h.handleTOTPEnable)
	mux.HandleFunc("/api/auth/totp/disable", h.handleTOTPDisable)
	mux.HandleFunc("/api/auth/totp/verify", h.handleTOTPVerify)
	mux.HandleFunc("/api/auth/recovery/verify", h.handleRecoveryVerify)
	mux.HandleFunc("/api/auth/recovery/regenerate", h.handleRecoveryRegenerate)

	// Phase 6.4 — admin views.
	mux.HandleFunc("/api/auth/admin/users", h.handleAdminUsers)
	mux.HandleFunc("/api/auth/admin/users/", h.handleAdminUsersSubtree)
	mux.HandleFunc("/api/auth/admin/audit", h.handleAdminAudit)

	// Stage 1 of plan/rag-and-memory-roadmap.md — user-scoped long-term memory.
	mux.HandleFunc("/api/auth/memories", h.handleMemories)
	mux.HandleFunc("/api/auth/memories/", h.handleMemoriesSubtree)
}

// ── Validation helpers ────────────────────────────────────────────────

var (
	emailRe    = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)
	usernameRe = regexp.MustCompile(`^[a-z0-9_-]{3,32}$`)
)

// emailLocalPart returns the bit before the "@" in a normalized
// (already-lowercased + trimmed) email. Returns the whole input if
// there's no "@" — defensive only; the signup gate rejects those.
func emailLocalPart(email string) string {
	if i := strings.IndexByte(email, '@'); i > 0 {
		return email[:i]
	}
	return email
}

// generateUsernameFromEmail derives a username from the email's local
// part, sanitized to fit the [a-z0-9_-]{3,32} pattern, and resolves
// any collision with an existing row by appending a short random
// suffix. The legacy /api/login admin path + audit-log filters still
// key off `username`, so we keep the column populated.
func (h *Handler) generateUsernameFromEmail(ctx context.Context, email string) (string, error) {
	base := emailLocalPart(email)
	// Strip anything outside [a-z0-9_-]; lowercase already from the
	// caller. Common local-part punctuation like "." / "+" gets
	// turned into "-" so the result stays readable.
	var b strings.Builder
	for _, r := range base {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_', r == '-':
			b.WriteRune(r)
		case r == '.' || r == '+':
			b.WriteRune('-')
		}
	}
	clean := b.String()
	if len(clean) < 3 {
		clean = clean + "user"
	}
	if len(clean) > 28 {
		clean = clean[:28]
	}
	// Try the cleaned handle first. On collision, append a 4-char
	// random suffix and retry up to 5 times before giving up.
	candidate := clean
	for i := 0; i < 6; i++ {
		if !usernameRe.MatchString(candidate) {
			// fall through to suffix path
		} else {
			if _, err := h.Store.FindUserByUsername(ctx, candidate); err != nil {
				if errors.Is(err, ErrUserNotFound) {
					return candidate, nil
				}
				return "", err
			}
		}
		// Collision (or candidate failed regex) — append random suffix.
		buf := make([]byte, 3)
		if _, rerr := rand.Read(buf); rerr != nil {
			return "", rerr
		}
		candidate = clean + "-" + hex.EncodeToString(buf)[:4]
		if len(candidate) > 32 {
			candidate = candidate[:32]
		}
	}
	return "", errors.New("could not generate a unique username")
}

// minPasswordLen is kept as a package-local alias because it's
// referenced from existing tests; the real source of truth is now
// MinPasswordLen + the CheckPasswordStrength rules in
// password_strength.go.
const minPasswordLen = MinPasswordLen

// signupRequest is email-only as of Phase 7. The legacy `username`
// field is kept on the struct for backward compat (older clients
// might still send it) but the server ignores it — a username is
// auto-generated from the email local-part below.
type signupRequest struct {
	Email    string `json:"email"`
	Username string `json:"username,omitempty"` // ignored; auto-generated
	// Optional. Empty → server defaults to the email's local-part. The
	// length cap mirrors handleUpdateNickname so the post-signup edit
	// affordance and the gate here agree.
	Nickname string `json:"nickname,omitempty"`
	Password string `json:"password"`
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// ── Handlers ──────────────────────────────────────────────────────────

func (h *Handler) handleSignup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	// IP throttle first — we want to reject account-spam before parsing
	// any JSON or spending an argon2id hash on hash_failed paths.
	if h.SignupIPLimiter != nil && !h.SignupIPLimiter.Allow(clientIP(r)) {
		h.rateLimit429(w, r, "", "ip", "signup")
		return
	}
	var req signupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))

	if !emailRe.MatchString(req.Email) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_email"})
		return
	}
	// Username is auto-generated from the email's local-part. Keeps the
	// column populated for backward compat (legacy /api/login admin
	// path, audit-log queries, etc.) without exposing it as a signup
	// field. Collision-safe: if the derived handle is already taken,
	// we append a short random suffix and retry.
	ctxLookup, lookupCancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer lookupCancel()
	generatedUsername, err := h.generateUsernameFromEmail(ctxLookup, req.Email)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "username_gen_failed"})
		return
	}
	// Strength policy: length floor + ≥2 character classes + no
	// 4-in-a-row repeats + no common weak passwords + no username/
	// email containment. See password_strength.go.
	if err := CheckPasswordStrength(req.Password, generatedUsername, req.Email); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "weak_password"})
		return
	}

	hash, err := Hash(req.Password)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "hash_failed"})
		return
	}
	// Nickname: caller-supplied wins, otherwise default to email local-part.
	// Length-capped at 32 runes to match /api/auth/profile/nickname so the
	// post-signup edit affordance and the gate here agree.
	nick := strings.TrimSpace(req.Nickname)
	if n := []rune(nick); len(n) > 32 {
		nick = string(n[:32])
	}
	if nick == "" {
		nick = emailLocalPart(req.Email)
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	userCount, err := h.Store.CountUsers(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "count_users_failed"})
		return
	}
	user := User{
		ID:           uuid.NewString(),
		Email:        req.Email,
		Username:     generatedUsername,
		PasswordHash: hash,
		Nickname:     nick,
		// Phase 6.6 — single_session ships on by default. Users can
		// opt back out from the security panel; the migration
		// (0007_single_session_default_on.sql) also flips this on for
		// existing rows that were created before the policy change.
		SingleSession: true,
	}
	if userCount == 0 && os.Getenv("FLOFFI_DISABLE_BOOTSTRAP_ADMIN") != "1" {
		// Bootstrap the very first real account as the recoverable admin seat
		// instead of seeding a network-reachable default credential. Tests can
		// opt out to build plain-user scenarios deterministically.
		user.ID = SuperAdminID
		user.IsAdmin = true
	}
	if err := h.Store.CreateUser(ctx, user); err != nil {
		switch {
		case errors.Is(err, ErrDuplicateEmail):
			writeJSON(w, http.StatusConflict, map[string]any{"error": "email_taken"})
		case errors.Is(err, ErrDuplicateUsername):
			writeJSON(w, http.StatusConflict, map[string]any{"error": "username_taken"})
		default:
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "create_failed"})
		}
		return
	}
	if err := h.issueCookies(ctx, w, r, user.ID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "session_failed"})
		return
	}
	// 감사 로그: 회원가입. Best-effort.
	_ = h.Store.LogAuditEvent(ctx, user.ID, "signup", clientIP(r), r.UserAgent(), "")
	// Phase 11 — let the outer server provision a default workspace for
	// the new account. Recover so a downstream panic doesn't roll back
	// the signup that already succeeded.
	if h.OnUserSignedUp != nil {
		func() {
			defer func() { _ = recover() }()
			h.OnUserSignedUp(user.ID)
		}()
	}
	// Phase 6.3 — register the signup device so we don't fire a "new
	// device" notification for the very next request the user makes
	// from the same browser. We intentionally swallow errors here:
	// failing to register just means the user gets one false-positive
	// new-device email on their next login, which is fine.
	{
		ipHash, uaHash := hashIPUA(clientIP(r), r.UserAgent())
		_ = h.Store.registerDeviceQuietly(ctx, user.ID, ipHash, uaHash)
	}
	// 가입 직후 이메일 인증 메일 자동 발송. 실패해도 가입 자체는 성공.
	if err := h.dispatchVerifyEmail(ctx, &user, r); err != nil {
		// 디버그용으로만 stderr에 흘림. 사용자 경험은 막지 않는다.
		_ = err
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"authenticated": true,
		"username":      user.Username,
		"email":         user.Email,
		"emailVerified": user.EmailVerified,
		"totpEnabled":   user.TOTPEnabled,
		"nickname":      user.DisplayName(),
		"avatar":        user.Avatar,
		"isAdmin":       user.IsAdmin,
		"userId":        user.ID,
	})
}

// handleCheckEmail — POST /api/auth/check-email. Used by the signup form
// to surface "사용 가능 / 이미 사용중" inline without making the user submit
// to find out. Returns one of three states:
//   - {valid:false}            → format failed regex
//   - {valid:true, available:false} → email already registered
//   - {valid:true, available:true}  → looks good
//
// The signup path already leaks account existence on duplicate (409
// email_taken) and the password-reset flow is the only place we keep
// strict enumeration silence (always-200). So exposing the same
// distinction up-front here is not a new leak — just a UX improvement.
// IP rate-limited so this can't be used to bulk-scrape the user table.
func (h *Handler) handleCheckEmail(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	if h.CheckEmailIPLimiter != nil && !h.CheckEmailIPLimiter.Allow(clientIP(r)) {
		h.rateLimit429(w, r, "", "ip", "check-email")
		return
	}
	var req struct {
		Email string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if !emailRe.MatchString(email) {
		writeJSON(w, http.StatusOK, map[string]any{"valid": false})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	u, err := h.Store.FindUserByEmail(ctx, email)
	if err != nil && !errors.Is(err, ErrUserNotFound) {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "lookup_failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"valid":     true,
		"available": u == nil,
	})
}

func (h *Handler) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	// IP burst guard — short window, generous cap. Catches credential
	// stuffers that rotate accounts but not IPs.
	if h.LoginIPLimiter != nil && !h.LoginIPLimiter.Allow(clientIP(r)) {
		h.rateLimit429(w, r, "", "ip", "login")
		return
	}
	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	identifier := strings.ToLower(strings.TrimSpace(req.Email))

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	// Accept either an email or a bare username here. Any user who prefers
	// to log in with their handle can do so without a separate input field.
	// a separate input field. "@" presence decides which lookup runs.
	var user *User
	var err error
	if strings.Contains(identifier, "@") {
		user, err = h.Store.FindUserByEmail(ctx, identifier)
	} else {
		user, err = h.Store.FindUserByUsername(ctx, identifier)
	}
	if err != nil {
		// Use the same generic response on user-not-found so we don't leak
		// account existence by status/error string.
		// 감사 로그 skip: 정체불명의 이메일/유저네임에 대한 로그인 실패는
		// 공격자의 아이디 추측을 그대로 기록하게 되므로 user_id 빈 행을
		// 만들지 않는다.
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid_credentials"})
		return
	}
	// Account-fail throttle: if THIS account has accumulated too many
	// failed attempts in the trailing window, reject before we even try
	// argon2id. Saves CPU under brute-force and stops the attacker from
	// using our verifier as a timing oracle. Doesn't reveal account
	// existence because the 429 only fires after a real account has
	// already collected real failures.
	if user != nil && h.LoginAcctFailLimiter != nil && h.LoginAcctFailLimiter.Blocked("acct:"+user.ID) {
		h.rateLimit429(w, r, user.ID, "acct", "login")
		return
	}
	// DB-backed lock escalation (Phase 6.2): persisted across restarts,
	// unlike the per-process rate-limit map. If this account is currently
	// locked — either temporarily (1h) or permanently (admin unlock only)
	// — refuse before we hash the password. 423 Locked is the canonical
	// status; the body includes lockedUntil so the UI can show a
	// countdown for temp locks and a "contact admin" message for the
	// permanent tier.
	if user != nil {
		if locked, until, level := lockStatus(user, time.Now().Unix()); locked {
			writeJSON(w, http.StatusLocked, map[string]any{
				"error":       "locked",
				"lockedUntil": until,
				"lockLevel":   level,
			})
			return
		}
	}
	ok, _ := Verify(user.PasswordHash, req.Password)
	if !ok {
		// 감사 로그: 알려진 사용자에 대한 비밀번호 실패. user_id를 붙여
		// 본인 활동 이력에 표시되도록 한다.
		_ = h.Store.LogAuditEvent(ctx, user.ID, "login_failed", clientIP(r), r.UserAgent(), "")
		// Count the failure into the per-account in-memory window. The
		// next bad attempt will see Blocked()==true above and short-circuit.
		if h.LoginAcctFailLimiter != nil {
			h.LoginAcctFailLimiter.Record("acct:" + user.ID)
		}
		// Phase 6.2 — DB-backed escalation. Record the attempt, count
		// recent failures, and trip the appropriate tier. We do this
		// AFTER the audit row so a writer crash here doesn't lose the
		// audit trail; the escalation row is a derived signal we can
		// rebuild from login_attempts if needed.
		_ = h.Store.RecordLoginAttempt(ctx, user.ID, user.Email, clientIP(r), r.UserAgent(), "failed")
		h.maybeEscalateLock(ctx, user, r)
		// 실패 카운트를 응답에 노출하지 않는다 — 존재하지 않는 이메일에
		// 대한 401과 응답 모양이 달라지면 공격자가 이메일 존재를 알아낼 수
		// 있기 때문(TestLoginInvalidCredentialsGeneric 가 이를 강제한다).
		// "5회 이상 오입력 시 잠금" 안내는 정적 텍스트로 로그인 화면에 미리
		// 노출한다(LoginView.tsx).
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid_credentials"})
		return
	}
	// Password is correct.
	// 1) Wipe the per-account in-memory failure counter — this user
	//    shouldn't carry stale failures into their next session.
	// 2) Clear the DB-backed failure history so the escalation window
	//    starts fresh.
	// 3) If locked_until was set but expired (we already passed the
	//    lockStatus check above), explicitly zero it so the next login
	//    isn't gated by a stale value.
	if h.LoginAcctFailLimiter != nil {
		h.LoginAcctFailLimiter.Reset("acct:" + user.ID)
	}
	_ = h.Store.ClearFailedLoginAttempts(ctx, user.ID)
	if user.LockedUntil != 0 && user.LockedUntil != LockedUntilPermanent {
		_ = h.Store.SetLockedUntil(ctx, user.ID, 0)
	}

	// TOTP가 활성화된 계정이면 쿠키를 바로 발급하지 않고 챌린지 토큰만 내려준다.
	// 클라이언트는 /api/auth/totp/verify 또는 /api/auth/recovery/verify 에
	// (challengeToken, code) 를 다시 POST 해서 로그인을 마무리한다.
	if user.TOTPEnabled {
		ch, err := h.createMFAChallenge(ctx, user.ID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "challenge_failed"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"mfaRequired":    true,
			"challengeToken": ch,
		})
		return
	}

	newSessionID, err := h.issueCookiesReturnSID(ctx, w, r, user.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "session_failed"})
		return
	}
	// 감사 로그: 로그인 성공.
	_ = h.Store.LogAuditEvent(ctx, user.ID, "login", clientIP(r), r.UserAgent(), "")
	// Phase 6.3 — fingerprint check + new-device email (post-login,
	// non-MFA path). Same hook fires from finishMFALogin for accounts
	// with TOTP enabled.
	h.notifyIfNewDevice(ctx, user, r)
	// 단일 세션 옵션이 켜져 있으면 다른 모든 활성 세션을 폐기. 폐기가
	// 실제로 일어났다면 (= 사용자가 다른 디바이스에 세션을 가지고 있었다면)
	// 그 사용자에게 알림 메일도 보낸다 — last-wins 정책에서 본인이 아닌
	// 누군가가 비번을 가로채서 로그인했을 가능성을 즉시 알리는 채널.
	if user.SingleSession {
		if n, rerr := h.Store.RevokeAllUserSessions(ctx, user.ID, newSessionID); rerr == nil && n > 0 {
			_ = h.Store.LogAuditEvent(ctx, user.ID, "other_sessions_revoked",
				clientIP(r), r.UserAgent(), fmt.Sprintf("n=%d", n))
			h.notifySessionKicked(ctx, user, n, r, "new_login")
			// Push the revoke signal to any live SSE streams owned by
			// this user — 0s latency vs. the 30s SSE heartbeat fallback.
			if h.OnSessionRevoked != nil {
				h.OnSessionRevoked(user.ID)
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"authenticated": true,
		"username":      user.Username,
		"email":         user.Email,
		"emailVerified": user.EmailVerified,
		"totpEnabled":   user.TOTPEnabled,
		"nickname":      user.DisplayName(),
		"avatar":        user.Avatar,
		"isAdmin":       user.IsAdmin,
		"userId":        user.ID,
	})
}

func (h *Handler) handleRefresh(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	// IP throttle. Real clients hit refresh ~4 times/hour; cap is 60/min
	// so any tab-explosion bug or buggy client retry-loop gets a 429
	// before it turns into a storm against the DB.
	if h.RefreshIPLimiter != nil && !h.RefreshIPLimiter.Allow(clientIP(r)) {
		h.rateLimit429(w, r, "", "ip", "refresh")
		return
	}
	rt, err := r.Cookie(RefreshCookieName)
	if err != nil || rt.Value == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "no_refresh"})
		return
	}
	sid, raw, ok := parseRefreshCookie(rt.Value)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "bad_refresh"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	newSID, newRaw, err := h.Store.RotateRefresh(ctx, sid, raw, r.UserAgent(), clientIP(r))
	if err != nil {
		if errors.Is(err, ErrRefreshReuse) {
			h.clearCookies(w, r)
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "refresh_reused"})
			return
		}
		h.clearCookies(w, r)
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "refresh_failed"})
		return
	}
	sess, err := h.Store.FindSession(ctx, newSID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "session_lookup"})
		return
	}
	// 회전 시 mfa_at 은 session 행에 보존된 값을 그대로 사용 — 단순 refresh
	// 만으로 step-up 윈도우가 갱신되면 안 되기 때문.
	access, err := IssueAccessWithMFA(sess.UserID, newSID, sess.MFAAt)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "issue_access"})
		return
	}
	h.setAccessCookie(w, r, access)
	h.setRefreshCookie(w, r, newSID, newRaw)

	user, err := h.Store.FindUserByID(ctx, sess.UserID)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"authenticated": true})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"authenticated": true,
		"username":      user.Username,
		"email":         user.Email,
		"emailVerified": user.EmailVerified,
		"totpEnabled":   user.TOTPEnabled,
		"nickname":      user.DisplayName(),
		"avatar":        user.Avatar,
		"isAdmin":       user.IsAdmin,
		"userId":        user.ID,
	})
}

// logoutRequest is the optional payload for /api/auth/logout. The whole
// body is optional; an empty POST still logs the user out cleanly.
type logoutRequest struct {
	// Reason is one of "idle" / "absolute" / "user". Anything else gets
	// recorded verbatim as "unknown" so audits stay clean.
	Reason string `json:"reason"`
}

func (h *Handler) handleLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}

	// Decode the body if any. Treat decode failure as "no reason"; we never
	// want logout to fail because the client sent junk JSON.
	reason := "user"
	if r.Body != nil {
		var req logoutRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err == nil {
			switch req.Reason {
			case "idle", "absolute", "user":
				reason = req.Reason
			case "":
				// leave default
			default:
				reason = "unknown"
			}
		}
	}

	// Capture the user id (if we can) before we revoke + clear, so the audit
	// row is attributable. The access cookie may already be invalid (expired,
	// session revoked) — in that case userID stays empty and the audit row
	// goes in with a null user_id, which is still useful for tracking
	// anonymous churn.
	var userID string
	if user, _, err := h.Authenticate(r); err == nil && user != nil {
		userID = user.ID
	}

	// Best-effort revoke; ignore errors so logout always clears the client side.
	if rt, err := r.Cookie(RefreshCookieName); err == nil && rt.Value != "" {
		if sid, _, ok := parseRefreshCookie(rt.Value); ok {
			ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
			defer cancel()
			_ = h.Store.RevokeSession(ctx, sid)
		}
	}

	// Audit write is best-effort: never block the logout response on it.
	// Failure here is logged via the returned error path in callers that
	// care; the user has already disconnected from our perspective.
	{
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := h.Store.LogAuditEvent(ctx, userID, "logout", clientIP(r), r.UserAgent(), reason); err != nil {
			// We don't have a structured logger here; stdlib log via Println
			// would pull in another import. The handler package already
			// writes diagnostic strings via fmt elsewhere; mirror that.
			// Keep it terse so production logs aren't noisy.
			_ = err
		}
	}

	h.clearCookies(w, r)
	writeJSON(w, http.StatusOK, map[string]any{"authenticated": false})
}

func (h *Handler) handleSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	user, _, err := h.Authenticate(r)
	if err == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"authenticated": true,
			"username":      user.Username,
			"email":         user.Email,
			"emailVerified": user.EmailVerified,
			"totpEnabled":   user.TOTPEnabled,
			"nickname":      user.DisplayName(),
			"avatar":        user.Avatar,
			"isAdmin":       user.IsAdmin,
			"userId":        user.ID,
		})
		return
	}
	// Try to auto-refresh if the access token expired but the refresh cookie
	// is still good. This keeps the user logged in across the 15 min window
	// without an extra round-trip from the frontend.
	if rt, err := r.Cookie(RefreshCookieName); err == nil && rt.Value != "" {
		if sid, raw, ok := parseRefreshCookie(rt.Value); ok {
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			defer cancel()
			newSID, newRaw, rerr := h.Store.RotateRefresh(ctx, sid, raw, r.UserAgent(), clientIP(r))
			if rerr == nil {
				sess, _ := h.Store.FindSession(ctx, newSID)
				if sess != nil {
					if access, aerr := IssueAccessWithMFA(sess.UserID, newSID, sess.MFAAt); aerr == nil {
						h.setAccessCookie(w, r, access)
						h.setRefreshCookie(w, r, newSID, newRaw)
						if u, uerr := h.Store.FindUserByID(ctx, sess.UserID); uerr == nil {
							writeJSON(w, http.StatusOK, map[string]any{
								"authenticated": true,
								"username":      u.Username,
								"email":         u.Email,
								"emailVerified": u.EmailVerified,
								"totpEnabled":   u.TOTPEnabled,
								"nickname":      u.DisplayName(),
								"avatar":        u.Avatar,
								"isAdmin":       u.IsAdmin,
							})
							return
						}
					}
				}
			}
			if errors.Is(rerr, ErrRefreshReuse) {
				h.clearCookies(w, r)
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"authenticated": false})
}

// handleUpdateNickname — PATCH /api/auth/profile/nickname. Sets the
// authenticated user's nickname. Empty string clears it (read path
// falls back to email local-part). Length-capped at 32 runes to match
// typical UI affordance and keep audit grep-able.
func (h *Handler) handleUpdateNickname(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPatch && r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	user, _, err := h.Authenticate(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return
	}
	var req struct {
		Nickname string `json:"nickname"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	nick := strings.TrimSpace(req.Nickname)
	if n := []rune(nick); len(n) > 32 {
		nick = string(n[:32])
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if err := h.Store.UpdateNickname(ctx, user.ID, nick); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "update_failed"})
		return
	}
	// Mirror the session response shape so the client can swap state in
	// place without an extra /session round-trip.
	user.Nickname = nick
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"nickname": user.DisplayName(),
	})
}

// handleUpdateAvatar — PATCH /api/auth/profile/avatar. Sets the
// authenticated user's avatar override (typically a single emoji),
// independent of the nickname. Empty string clears it so the UI falls
// back to the nickname's first code point.
//
// Capped at 8 runes: a single emoji can be a multi-code-point ZWJ /
// flag / skin-tone sequence, but 8 is well clear of any real glyph while
// keeping the field from being used as a second nickname.
func (h *Handler) handleUpdateAvatar(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPatch && r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	user, _, err := h.Authenticate(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return
	}
	var req struct {
		Avatar string `json:"avatar"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	avatar := strings.TrimSpace(req.Avatar)
	if n := []rune(avatar); len(n) > 8 {
		avatar = string(n[:8])
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if err := h.Store.UpdateAvatar(ctx, user.ID, avatar); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "update_failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":     true,
		"avatar": avatar,
	})
}

// handleDeleteAccount — POST /api/auth/account/delete. Hard-deletes the
// authenticated user's account after step-up verification:
//
//   - password (always)
//   - TOTP code (only if user has 2FA enabled)
//   - confirm field === user.Email (type-to-confirm guard, GitHub pattern)
//
// The confirm string must match the account's own email address (case-
// insensitive, trimmed). Email is account-specific, longer than a generic
// token like "탈퇴", and harder to muscle-memory through — strongest
// accident guard the type-to-confirm pattern provides.
//
// Audit happens BEFORE the delete so the trail outlives the cascade. FK
// CASCADE on the auth-scoped tables takes care of sessions/tokens; cookies
// are cleared on the response so the now-orphaned access JWT can't be
// replayed before its 15-min expiry.
func (h *Handler) handleDeleteAccount(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	user, sess, err := h.Authenticate(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return
	}
	var req struct {
		Password string `json:"password"`
		TOTPCode string `json:"totpCode"`
		Confirm  string `json:"confirm"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	if !strings.EqualFold(strings.TrimSpace(req.Confirm), user.Email) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "confirm_mismatch"})
		return
	}
	if req.Password == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "password_required"})
		return
	}
	if ok, _ := Verify(user.PasswordHash, req.Password); !ok {
		// 같은 실패도 감사 로그에 남겨야 forensic 분석 가능.
		_ = h.Store.LogAuditEvent(r.Context(), user.ID, "account_delete_failed",
			clientIP(r), r.UserAgent(), "reason=invalid_password")
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid_password"})
		return
	}
	if user.TOTPEnabled {
		if strings.TrimSpace(req.TOTPCode) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "totp_required"})
			return
		}
		if ok, _ := VerifyTOTP(user.TOTPSecret, req.TOTPCode); !ok {
			_ = h.Store.LogAuditEvent(r.Context(), user.ID, "account_delete_failed",
				clientIP(r), r.UserAgent(), "reason=invalid_totp")
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid_totp"})
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	// Audit BEFORE delete — once the row is gone, FK CASCADE won't touch
	// audit_log (which has no FK), and the orphan user_id is preserved
	// as a historical breadcrumb. meta includes the email so an operator
	// can reconcile "who was this user" without a DB join.
	_ = h.Store.LogAuditEvent(ctx, user.ID, "account_deleted",
		clientIP(r), r.UserAgent(),
		fmt.Sprintf("email=%s session=%s", user.Email, sess.ID))
	if err := h.Store.DeleteUserByID(ctx, user.ID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "delete_failed"})
		return
	}
	h.clearCookies(w, r)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// Authenticate validates the access cookie + session row. Returns the user
// and session on success. Used by /api/auth/session and the outer
// requireAuth middleware.
func (h *Handler) Authenticate(r *http.Request) (*User, *Session, error) {
	c, err := r.Cookie(AccessCookieName)
	if err != nil || c.Value == "" {
		return nil, nil, errors.New("no_access")
	}
	claims, err := ParseAccess(c.Value)
	if err != nil {
		return nil, nil, err
	}
	if claims.SessionID == "" || claims.Subject == "" {
		return nil, nil, errors.New("bad_claims")
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	sess, err := h.Store.FindSession(ctx, claims.SessionID)
	if err != nil {
		return nil, nil, err
	}
	if sess.RevokedAt != 0 {
		return nil, nil, ErrSessionRevoked
	}
	if sess.UserID != claims.Subject {
		return nil, nil, errors.New("subject_mismatch")
	}
	user, err := h.Store.FindUserByID(ctx, sess.UserID)
	if err != nil {
		return nil, nil, err
	}
	return user, sess, nil
}

// ── Session management ────────────────────────────────────────────────

// handleSessions handles GET /api/auth/sessions — list active refresh
// sessions for the authenticated user.
func (h *Handler) handleSessions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	user, sess, err := h.Authenticate(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	rows, err := h.Store.ListActiveSessions(ctx, user.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "list_failed"})
		return
	}
	out := make([]map[string]any, 0, len(rows))
	for _, s := range rows {
		out = append(out, map[string]any{
			"id":         s.ID,
			"ip":         s.IP,
			"userAgent":  s.UserAgent,
			"createdAt":  s.CreatedAt,
			"lastUsedAt": s.LastUsedAt,
			"isCurrent":  s.ID == sess.ID,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": out})
}

// handleSessionsSubtree dispatches /api/auth/sessions/* paths.
//   - /sessions/revoke-others        → POST: revoke all but the calling session
//   - /sessions/{id}/revoke          → POST: revoke a specific session
func (h *Handler) handleSessionsSubtree(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/auth/sessions/")
	switch {
	case rest == "revoke-others":
		h.handleRevokeOthers(w, r)
	case strings.HasSuffix(rest, "/revoke"):
		id := strings.TrimSuffix(rest, "/revoke")
		if id == "" || strings.ContainsRune(id, '/') {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found"})
			return
		}
		h.handleRevokeOne(w, r, id)
	default:
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found"})
	}
}

func (h *Handler) handleRevokeOthers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	user, sess, err := h.Authenticate(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	n, err := h.Store.RevokeAllUserSessions(ctx, user.ID, sess.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "revoke_failed"})
		return
	}
	_ = h.Store.LogAuditEvent(ctx, user.ID, "other_sessions_revoked",
		clientIP(r), r.UserAgent(), fmt.Sprintf("n=%d", n))
	writeJSON(w, http.StatusOK, map[string]any{"revoked": n})
}

func (h *Handler) handleRevokeOne(w http.ResponseWriter, r *http.Request, sessionID string) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	user, _, err := h.Authenticate(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	// Verify the target session belongs to the calling user — preventing one
	// authenticated account from killing another's sessions by id-guessing.
	target, err := h.Store.FindSession(ctx, sessionID)
	if err != nil || target.UserID != user.ID {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found"})
		return
	}
	if err := h.Store.RevokeSession(ctx, sessionID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "revoke_failed"})
		return
	}
	_ = h.Store.LogAuditEvent(ctx, user.ID, "session_revoked",
		clientIP(r), r.UserAgent(), "session="+sessionID)
	writeJSON(w, http.StatusOK, map[string]any{"revoked": true})
}

// ── Security prefs ────────────────────────────────────────────────────

type securityPrefsRequest struct {
	SingleSession bool `json:"singleSession"`
}

func (h *Handler) handleSecurity(w http.ResponseWriter, r *http.Request) {
	user, sess, err := h.Authenticate(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	switch r.Method {
	case http.MethodGet:
		ss, gerr := h.Store.GetSecurityPrefs(ctx, user.ID)
		if gerr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "load_failed"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"singleSession": ss})
	case http.MethodPost:
		var req securityPrefsRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
			return
		}
		// Capture the prior state so we can detect a false→true edge.
		// On that edge we don't just save the preference — we apply it
		// immediately by revoking every OTHER active refresh session.
		// Without this, a user who flips the toggle expecting "kick my
		// other devices NOW" would be surprised that their phone is
		// still signed in until the next time they sign in fresh.
		priorSS, _ := h.Store.GetSecurityPrefs(ctx, user.ID)
		if err := h.Store.UpdateSecurityPrefs(ctx, user.ID, req.SingleSession); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "save_failed"})
			return
		}
		_ = h.Store.LogAuditEvent(ctx, user.ID, "security_prefs_changed",
			clientIP(r), r.UserAgent(), fmt.Sprintf("single_session=%t", req.SingleSession))
		revokedNow := 0
		if req.SingleSession && !priorSS {
			if n, rerr := h.Store.RevokeAllUserSessions(ctx, user.ID, sess.ID); rerr == nil && n > 0 {
				revokedNow = n
				_ = h.Store.LogAuditEvent(ctx, user.ID, "other_sessions_revoked",
					clientIP(r), r.UserAgent(),
					fmt.Sprintf("n=%d source=toggle_on", n))
				h.notifySessionKicked(ctx, user, n, r, "single_session_toggle_on")
				if h.OnSessionRevoked != nil {
					h.OnSessionRevoked(user.ID)
				}
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"singleSession": req.SingleSession,
			"revokedNow":    revokedNow,
		})
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
	}
}

// ── Audit log viewer ──────────────────────────────────────────────────

func (h *Handler) handleAudit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	user, _, err := h.Authenticate(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return
	}
	limit := 100
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	if limit > 200 {
		limit = 200
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	events, err := h.Store.ListAuditEvents(ctx, user.ID, limit)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "list_failed"})
		return
	}
	out := make([]map[string]any, 0, len(events))
	for _, e := range events {
		row := map[string]any{
			"event":     e.Event,
			"ip":        e.IP,
			"userAgent": e.UserAgent,
			"at":        e.At,
		}
		// Only emit meta when populated to keep the wire payload tight.
		if e.Meta != "" {
			row["meta"] = e.Meta
		}
		out = append(out, row)
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": out})
}

// ── Cookie helpers ────────────────────────────────────────────────────

// issueCookies creates a fresh refresh session for userID and sets both
// cookies on the response.
func (h *Handler) issueCookies(ctx context.Context, w http.ResponseWriter, r *http.Request, userID string) error {
	_, err := h.issueCookiesReturnSID(ctx, w, r, userID)
	return err
}

// issueCookiesReturnSID is identical to issueCookies but also returns the
// new refresh session ID so the caller can use it (e.g. as the "except"
// argument when revoking other sessions).
func (h *Handler) issueCookiesReturnSID(ctx context.Context, w http.ResponseWriter, r *http.Request, userID string) (string, error) {
	sid, raw, err := h.Store.IssueRefresh(ctx, userID, r.UserAgent(), clientIP(r))
	if err != nil {
		return "", err
	}
	access, err := IssueAccess(userID, sid)
	if err != nil {
		return "", err
	}
	h.setAccessCookie(w, r, access)
	h.setRefreshCookie(w, r, sid, raw)
	// Clear the retired HMAC cookie on every fresh login so a browser
	// that's been carrying it since pre-cutover doesn't keep silently
	// authenticating workspace API calls outside the modern session
	// machinery.
	h.clearLegacyCookie(w)
	return sid, nil
}

// secureCookies returns true only when FLOFFI_PROD=1. Dev mode is the
// default (localhost over plain http) so a clean checkout doesn't need
// any env-var ceremony to sign in; production must opt in explicitly.
func forwardedProto(r *http.Request) string {
	if r == nil {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")))
}

func canonicalHost(hostport string) string {
	host := strings.TrimSpace(hostport)
	if strings.HasPrefix(host, "[") {
		if end := strings.Index(host, "]"); end > 0 {
			return strings.ToLower(host[1:end])
		}
	}
	if h, _, err := net.SplitHostPort(host); err == nil {
		return strings.ToLower(h)
	}
	return strings.ToLower(host)
}

func isLoopbackHost(host string) bool {
	host = canonicalHost(host)
	switch host {
	case "localhost", "127.0.0.1", "::1":
		return true
	default:
		return false
	}
}

// secureCookies defaults to Secure cookies everywhere except localhost HTTP.
//
// Self-hosted LAN instances sometimes run plain HTTP during bring-up
// (e.g. http://192.168.x.x:19981). Browsers drop Secure cookies on those
// origins, which makes login appear to succeed and then vanish on refresh.
// To support that explicit self-hosted case without weakening the default,
// operators may set FLOFFI_ALLOW_INSECURE_HTTP=1.
func secureCookies(r *http.Request) bool {
	if r == nil {
		return true
	}
	if r.TLS != nil || forwardedProto(r) == "https" {
		return true
	}
	if isLoopbackHost(r.Host) {
		return false
	}
	return os.Getenv("FLOFFI_ALLOW_INSECURE_HTTP") != "1"
}

func trustProxyHeaders() bool { return os.Getenv("FLOFFI_TRUST_PROXY") == "1" }

func (h *Handler) setAccessCookie(w http.ResponseWriter, r *http.Request, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     AccessCookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   secureCookies(r),
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int(AccessTokenTTL().Seconds()),
	})
}

func (h *Handler) setRefreshCookie(w http.ResponseWriter, r *http.Request, sid, raw string) {
	http.SetCookie(w, &http.Cookie{
		Name:  RefreshCookieName,
		Value: encodeRefreshCookie(sid, raw),
		// Refresh cookie is scoped to /api/auth so it's never sent on
		// workspace API calls. Reduces accidental exposure if any /api/*
		// handler ever logs cookies for debugging.
		Path:     "/api/auth",
		HttpOnly: true,
		Secure:   secureCookies(r),
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int(RefreshTokenTTL.Seconds()),
	})
}

func (h *Handler) clearCookies(w http.ResponseWriter, r *http.Request) {
	for _, c := range []*http.Cookie{
		{Name: AccessCookieName, Path: "/", MaxAge: -1, HttpOnly: true, Secure: secureCookies(r), SameSite: http.SameSiteStrictMode},
		{Name: RefreshCookieName, Path: "/api/auth", MaxAge: -1, HttpOnly: true, Secure: secureCookies(r), SameSite: http.SameSiteStrictMode},
	} {
		http.SetCookie(w, c)
	}
	h.clearLegacyCookie(w)
}

// clearLegacyCookie wipes the retired HMAC `floffi_session` cookie.
// Called from issueCookiesReturnSID (new login) and clearCookies
// (logout) so the legacy cookie can't outlive its surrounding session.
// Path / SameSite mirror the legacy issuer in
// internal/server/auth.go:setSessionCookie.
func (h *Handler) clearLegacyCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     LegacyHMACCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}

// encodeRefreshCookie packs (sessionID, rawToken) into a single cookie value
// so we don't need a second cookie for the session id. Format: "<sid>.<raw>".
// The session id is a UUID so it never contains a '.'.
func encodeRefreshCookie(sid, raw string) string { return sid + "." + raw }

func parseRefreshCookie(v string) (sid, raw string, ok bool) {
	i := strings.IndexByte(v, '.')
	if i <= 0 || i == len(v)-1 {
		return "", "", false
	}
	return v[:i], v[i+1:], true
}

func clientIP(r *http.Request) string {
	if trustProxyHeaders() {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			if i := strings.IndexByte(xff, ','); i > 0 {
				return strings.TrimSpace(xff[:i])
			}
			return strings.TrimSpace(xff)
		}
	}
	addr := strings.TrimSpace(r.RemoteAddr)
	if host, _, err := net.SplitHostPort(addr); err == nil {
		return host
	}
	return addr
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
