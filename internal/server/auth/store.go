// Package auth owns the SQLite-backed user/session store and the HTTP
// handlers for /api/auth/*. Phase 1 + 2 of plan/auth-implementation.md.
package auth

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Common error sentinels exposed to handlers + tests.
var (
	ErrUserNotFound       = errors.New("user not found")
	ErrSessionNotFound    = errors.New("session not found")
	ErrSessionRevoked     = errors.New("session revoked")
	ErrDuplicateEmail     = errors.New("email already registered")
	ErrDuplicateUsername  = errors.New("username already taken")
	ErrEmailTokenNotFound = errors.New("email token not found")
	ErrEmailTokenUsed     = errors.New("email token already used")
	ErrEmailTokenExpired  = errors.New("email token expired")
	ErrChallengeNotFound  = errors.New("mfa challenge not found")
	ErrChallengeExpired   = errors.New("mfa challenge expired")
)

// Store wraps the *sql.DB with typed methods. One per process.
type Store struct {
	db *sql.DB
}

// User mirrors a row in `users`. Zero values are safe for new inserts.
type User struct {
	ID            string
	Email         string
	EmailVerified bool
	Username      string
	PasswordHash  string
	CreatedAt     int64
	UpdatedAt     int64
	LockedUntil   int64
	TOTPSecret    string
	TOTPEnabled   bool
	// SingleSession: when true, a successful login on a NEW device revokes
	// every other active refresh session for this user. Opt-in.
	SingleSession bool
	// IsAdmin: Phase 6.4 — admin-view permission. Set on the legacy admin
	// seed and via Store.SetAdmin. Only users.is_admin=1 can hit the
	// /api/auth/admin/* routes.
	IsAdmin bool
	// Nickname: Phase 7 — user-editable display name. Replaces the old
	// "username" affordance in the UI (topbar avatar, inbox honorific,
	// admin user list). Empty means "fall back to the email's local
	// part" — most users will never bother to set one, so the read
	// path supplies a sensible default.
	Nickname string
	// Avatar: user-editable avatar override (typically a single emoji),
	// independent of Nickname. Empty means "fall back to the nickname's
	// first code point" — the legacy initial-letter behaviour.
	Avatar string
}

// Session mirrors a row in `refresh_sessions`. token_hash is the sha256 of
// the opaque refresh token; we never store the raw token.
//
// MFAAt records the last "strong auth" moment (MFA pass or fresh password
// login) for this session chain. It's copied across refresh rotations so
// plain refresh can't extend the step-up window — only an explicit
// re-authentication does.
type Session struct {
	ID         string
	UserID     string
	TokenHash  string
	ParentID   sql.NullString
	CreatedAt  int64
	ExpiresAt  int64
	LastUsedAt int64
	UserAgent  string
	IP         string
	RevokedAt  int64
	MFAAt      int64
}

// Open creates `.data/` if needed, opens the SQLite DB and runs the init
// migration. Safe to call once per server boot.
func Open(path string) (*Store, error) {
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("auth: mkdir %s: %w", dir, err)
		}
	}

	// `_pragma=foreign_keys(1)` enforces the ON DELETE CASCADE on refresh
	// sessions / recovery codes when a user row is deleted.
	dsn := path + "?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("auth: open db: %w", err)
	}
	db.SetMaxOpenConns(1) // SQLite + WAL: a single writer keeps locking simple.

	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

// Close releases the underlying DB handle.
func (s *Store) Close() error { return s.db.Close() }

// DB exposes the raw *sql.DB for tests that need to inspect rows directly.
func (s *Store) DB() *sql.DB { return s.db }

