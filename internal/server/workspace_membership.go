package server

// workspace_membership.go — Phase 11 multi-workspace API surface.
//
// Routes mounted under /api/workspaces:
//
//   GET    /api/workspaces                                       내 워크스페이스 목록
//   POST   /api/workspaces                                       워크스페이스 생성 (cap 가드)
//   PATCH  /api/workspaces/{id}                                  이름 변경 (owner)
//   DELETE /api/workspaces/{id}                                  soft delete (owner)
//   GET    /api/workspaces/{id}/members                          멤버 목록 + pending invitations
//   POST   /api/workspaces/{id}/members/invite                   초대 토큰 발급 (owner)
//   DELETE /api/workspaces/{id}/members/{userID}                 멤버 강퇴 (owner)
//   POST   /api/workspaces/{id}/members/leave                    본인 떠나기 (멤버; owner 는 transfer 후 이용)
//   POST   /api/workspaces/{id}/transfer-owner                   owner 이전 (owner)
//   POST   /api/workspaces/{id}/mode-personal                    협업→개인 (owner, 다른 멤버 일괄 강퇴)
//
// Invitation acceptance lives on a separate path (unauthenticated path
// not needed — accept requires login, but workspaceID is in the body
// so the path stays flat):
//
//   POST   /api/workspaces/invitations/accept                    초대 수락 (raw token 필요)
//
// Every owner-only verb double-checks role inside the handler so an
// invite-link race or stale UI state can't escalate a member into an
// owner-only action.

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"floffi/internal/server/auth"

	"github.com/google/uuid"
)

const (
	// workspaceInvitationTTL is short enough that a leaked token from
	// a screenshot/Slack message decays quickly, long enough that the
	// invitee has a realistic window to accept on their own schedule.
	workspaceInvitationTTL = 7 * 24 * time.Hour
)

// handleWorkspacesRoot dispatches /api/workspaces (collection) and the
// nested /api/workspaces/{id}... tree. Kept on one handler so the
// router stays simple: one HandleFunc("/api/workspaces", ...) +
// HandleFunc("/api/workspaces/", ...).
func (s *Server) handleWorkspacesRoot(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.handleWorkspaceList(w, r)
	case http.MethodPost:
		s.handleWorkspaceCreate(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleWorkspacesSubtree handles every path that starts with
// /api/workspaces/. Splits the path once and dispatches by the verb
// after the workspace ID.
func (s *Server) handleWorkspacesSubtree(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/workspaces/")
	// Invitations live on /api/workspaces/invitations/<verb> — handle
	// that subtree first so the workspace-ID dispatcher below doesn't
	// try to treat "invitations" as a workspace id.
	if strings.HasPrefix(rest, "invitations/") {
		verb := strings.TrimPrefix(rest, "invitations/")
		switch verb {
		case "accept":
			s.handleInvitationAccept(w, r)
		default:
			http.NotFound(w, r)
		}
		return
	}

	parts := strings.SplitN(rest, "/", 2)
	workspaceID := parts[0]
	if workspaceID == "" {
		http.NotFound(w, r)
		return
	}

	// /api/workspaces/{id} with no verb — PATCH (rename) or DELETE.
	if len(parts) == 1 {
		switch r.Method {
		case http.MethodPatch:
			s.handleWorkspaceRename(w, r, workspaceID)
		case http.MethodDelete:
			s.handleWorkspaceDelete(w, r, workspaceID)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
		return
	}

	// /api/workspaces/{id}/<rest>
	tail := parts[1]
	switch {
	case tail == "members":
		s.handleMembersList(w, r, workspaceID)
	case tail == "members/invite":
		s.handleInvitationCreate(w, r, workspaceID)
	case tail == "members/leave":
		s.handleMemberLeave(w, r, workspaceID)
	case strings.HasPrefix(tail, "members/"):
		userID := strings.TrimPrefix(tail, "members/")
		s.handleMemberRemove(w, r, workspaceID, userID)
	case tail == "transfer-owner":
		s.handleTransferOwner(w, r, workspaceID)
	case tail == "mode-personal":
		s.handleSwitchToPersonal(w, r, workspaceID)
	default:
		http.NotFound(w, r)
	}
}

// ── helpers ──────────────────────────────────────────────────────────

// requireAuthedUser is the shared first step of every workspace verb:
// returns the authenticated user, or writes 401 and returns nil.
func (s *Server) requireAuthedUser(w http.ResponseWriter, r *http.Request) *auth.User {
	user, _, err := s.authHandler.Authenticate(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return nil
	}
	return user
}

// requireMembership ensures the user is a member of workspaceID,
// returning the workspace + their membership row. Writes 403/404 on
// failure.
func (s *Server) requireMembership(w http.ResponseWriter, r *http.Request, user *auth.User, workspaceID string) (*auth.Workspace, *auth.WorkspaceMember) {
	wsRow, member, err := s.authStore.FindMembership(r.Context(), workspaceID, user.ID)
	if err != nil {
		switch {
		case errors.Is(err, auth.ErrWorkspaceNotFound):
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "workspace_not_found"})
		case errors.Is(err, auth.ErrWorkspaceMembershipMissing):
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "workspace_membership_required"})
		default:
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "membership_lookup_failed"})
		}
		return nil, nil
	}
	return wsRow, member
}

