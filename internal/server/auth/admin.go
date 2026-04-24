package auth

// admin.go — Phase 6.4: admin-only routes under /api/auth/admin/*.
//
// Auth model is intentionally lightweight: users.is_admin is a single
// boolean, granted to the legacy admin seed and (in the future) via a
// CLI or DB migration. We don't expose "grant admin" over HTTP yet —
// that's the kind of action whose blast radius warrants a fresh
// design pass.
//
// Routes:
//   GET  /api/auth/admin/users                       — list every user (no secrets)
//   GET  /api/auth/admin/audit?userId=X              — any user's audit feed
//   POST /api/auth/admin/users/{id}/lock             — block a user from signing in
//   POST /api/auth/admin/users/{id}/unlock           — clear users.locked_until
//   POST /api/auth/admin/users/{id}/reset-password   — issue a fresh reset link
//                                                      on behalf of the user
//   POST /api/auth/admin/users/{id}/grant-admin      — promote a user to admin
//   POST /api/auth/admin/users/{id}/revoke-admin     — demote an admin to plain user
//   POST /api/auth/admin/users/{id}/workspace-cap    — set/clear per-user
//                                                      workspace count override
//
// All routes 401 on missing/invalid session, 403 when the caller is
// authenticated but not an admin. The 403/401 split helps the UI:
// "you're not signed in" vs "you don't have rights here" are
// different actionable states.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// SuperAdminID is the fixed UUID we assign to the bootstrap admin
// assigned to the bootstrap admin seat (normally the first real admin account).
// We treat that single row as the "super admin" who cannot be locked,
// demoted, or password-reset by any other admin — the goal is to
// guarantee at least one operator account is always recoverable, so
// admins fighting each other (or a single compromised admin) can't
// strip every recovery path.
//
// Why a fixed-UUID sentinel rather than a new boolean column on
// users: the seed already uses this UUID for an unrelated reason
// (deterministic ID for the legacy admin so older deployments stay
// consistent across restarts), and only one row in any deployment
// can hold it. That's exactly the invariant we need — "the original
// admin seat is identifiable, and there is exactly one" — without a
// migration. If we ever need to transfer the super-admin seat (e.g.
// onboarding a new operator and retiring the bootstrap account), we
// add a small Store helper at that point; for now nobody asks for
// that flow.
const SuperAdminID = "00000000-0000-0000-0000-000000000001"

// IsSuperAdmin reports whether u is the bootstrap super admin who is
// shielded from lock / revoke-admin / reset-password by other admins.
func IsSuperAdmin(u *User) bool {
	return u != nil && u.ID == SuperAdminID
}

// requireAdmin runs Authenticate then enforces the is_admin bit. The
// returned user is non-nil only when both checks pass. On failure the
// helper writes the response and the caller just returns.
func (h *Handler) requireAdmin(w http.ResponseWriter, r *http.Request) *User {
	user, _, err := h.Authenticate(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return nil
	}
	if !user.IsAdmin {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "admin_only"})
		return nil
	}
	return user
}

// handleAdminUsers — GET /api/auth/admin/users
func (h *Handler) handleAdminUsers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	if h.requireAdmin(w, r) == nil {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	rows, err := h.Store.ListAllUsers(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "list_failed"})
		return
	}
	out := make([]map[string]any, 0, len(rows))
	for _, u := range rows {
		var capOverride any
		if u.WorkspaceCapOverride != nil {
			capOverride = *u.WorkspaceCapOverride
		}
		out = append(out, map[string]any{
			"id":                   u.ID,
			"email":                u.Email,
			"username":             u.Username,
			"emailVerified":        u.EmailVerified,
			"totpEnabled":          u.TOTPEnabled,
			"lockedUntil":          u.LockedUntil,
			"isAdmin":              u.IsAdmin,
			"createdAt":            u.CreatedAt,
			"updatedAt":            u.UpdatedAt,
			"workspaceCapOverride": capOverride,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": out})
}

// handleAdminAudit — GET /api/auth/admin/audit?userId=<id>&limit=N
func (h *Handler) handleAdminAudit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	if h.requireAdmin(w, r) == nil {
		return
	}
	target := r.URL.Query().Get("userId")
	if target == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing_user_id"})
		return
	}
	limit := 100
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	events, err := h.Store.ListAuditEventsForAdmin(ctx, target, limit)
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
		if e.Meta != "" {
			row["meta"] = e.Meta
		}
		out = append(out, row)
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": out})
}