// migrate applies every embedded *.sql file under migrations/ in alphabetical
// order. Each file runs inside its own transaction so a mid-file failure can't
// half-apply.
//
// Idempotency notes:
//   - 0001_init.sql uses CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT
//     EXISTS, so re-running is a no-op.
//   - 0002_user_security_prefs.sql does ALTER TABLE ADD COLUMN, which SQLite
//     does NOT support with an IF NOT EXISTS clause. We detect the
//     "duplicate column name" error and swallow it so re-running migrate()
//     on an already-upgraded DB is harmless.
func (s *Store) migrate() error {
	entries, err := migrationFS.ReadDir("migrations")
	if err != nil {
		return fmt.Errorf("auth: read migrations dir: %w", err)
	}
	// embed.FS already returns entries sorted by name, but be explicit so a
	// reader doesn't have to remember that.
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sortStrings(names)

	for _, name := range names {
		data, err := migrationFS.ReadFile("migrations/" + name)
		if err != nil {
			return fmt.Errorf("auth: read migration %s: %w", name, err)
		}
		if err := s.applyMigration(name, string(data)); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) applyMigration(name, sql string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("auth: migration %s begin: %w", name, err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec(sql); err != nil {
		// "duplicate column name" surfaces from ALTER TABLE ADD COLUMN
		// when the column already exists. Swallow so re-runs are safe.
		if strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
			return nil
		}
		return fmt.Errorf("auth: migration %s apply: %w", name, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("auth: migration %s commit: %w", name, err)
	}
	return nil
}

// sortStrings is a tiny insertion sort kept local so the migrate path
// doesn't pull in `sort` just for a 1–10 element slice.
func sortStrings(a []string) {
	for i := 1; i < len(a); i++ {
		for j := i; j > 0 && a[j-1] > a[j]; j-- {
			a[j-1], a[j] = a[j], a[j-1]
		}
	}
}

// CountUsers returns the total number of rows in `users`. Used by the
// legacy-admin seed path so existing deployments aren't locked out.
func (s *Store) CountUsers(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

// DeleteUserByID hard-deletes a user row. FK CASCADE on the auth-scoped
// tables (refresh_sessions, email_tokens, recovery_codes, recovery_codes_v2,
// mfa_challenges, known_devices) wipes their dependent rows automatically.
//
// audit_log + login_attempts intentionally keep the (now orphaned) user_id
// reference — they're historical records, and a separate `account_deleted`
// audit row makes the deletion itself grep-able. Callers should LogAuditEvent
// *before* calling this so the trail survives the cascade.
//
// FK enforcement is enabled in Open() via `_pragma=foreign_keys(1)`, so the
// cascade fires reliably.
func (s *Store) DeleteUserByID(ctx context.Context, userID string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, userID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrUserNotFound
	}
	return nil
}

// CreateUser inserts a new user. Caller supplies the already-hashed password.
// Returns ErrDuplicateEmail / ErrDuplicateUsername on unique violations.
func (s *Store) CreateUser(ctx context.Context, u User) error {
	now := time.Now().Unix()
	if u.CreatedAt == 0 {
		u.CreatedAt = now
	}
	if u.UpdatedAt == 0 {
		u.UpdatedAt = now
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO users (id, email, email_verified, username, password_hash,
		                   created_at, updated_at, locked_until, totp_secret, totp_enabled,
		                   single_session, is_admin, nickname, avatar)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		u.ID, u.Email, boolToInt(u.EmailVerified), u.Username, u.PasswordHash,
		u.CreatedAt, u.UpdatedAt, u.LockedUntil, u.TOTPSecret, boolToInt(u.TOTPEnabled),
		boolToInt(u.SingleSession), boolToInt(u.IsAdmin), u.Nickname, u.Avatar,
	)
	if err != nil {
		// modernc.org/sqlite returns errors of the form "constraint failed:
		// UNIQUE constraint failed: users.email". Map to typed sentinels so
		// the handler can return a clean 409.
		msg := err.Error()
		if strings.Contains(msg, "users.email") {
			return ErrDuplicateEmail
		}
		if strings.Contains(msg, "users.username") {
			return ErrDuplicateUsername
		}
		return err
	}
	return nil
}

// FindUserByEmail does a case-sensitive lookup. Callers must normalize email
// to lowercase before calling.
func (s *Store) FindUserByEmail(ctx context.Context, email string) (*User, error) {
	return s.findUser(ctx, `WHERE email = ?`, email)
}

// FindUserByID looks up by the primary-key UUID.
func (s *Store) FindUserByID(ctx context.Context, id string) (*User, error) {
	return s.findUser(ctx, `WHERE id = ?`, id)
}

// FindUserByUsername looks up by the lowercase handle.
func (s *Store) FindUserByUsername(ctx context.Context, username string) (*User, error) {
	return s.findUser(ctx, `WHERE username = ?`, username)
}

func (s *Store) findUser(ctx context.Context, where string, arg string) (*User, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, email, email_verified, username, password_hash,
		       created_at, updated_at, locked_until, totp_secret, totp_enabled,
		       single_session, is_admin, nickname, avatar
		FROM users `+where, arg)
	var u User
	var ev, te, ss, ia int
	err := row.Scan(&u.ID, &u.Email, &ev, &u.Username, &u.PasswordHash,
		&u.CreatedAt, &u.UpdatedAt, &u.LockedUntil, &u.TOTPSecret, &te, &ss, &ia, &u.Nickname, &u.Avatar)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUserNotFound
	}
	if err != nil {
		return nil, err
	}
	u.EmailVerified = ev != 0
	u.TOTPEnabled = te != 0
	u.SingleSession = ss != 0
	u.IsAdmin = ia != 0
	return &u, nil
}

// CreateSession inserts a refresh_sessions row. Caller computes token_hash.
func (s *Store) CreateSession(ctx context.Context, sess Session) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO refresh_sessions (id, user_id, token_hash, parent_id,
		                              created_at, expires_at, last_used_at,
		                              user_agent, ip, revoked_at, mfa_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		sess.ID, sess.UserID, sess.TokenHash, nullStr(sess.ParentID),
		sess.CreatedAt, sess.ExpiresAt, sess.LastUsedAt,
		sess.UserAgent, sess.IP, sess.RevokedAt, sess.MFAAt,
	)
	return err
}

// FindSession returns the row by primary key.
func (s *Store) FindSession(ctx context.Context, id string) (*Session, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, user_id, token_hash, parent_id, created_at, expires_at,
		       last_used_at, user_agent, ip, revoked_at, mfa_at
		FROM refresh_sessions WHERE id = ?`, id)
	var sess Session
	err := row.Scan(&sess.ID, &sess.UserID, &sess.TokenHash, &sess.ParentID,
		&sess.CreatedAt, &sess.ExpiresAt, &sess.LastUsedAt,
		&sess.UserAgent, &sess.IP, &sess.RevokedAt, &sess.MFAAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrSessionNotFound
	}
	if err != nil {
		return nil, err
	}
	return &sess, nil
}

// MarkSessionRevoked stamps revoked_at on a single row.
func (s *Store) MarkSessionRevoked(ctx context.Context, id string, at int64) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE refresh_sessions SET revoked_at = ? WHERE id = ? AND revoked_at = 0`,
		at, id)
	return err
}

// RevokeSessionChain walks descendants (sessions whose parent_id eventually
// resolves to startID, in either direction) and stamps revoked_at on all of
// them. Used for refresh-token reuse detection: if attacker presents an old
// (already-rotated) refresh token, we burn the whole chain so neither party
// can keep using it.
//
// Walk strategy: collect ancestors (parent_id chain) AND descendants
// (rows whose parent_id matches anything in the current set), iteratively
// until the set stabilizes.
func (s *Store) RevokeSessionChain(ctx context.Context, startID string, at int64) error {
	seen := map[string]struct{}{startID: {}}
	frontier := []string{startID}

	for len(frontier) > 0 {
		next := []string{}
		// Ancestors: parent_id of current frontier rows.
		for _, id := range frontier {
			var pid sql.NullString
			err := s.db.QueryRowContext(ctx,
				`SELECT parent_id FROM refresh_sessions WHERE id = ?`, id).Scan(&pid)
			if err == nil && pid.Valid {
				if _, ok := seen[pid.String]; !ok {
					seen[pid.String] = struct{}{}
					next = append(next, pid.String)
				}
			}
		}
		// Descendants: rows whose parent_id is in the current frontier.
		for _, id := range frontier {
			rows, err := s.db.QueryContext(ctx,
				`SELECT id FROM refresh_sessions WHERE parent_id = ?`, id)
			if err != nil {
				return err
			}
			for rows.Next() {
				var childID string
				if err := rows.Scan(&childID); err != nil {
					rows.Close()
					return err
				}
				if _, ok := seen[childID]; !ok {
					seen[childID] = struct{}{}
					next = append(next, childID)
				}
			}
			rows.Close()
		}
		frontier = next
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(ctx,
		`UPDATE refresh_sessions SET revoked_at = ? WHERE id = ? AND revoked_at = 0`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for id := range seen {
		if _, err := stmt.ExecContext(ctx, at, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// UpdateSecurityPrefs flips the per-user single_session flag.
func (s *Store) UpdateSecurityPrefs(ctx context.Context, userID string, singleSession bool) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE users SET single_session = ?, updated_at = ? WHERE id = ?`,
		boolToInt(singleSession), time.Now().Unix(), userID)
	return err
}