// requireOwner gates a verb to owners only.
func (s *Server) requireOwner(w http.ResponseWriter, member *auth.WorkspaceMember) bool {
	if member.Role != auth.WorkspaceRoleOwner {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": "owner_only"})
		return false
	}
	return true
}

// ── handlers ─────────────────────────────────────────────────────────

// handleWorkspaceList — GET /api/workspaces
//
// Returns every workspace the user is a member of, with role + member
// count. The switcher UI renders directly from this payload.
func (s *Server) handleWorkspaceList(w http.ResponseWriter, r *http.Request) {
	user := s.requireAuthedUser(w, r)
	if user == nil {
		return
	}
	rows, err := s.ensureUserHasWorkspace(r.Context(), user.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "workspace_bootstrap_failed"})
		return
	}
	override, _ := s.authStore.GetWorkspaceCapOverride(r.Context(), user.ID)
	cap := auth.ResolveWorkspaceCap(override, resolveGlobalWorkspaceCap())
	out := make([]map[string]any, 0, len(rows))
	for _, item := range rows {
		out = append(out, map[string]any{
			"id":          item.ID,
			"name":        item.Name,
			"ownerId":     item.OwnerID,
			"role":        item.Role,
			"memberCount": item.MemberCount,
			"createdAt":   item.CreatedAt,
			"updatedAt":   item.UpdatedAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"workspaces": out,
		"cap":        cap,
	})
}

// handleWorkspaceCreate — POST /api/workspaces
// Body: { "name": "..." }
func (s *Server) handleWorkspaceCreate(w http.ResponseWriter, r *http.Request) {
	user := s.requireAuthedUser(w, r)
	if user == nil {
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		name = "새 워크스페이스"
	}
	// Honour the cap on user-initiated creates. The signup callback
	// uses skipCapCheck=true to guarantee at least one workspace
	// regardless of misconfig.
	if err := s.createWorkspaceForUser(r.Context(), user.ID, name, false); err != nil {
		if strings.Contains(err.Error(), "cap reached") {
			writeJSON(w, http.StatusConflict, map[string]any{"error": "workspace_cap_reached"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "create_failed"})
		return
	}
	// Echo the updated list back so the switcher UI doesn't need a
	// second round-trip after create.
	s.handleWorkspaceList(w, r)
}

// handleWorkspaceRename — PATCH /api/workspaces/{id}
// Body: { "name": "..." }. Owner only.
func (s *Server) handleWorkspaceRename(w http.ResponseWriter, r *http.Request, workspaceID string) {
	user := s.requireAuthedUser(w, r)
	if user == nil {
		return
	}
	_, member := s.requireMembership(w, r, user, workspaceID)
	if member == nil {
		return
	}
	if !s.requireOwner(w, member) {
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "name_required"})
		return
	}
	if err := s.authStore.RenameWorkspace(r.Context(), workspaceID, name); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "rename_failed"})
		return
	}
	// Keep state_json.boardTitle in lockstep with the workspaces.name column
	// so the topbar input never disagrees with the switcher / management
	// surfaces. Going through workspaceStore.replace runs the usual
	// normalize → persist → searchSync funnel, so the FTS5 row and ETag
	// stay accurate too.
	if store, err := s.workspaces.For(r.Context(), workspaceID); err == nil {
		next := store.snapshot()
		next.BoardTitle = name
		if err := store.replace(next); err != nil {
			logger.Error("rename: sync boardTitle failed", "workspace", workspaceID, "err", err)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "name": name})
}

