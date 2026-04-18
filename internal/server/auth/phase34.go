package auth

// phase34.go — handlers for email verification + password reset (Phase 3)
// and TOTP 2FA + recovery codes (Phase 4). Kept in a separate file so the
// original handler.go stays focused on the Phase 1+2 session lifecycle.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Token TTLs — tuned per OWASP guidance + product UX.
const (
	emailVerifyTTL    = 24 * time.Hour
	passwordResetTTL  = 15 * time.Minute
	mfaChallengeTTL   = 5 * time.Minute
	mfaStepUpWindow   = 5 * time.Minute
)

// ── helpers ───────────────────────────────────────────────────────────

// newURLToken returns a fresh random 32-byte token in base64url plus its
// sha256 hash (hex). The raw token is the only time the plaintext exists;
// the DB only sees the hash.
func newURLToken() (raw, hashHex string, err error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", "", fmt.Errorf("auth: token random: %w", err)
	}
	raw = base64.RawURLEncoding.EncodeToString(buf)
	sum := sha256.Sum256([]byte(raw))
	hashHex = hex.EncodeToString(sum[:])
	return raw, hashHex, nil
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// dispatchVerifyEmail (re)issues a verify token if no usable one exists and
// sends the link via the configured EmailSender. Safe to call any number of
// times — the active-token reuse keeps the inbox quiet.
func (h *Handler) dispatchVerifyEmail(ctx context.Context, user *User, r *http.Request) error {
	if user.EmailVerified {
		return nil
	}
	if existing, err := h.Store.FindActiveEmailToken(ctx, user.ID, "verify"); err == nil && existing != nil {
		// We never stored the plaintext, so we can't resend the old link.
		// Per spec "don't spam": just no-op when an active token exists.
		// The previous link the user already received remains valid until TTL.
		return nil
	}
	raw, hashHex, err := newURLToken()
	if err != nil {
		return err
	}
	now := time.Now()
	if err := h.Store.CreateEmailToken(ctx, EmailToken{
		ID:        uuid.NewString(),
		UserID:    user.ID,
		Kind:      "verify",
		TokenHash: hashHex,
		CreatedAt: now.Unix(),
		ExpiresAt: now.Add(emailVerifyTTL).Unix(),
	}); err != nil {
		return err
	}
	link := h.baseURL() + "/verify?token=" + raw
	body := fmt.Sprintf("안녕하세요.\n\nfloffi 계정의 이메일 인증을 완료하려면 다음 링크를 눌러주세요:\n\n%s\n\n이 링크는 24시간 동안 유효합니다.\n본인이 요청하지 않은 메일이라면 이 메일을 무시해도 됩니다.\n", link)
	if err := h.emailSender().Send(ctx, user.Email, "[floffi] 이메일을 인증해주세요", body); err != nil {
		return err
	}
	_ = h.Store.LogAuditEvent(ctx, user.ID, "email_verify_sent", clientIP(r), r.UserAgent(), "")
	return nil
}

// ── /api/auth/verify-email/start ──────────────────────────────────────

func (h *Handler) handleVerifyEmailStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	user, _, err := h.Authenticate(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if user.EmailVerified {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "alreadyVerified": true})
		return
	}
	if err := h.dispatchVerifyEmail(ctx, user, r); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "send_failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ── /api/auth/verify-email/complete ───────────────────────────────────

type tokenBody struct {
	Token string `json:"token"`
}

func (h *Handler) handleVerifyEmailComplete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	var req tokenBody
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Token == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	t, err := h.Store.ConsumeEmailToken(ctx, "verify", sha256Hex(req.Token))
	if err != nil {
		switch {
		case errors.Is(err, ErrEmailTokenExpired):
			writeJSON(w, http.StatusGone, map[string]any{"error": "token_expired"})
		case errors.Is(err, ErrEmailTokenUsed):
			writeJSON(w, http.StatusGone, map[string]any{"error": "token_used"})
		case errors.Is(err, ErrEmailTokenNotFound):
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "token_not_found"})
		default:
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "consume_failed"})
		}
		return
	}
	if err := h.Store.MarkEmailVerified(ctx, t.UserID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "verify_failed"})
		return
	}
	_ = h.Store.LogAuditEvent(ctx, t.UserID, "email_verified", clientIP(r), r.UserAgent(), "")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ── /api/auth/reset-password/start ────────────────────────────────────

