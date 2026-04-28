package server

// workspace_resolver.go — Phase 11 helpers that bridge "the request's
// authenticated user" to "the workspace that user is currently
// looking at". Two surfaces:
//
//   provisionDefaultWorkspaceForUser  — fires from auth.OnUserSignedUp,
//   creates a fresh personal workspace for the new account so the
//   switcher UI is never empty.
//
//   resolveActiveWorkspace  — used by every per-workspace API handler.
//   Picks the workspaceID from (in order) the X-Workspace-ID header,
//   the ?workspace_id query, or the user's first membership row. The
//   resolved workspaceID is then membership-checked: a member can
//   only target a workspace they belong to, never anyone else's.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"time"

	"floffi/internal/server/auth"

	"github.com/google/uuid"
)

// defaultWorkspaceCap is the fallback workspace cap when neither the
// per-user override nor FLOFFI_WORKSPACE_CAP is set. Tests rely on
// the number for cap-related assertions; production callers go
// through resolveWorkspaceCap().
const defaultWorkspaceCap = 3

// resolveGlobalWorkspaceCap reads the global cap from the environment,
// falling back to defaultWorkspaceCap. The result is the input to the
// per-user override resolver — callers pass the user's override
// (possibly nil) plus this value into auth.ResolveWorkspaceCap.
func resolveGlobalWorkspaceCap() int {
	return auth.ParseWorkspaceCapFromString(getenv("FLOFFI_WORKSPACE_CAP"), defaultWorkspaceCap)
}

// provisionDefaultWorkspaceForUser is the OnUserSignedUp callback. It
// creates a single personal workspace owned by `userID` so a fresh
// account isn't dropped into an empty switcher. Best-effort: a
// failure here doesn't reverse the signup (the auth handler already
// has the user logged in), so we log and move on.
func (s *Server) provisionDefaultWorkspaceForUser(userID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.createWorkspaceForUser(ctx, userID, "내 워크스페이스", true); err != nil {
		logger.Error("workspace bootstrap for user failed", "user", userID, "err", err)
	}
}

// createWorkspaceForUser is the shared helper behind the signup
// callback and the future /api/workspaces POST. `skipCapCheck` is
// true only on signup (we want every fresh account to have at least
// one workspace even if a misconfigured cap is 0). User-initiated
// creates from the API always honour the cap.
func (s *Server) createWorkspaceForUser(ctx context.Context, userID, name string, skipCapCheck bool) error {
	if !skipCapCheck {
		count, err := s.authStore.CountWorkspacesForUser(ctx, userID)
		if err != nil {
			return fmt.Errorf("count workspaces: %w", err)
		}
		override, err := s.authStore.GetWorkspaceCapOverride(ctx, userID)
		if err != nil {
			return fmt.Errorf("read cap override: %w", err)
		}
		cap := auth.ResolveWorkspaceCap(override, resolveGlobalWorkspaceCap())
		if count >= cap {
			return fmt.Errorf("workspace cap reached (%d)", cap)
		}
	}
	initial := defaultWorkspaceState()
	// Seed boardTitle from the workspace name so the topbar input and the
	// switcher/management UI show the same string out of the gate. Without
	// this the user types a name in the create dialog, sees it in the
	// switcher, then notices the topbar still reads "Workspace" — the two
	// surfaces are wired to different fields (workspaces.name vs
	// state_json.boardTitle) and only converge on a manual rename.
	initial.BoardTitle = name
	normalized := normalizeWorkspaceState(initial)
	stateJSON, err := json.Marshal(normalized)
	if err != nil {
		return err
	}
	// Column token must mirror state.webhookConfig.token — the ingest
	// handler checks both and the UI surfaces the state one. A separate
	// generateToken() here would 401 every /ingest call for this
	// workspace (see workspace_bootstrap.go for the full story).
	now := time.Now().Unix()
	return s.authStore.CreateWorkspace(ctx, auth.Workspace{
		ID:           uuid.NewString(),
		Name:         name,
		OwnerID:      userID,
		StateJSON:    string(stateJSON),
		WebhookToken: normalized.WebhookConfig.Token,
		CreatedAt:    now,
		UpdatedAt:    now,
	})
}

// ensureUserHasWorkspace is the self-heal path for legacy accounts that
// predate per-user workspace bootstrap or lost their membership rows.
// It keeps both /api/workspaces and /api/workspace from surfacing an empty
// switcher just because the account's first workspace was never provisioned.
func (s *Server) ensureUserHasWorkspace(ctx context.Context, userID string) ([]auth.WorkspaceListItem, error) {
	rows, err := s.authStore.ListWorkspacesForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list workspaces: %w", err)
	}
	if len(rows) > 0 {
		return rows, nil
	}
	if err := s.createWorkspaceForUser(ctx, userID, "내 워크스페이스", true); err != nil {
		return nil, fmt.Errorf("bootstrap workspace: %w", err)
	}
	rows, err = s.authStore.ListWorkspacesForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("relist workspaces: %w", err)
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("bootstrap workspace: workspace list still empty")
	}
	return rows, nil
}

// activeWorkspaceContext bundles what every per-workspace handler
// needs after auth + workspace resolution: the user, the workspace
// row, the membership (role), and the live in-memory store.
type activeWorkspaceContext struct {
	user      *auth.User
	workspace *auth.Workspace
	member    *auth.WorkspaceMember
	store     *workspaceStore
}

// resolveActiveWorkspace authenticates the request, picks the target
// workspaceID, verifies membership, and returns the loaded store.
// Writes 401/403/404 + returns nil on failure — caller just returns.
//
// Selection priority:
//  1. ?workspace_id=<id> query param
//  2. X-Workspace-ID header
//  3. The user's first workspace (oldest joined_at). New accounts
//     reach this branch because provisionDefaultWorkspaceForUser
//     already created one row at signup time.
//
// Pre-Phase-11 frontends that don't send (1) or (2) automatically
// land on (3), which is the user's personal workspace. That's the
// behaviour we need to make the "shared workspace" symptom go away
// before any switcher UI exists.
func (s *Server) resolveActiveWorkspace(w http.ResponseWriter, r *http.Request) *activeWorkspaceContext {
	user, _, err := s.authHandler.Authenticate(r)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return nil
	}
	ctx := r.Context()
	workspaceID := r.URL.Query().Get("workspace_id")
	if workspaceID == "" {
		workspaceID = r.Header.Get("X-Workspace-ID")
	}
	if workspaceID == "" {
		// Fall back to the user's first workspace. Legacy accounts that
		// somehow have zero memberships are self-healed here so the first
		// post-login workspace fetch provisions a personal workspace instead
		// of surfacing a dead board.
		rows, err := s.ensureUserHasWorkspace(ctx, user.ID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "workspace_bootstrap_failed"})
			return nil
		}
		workspaceID = rows[0].ID
	}
	wsRow, member, err := s.authStore.FindMembership(ctx, workspaceID, user.ID)
	if err != nil {
		switch {
		case errors.Is(err, auth.ErrWorkspaceNotFound):
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "workspace_not_found"})
		case errors.Is(err, auth.ErrWorkspaceMembershipMissing):
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "workspace_membership_required"})
		default:
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "membership_lookup_failed"})
		}
		return nil
	}
	store, err := s.workspaces.For(ctx, wsRow.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "workspace_open_failed"})
		return nil
	}
	return &activeWorkspaceContext{
		user:      user,
		workspace: wsRow,
		member:    member,
		store:     store,
	}
}

// getenv is a small indirection so tests can override FLOFFI_*
// without setting process env. Replace the variable in a test setup
// to inject deterministic values.
var getenv = os.Getenv