// GetSecurityPrefs returns the user's single_session pref. ErrUserNotFound
// when the row is missing.
func (s *Store) GetSecurityPrefs(ctx context.Context, userID string) (bool, error) {
	var ss int
	err := s.db.QueryRowContext(ctx,
		`SELECT single_session FROM users WHERE id = ?`, userID).Scan(&ss)
	if errors.Is(err, sql.ErrNoRows) {
		return false, ErrUserNotFound
	}
	if err != nil {
		return false, err
	}
	return ss != 0, nil
}

// RevokeAllUserSessions stamps revoked_at on every active refresh_sessions
// row for userID except exceptSessionID (which is typically the session that
// just authenticated). Returns the number of rows affected.
func (s *Store) RevokeAllUserSessions(ctx context.Context, userID, exceptSessionID string) (int, error) {
	now := time.Now().Unix()
	res, err := s.db.ExecContext(ctx, `
		UPDATE refresh_sessions
		   SET revoked_at = ?
		 WHERE user_id = ?
		   AND id != ?
		   AND revoked_at = 0`, now, userID, exceptSessionID)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}
	return int(n), nil
}

// ListActiveSessions returns all non-revoked refresh_sessions rows for userID
// ordered by last_used_at desc. Used by /api/auth/sessions for the UI list.
func (s *Store) ListActiveSessions(ctx context.Context, userID string) ([]Session, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, user_id, token_hash, parent_id, created_at, expires_at,
		       last_used_at, user_agent, ip, revoked_at, mfa_at
		FROM refresh_sessions
		WHERE user_id = ? AND revoked_at = 0
		ORDER BY last_used_at DESC, created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Session
	for rows.Next() {
		var sess Session
		if err := rows.Scan(&sess.ID, &sess.UserID, &sess.TokenHash, &sess.ParentID,
			&sess.CreatedAt, &sess.ExpiresAt, &sess.LastUsedAt,
			&sess.UserAgent, &sess.IP, &sess.RevokedAt, &sess.MFAAt); err != nil {
			return nil, err
		}
		out = append(out, sess)
	}
	return out, rows.Err()
}