type resetStartBody struct {
	Email string `json:"email"`
}

func (h *Handler) handleResetPasswordStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	var req resetStartBody
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	emailAddr := strings.ToLower(strings.TrimSpace(req.Email))

	// Always-200 to avoid leaking account existence. We do the lookup in
	// the background and only send when there's a real user — that's the
	// account-enumeration guard.
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	user, err := h.Store.FindUserByEmail(ctx, emailAddr)
	if err == nil && user != nil {
		raw, hashHex, terr := newURLToken()
		if terr == nil {
			now := time.Now()
			if cerr := h.Store.CreateEmailToken(ctx, EmailToken{
				ID:        uuid.NewString(),
				UserID:    user.ID,
				Kind:      "reset",
				TokenHash: hashHex,
				CreatedAt: now.Unix(),
				ExpiresAt: now.Add(passwordResetTTL).Unix(),
			}); cerr == nil {
				link := h.baseURL() + "/reset?token=" + raw
				body := fmt.Sprintf("안녕하세요.\n\nfloffi 계정의 비밀번호 재설정을 요청하셨습니다. 다음 링크에서 새 비밀번호를 설정해주세요:\n\n%s\n\n이 링크는 15분 동안만 유효합니다.\n본인이 요청하지 않았다면 이 메일을 무시해주세요.\n", link)
				// 비동기 송신: SMTP 지연이 사용자 요청을 잡아두지 않도록.
				// always-200 enumeration guard 와도 결이 맞는다 — 송신
				// 결과는 응답에 노출하지 않으므로 동기로 기다릴 이유가
				// 없다.
				h.sendEmailAsync("reset-password", user.Email, "[floffi] 비밀번호 재설정", body)
				_ = h.Store.LogAuditEvent(ctx, user.ID, "password_reset_requested", clientIP(r), r.UserAgent(), "")
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ── /api/auth/reset-password/complete ─────────────────────────────────

type resetCompleteBody struct {
	Token    string `json:"token"`
	Password string `json:"password"`
}

func (h *Handler) handleResetPasswordComplete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	var req resetCompleteBody
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Token == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	// Pre-consume strength check — same rules as signup, except we
	// don't have the user's identifiers at this point in the flow
	// (would need an extra DB lookup before consuming the token),
	// so the username/email-containment branch is just skipped.
	// The length / character-class / repeat / blacklist branches
	// catch the most common weak inputs anyway.
	if err := CheckPasswordStrength(req.Password, "", ""); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "weak_password"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	t, err := h.Store.ConsumeEmailToken(ctx, "reset", sha256Hex(req.Token))
	if err != nil {
		switch {
		case errors.Is(err, ErrEmailTokenExpired):
			writeJSON(w, http.StatusGone, map[string]any{"error": "token_expired"})
		case errors.Is(err, ErrEmailTokenUsed):
			writeJSON(w, http.StatusGone, map[string]any{"error": "token_used"})
		case errors.Is(err, ErrEmailTokenNotFound):
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "token_not_found"})
		default:
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "consume_failed"})
		}
		return
	}
	hash, herr := Hash(req.Password)
	if herr != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "hash_failed"})
		return
	}
	if err := h.Store.UpdatePasswordHash(ctx, t.UserID, hash); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "update_failed"})
		return
	}
	// 모든 refresh 세션 즉시 폐기 — 누군가가 가로챈 쿠키로 세션을 유지하지 못하게.
	n, _ := h.Store.RevokeAllSessionsForUser(ctx, t.UserID)
	// 이메일 토큰을 들고 비밀번호를 재설정했다는 것은 메일함을 통제하고
	// 있다는 강한 재인증 신호다. tier-1 임시 잠금(5회 오입력 → 1시간)에
	// 걸린 사용자는 reset 한 번으로 즉시 복구되도록, locked_until을 0으로
	// 되돌리고 실패 히스토리도 비운다. tier-2(영구 잠금)는 admin 검토가
	// 필요한 강한 신호로 남겨두기 위해 여기서 풀지 않는다.
	unlocked := false
	if u, ferr := h.Store.FindUserByID(ctx, t.UserID); ferr == nil && u != nil {
		if u.LockedUntil != 0 && u.LockedUntil != LockedUntilPermanent {
			_ = h.Store.SetLockedUntil(ctx, t.UserID, 0)
			unlocked = true
		}
	}
	_ = h.Store.ClearFailedLoginAttempts(ctx, t.UserID)
	if h.LoginAcctFailLimiter != nil {
		h.LoginAcctFailLimiter.Reset("acct:" + t.UserID)
	}
	if unlocked {
		_ = h.Store.LogAuditEvent(ctx, t.UserID, "account_unlocked_via_reset",
			clientIP(r), r.UserAgent(), "")
	}
	_ = h.Store.LogAuditEvent(ctx, t.UserID, "password_reset_completed", clientIP(r), r.UserAgent(),
		fmt.Sprintf("revoked_sessions=%d unlocked=%v", n, unlocked))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ── MFA challenge plumbing ────────────────────────────────────────────

