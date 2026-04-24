package auth

// devices.go — Phase 6.3: known-device fingerprinting + new-device
// notifications.
//
// Goal: when a session-issuing event (signup, password login, MFA
// completion) lands from a (user, ip, user-agent) tuple we've never
// seen before, send the account-holder an email so they can react if
// it wasn't them. We don't try to be clever about subnet aggregation
// or browser-fingerprint parsing — exact (ip_hash, ua_hash) matching
// produces some false-positive notifications (e.g. when a phone hops
// from wifi to cell), but those are loud-but-honest, which is the
// right failure mode for a security alert. False NEGATIVES are the
// dangerous case, and exact matching has none.
//
// Privacy: we never store the raw IP or User-Agent. They get sha256'd
// before insert, so a DB dump can't reconstruct per-user location
// history.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
)

// hashIPUA returns the (ip_hash, ua_hash) pair we store/lookup against.
// Empty strings are hashed too — we don't special-case missing fields,
// so a request with no UA still gets a stable bucket.
func hashIPUA(ip, ua string) (ipHash, uaHash string) {
	a := sha256.Sum256([]byte(ip))
	b := sha256.Sum256([]byte(ua))
	return hex.EncodeToString(a[:]), hex.EncodeToString(b[:])
}

// rememberDevice records a (user, ip, ua) tuple and reports whether it
// was previously unknown. We use a tx so the SELECT-then-INSERT/UPDATE
// is atomic — two simultaneous logins from the same new device must
// only fire one "new device" email, not two.
func (s *Store) rememberDevice(ctx context.Context, userID, ipHash, uaHash string) (isNew bool, err error) {
	now := time.Now().Unix()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()

	var existingID string
	err = tx.QueryRowContext(ctx, `
		SELECT id FROM known_devices
		WHERE user_id = ? AND ip_hash = ? AND ua_hash = ?`,
		userID, ipHash, uaHash).Scan(&existingID)
	switch err {
	case nil:
		// Known device — just touch last_seen.
		if _, err := tx.ExecContext(ctx, `
			UPDATE known_devices SET last_seen = ? WHERE id = ?`,
			now, existingID); err != nil {
			return false, err
		}
		return false, tx.Commit()
	default:
		// Any "not found" surface is treated as new. We don't import
		// sql here just to compare; modernc returns sql.ErrNoRows.
		if err.Error() != "sql: no rows in result set" {
			return false, err
		}
	}

	// Truly new — insert. The UNIQUE index guards against a concurrent
	// peer inserting the same tuple between our SELECT and this
	// INSERT; if that happens we collapse to "not new" so we don't
	// double-email.
	_, err = tx.ExecContext(ctx, `
		INSERT INTO known_devices (id, user_id, ip_hash, ua_hash, first_seen, last_seen)
		VALUES (?, ?, ?, ?, ?, ?)`,
		uuid.NewString(), userID, ipHash, uaHash, now, now)
	if err != nil {
		// UNIQUE violation → another writer beat us to it. Treat as
		// not-new and let the prior row stand.
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return false, tx.Commit()
		}
		return false, err
	}
	return true, tx.Commit()
}

// registerDeviceQuietly is the signup path — we want the gating row in
// known_devices but DON'T want to email the user "new device" the
// moment they create their account.
func (s *Store) registerDeviceQuietly(ctx context.Context, userID, ipHash, uaHash string) error {
	_, err := s.rememberDevice(ctx, userID, ipHash, uaHash)
	return err
}

// notifyIfNewDevice is the post-login hook. Pulls user + fingerprints
// the request, then sends a "new device" email when warranted. Audit
// row is best-effort and never blocks the response.
//
// Called from handleLogin (no-MFA branch) and finishMFALogin so both
// paths to a fresh session get the same treatment.
func (h *Handler) notifyIfNewDevice(ctx context.Context, user *User, r *http.Request) {
	ip := clientIP(r)
	ua := r.UserAgent()
	ipHash, uaHash := hashIPUA(ip, ua)

	isNew, err := h.Store.rememberDevice(ctx, user.ID, ipHash, uaHash)
	if err != nil || !isNew {
		return
	}
	// Mail body: keep it short. The IP appears raw in the email (where
	// the user owns the channel), not in the DB.
	body := fmt.Sprintf(
		"안녕하세요.\n\n새로운 위치 또는 기기에서 floffi 계정에 로그인되었어요.\n\n"+
			"  - IP: %s\n"+
			"  - 브라우저/기기: %s\n"+
			"  - 시각: %s\n\n"+
			"본인이 한 로그인이 맞다면 이 메일은 무시해주세요. "+
			"본인이 아니라면 즉시 비밀번호를 변경하고 워크스페이스 보안 패널에서 다른 세션을 모두 해제해주세요.\n",
		ip, truncate(ua, 200), time.Now().Format(time.RFC3339))
	h.sendEmailAsync("new-device", user.Email,
		"[floffi] 새 위치에서 로그인되었어요", body)
	_ = h.Store.LogAuditEvent(ctx, user.ID, "new_device_login",
		ip, ua, "")
}

// notifySessionKicked tells the account holder that another device
// just signed in and that this caused N existing sessions to be
// revoked. Last-wins policy means a credential leak would silently
// kick the legitimate user — without this mail they'd notice only
// when they next clicked something and got a 401, possibly losing
// in-flight work. The mail gives them an immediate side-channel
// signal so they can react (rotate password, enable TOTP) within
// minutes instead of "next time they sign in".
//
// kickedCount is the number reported by RevokeAllUserSessions. We
// only mail when it's at least 1, so a fresh signup or a login that
// happens to be the user's only active session never spams them.
//
// reason is a short tag included in both the mail body and the audit
// row so future debugging can tell "kicked by new login" from
// "kicked by toggling single_session on" apart.
func (h *Handler) notifySessionKicked(ctx context.Context, user *User, kickedCount int, r *http.Request, reason string) {
	if kickedCount <= 0 {
		return
	}
	ip := clientIP(r)
	ua := r.UserAgent()
	body := fmt.Sprintf(
		"안녕하세요.\n\n다른 디바이스에서 새로 로그인되어 기존에 사용 중이던 세션 %d개가 자동으로 종료되었어요.\n\n"+
			"  - 새 로그인 IP: %s\n"+
			"  - 새 디바이스: %s\n"+
			"  - 시각: %s\n"+
			"  - 사유: %s\n\n"+
			"본인이 다른 디바이스에서 로그인하신 거라면 이 메일은 무시해주세요. "+
			"본인이 아니라면 즉시 비밀번호를 변경하고, 워크스페이스 보안 패널에서 "+
			"TOTP 2단계 인증을 활성화해주세요.\n",
		kickedCount, ip, truncate(ua, 200), time.Now().Format(time.RFC3339), reason)
	h.sendEmailAsync("session-kick", user.Email,
		"[floffi] 다른 곳에서 로그인되어 세션이 종료되었어요", body)
	_ = h.Store.LogAuditEvent(ctx, user.ID, "session_kick_notified",
		ip, ua, fmt.Sprintf("n=%d reason=%s", kickedCount, reason))
}

// truncate caps s at n runes (not bytes) for safe inclusion in the
// email body. Long User-Agent strings from custom clients shouldn't be
// able to bloat the mail.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	// Byte-level cap is fine for the UA header which is ASCII in
	// practice, but we round down to a rune boundary just in case
	// something exotic shows up.
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n]) + "…"
}
