package auth

// workspaces.go — Phase 11 multi-tenant workspace storage.
//
// The store-level helpers here own the workspaces / workspace_members /
// workspace_invitations tables introduced by migration 0009. The
// outer `internal/server` package wraps these in a lazy in-memory
// cache keyed by workspaceID and exposes the result over HTTP; this
// file stays focused on persistence + integrity guarantees.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Errors specific to the workspace surface. Lifting them into named
// values means handlers can branch on them with errors.Is rather than
// matching strings.
var (
	ErrWorkspaceNotFound          = errors.New("workspace not found")
	ErrWorkspaceDeleted           = errors.New("workspace deleted")
	ErrWorkspaceMembershipMissing = errors.New("workspace membership missing")
	ErrInvitationNotFound         = errors.New("workspace invitation not found")
	ErrInvitationExpired          = errors.New("workspace invitation expired")
	ErrInvitationUsed             = errors.New("workspace invitation already used")
	ErrInvitationEmailMismatch    = errors.New("workspace invitation email mismatch")
	ErrWorkspaceCapReached        = errors.New("workspace cap reached")
	ErrAlreadyMember              = errors.New("workspace membership already exists")
)

// Role constants. Strings so the DB row reads naturally; only two
// values are valid today, but keeping them as labelled constants
// avoids stringly-typed comparisons scattered across handlers.
const (
	WorkspaceRoleOwner  = "owner"
	WorkspaceRoleMember = "member"
)

// Workspace is the persisted shape. StateJSON is intentionally a raw
// string — the outer server package owns the JSON schema and we don't
// want to import that package here (auth must not depend on server).
type Workspace struct {
	ID           string
	Name         string
	OwnerID      string
	StateJSON    string
	WebhookToken string
	CreatedAt    int64
	UpdatedAt    int64
	DeletedAt    int64
}

// WorkspaceMember is a (workspace, user) pairing with a role.
type WorkspaceMember struct {
	WorkspaceID string
	UserID      string
	Role        string
	JoinedAt    int64
}

// WorkspaceInvitation is a pending invite. We store sha256(token); raw
// is shown to the inviter exactly once.
type WorkspaceInvitation struct {
	ID           string
	WorkspaceID  string
	InvitedEmail string
	InvitedBy    string
	TokenHash    string
	ExpiresAt    int64
	UsedAt       int64
	CreatedAt    int64
}