// handleAdminUsersSubtree dispatches the per-user admin actions mounted
// under /api/auth/admin/users/. Each action is `/{id}/<verb>`.
//
// Verbs:
//
//	/unlock         — clear users.locked_until (handleAdminUnlock)
//	/reset-password — issue a fresh reset token (handleAdminResetPassword)
//
// Path/method validation happens here once; the verb handlers can assume
// they were dispatched to with a valid target user id loaded from the DB.
func (h *Handler) handleAdminUsersSubtree(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/auth/admin/users/")
	// Split into "{id}/{verb}". Reject anything else (deeper paths,
	// missing verb) as 404 so probes don't get a method-not-allowed
	// hint that the route exists.
	idx := strings.IndexRune(rest, '/')
	if idx <= 0 || idx == len(rest)-1 {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found"})
		return
	}
	id, verb := rest[:idx], rest[idx+1:]
	if strings.ContainsRune(verb, '/') {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found"})
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	admin := h.requireAdmin(w, r)
	if admin == nil {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	target, err := h.Store.FindUserByID(ctx, id)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "user_not_found"})
		return
	}
	// Super-admin shield: the bootstrap admin seat (SuperAdminID) is immune to
	// every destructive verb targeted at them BY OTHERS. lock / unlock /
	// reset-password / revoke-admin / grant-admin all carry through; the
	// dispatcher refuses any of them when target is super-admin and the
	// caller is someone else. The super-admin can still operate on
	// themselves (e.g. unlock themselves if a future flow ever locks
	// them, or revoke their own admin — though self-revoke is blocked
	// downstream by cannot_revoke_self). Concrete refusals we want to
	// produce:
	//   - lock super-admin → blocked (otherwise admin1 + admin2 could
	//     conspire to lock the original operator and split the keys).
	//   - revoke-admin super-admin → blocked (same threat model, but
	//     one step further — locking is reversible; demotion + lock
	//     would strip the recovery path entirely).
	//   - reset-password super-admin → blocked (a hijacked admin
	//     account could otherwise mint a reset link for the super
	//     admin and take over the recovery seat).
	//   - unlock super-admin / grant super-admin → these are
	//     constructive verbs on a super-admin, but we still refuse
	//     them under the same rule for simplicity: nobody but the
	//     super-admin themselves operates on the super-admin row.
	//     Unlock would normally be a no-op anyway (super-admin can't
	//     be locked), and grant is a no-op (already admin). The
	//     blanket rule keeps the policy memorable: "the super-admin
	//     seat is read-only to everyone else."
	if IsSuperAdmin(target) && admin.ID != target.ID {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "super_admin_protected"})
		return
	}
	switch verb {
	case "lock":
		h.handleAdminLock(ctx, w, r, admin, target)
	case "unlock":
		h.handleAdminUnlock(ctx, w, r, admin, target)
	case "reset-password":
		h.handleAdminResetPassword(ctx, w, r, admin, target)
	case "grant-admin":
		h.handleAdminGrant(ctx, w, r, admin, target)
	case "workspace-cap":
		h.handleAdminWorkspaceCap(ctx, w, r, admin, target)
	case "revoke-admin":
		h.handleAdminRevoke(ctx, w, r, admin, target)
	default:
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not_found"})
	}
}

// handleAdminGrant promotes `target` to admin. The blast radius of this
// action is large — a freshly-promoted admin can immediately lock,
// reset, or further promote anyone. So we keep the gate tight:
//
//   - Target must not already be admin (already_admin, 409). no-op
//     hides the fact that the UI offered a button that shouldn't
//     have been there.
//   - Target must not be currently locked (target_locked, 409).
//     Promoting a locked account creates the weird state of an
//     admin who can't sign in, and an attacker who has gained a
//     temporary unlock window would benefit from the new privilege.
//
// Why no "cannot grant to self": you can't, because requireAdmin
// already proved the caller is admin. Self-grant is a no-op caught
// by already_admin.
func (h *Handler) handleAdminGrant(ctx context.Context, w http.ResponseWriter, r *http.Request, admin, target *User) {
	if target.IsAdmin {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "already_admin"})
		return
	}
	if locked, _, _ := lockStatus(target, time.Now().Unix()); locked {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "target_locked"})
		return
	}
	if err := h.Store.SetAdmin(ctx, target.ID, true); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "grant_failed"})
		return
	}
	_ = h.Store.LogAuditEvent(ctx, target.ID, "admin_granted",
		clientIP(r), r.UserAgent(), "granted_by=admin:"+admin.Username)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleAdminRevoke demotes `target` from admin to plain user. The