// createMFAChallenge returns a fresh opaque challenge token for the user.
// The token itself is the row's PK; we don't bother hashing because the
// challenge is short-lived (5 min) and consumed once.
func (h *Handler) createMFAChallenge(ctx context.Context, userID string) (string, error) {
	tok, _, err := newURLToken()
	if err != nil {
		return "", err
	}
	now := time.Now()
	if err := h.Store.CreateMFAChallenge(ctx, MFAChallenge{
		ID:        tok,
		UserID:    userID,
		CreatedAt: now.Unix(),
		ExpiresAt: now.Add(mfaChallengeTTL).Unix(),
	}); err != nil {
		return "", err
	}
	return tok, nil
}

// finishMFALogin shared tail used by both /totp/verify and /recovery/verify
// after the code check passes. Issues cookies, applies single-session, and
// writes the success audit row.
func (h *Handler) finishMFALogin(ctx context.Context, w http.ResponseWriter, r *http.Request, user *User, auditEvent string) {
	newSessionID, err := h.issueCookiesReturnSIDWithMFA(ctx, w, r, user.ID, time.Now().Unix())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "session_failed"})
		return
	}
	_ = h.Store.LogAuditEvent(ctx, user.ID, "login", clientIP(r), r.UserAgent(), "via="+auditEvent)
	_ = h.Store.LogAuditEvent(ctx, user.ID, auditEvent, clientIP(r), r.UserAgent(), "")
	// Phase 6.3 — same new-device check as the non-MFA path. We run it
	// AFTER the MFA verify, so a successful TOTP/recovery code that
	// arrives from an unfamiliar device still triggers the alert email.
	h.notifyIfNewDevice(ctx, user, r)
	if user.SingleSession {
		if n, rerr := h.Store.RevokeAllUserSessions(ctx, user.ID, newSessionID); rerr == nil && n > 0 {
			_ = h.Store.LogAuditEvent(ctx, user.ID, "other_sessions_revoked",
				clientIP(r), r.UserAgent(), fmt.Sprintf("n=%d", n))
			h.notifySessionKicked(ctx, user, n, r, "new_login_mfa")
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
	})
}

// issueCookiesReturnSIDWithMFA mirrors issueCookiesReturnSID but stamps
// mfa_at on the JWT so step-up checks pass within the window.
func (h *Handler) issueCookiesReturnSIDWithMFA(ctx context.Context, w http.ResponseWriter, r *http.Request, userID string, mfaAt int64) (string, error) {
	sid, raw, err := h.Store.IssueRefresh(ctx, userID, r.UserAgent(), clientIP(r))
	if err != nil {
		return "", err
	}
	access, err := IssueAccessWithMFA(userID, sid, mfaAt)
	if err != nil {
		return "", err
	}
	h.setAccessCookie(w, r, access)
	h.setRefreshCookie(w, r, sid, raw)
	// Match issueCookiesReturnSID — wipe the retired HMAC cookie so an
	// MFA-completed login can't co-exist with a pre-cutover session.
	h.clearLegacyCookie(w)
	return sid, nil
}