// AuditEvent is the lightweight projection of an audit_log row that the
// handler returns to the frontend. id/at are stored as unix seconds.
type AuditEvent struct {
	Event     string
	IP        string
	UserAgent string
	Meta      string
	At        int64
}

// ListAuditEvents returns the most recent audit_log rows for userID, newest
// first. Caller passes the cap; handler is responsible for clamping.
func (s *Store) ListAuditEvents(ctx context.Context, userID string, limit int) ([]AuditEvent, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT event, ip, user_agent, meta, at
		FROM audit_log
		WHERE user_id = ?
		ORDER BY id DESC
		LIMIT ?`, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AuditEvent
	for rows.Next() {
		var e AuditEvent
		if err := rows.Scan(&e.Event, &e.IP, &e.UserAgent, &e.Meta, &e.At); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// LogAuditEvent inserts a row into audit_log. Best-effort — callers should
// log but never abort on failure. userID may be empty for events that are
// not tied to a specific account (e.g. anonymous probes).
func (s *Store) LogAuditEvent(ctx context.Context, userID, event, ip, ua, meta string) error {
	var uid any
	if userID != "" {
		uid = userID
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO audit_log (user_id, event, ip, user_agent, meta, at)
		VALUES (?, ?, ?, ?, ?, ?)`,
		uid, event, ip, ua, meta, time.Now().Unix())
	return err
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func nullStr(s sql.NullString) any {
	if s.Valid {
		return s.String
	}
	return nil
}