// guards mirror lock's "don't create a system lockout":
//
//   - 본인 강등 거부 (cannot_revoke_self): 자기 자신을 강등하면
//     활성 admin 한 명이 동시에 사라진다. 진짜 의도된 강등이라면
//     다른 admin 이 처리하면 된다. 자기 자신 처리 금지가 "조용히
//     마지막 admin 인지 검사" 보다 정직하다 — 의도된 단순한 거절.
//   - 마지막 admin 강등 거부 (cannot_revoke_last_admin): 본인이
//     아닌 다른 admin 을 강등할 때, 그가 마지막 활성 admin 이면
//     거부. CountActiveAdmins 가 target 포함값을 돌려주므로 그
//     값이 1 이면 강등 후 0 명이 된다는 뜻.
//   - Target 이 admin 이 아니면 not_admin (409) — 같은 no-op-hide
//     이유.
//
// 잠긴 admin 을 강등하는 건 허용한다. lock 상태에서는 CountActiveAdmins
// 가 그를 빼고 세므로 가드가 자연스럽게 통과/차단을 결정한다. 그리고
// "잠긴 admin 의 권한을 미리 떼어두는" 운영 시나리오(퇴사자 정리 등)
// 가 의미 있어서.
func (h *Handler) handleAdminRevoke(ctx context.Context, w http.ResponseWriter, r *http.Request, admin, target *User) {
	if target.ID == admin.ID {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "cannot_revoke_self"})
		return
	}
	if !target.IsAdmin {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "not_admin"})
		return
	}
	// CountActiveAdmins 는 잠긴 admin 을 제외하므로, target 이 unlocked
	// 라면 그가 카운트에 포함된다. 그 값이 1 이면 강등 후 0 명. 만약
	// target 이 잠긴 admin 이면 그는 카운트에 없으니 강등해도 활성
	// admin 수는 변하지 않아 가드가 발동하지 않는다 — 이게 위에서
	// 말한 "잠긴 admin 은 강등 가능" 동작이다.
	if locked, _, _ := lockStatus(target, time.Now().Unix()); !locked {
		n, err := h.Store.CountActiveAdmins(ctx)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "count_failed"})
			return
		}
		if n <= 1 {
			writeJSON(w, http.StatusConflict, map[string]any{"error": "cannot_revoke_last_admin"})
			return
		}
	}
	if err := h.Store.SetAdmin(ctx, target.ID, false); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "revoke_failed"})
		return
	}
	_ = h.Store.LogAuditEvent(ctx, target.ID, "admin_revoked",
		clientIP(r), r.UserAgent(), "revoked_by=admin:"+admin.Username)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleAdminLock blocks `target` from signing in by writing a permanent