// ── /api/auth/totp/setup ──────────────────────────────────────────────

func (h *Handler) handleTOTPSetup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	user, _, err := h.Authenticate(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return
	}
	// TOTP 활성화는 이메일 인증과 독립이다. 복구 경로는 enable 단계에
	// 발급되는 복구 코드 10개로 충족되며, 이메일 검증을 전제로 강요하면
	// "OTP 만 빨리 켜고 싶다" 는 정상 시나리오를 차단해 사용자 마찰을
	// 늘린다. (이전 Phase 7 의 email_verify_required 가드는 제거됨.)
	secret, err := NewTOTPSecret()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "secret_failed"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if err := h.Store.SetTOTPSecret(ctx, user.ID, secret); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "store_failed"})
		return
	}
	uri := OtpauthURI(h.totpIssuer(), user.Email, secret)
	_ = h.Store.LogAuditEvent(ctx, user.ID, "totp_setup_started", clientIP(r), r.UserAgent(), "")
	writeJSON(w, http.StatusOK, map[string]any{
		"otpauthURI": uri,
		"secret":     secret,
	})
}

// ── /api/auth/totp/enable ─────────────────────────────────────────────

type codeBody struct {
	Code string `json:"code"`
}

type challengeCodeBody struct {
	ChallengeToken string `json:"challengeToken"`
	Code           string `json:"code"`
}

func (h *Handler) handleTOTPEnable(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	user, _, err := h.Authenticate(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return
	}
	var req codeBody
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	if user.TOTPSecret == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "no_pending_secret"})
		return
	}
	ok, _ := VerifyTOTP(user.TOTPSecret, req.Code)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid_code"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if err := h.Store.EnableTOTP(ctx, user.ID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "enable_failed"})
		return
	}
	codes, hashed, err := h.generateAndStoreRecoveryCodes(ctx, user.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "recovery_failed"})
		return
	}
	_ = hashed
	_ = h.Store.LogAuditEvent(ctx, user.ID, "totp_enabled", clientIP(r), r.UserAgent(), "")
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":            true,
		"recoveryCodes": codes,
	})
}

// generateAndStoreRecoveryCodes returns the raw codes (to ship to the
// client exactly once) and persists the argon2id hashes.
func (h *Handler) generateAndStoreRecoveryCodes(ctx context.Context, userID string) (raw []string, stored int, err error) {
	codes, err := NewRecoveryCodes()
	if err != nil {
		return nil, 0, err
	}
	rows := make([]RecoveryCode, 0, len(codes))
	now := time.Now().Unix()
	for _, c := range codes {
		hash, herr := Hash(c)
		if herr != nil {
			return nil, 0, herr
		}
		rows = append(rows, RecoveryCode{
			ID:        uuid.NewString(),
			UserID:    userID,
			CodeHash:  hash,
			CreatedAt: now,
		})
	}
	if err := h.Store.ReplaceRecoveryCodes(ctx, userID, rows); err != nil {
		return nil, 0, err
	}
	return codes, len(rows), nil
}

// ── /api/auth/totp/disable ────────────────────────────────────────────

func (h *Handler) handleTOTPDisable(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	user, _, err := h.Authenticate(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return
	}
	var req codeBody
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	// 현재 TOTP 코드 OR 복구 코드 둘 다 허용.
	verified := false
	if user.TOTPEnabled && user.TOTPSecret != "" {
		if ok, _ := VerifyTOTP(user.TOTPSecret, req.Code); ok {
			verified = true
		}
	}
	if !verified {
		if ok, _ := h.checkRecoveryCode(ctx, user.ID, req.Code); ok {
			verified = true
		}
	}
	if !verified {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid_code"})
		return
	}
	if err := h.Store.DisableTOTP(ctx, user.ID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "disable_failed"})
		return
	}
	_ = h.Store.LogAuditEvent(ctx, user.ID, "totp_disabled", clientIP(r), r.UserAgent(), "")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// checkRecoveryCode verifies code against the stored argon2id hashes and