// CreateWorkspace inserts a fresh workspace row + owner membership in
// a single transaction. The caller supplies the ID (UUID) and the
// initial state JSON.
func (s *Store) CreateWorkspace(ctx context.Context, w Workspace) error {
	now := time.Now().Unix()
	if w.CreatedAt == 0 {
		w.CreatedAt = now
	}
	if w.UpdatedAt == 0 {
		w.UpdatedAt = now
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO workspaces
		    (id, name, owner_id, state_json, webhook_token, created_at, updated_at, deleted_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
		w.ID, w.Name, w.OwnerID, w.StateJSON, w.WebhookToken, w.CreatedAt, w.UpdatedAt); err != nil {
		return fmt.Errorf("create workspace: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO workspace_members (workspace_id, user_id, role, joined_at)
		VALUES (?, ?, ?, ?)`,
		w.ID, w.OwnerID, WorkspaceRoleOwner, w.CreatedAt); err != nil {
		return fmt.Errorf("create workspace owner membership: %w", err)
	}
	return tx.Commit()
}

// FindWorkspaceByID returns a single workspace by ID, ignoring
// soft-deleted rows. Returns ErrWorkspaceNotFound for both missing
// and tombstoned rows so the caller can't accidentally leak the
// existence of a deleted workspace.
func (s *Store) FindWorkspaceByID(ctx context.Context, id string) (*Workspace, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, name, owner_id, state_json, webhook_token,
		       created_at, updated_at, deleted_at
		FROM workspaces
		WHERE id = ? AND deleted_at = 0`, id)
	var w Workspace
	err := row.Scan(&w.ID, &w.Name, &w.OwnerID, &w.StateJSON, &w.WebhookToken,
		&w.CreatedAt, &w.UpdatedAt, &w.DeletedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrWorkspaceNotFound
	}
	if err != nil {
		return nil, err
	}
	return &w, nil
}

// FindWorkspaceByWebhookToken looks up a workspace by its webhook
// token. Used by /api/webhook/* to route inbound events to the right
// tenant without requiring an authenticated session.
func (s *Store) FindWorkspaceByWebhookToken(ctx context.Context, token string) (*Workspace, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, name, owner_id, state_json, webhook_token,
		       created_at, updated_at, deleted_at
		FROM workspaces
		WHERE webhook_token = ? AND deleted_at = 0`, token)
	var w Workspace
	err := row.Scan(&w.ID, &w.Name, &w.OwnerID, &w.StateJSON, &w.WebhookToken,
		&w.CreatedAt, &w.UpdatedAt, &w.DeletedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrWorkspaceNotFound
	}
	if err != nil {
		return nil, err
	}
	return &w, nil
}

// ListWorkspacesForUser returns every non-deleted workspace the user
// is a member of, with the membership role stitched in. Used by the
// workspace switcher.
type WorkspaceListItem struct {
	Workspace
	Role        string
	MemberCount int
}

func (s *Store) ListWorkspacesForUser(ctx context.Context, userID string) ([]WorkspaceListItem, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT w.id, w.name, w.owner_id, w.state_json, w.webhook_token,
		       w.created_at, w.updated_at, w.deleted_at,
		       m.role,
		       (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = w.id) AS member_count
		FROM workspaces w
		JOIN workspace_members m ON m.workspace_id = w.id
		WHERE m.user_id = ? AND w.deleted_at = 0
		ORDER BY w.created_at ASC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WorkspaceListItem{}
	for rows.Next() {
		var item WorkspaceListItem
		if err := rows.Scan(&item.ID, &item.Name, &item.OwnerID, &item.StateJSON,
			&item.WebhookToken, &item.CreatedAt, &item.UpdatedAt, &item.DeletedAt,
			&item.Role, &item.MemberCount); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

// CountWorkspacesForUser is what the cap guard reads. It counts every
// workspace the user is a member of (owner or member); the cap is
// "total membership slots", matching how the user perceives the
// switcher.
func (s *Store) CountWorkspacesForUser(ctx context.Context, userID string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM workspace_members m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.user_id = ? AND w.deleted_at = 0`, userID).Scan(&n)
	return n, err
}

// UpdateWorkspaceState persists a new state_json + bumps updated_at.
// Called on every PUT /api/workspace. The caller computes the new
// state outside the DB transaction (normalization, merge); we just
// write the result.
//
// webhook_token is kept in lockstep with state_json's
// $.webhookConfig.token: the ingest handler resolves the tenant via the
// column but validates against the state, so any drift between the two
// bricks /ingest with a permanent 401 (this actually happened — a legacy
// import minted a fresh column token while the state kept its old one).
// Syncing on every save both prevents new drift and self-heals rows that
// already drifted. The NULLIF/COALESCE guard keeps the existing column
// value when the state has no token, since the column is NOT NULL.
func (s *Store) UpdateWorkspaceState(ctx context.Context, id, stateJSON string) error {
	now := time.Now().Unix()
	res, err := s.db.ExecContext(ctx, `
		UPDATE workspaces SET state_json = ?, updated_at = ?,
			webhook_token = COALESCE(
				NULLIF(json_extract(?, '$.webhookConfig.token'), ''),
				webhook_token)
		WHERE id = ? AND deleted_at = 0`, stateJSON, now, stateJSON, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrWorkspaceNotFound
	}
	return nil
}

// RenameWorkspace updates only the human-visible name. Kept separate
// from UpdateWorkspaceState so the rename + state-save call sites
// stay tidy.
func (s *Store) RenameWorkspace(ctx context.Context, id, name string) error {
	now := time.Now().Unix()
	res, err := s.db.ExecContext(ctx, `
		UPDATE workspaces SET name = ?, updated_at = ?
		WHERE id = ? AND deleted_at = 0`, name, now, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrWorkspaceNotFound
	}
	return nil
}

// SoftDeleteWorkspace flips deleted_at to now(). Membership rows stay
// behind so a future "restore" flow can repopulate the workspace
// without re-inviting everyone. Hard delete is a separate operation
// run by a background sweeper once we have a retention policy
// defined.
func (s *Store) SoftDeleteWorkspace(ctx context.Context, id string) error {
	now := time.Now().Unix()
	res, err := s.db.ExecContext(ctx, `
		UPDATE workspaces SET deleted_at = ?, updated_at = ?
		WHERE id = ? AND deleted_at = 0`, now, now, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrWorkspaceNotFound
	}
	return nil
}

// TransferWorkspaceOwner reassigns the owner_id and promotes the
// target's membership row to 'owner'. Demoting the previous owner to
// 'member' is part of the same transaction.
func (s *Store) TransferWorkspaceOwner(ctx context.Context, workspaceID, newOwnerID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Look up current owner so we can demote them.
	var prevOwner string
	if err := tx.QueryRowContext(ctx, `
		SELECT owner_id FROM workspaces WHERE id = ? AND deleted_at = 0`,
		workspaceID).Scan(&prevOwner); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrWorkspaceNotFound
		}
		return err
	}
	// Verify target is already a member (transferring to a non-member
	// would silently lose the previous owner). This is enforced by the
	// caller too, but a second check here closes the race window.
	var dummy int
	if err := tx.QueryRowContext(ctx, `
		SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
		workspaceID, newOwnerID).Scan(&dummy); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrWorkspaceMembershipMissing
		}
		return err
	}
	now := time.Now().Unix()
	if _, err := tx.ExecContext(ctx, `
		UPDATE workspaces SET owner_id = ?, updated_at = ? WHERE id = ?`,
		newOwnerID, now, workspaceID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?`,
		WorkspaceRoleMember, workspaceID, prevOwner); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?`,
		WorkspaceRoleOwner, workspaceID, newOwnerID); err != nil {
		return err
	}
	return tx.Commit()
}

// FindMembership returns (workspace, member) when userID is a member
// of workspaceID. Returns ErrWorkspaceMembershipMissing on miss. Used
// as the canonical access-gate read for every per-workspace handler.
func (s *Store) FindMembership(ctx context.Context, workspaceID, userID string) (*Workspace, *WorkspaceMember, error) {
	w, err := s.FindWorkspaceByID(ctx, workspaceID)
	if err != nil {
		return nil, nil, err
	}
	row := s.db.QueryRowContext(ctx, `
		SELECT workspace_id, user_id, role, joined_at
		FROM workspace_members
		WHERE workspace_id = ? AND user_id = ?`, workspaceID, userID)
	var m WorkspaceMember
	if err := row.Scan(&m.WorkspaceID, &m.UserID, &m.Role, &m.JoinedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return w, nil, ErrWorkspaceMembershipMissing
		}
		return nil, nil, err
	}
	return w, &m, nil
}

// ListMembers returns every member of a workspace with the user's
// email/nickname stitched in so the UI doesn't need a follow-up call
// per row. The SELECT is on `users` directly because membership is
// inert without identifier metadata.
type WorkspaceMemberDetail struct {
	WorkspaceMember
	Email    string
	Username string
	Nickname string
	IsAdmin  bool
}

func (s *Store) ListMembers(ctx context.Context, workspaceID string) ([]WorkspaceMemberDetail, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT m.workspace_id, m.user_id, m.role, m.joined_at,
		       u.email, u.username, u.nickname, u.is_admin
		FROM workspace_members m
		JOIN users u ON u.id = m.user_id
		WHERE m.workspace_id = ?
		ORDER BY m.joined_at ASC`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WorkspaceMemberDetail{}
	for rows.Next() {
		var d WorkspaceMemberDetail
		var adminInt int
		if err := rows.Scan(&d.WorkspaceID, &d.UserID, &d.Role, &d.JoinedAt,
			&d.Email, &d.Username, &d.Nickname, &adminInt); err != nil {
			return nil, err
		}
		d.IsAdmin = adminInt != 0
		out = append(out, d)
	}
	return out, rows.Err()
}

