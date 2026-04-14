package auth

// lockout.go — Phase 6.2 account-lock escalation.
//
// We trip two DB-backed tiers, layered on top of the existing in-memory
// rate limit (5 failures / 15 min → 429 throttle, see ratelimit.go).
// The rate limit gives short cool-downs against opportunistic brute
// force; the tiers below catch sustained attacks and survive a process
// restart by persisting users.locked_until.
//
//   Tier 1 (reset-required): 5 failed attempts within 1 hour → locked
//       until the user completes the email-based password reset flow.
//       No time-based auto-recovery — re-auth via email is the only
//       way out. Implemented by writing a far-future locked_until so
//       the existing time-comparison branch stays correct; the reset
//       handler clears it on success.
//   Tier 2 (permanent): 50 failed attempts within 24 hours → admin unlock
//
// On a successful login we clear both the failure history and the
// locked_until value (see handleLogin), so a user who finally remembers
// their password is back to a clean slate. However a tier-1 lock blocks
// the verify step, so "successful login while tier-1 locked" cannot
// happen — the only escape is handleResetPasswordComplete, which
// clears locked_until + failure history as part of "re-auth via email".

import (
	"context"
	"net/http"
	"time"
)

const (
	// Escalation tier 1 — recoverable only by password reset. Threshold
	// matches the in-memory per-account 429 limiter (5 fails / 15 min)
	// so the user hits the persistent DB lock at the same time, not
	// after a second round. Recovery: complete the email-based password
	// reset (handleResetPasswordComplete clears the lock). The lock is
	// stored as a far-future expiry rather than a sentinel so the
	// existing `locked_until > now` branch in lockStatus and the
	// `!= LockedUntilPermanent` branch in the reset handler keep
	// working unchanged. ~100 years is comfortably past the int64
	// unix-second ceiling concerns and easy to spot in DB inspection.
	lockTier1Threshold = 5
	lockTier1Window    = 1 * time.Hour
	lockTier1Duration  = 100 * 365 * 24 * time.Hour

	// Escalation tier 2 — long, manual recovery.
	lockTier2Threshold = 50
	lockTier2Window    = 24 * time.Hour
)

// lockStatus reports whether a user is currently locked out and, if so,
// returns the lock's expiry and tier. now is passed in so tests can
// drive deterministic timing without monkey-patching time.Now.
//
//   level=0: not locked
//   level=1: tier-1 temporary lock
//   level=2: tier-2 permanent lock (until is reported as
//            LockedUntilPermanent so the caller can branch its UI)
func lockStatus(u *User, now int64) (locked bool, until int64, level int) {
	if u == nil || u.LockedUntil == 0 {
		return false, 0, 0
	}
	if u.LockedUntil == LockedUntilPermanent {
		return true, LockedUntilPermanent, 2
	}
	if u.LockedUntil > now {
		return true, u.LockedUntil, 1
	}
	// LockedUntil is set but already in the past — caller treats this as
	// "not locked" and will clear the field on the next successful login.
	return false, 0, 0
}

// maybeEscalateLock is invoked after a failed login. It counts recent
// failures in the two escalation windows and writes a lock + audit row
// if the threshold is met. Best-effort: a count error doesn't fail the
// login response (the caller already returned 401 to the user).
func (h *Handler) maybeEscalateLock(ctx context.Context, user *User, r *http.Request) {
	now := time.Now().Unix()
	// Tier 2 is checked first because crossing it is strictly more
	// severe than tier 1, and we don't want a 1h lock to mask a
	// permanent-lock-eligible account from showing up correctly.
	if fails24h, err := h.Store.CountFailedLoginAttemptsSince(ctx, user.ID, now-int64(lockTier2Window.Seconds())); err == nil && fails24h >= lockTier2Threshold {
		_ = h.Store.SetLockedUntil(ctx, user.ID, LockedUntilPermanent)
		_ = h.Store.LogAuditEvent(ctx, user.ID, "account_locked_permanent",
			clientIP(r), r.UserAgent(), "fails_24h=50+")
		return
	}
	if fails1h, err := h.Store.CountFailedLoginAttemptsSince(ctx, user.ID, now-int64(lockTier1Window.Seconds())); err == nil && fails1h >= lockTier1Threshold {
		_ = h.Store.SetLockedUntil(ctx, user.ID, now+int64(lockTier1Duration.Seconds()))
		_ = h.Store.LogAuditEvent(ctx, user.ID, "account_locked_temporary",
			clientIP(r), r.UserAgent(), "fails_1h=5+ reset_required=1")
	}
}