// ── Email tokens (verify / reset) ────────────────────────────────────

// EmailToken mirrors a row in email_tokens. Phase 3 uses two kinds:
// "verify" (24h TTL) and "reset" (15min TTL). token_hash is sha256(token).
type EmailToken struct {
	ID        string
	UserID    string
	Kind      string
	TokenHash string
	CreatedAt int64
	ExpiresAt int64
	UsedAt    int64
}

// FindActiveEmailToken returns the most recent unused, unexpired token of
// the given kind for userID. Used by start-verify to avoid spamming the
// mailbox: if a valid one already exists, reuse it instead of issuing fresh.
func (s *Store) FindActiveEmailToken(ctx context.Context, userID, kind string) (*EmailToken, error) {
	now := time.Now().Unix()
	row := s.db.QueryRowContext(ctx, `
		SELECT id, user_id, kind, token_hash, created_at, expires_at, used_at
		FROM email_tokens
		WHERE user_id = ? AND kind = ? AND used_at = 0 AND expires_at > ?
		ORDER BY created_at DESC LIMIT 1`, userID, kind, now)
	var t EmailToken
	err := row.Scan(&t.ID, &t.UserID, &t.Kind, &t.TokenHash, &t.CreatedAt, &t.ExpiresAt, &t.UsedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrEmailTokenNotFound
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// CreateEmailToken inserts a new email_tokens row.
func (s *Store) CreateEmailToken(ctx context.Context, t EmailToken) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO email_tokens (id, user_id, kind, token_hash, created_at, expires_at, used_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		t.ID, t.UserID, t.Kind, t.TokenHash, t.CreatedAt, t.ExpiresAt, t.UsedAt)
	return err
}

// ConsumeEmailToken validates (kind, hash) against an unused, unexpired row
// and marks it used in the same transaction so the call is single-shot. The
// matched row is returned so the caller can find the linked user_id.
func (s *Store) ConsumeEmailToken(ctx context.Context, kind, tokenHash string) (*EmailToken, error) {
	now := time.Now().Unix()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	row := tx.QueryRowContext(ctx, `
		SELECT id, user_id, kind, token_hash, created_at, expires_at, used_at
		FROM email_tokens
		WHERE kind = ? AND token_hash = ?`, kind, tokenHash)
	var t EmailToken
	if err := row.Scan(&t.ID, &t.UserID, &t.Kind, &t.TokenHash, &t.CreatedAt, &t.ExpiresAt, &t.UsedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrEmailTokenNotFound
		}
		return nil, err
	}
	if t.UsedAt != 0 {
		return nil, ErrEmailTokenUsed
	}
	if now > t.ExpiresAt {
		return nil, ErrEmailTokenExpired
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE email_tokens SET used_at = ? WHERE id = ?`, now, t.ID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	t.UsedAt = now
	return &t, nil
}

// MarkEmailVerified sets users.email_verified = 1. Idempotent.
func (s *Store) MarkEmailVerified(ctx context.Context, userID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?`,
		time.Now().Unix(), userID)
	return err
}