// lock and revoking every refresh session. Mirrors the tier-2 lockout
// effect, but the cause is admin decision (suspected compromise, off-
// boarding) rather than brute-force escalation.
//
// 가드:
//   - 본인 잠금 거부 (cannot_lock_self): admin 이 실수로 자기를 잠그면
//     영구 락아웃이라 복구 비용이 크다. 자기 자신을 차단할 정당한
//     이유는 거의 없고, 있다면 logout/세션 해제 같은 별도 액션으로
//     충분하다.
//   - 마지막 admin 잠금 거부 (cannot_lock_last_admin): target 이
//     admin 이고, 그를 잠그면 시스템에 살아있는 admin 이 0 명이
//     되는 경우 차단. Entra ID / Okta / GitHub Enterprise 의 동일
//     가드와 같은 의도 — "어떤 admin 동작으로도 모든 admin 을
//     동시에 차단할 수 없다" 는 불변식을 유지한다.
//   - 이미 잠긴 사용자 재잠금 (already_locked, 409): no-op 이긴
//     하지만 admin UI 가 "잠금" 버튼을 잠긴 사용자에게 노출하지
//     않도록 보조하는 정직한 신호. 굳이 200 으로 swallow 하면
//     "잠금 해제" 버튼만 떠 있어야 할 자리에 "잠금" 버튼이
//     실수로 떠 있었다는 사실이 묻힌다.
//
// 효과:
//   - users.locked_until = LockedUntilPermanent (-1) — lockStatus 가
//     tier-2 영구 잠금과 동일하게 처리 → 다음 로그인 시도부터
//     423 Locked.
//   - 모든 refresh 세션 폐기 → access JWT 의 잔여 15분은 stateless
//     이지만 Authenticate() 가 매 요청 세션 검증을 하므로 즉시 401.
//   - audit account_locked_by_admin (meta=`locked_by=admin:<username>`).
//   - 사용자에게 메일 발송은 의도적으로 생략. lock 의 사유는 보안/
//     운영 결정인 경우가 많아 자동 통지가 오히려 사고 대응을
//     방해할 수 있다. 관리자가 별도 채널로 알리는 게 맞다.
func (h *Handler) handleAdminLock(ctx context.Context, w http.ResponseWriter, r *http.Request, admin, target *User) {
	if target.ID == admin.ID {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "cannot_lock_self"})
		return
	}
	// Already locked? No-op + signal so the UI can self-heal.
	if locked, _, _ := lockStatus(target, time.Now().Unix()); locked {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "already_locked"})
		return
	}
	// Last-admin guard: if target is an admin and locking them would
	// leave zero active admins, refuse. CountActiveAdmins already
	// filters out locked admins; target is unlocked here (we just
	// checked), so they're counted in the result. Locking them drops
	// the count by exactly 1.
	if target.IsAdmin {
		n, err := h.Store.CountActiveAdmins(ctx)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "count_failed"})
			return
		}
		if n <= 1 {
			writeJSON(w, http.StatusConflict, map[string]any{"error": "cannot_lock_last_admin"})
			return
		}
	}
	if err := h.Store.SetLockedUntil(ctx, target.ID, LockedUntilPermanent); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "lock_failed"})
		return
	}
	// Revoke every live session so the lock is effective NOW, not at
	// the next access-token expiry. The count is logged into the audit
	// meta for forensic clarity.
	revoked, _ := h.Store.RevokeAllSessionsForUser(ctx, target.ID)
	if h.OnSessionRevoked != nil {
		// Same SSE push the login flow uses to kick live clients —
		// any tab the target had open will receive session-revoked
		// within the next heartbeat.
		func() {
			defer func() { _ = recover() }()
			h.OnSessionRevoked(target.ID)
		}()
	}
	_ = h.Store.LogAuditEvent(ctx, target.ID, "account_locked_by_admin",
		clientIP(r), r.UserAgent(),
		fmt.Sprintf("locked_by=admin:%s revoked_sessions=%d", admin.Username, revoked))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "revokedSessions": revoked})
}

// handleAdminUnlock clears the lock on `target`. Called by the subtree
// dispatcher after admin/target are resolved.
//
// 잠금 해제는 세 층의 상태를 모두 리셋해야 한다. 하나라도 빠지면
// 사용자가 "잠금이 풀렸다" 고 들었는데 막상 로그인하면 다른 층에서
// 막혀 다시 잠긴 것처럼 보이는 혼란이 생긴다:
//
//  1. users.locked_until = 0  — DB 의 영구/임시 lock 신호.
//     lockStatus() 가 423 Locked 를 결정하는 1차 소스.
//  2. login_attempts 의 failed 행 삭제  — Phase 6.2 escalation 의
//     카운팅 소스. 안 비우면 tier-2(50회) 임계값에 걸린 계정을
//     admin 이 풀어도 다음 로그인 실패 한 번에 재-lock 된다.
//  3. LoginAcctFailLimiter ("acct:<id>")  — Phase 6.1 in-memory
//     sliding-window 한도(15분/5회). DB 와 독립적이라 별도 Reset
//     필요. 안 비우면 잠긴 동안 누적된 in-memory 카운터가 그대로
//     남아 unlock 직후 사용자가 로그인 하면 429 rate_limited
//     (scope=acct) 로 떨어지고, 프론트는 그걸 같은 "계정이 잠겼어요"
//     모달로 표시한다 → 사용자 입장에선 "여전히 잠긴 상태" 처럼
//     보인다. handleResetPasswordComplete 와 동일한 패턴이다.
func (h *Handler) handleAdminUnlock(ctx context.Context, w http.ResponseWriter, r *http.Request, admin, target *User) {
	if err := h.Store.SetLockedUntil(ctx, target.ID, 0); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "unlock_failed"})
		return
	}
	_ = h.Store.ClearFailedLoginAttempts(ctx, target.ID)
	if h.LoginAcctFailLimiter != nil {
		h.LoginAcctFailLimiter.Reset("acct:" + target.ID)
	}
	_ = h.Store.LogAuditEvent(ctx, target.ID, "account_unlocked",
		clientIP(r), r.UserAgent(), "unlocked_by=admin:"+admin.Username)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleAdminResetPassword issues a fresh password-reset token on behalf