// handleWorkspaceDelete — DELETE /api/workspaces/{id}. Owner only.
// Soft delete: the row stays in the DB so it can be restored or
// inspected, but it disappears from listings and any handler that
// resolves through FindWorkspaceByID will return 404.
func (s *Server) handleWorkspaceDelete(w http.ResponseWriter, r *http.Request, workspaceID string) {
	user := s.requireAuthedUser(w, r)
	if user == nil {
		return
	}
	_, member := s.requireMembership(w, r, user, workspaceID)
	if member == nil {
		return
	}
	if !s.requireOwner(w, member) {
		return
	}
	if err := s.authStore.SoftDeleteWorkspace(r.Context(), workspaceID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "delete_failed"})
		return
	}
	// Drop the cached store so any subsequent reads don't see stale
	// in-memory state. The next access to this workspaceID would
	// 404 against the soft-deleted row anyway, but tidying the cache
	// avoids a confusing diagnostic if something tries.
	s.workspaces.Forget(workspaceID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleMembersList — GET /api/workspaces/{id}/members
// Returns members + pending invitations so the UI can render both
// columns in one request.
func (s *Server) handleMembersList(w http.ResponseWriter, r *http.Request, workspaceID string) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	user := s.requireAuthedUser(w, r)
	if user == nil {
		return
	}
	_, member := s.requireMembership(w, r, user, workspaceID)
	if member == nil {
		return
	}
	members, err := s.authStore.ListMembers(r.Context(), workspaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "members_lookup_failed"})
		return
	}
	memberOut := make([]map[string]any, 0, len(members))
	for _, m := range members {
		memberOut = append(memberOut, map[string]any{
			"userId":   m.UserID,
			"email":    m.Email,
			"username": m.Username,
			"nickname": m.Nickname,
			"role":     m.Role,
			"isAdmin":  m.IsAdmin,
			"joinedAt": m.JoinedAt,
		})
	}
	// Pending invitations are owner-visible. Members see only the
	// member list — pending invites can leak email addresses to
	// non-owners otherwise.
	var inviteOut []map[string]any
	if member.Role == auth.WorkspaceRoleOwner {
		invites, err := s.authStore.ListPendingInvitations(r.Context(), workspaceID)
		if err == nil {
			for _, inv := range invites {
				inviteOut = append(inviteOut, map[string]any{
					"id":           inv.ID,
					"invitedEmail": inv.InvitedEmail,
					"expiresAt":    inv.ExpiresAt,
					"createdAt":    inv.CreatedAt,
				})
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"members":     memberOut,
		"invitations": inviteOut,
		"role":        member.Role,
	})
}