// UpdatePasswordHash replaces the stored argon2id encoded password.
func (s *Store) UpdatePasswordHash(ctx context.Context, userID, hash string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`,
		hash, time.Now().Unix(), userID)
	return err
}

// RevokeAllSessionsForUser stamps revoked_at on every active session for
// userID. Used by password reset so a leaked refresh cookie loses access
// the instant the legitimate owner resets their password.
func (s *Store) RevokeAllSessionsForUser(ctx context.Context, userID string) (int, error) {
	now := time.Now().Unix()
	res, err := s.db.ExecContext(ctx, `
		UPDATE refresh_sessions SET revoked_at = ?
		WHERE user_id = ? AND revoked_at = 0`, now, userID)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}
	return int(n), nil
}

// ── TOTP / recovery codes ────────────────────────────────────────────

// SetTOTPSecret stores a freshly generated (not yet verified) secret.
func (s *Store) SetTOTPSecret(ctx context.Context, userID, secret string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE users SET totp_secret = ?, updated_at = ? WHERE id = ?`,
		secret, time.Now().Unix(), userID)
	return err
}

// EnableTOTP flips users.totp_enabled = 1.
func (s *Store) EnableTOTP(ctx context.Context, userID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE users SET totp_enabled = 1, updated_at = ? WHERE id = ?`,
		time.Now().Unix(), userID)
	return err
}

// DisableTOTP clears secret + flag and deletes any outstanding recovery codes.
func (s *Store) DisableTOTP(ctx context.Context, userID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`UPDATE users SET totp_secret = '', totp_enabled = 0, updated_at = ? WHERE id = ?`,
		time.Now().Unix(), userID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM recovery_codes_v2 WHERE user_id = ?`, userID); err != nil {
		return err
	}
	return tx.Commit()
}

// RecoveryCode mirrors a row in recovery_codes_v2.
type RecoveryCode struct {
	ID        string
	UserID    string
	CodeHash  string
	UsedAt    int64
	CreatedAt int64
}

// ReplaceRecoveryCodes wipes existing codes for userID and inserts the
// supplied set in one transaction. Used by enable + regenerate.
func (s *Store) ReplaceRecoveryCodes(ctx context.Context, userID string, codes []RecoveryCode) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM recovery_codes_v2 WHERE user_id = ?`, userID); err != nil {
		return err
	}
	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO recovery_codes_v2 (id, user_id, code_hash, used_at, created_at)
		VALUES (?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, c := range codes {
		if _, err := stmt.ExecContext(ctx, c.ID, c.UserID, c.CodeHash, c.UsedAt, c.CreatedAt); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ListRecoveryCodes returns all unused recovery codes for userID.
func (s *Store) ListRecoveryCodes(ctx context.Context, userID string) ([]RecoveryCode, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, user_id, code_hash, used_at, created_at
		FROM recovery_codes_v2 WHERE user_id = ? AND used_at = 0`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RecoveryCode
	for rows.Next() {
		var c RecoveryCode
		if err := rows.Scan(&c.ID, &c.UserID, &c.CodeHash, &c.UsedAt, &c.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// MarkRecoveryCodeUsed stamps used_at on a single code by id.
func (s *Store) MarkRecoveryCodeUsed(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE recovery_codes_v2 SET used_at = ? WHERE id = ? AND used_at = 0`,
		time.Now().Unix(), id)
	return err
}

// ── MFA challenges ───────────────────────────────────────────────────

// MFAChallenge tracks the partial-auth state between password-OK and
// TOTP/recovery-code completion during login.
type MFAChallenge struct {
	ID         string
	UserID     string
	CreatedAt  int64
	ExpiresAt  int64
	ConsumedAt int64
}

// CreateMFAChallenge inserts a new challenge row.
func (s *Store) CreateMFAChallenge(ctx context.Context, c MFAChallenge) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO mfa_challenges (id, user_id, created_at, expires_at, consumed_at)
		VALUES (?, ?, ?, ?, ?)`,
		c.ID, c.UserID, c.CreatedAt, c.ExpiresAt, c.ConsumedAt)
	return err
}

// ConsumeMFAChallenge validates + marks consumed atomically. Returns the
// linked user_id on success.
func (s *Store) ConsumeMFAChallenge(ctx context.Context, id string) (*MFAChallenge, error) {
	now := time.Now().Unix()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	row := tx.QueryRowContext(ctx, `
		SELECT id, user_id, created_at, expires_at, consumed_at
		FROM mfa_challenges WHERE id = ?`, id)
	var c MFAChallenge
	if err := row.Scan(&c.ID, &c.UserID, &c.CreatedAt, &c.ExpiresAt, &c.ConsumedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrChallengeNotFound
		}
		return nil, err
	}
	if c.ConsumedAt != 0 || now > c.ExpiresAt {
		return nil, ErrChallengeExpired
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE mfa_challenges SET consumed_at = ? WHERE id = ?`, now, c.ID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	c.ConsumedAt = now
	return &c, nil
}

// ── Phase 6.2: account lock escalation (DB-backed) ────────────────────
//
// LockedUntilPermanent is the sentinel we store in users.locked_until to
// mean "admin must unlock". Picked as -1 so any "is this in the past?"
// check (locked_until > now) trivially says yes, and ordinary timestamp
// arithmetic doesn't accidentally clear it.
const LockedUntilPermanent int64 = -1

// RecordLoginAttempt inserts one row into login_attempts. outcome is the
// short string used for windowed counting: "failed" is the only one we
// look at today, but we keep the column generic in case we ever want to
// track success rates by IP.
func (s *Store) RecordLoginAttempt(ctx context.Context, userID, email, ip, ua, outcome string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO login_attempts (user_id, email, ip, user_agent, outcome, at)
		VALUES (?, ?, ?, ?, ?, ?)`,
		nullableUserID(userID), email, ip, ua, outcome, time.Now().Unix())
	return err
}