// of `target` and returns the raw token + link to the admin so they can
// hand it off out-of-band (Slack, SMS, in-person). The user does NOT
// gain knowledge of the new password from the admin — they still set
// it themselves via /api/auth/reset-password/complete.
//
// Why this exists despite the user-driven reset flow already existing:
// in environments where outbound SMTP is blocked (the situation that
// surfaced this feature), the normal reset-by-email path silently
// stalls. The admin route gives an operator a manual delivery channel
// without ever holding the user's plaintext password.
//
// Security shape (matches the AWS IAM / Entra ID "one-time credential"
// pattern):
//   - Raw token appears exactly once, in this response. Lost = re-issue.
//   - DB only stores sha256(token); a DB dump can't replay it.
//   - 15-min TTL via passwordResetTTL — same as user-driven reset.
//   - Single-use via email_tokens.used_at — replay is rejected.
//   - Two audit rows: password_reset_issued_by_admin (under target),
//     and a best-effort email send so the user has an independent
//     side-channel notification IF SMTP is working.
//   - The handler does NOT clear users.locked_until itself. Lock
//     clearing happens automatically when the user completes the
//     reset, mirroring the user-driven flow. Admins who want to
//     unlock without forcing a password change should use /unlock.
func (h *Handler) handleAdminResetPassword(ctx context.Context, w http.ResponseWriter, r *http.Request, admin, target *User) {
	raw, hashHex, err := newURLToken()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "token_failed"})
		return
	}
	now := time.Now()
	expiresAt := now.Add(passwordResetTTL).Unix()
	if err := h.Store.CreateEmailToken(ctx, EmailToken{
		ID:        uuid.NewString(),
		UserID:    target.ID,
		Kind:      "reset",
		TokenHash: hashHex,
		CreatedAt: now.Unix(),
		ExpiresAt: expiresAt,
	}); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "token_persist_failed"})
		return
	}
	link := h.baseURL() + "/reset?token=" + raw

	// Background mail attempt — gives the user a parallel channel when
	// SMTP is healthy. The admin already has the link in the response,
	// so a send failure here does not affect the API outcome.
	body := fmt.Sprintf("안녕하세요.\n\n관리자가 floffi 계정의 비밀번호 재설정 링크를 발급했어요. 다음 링크에서 새 비밀번호를 설정해주세요:\n\n%s\n\n이 링크는 15분 동안만 유효합니다.\n본인이 요청한 것이 아니라면 관리자에게 문의해주세요.\n", link)
	h.sendEmailAsync("admin-reset-password", target.Email, "[floffi] 비밀번호 재설정 (관리자 발급)", body)

	// Audit: store the actor identity on the target's feed. The user's
	// own audit page should clearly show "admin X reset my password",
	// matching how account_unlocked already records the admin user.
	_ = h.Store.LogAuditEvent(ctx, target.ID, "password_reset_issued_by_admin",
		clientIP(r), r.UserAgent(), "issued_by=admin:"+admin.Username)

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":        true,
		"resetURL":  link,
		"expiresAt": expiresAt,
		"ttlSec":    int64(passwordResetTTL.Seconds()),
	})
}

// handleAdminWorkspaceCap sets or clears the per-user workspace cap
// override. Body: { "cap": 5 } sets it; { "cap": null } clears.
//
// Why allow clearing: an admin who lifted a user's cap for a one-off
// project later wants the user to fall back to the global default
// without having to remember what the default was. Passing null is
// the explicit way to say "revert to default".
func (h *Handler) handleAdminWorkspaceCap(ctx context.Context, w http.ResponseWriter, r *http.Request, admin, target *User) {
	var body struct {
		// *int so a JSON null distinguishes "clear override" from
		// "didn't include this field at all". The latter would be a
		// 400; the former is a valid no-op-revert.
		Cap *int `json:"cap"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	if body.Cap != nil && *body.Cap < 1 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "cap_must_be_positive"})
		return
	}
	if err := h.Store.SetWorkspaceCapOverride(ctx, target.ID, body.Cap); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "set_failed"})
		return
	}
	meta := "cleared"
	if body.Cap != nil {
		meta = fmt.Sprintf("cap=%d", *body.Cap)
	}
	_ = h.Store.LogAuditEvent(ctx, target.ID, "workspace_cap_changed_by_admin",
		clientIP(r), r.UserAgent(), fmt.Sprintf("changed_by=admin:%s %s", admin.Username, meta))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// adminPayload returns the shape we want to merge into /api/auth/session
// + /api/auth/login responses when the user is an admin. Keeping the
// flag visible to the client lets the SecurityPanel mount the admin
// section without an extra round-trip.
//
// The caller stitches this in by `data["isAdmin"] = true` when the user
// is admin — we don't bother with a struct just for one bool.
var _ = json.Marshal // keep encoding/json imported even if no inline marshal used
