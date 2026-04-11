package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// ErrRefreshReuse is returned when a refresh token that has already been
// rotated (and thus revoked) is presented again — the classic
// attacker-stole-the-cookie signal. The full session chain is burned as a
// side effect; the caller should also clear cookies and force re-login.
var ErrRefreshReuse = errors.New("refresh token reuse detected")

// IssueRefresh creates a fresh refresh_sessions row tied to userID and
// returns (sessionID, rawToken). The raw token is the only time the
// plaintext exists; we store sha256 in the DB. mfa_at is set to "now" so
// a freshly issued session passes the step-up window.
func (s *Store) IssueRefresh(ctx context.Context, userID, userAgent, ip string) (sessionID, rawToken string, err error) {
	rawToken, hashHex, err := newRefreshToken()
	if err != nil {
		return "", "", err
	}
	sessionID = uuid.NewString()
	now := time.Now().Unix()
	sess := Session{
		ID:         sessionID,
		UserID:     userID,
		TokenHash:  hashHex,
		ParentID:   sql.NullString{},
		CreatedAt:  now,
		ExpiresAt:  now + int64(RefreshTokenTTL.Seconds()),
		LastUsedAt: now,
		UserAgent:  userAgent,
		IP:         ip,
		MFAAt:      now,
	}
	if err := s.CreateSession(ctx, sess); err != nil {
		return "", "", fmt.Errorf("auth: create session: %w", err)
	}
	return sessionID, rawToken, nil
}

// RotateRefresh validates the presented raw token against the session row
// keyed by sessionID, then atomically issues a new session row whose
// parent_id is the old one. Returns (newSessionID, newRawToken).
//
// Reuse detection: if the row is already revoked OR the hash doesn't
// match the stored hash, the entire chain rooted at sessionID is revoked
// and ErrRefreshReuse is returned.
func (s *Store) RotateRefresh(ctx context.Context, sessionID, rawToken, userAgent, ip string) (newID, newRaw string, err error) {
	old, err := s.FindSession(ctx, sessionID)
	if err != nil {
		return "", "", err
	}
	now := time.Now().Unix()

	// Reuse: rotated row presented again, or hash mismatch.
	if old.RevokedAt != 0 || !constantTimeEqual(old.TokenHash, hashRefresh(rawToken)) {
		_ = s.RevokeSessionChain(ctx, sessionID, now)
		return "", "", ErrRefreshReuse
	}
	if now > old.ExpiresAt {
		_ = s.MarkSessionRevoked(ctx, sessionID, now)
		return "", "", ErrSessionRevoked
	}

	rawNew, hashNew, err := newRefreshToken()
	if err != nil {
		return "", "", err
	}
	newID = uuid.NewString()
	newSess := Session{
		ID:         newID,
		UserID:     old.UserID,
		TokenHash:  hashNew,
		ParentID:   sql.NullString{String: old.ID, Valid: true},
		CreatedAt:  now,
		ExpiresAt:  now + int64(RefreshTokenTTL.Seconds()),
		LastUsedAt: now,
		UserAgent:  userAgent,
		IP:         ip,
		MFAAt:      old.MFAAt, // 회전 시 step-up 타임스탬프 보존
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", "", err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`UPDATE refresh_sessions SET revoked_at = ? WHERE id = ? AND revoked_at = 0`,
		now, old.ID); err != nil {
		return "", "", err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO refresh_sessions (id, user_id, token_hash, parent_id,
		                              created_at, expires_at, last_used_at,
		                              user_agent, ip, revoked_at, mfa_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
		newSess.ID, newSess.UserID, newSess.TokenHash, newSess.ParentID.String,
		newSess.CreatedAt, newSess.ExpiresAt, newSess.LastUsedAt,
		newSess.UserAgent, newSess.IP, newSess.MFAAt); err != nil {
		return "", "", err
	}
	if err := tx.Commit(); err != nil {
		return "", "", err
	}
	return newID, rawNew, nil
}

// RevokeSession marks a single session as revoked (used by logout).
func (s *Store) RevokeSession(ctx context.Context, sessionID string) error {
	return s.MarkSessionRevoked(ctx, sessionID, time.Now().Unix())
}

// hashRefresh returns the hex sha256 of a raw refresh token.
func hashRefresh(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

func newRefreshToken() (raw, hashHex string, err error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", "", fmt.Errorf("auth: read random: %w", err)
	}
	raw = base64.RawURLEncoding.EncodeToString(buf)
	hashHex = hashRefresh(raw)
	return raw, hashHex, nil
}

// constantTimeEqual avoids the timing side-channel that strings.Equal would
// expose. Hex strings are always the same length so direct byte compare is
// safe to constant-time.
func constantTimeEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var diff byte
	for i := 0; i < len(a); i++ {
		diff |= a[i] ^ b[i]
	}
	return diff == 0
}