// CountFailedLoginAttemptsSince returns the number of failed attempts for
// userID at or after the given unix-sec timestamp. Used to decide when
// escalation tiers (1h / 24h) trip.
func (s *Store) CountFailedLoginAttemptsSince(ctx context.Context, userID string, since int64) (int, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM login_attempts
		WHERE user_id = ? AND outcome = 'failed' AND at >= ?`, userID, since)
	var n int
	if err := row.Scan(&n); err != nil {
		return 0, err
	}
	return n, nil
}

// SetLockedUntil writes a new value to users.locked_until. Pass 0 to
// clear, a future unix-sec to gate logins until that time, or
// LockedUntilPermanent for admin-only unlock.
func (s *Store) SetLockedUntil(ctx context.Context, userID string, until int64) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE users SET locked_until = ?, updated_at = ? WHERE id = ?`,
		until, time.Now().Unix(), userID)
	return err
}

// ClearFailedLoginAttempts deletes all "failed" rows for userID. Called
// after a successful login so the escalation window doesn't carry stale
// failures into the next attempt window. We DON'T touch success rows or
// rows for other users (no broad DELETE).
func (s *Store) ClearFailedLoginAttempts(ctx context.Context, userID string) error {
	_, err := s.db.ExecContext(ctx, `
		DELETE FROM login_attempts WHERE user_id = ? AND outcome = 'failed'`, userID)
	return err
}

// nullableUserID returns nil for "" so the column gets NULL instead of
// the empty string — useful when we eventually want to filter on
// "attempts against a real account" vs "attempts at non-existent users".
func nullableUserID(id string) any {
	if id == "" {
		return nil
	}
	return id
}

// UpdateNickname writes a new user-editable display name. Trim is the
// caller's responsibility; passing an empty string lets read paths
// fall back to the email local-part.
func (s *Store) UpdateNickname(ctx context.Context, userID, nickname string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE users SET nickname = ?, updated_at = ? WHERE id = ?`,
		nickname, time.Now().Unix(), userID)
	return err
}

// UpdateAvatar writes a new avatar override (typically a single emoji).
// Trim/length-cap is the caller's responsibility; an empty string clears
// the override so read paths fall back to the nickname initial.
func (s *Store) UpdateAvatar(ctx context.Context, userID, avatar string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE users SET avatar = ?, updated_at = ? WHERE id = ?`,
		avatar, time.Now().Unix(), userID)
	return err
}

// DisplayName returns nickname when set, else the email's local-part,
// else (very last resort) the username. Use whenever the UI needs a
// label for a user without making the caller fall back manually.
func (u *User) DisplayName() string {
	if u == nil {
		return ""
	}
	if u.Nickname != "" {
		return u.Nickname
	}
	if at := indexOfAt(u.Email); at > 0 {
		return u.Email[:at]
	}
	return u.Username
}