// handleInvitationCreate — POST /api/workspaces/{id}/members/invite
// Body: { "email": "..." }. Owner only.
//
// Mirrors the admin reset-password pattern: server mints a raw token,
// stores sha256(token) in the DB, returns the raw value in the
// response exactly once. The owner shares the link with the invitee
// out-of-band (Slack, email, in person) since SMTP outbound may be
// blocked in this deployment.
func (s *Server) handleInvitationCreate(w http.ResponseWriter, r *http.Request, workspaceID string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	user := s.requireAuthedUser(w, r)
	if user == nil {
		return
	}
	_, member := s.requireMembership(w, r, user, workspaceID)
	if member == nil {
		return
	}
	if !s.requireOwner(w, member) {
		return
	}
	var body struct {
		Email string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	email := strings.ToLower(strings.TrimSpace(body.Email))
	if email == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "email_required"})
		return
	}
	rawToken, tokenHash, err := newInvitationToken()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "token_failed"})
		return
	}
	expiresAt := time.Now().Add(workspaceInvitationTTL).Unix()
	inv := auth.WorkspaceInvitation{
		ID:           uuid.NewString(),
		WorkspaceID:  workspaceID,
		InvitedEmail: email,
		InvitedBy:    user.ID,
		TokenHash:    tokenHash,
		ExpiresAt:    expiresAt,
	}
	if err := s.authStore.CreateInvitation(r.Context(), inv); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "invite_failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":           true,
		"token":        rawToken,
		"expiresAt":    expiresAt,
		"invitedEmail": email,
	})
}

// handleInvitationAccept — POST /api/workspaces/invitations/accept
// Body: { "token": "..." }. Authenticated user joins the workspace
// the token points at. Honours the per-user workspace cap.
func (s *Server) handleInvitationAccept(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	user := s.requireAuthedUser(w, r)
	if user == nil {
		return
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Token) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	tokenHash := sha256HexHash(body.Token)
	override, _ := s.authStore.GetWorkspaceCapOverride(r.Context(), user.ID)
	cap := auth.ResolveWorkspaceCap(override, resolveGlobalWorkspaceCap())
	inv, err := s.authStore.AcceptInvitation(r.Context(), tokenHash, user.ID, user.Email, cap)
	if err != nil {
		switch {
		case errors.Is(err, auth.ErrInvitationNotFound):
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "invitation_not_found"})
		case errors.Is(err, auth.ErrInvitationExpired):
			writeJSON(w, http.StatusGone, map[string]any{"error": "invitation_expired"})
		case errors.Is(err, auth.ErrInvitationUsed):
			writeJSON(w, http.StatusGone, map[string]any{"error": "invitation_used"})
		case errors.Is(err, auth.ErrInvitationEmailMismatch):
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "invitation_email_mismatch"})
		case errors.Is(err, auth.ErrWorkspaceCapReached):
			writeJSON(w, http.StatusConflict, map[string]any{"error": "workspace_cap_reached"})
		case errors.Is(err, auth.ErrAlreadyMember):
			writeJSON(w, http.StatusConflict, map[string]any{"error": "already_member"})
		case errors.Is(err, auth.ErrWorkspaceDeleted):
			writeJSON(w, http.StatusGone, map[string]any{"error": "workspace_deleted"})
		case errors.Is(err, auth.ErrWorkspaceNotFound):
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "workspace_not_found"})
		default:
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "consume_failed"})
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":          true,
		"workspaceId": inv.WorkspaceID,
	})
}

// handleMemberRemove — DELETE /api/workspaces/{id}/members/{userID}
// Owner only. Refuses to remove the owner themselves (use leave /
// transfer-owner / delete instead).
func (s *Server) handleMemberRemove(w http.ResponseWriter, r *http.Request, workspaceID, targetUserID string) {
	if r.Method != http.MethodDelete {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	user := s.requireAuthedUser(w, r)
	if user == nil {
		return
	}
	wsRow, member := s.requireMembership(w, r, user, workspaceID)
	if member == nil {
		return
	}
	if !s.requireOwner(w, member) {
		return
	}
	if targetUserID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "user_id_required"})
		return
	}
	if targetUserID == wsRow.OwnerID {
		// Owner removal would orphan the workspace. Force the caller
		// to either transfer ownership first or delete the workspace.
		writeJSON(w, http.StatusConflict, map[string]any{"error": "cannot_remove_owner"})
		return
	}
	if err := s.authStore.RemoveMember(r.Context(), workspaceID, targetUserID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "remove_failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleMemberLeave — POST /api/workspaces/{id}/members/leave
// Self-removal. Owners must transfer first.
func (s *Server) handleMemberLeave(w http.ResponseWriter, r *http.Request, workspaceID string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	user := s.requireAuthedUser(w, r)
	if user == nil {
		return
	}
	_, member := s.requireMembership(w, r, user, workspaceID)
	if member == nil {
		return
	}
	if member.Role == auth.WorkspaceRoleOwner {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "owner_must_transfer_first"})
		return
	}
	if err := s.authStore.RemoveMember(r.Context(), workspaceID, user.ID); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "leave_failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleTransferOwner — POST /api/workspaces/{id}/transfer-owner