// marks the matched row used. Returns (matched, matchedID).
func (h *Handler) checkRecoveryCode(ctx context.Context, userID, code string) (bool, string) {
	normalized := NormalizeRecoveryCode(code)
	rows, err := h.Store.ListRecoveryCodes(ctx, userID)
	if err != nil {
		return false, ""
	}
	for _, c := range rows {
		ok, _ := Verify(c.CodeHash, normalized)
		if ok {
			if err := h.Store.MarkRecoveryCodeUsed(ctx, c.ID); err == nil {
				return true, c.ID
			}
		}
	}
	return false, ""
}

// ── /api/auth/totp/verify (during login) ──────────────────────────────

func (h *Handler) handleTOTPVerify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	var req challengeCodeBody
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ChallengeToken == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	ch, err := h.Store.ConsumeMFAChallenge(ctx, req.ChallengeToken)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "challenge_invalid"})
		return
	}
	user, err := h.Store.FindUserByID(ctx, ch.UserID)
	if err != nil || user.TOTPSecret == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "challenge_invalid"})
		return
	}
	ok, _ := VerifyTOTP(user.TOTPSecret, req.Code)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid_code"})
		return
	}
	h.finishMFALogin(ctx, w, r, user, "totp_verified")
}

// ── /api/auth/recovery/verify ─────────────────────────────────────────

func (h *Handler) handleRecoveryVerify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	var req challengeCodeBody
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ChallengeToken == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	ch, err := h.Store.ConsumeMFAChallenge(ctx, req.ChallengeToken)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "challenge_invalid"})
		return
	}
	user, err := h.Store.FindUserByID(ctx, ch.UserID)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "challenge_invalid"})
		return
	}
	ok, _ := h.checkRecoveryCode(ctx, user.ID, req.Code)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid_code"})
		return
	}
	// finishMFALogin writes the recovery_code_used audit row + the login row.
	h.finishMFALogin(ctx, w, r, user, "recovery_code_used")
}

// ── /api/auth/recovery/regenerate ─────────────────────────────────────

func (h *Handler) handleRecoveryRegenerate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	user, _, err := h.Authenticate(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return
	}
	if err := h.requireRecentMFA(r); err != nil {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "mfa_required"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	codes, _, err := h.generateAndStoreRecoveryCodes(ctx, user.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "recovery_failed"})
		return
	}
	_ = h.Store.LogAuditEvent(ctx, user.ID, "recovery_codes_regenerated",
		clientIP(r), r.UserAgent(), "")
	writeJSON(w, http.StatusOK, map[string]any{"recoveryCodes": codes})
}

// requireRecentMFA enforces the step-up window. Behavior:
//   - User has TOTP enabled: the JWT's mfa_at must be within mfaStepUpWindow.
//     This is set by /totp/verify or /recovery/verify on login, and reset
//     on every re-auth via the same paths. We DO NOT re-issue mfa_at on
//     plain refresh — that would defeat the purpose of the window.
//   - User has TOTP disabled: a fresh login is the only re-auth signal we
//     have, so we accept mfa_at within the same window. This mirrors the
//     login timestamp set by IssueAccess.
//
// In both branches, missing/zero mfa_at fails the check.
func (h *Handler) requireRecentMFA(r *http.Request) error {
	c, err := r.Cookie(AccessCookieName)
	if err != nil || c.Value == "" {
		return errors.New("no_access")
	}
	claims, err := ParseAccess(c.Value)
	if err != nil {
		return err
	}
	if claims.MFAAt == 0 {
		return errors.New("no_mfa_claim")
	}
	if time.Now().Unix()-claims.MFAAt > int64(mfaStepUpWindow.Seconds()) {
		return errors.New("mfa_stale")
	}
	return nil
}