func indexOfAt(s string) int {
	for i := 0; i < len(s); i++ {
		if s[i] == '@' {
			return i
		}
	}
	return -1
}

// ── Phase 6.4: admin views ────────────────────────────────────────────

// AdminUserListItem is the shape returned by ListAllUsers. We intentionally
// expose only the fields the admin UI actually needs — password hashes,
// TOTP secrets, and recovery code hashes are never sent over the wire.
type AdminUserListItem struct {
	ID            string
	Email         string
	Username      string
	EmailVerified bool
	TOTPEnabled   bool
	LockedUntil   int64
	IsAdmin       bool
	CreatedAt     int64
	UpdatedAt     int64
	// Phase 11 — per-user workspace cap override. nil means "use the
	// global default" (admin UI shows that as a placeholder).
	WorkspaceCapOverride *int
}

// ListAllUsers returns every user row, newest-created first. We don't
// page here yet — floffi instances are small enough that a single
// query is fine, and pagination becomes worth adding only when an
// admin actually complains about latency.
func (s *Store) ListAllUsers(ctx context.Context) ([]AdminUserListItem, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, email, username, email_verified, totp_enabled,
		       locked_until, is_admin, created_at, updated_at,
		       workspace_cap_override
		FROM users
		ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AdminUserListItem{}
	for rows.Next() {
		var u AdminUserListItem
		var ev, te, ia int
		var override sql.NullInt64
		if err := rows.Scan(&u.ID, &u.Email, &u.Username,
			&ev, &te, &u.LockedUntil, &ia, &u.CreatedAt, &u.UpdatedAt, &override); err != nil {
			return nil, err
		}
		u.EmailVerified = ev != 0
		u.TOTPEnabled = te != 0
		u.IsAdmin = ia != 0
		if override.Valid {
			v := int(override.Int64)
			u.WorkspaceCapOverride = &v
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// CountActiveAdmins returns the number of users with is_admin=1 whose
// account is NOT currently locked. Used by the admin-lock guard so we
// don't create a system lockout where no live admin can sign in. The
// "active" filter mirrors lockStatus(): LockedUntilPermanent (-1) and
// any future-dated lock both count as locked here; expired locks
// (locked_until > 0 but <= now) count as not locked, same as 0.
func (s *Store) CountActiveAdmins(ctx context.Context) (int, error) {
	now := time.Now().Unix()
	var n int
	err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM users
		WHERE is_admin = 1
		  AND (locked_until = 0 OR (locked_until > 0 AND locked_until <= ?))`,
		now).Scan(&n)
	return n, err
}

// SetAdmin flips users.is_admin. Used by the legacy-admin seeder and
// by future admin-management UI; not exposed as an /api/auth/admin
// endpoint yet because granting admin rights via the web UI is the
// kind of thing that warrants its own audit + review pass.
func (s *Store) SetAdmin(ctx context.Context, userID string, isAdmin bool) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE users SET is_admin = ?, updated_at = ? WHERE id = ?`,
		boolToInt(isAdmin), time.Now().Unix(), userID)
	return err
}

// ListAuditEventsForAdmin returns the most recent audit rows for
// targetUserID. Same shape as ListAuditEvents (which scopes to the
// authenticated user) — the admin variant just skips the "must equal
// own user_id" check. Caller is responsible for verifying admin
// rights BEFORE calling this.
func (s *Store) ListAuditEventsForAdmin(ctx context.Context, targetUserID string, limit int) ([]AuditEvent, error) {
	if limit <= 0 {
		limit = 100
	}
	if limit > 200 {
		limit = 200
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT event, ip, user_agent, meta, at
		FROM audit_log
		WHERE user_id = ?
		ORDER BY id DESC
		LIMIT ?`, targetUserID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AuditEvent{}
	for rows.Next() {
		var e AuditEvent
		if err := rows.Scan(&e.Event, &e.IP, &e.UserAgent, &e.Meta, &e.At); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