// Body: { "userId": "..." }. Owner only. Target must already be a
// member.
func (s *Server) handleTransferOwner(w http.ResponseWriter, r *http.Request, workspaceID string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	user := s.requireAuthedUser(w, r)
	if user == nil {
		return
	}
	_, member := s.requireMembership(w, r, user, workspaceID)
	if member == nil {
		return
	}
	if !s.requireOwner(w, member) {
		return
	}
	var body struct {
		UserID string `json:"userId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.UserID) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	if body.UserID == user.ID {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "cannot_transfer_to_self"})
		return
	}
	if err := s.authStore.TransferWorkspaceOwner(r.Context(), workspaceID, body.UserID); err != nil {
		switch {
		case errors.Is(err, auth.ErrWorkspaceMembershipMissing):
			writeJSON(w, http.StatusConflict, map[string]any{"error": "target_not_member"})
		default:
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "transfer_failed"})
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleSwitchToPersonal — POST /api/workspaces/{id}/mode-personal
// Body: { "confirmName": "..." } — must match the current workspace
// name. Owner only. Removes every member except the owner.
//
// The confirmName guard is the server-side enforcement of the
// frontend's type-to-confirm dialog: even if a malicious client
// skips the dialog, the server still requires the exact name.
func (s *Server) handleSwitchToPersonal(w http.ResponseWriter, r *http.Request, workspaceID string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	user := s.requireAuthedUser(w, r)
	if user == nil {
		return
	}
	wsRow, member := s.requireMembership(w, r, user, workspaceID)
	if member == nil {
		return
	}
	if !s.requireOwner(w, member) {
		return
	}
	var body struct {
		ConfirmName string `json:"confirmName"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	if strings.TrimSpace(body.ConfirmName) != wsRow.Name {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "confirm_name_mismatch"})
		return
	}
	removed, err := s.authStore.RemoveNonOwnerMembers(r.Context(), workspaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "switch_failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":             true,
		"removedMembers": removed,
	})
}

// newInvitationToken returns a random 32-byte token in base64url +
// its sha256 hash (hex). Mirrors auth.newURLToken but lives here so
// the workspace package doesn't depend on auth-internal helpers.
func newInvitationToken() (raw, hashHex string, err error) {
	tok, err := generateInvitationRaw()
	if err != nil {
		return "", "", err
	}
	return tok, sha256HexHash(tok), nil
}

// generateInvitationRaw uses crypto/rand under the hood. Kept narrow
// so the format stays consistent if we ever need to tighten it.
func generateInvitationRaw() (string, error) {
	// 32 bytes encoded base64url. Matches the password reset / email
	// verify token shape, so a token "looks like" the others to any
	// log inspector.
	const n = 32
	buf := make([]byte, n)
	if _, err := readRandom(buf); err != nil {
		return "", err
	}
	return base64URLEncode(buf), nil
}

// readRandom + base64URLEncode are tiny wrappers around crypto/rand +
// encoding/base64. Inlined as variables so a future test can swap in
// a deterministic random source if needed.
var (
	readRandom      = func(b []byte) (int, error) { return rand.Read(b) }
	base64URLEncode = func(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }
)

func sha256HexHash(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}