// AddMember inserts a (workspace, user) row with the given role.
// Idempotent: returns nil on duplicate so a re-invite or race-y
// accept call doesn't blow up.
func (s *Store) AddMember(ctx context.Context, workspaceID, userID, role string) error {
	now := time.Now().Unix()
	_, err := s.db.ExecContext(ctx, `
		INSERT OR IGNORE INTO workspace_members
		    (workspace_id, user_id, role, joined_at)
		VALUES (?, ?, ?, ?)`,
		workspaceID, userID, role, now)
	return err
}

// RemoveMember drops a membership row. The 'owner' role is special —
// removing the owner would orphan the workspace, so the caller is
// expected to either transfer ownership first or use a different code
// path (workspace delete). We don't enforce that constraint here so
// the test surface stays minimal; handlers will.
func (s *Store) RemoveMember(ctx context.Context, workspaceID, userID string) error {
	_, err := s.db.ExecContext(ctx, `
		DELETE FROM workspace_members
		WHERE workspace_id = ? AND user_id = ?`, workspaceID, userID)
	return err
}

// RemoveNonOwnerMembers strips every member except the owner. Used by
// the "switch to personal mode" flow.
func (s *Store) RemoveNonOwnerMembers(ctx context.Context, workspaceID string) (int, error) {
	res, err := s.db.ExecContext(ctx, `
		DELETE FROM workspace_members
		WHERE workspace_id = ? AND role != ?`,
		workspaceID, WorkspaceRoleOwner)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// CreateInvitation persists a single-use invite. token_hash is the
// sha256 of the raw token; the raw value is shown to the inviter
// exactly once in the API response.
func (s *Store) CreateInvitation(ctx context.Context, inv WorkspaceInvitation) error {
	now := time.Now().Unix()
	if inv.CreatedAt == 0 {
		inv.CreatedAt = now
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO workspace_invitations
		    (id, workspace_id, invited_email, invited_by, token_hash,
		     expires_at, used_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
		inv.ID, inv.WorkspaceID, inv.InvitedEmail, inv.InvitedBy,
		inv.TokenHash, inv.ExpiresAt, inv.CreatedAt)
	return err
}

// ConsumeInvitation is the legacy low-level primitive used by older call
// sites: it validates a tokenHash, marks it used, and returns the invitation.
// New acceptance flows should prefer AcceptInvitation so email binding, cap
// checks, membership creation, and used_at marking happen in one transaction.
func (s *Store) ConsumeInvitation(ctx context.Context, tokenHash string) (*WorkspaceInvitation, error) {
	now := time.Now().Unix()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	row := tx.QueryRowContext(ctx, `
		SELECT id, workspace_id, invited_email, invited_by, token_hash,
		       expires_at, used_at, created_at
		FROM workspace_invitations
		WHERE token_hash = ?`, tokenHash)
	var inv WorkspaceInvitation
	if err := row.Scan(&inv.ID, &inv.WorkspaceID, &inv.InvitedEmail, &inv.InvitedBy,
		&inv.TokenHash, &inv.ExpiresAt, &inv.UsedAt, &inv.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrInvitationNotFound
		}
		return nil, err
	}
	if inv.UsedAt != 0 {
		return nil, ErrInvitationUsed
	}
	if now > inv.ExpiresAt {
		return nil, ErrInvitationExpired
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workspace_invitations SET used_at = ?
		WHERE id = ? AND used_at = 0`, now, inv.ID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	inv.UsedAt = now
	return &inv, nil
}

// AcceptInvitation consumes a pending invite only if the authenticated user's
// email matches the invite target, the workspace is still live, the user is
// not already a member, and accepting would not exceed the caller-supplied
// workspace cap. All checks + membership creation + used_at marking happen in
// one transaction so failures do not burn the invite token.
func (s *Store) AcceptInvitation(ctx context.Context, tokenHash, userID, userEmail string, cap int) (*WorkspaceInvitation, error) {
	now := time.Now().Unix()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var inv WorkspaceInvitation
	var deletedAt sql.NullInt64
	row := tx.QueryRowContext(ctx, `
		SELECT i.id, i.workspace_id, i.invited_email, i.invited_by, i.token_hash,
		       i.expires_at, i.used_at, i.created_at, w.deleted_at
		FROM workspace_invitations i
		LEFT JOIN workspaces w ON w.id = i.workspace_id
		WHERE i.token_hash = ?`, tokenHash)
	if err := row.Scan(&inv.ID, &inv.WorkspaceID, &inv.InvitedEmail, &inv.InvitedBy,
		&inv.TokenHash, &inv.ExpiresAt, &inv.UsedAt, &inv.CreatedAt, &deletedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrInvitationNotFound
		}
		return nil, err
	}
	if (!deletedAt.Valid) {
		return nil, ErrWorkspaceNotFound
	}

	memberExists := func() (bool, error) {
		var existing int
		err := tx.QueryRowContext(ctx, `
			SELECT 1 FROM workspace_members
			WHERE workspace_id = ? AND user_id = ?`, inv.WorkspaceID, userID).Scan(&existing)
		switch {
		case err == nil:
			return true, nil
		case errors.Is(err, sql.ErrNoRows):
			return false, nil
		default:
			return false, err
		}
	}

	if deletedAt.Int64 != 0 {
		return nil, ErrWorkspaceDeleted
	}
	if inv.UsedAt != 0 {
		exists, err := memberExists()
		if err != nil {
			return nil, err
		}
		if exists {
			return &inv, nil
		}
		return nil, ErrInvitationUsed
	}
	if now > inv.ExpiresAt {
		return nil, ErrInvitationExpired
	}
	if strings.TrimSpace(strings.ToLower(userEmail)) != strings.TrimSpace(strings.ToLower(inv.InvitedEmail)) {
		return nil, ErrInvitationEmailMismatch
	}

	exists, err := memberExists()
	if err != nil {
		return nil, err
	}
	if exists {
		return &inv, nil
	}

	var membershipCount int
	if err := tx.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM workspace_members m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.user_id = ? AND w.deleted_at = 0`, userID).Scan(&membershipCount); err != nil {
		return nil, err
	}
	if cap < 1 {
		cap = 1
	}
	if membershipCount >= cap {
		return nil, ErrWorkspaceCapReached
	}

	res, err := tx.ExecContext(ctx, `
		INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, joined_at)
		VALUES (?, ?, ?, ?)`,
		inv.WorkspaceID, userID, WorkspaceRoleMember, now)
	if err != nil {
		return nil, err
	}
	inserted, _ := res.RowsAffected()
	if inserted == 0 {
		exists, err := memberExists()
		if err != nil {
			return nil, err
		}
		if exists {
			inv.UsedAt = now
			return &inv, nil
		}
		return nil, ErrAlreadyMember
	}
	res, err = tx.ExecContext(ctx, `
		UPDATE workspace_invitations SET used_at = ?
		WHERE id = ? AND used_at = 0`, now, inv.ID)
	if err != nil {
		return nil, err
	}
	affected, _ := res.RowsAffected()
	if affected == 0 {
		exists, err := memberExists()
		if err != nil {
			return nil, err
		}
		if exists {
			inv.UsedAt = now
			return &inv, nil
		}
		return nil, ErrInvitationUsed
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	inv.UsedAt = now
	return &inv, nil
}

// ListPendingInvitations returns un-used, un-expired invites for a
// workspace. Used by the owner's membership UI so they can see who
// has an outstanding invite (and revoke if desired — revoke isn't
// exposed yet but the list is the input for that future flow).
func (s *Store) ListPendingInvitations(ctx context.Context, workspaceID string) ([]WorkspaceInvitation, error) {
	now := time.Now().Unix()
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, workspace_id, invited_email, invited_by, token_hash,
		       expires_at, used_at, created_at
		FROM workspace_invitations
		WHERE workspace_id = ? AND used_at = 0 AND expires_at > ?
		ORDER BY created_at DESC`, workspaceID, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WorkspaceInvitation{}
	for rows.Next() {
		var inv WorkspaceInvitation
		if err := rows.Scan(&inv.ID, &inv.WorkspaceID, &inv.InvitedEmail, &inv.InvitedBy,
			&inv.TokenHash, &inv.ExpiresAt, &inv.UsedAt, &inv.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, inv)
	}
	return out, rows.Err()
}

// GetWorkspaceCapOverride reads the per-user override. nil means "no
// override set", in which case the caller falls back to the global
// default. We use a *int rather than a sentinel so the migration's
// default (NULL) round-trips cleanly through scan.
func (s *Store) GetWorkspaceCapOverride(ctx context.Context, userID string) (*int, error) {
	var n sql.NullInt64
	err := s.db.QueryRowContext(ctx, `
		SELECT workspace_cap_override FROM users WHERE id = ?`, userID).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUserNotFound
	}
	if err != nil {
		return nil, err
	}
	if !n.Valid {
		return nil, nil
	}
	v := int(n.Int64)
	return &v, nil
}

// SetWorkspaceCapOverride writes the per-user override. Pass nil to
// clear (revert to global default).
func (s *Store) SetWorkspaceCapOverride(ctx context.Context, userID string, override *int) error {
	now := time.Now().Unix()
	if override == nil {
		_, err := s.db.ExecContext(ctx, `
			UPDATE users SET workspace_cap_override = NULL, updated_at = ?
			WHERE id = ?`, now, userID)
		return err
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE users SET workspace_cap_override = ?, updated_at = ?
		WHERE id = ?`, *override, now, userID)
	return err
}

// ResolveWorkspaceCap returns the effective cap for `userID`. Priority:
//  1. users.workspace_cap_override (admin-set per-user)
//  2. global default (passed in by the caller — the server resolves
//     it from env at boot or from a future settings row)
//
// The numeric result is always >= 1; we clamp to 1 even if a misconfig
// produces 0 or negative, so a sane lower bound is always enforced.
func ResolveWorkspaceCap(override *int, globalDefault int) int {
	if override != nil {
		if *override < 1 {
			return 1
		}
		return *override
	}
	if globalDefault < 1 {
		return 1
	}
	return globalDefault
}

// ParseWorkspaceCapFromString is a small helper the server uses to
// turn the FLOFFI_WORKSPACE_CAP env var into a usable integer. Empty
// → fallback. Negative or non-numeric → fallback. Centralized so the
// parse + clamp policy stays consistent.
func ParseWorkspaceCapFromString(s string, fallback int) int {
	s = strings.TrimSpace(s)
	if s == "" {
		return fallback
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 1 {
		return fallback
	}
	return n
}
