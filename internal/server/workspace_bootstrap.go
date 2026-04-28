package server

// workspace_bootstrap.go — Phase 11 wiring of the workspace registry +
// default-workspace resolution at server start.
//
// Responsibilities:
//   1) Ensure a default owner workspace exists when a bootstrap admin seat is
//      already present.
//   2) Keep startup working when the auth DB is empty: the server can still
//      serve signup/login, and the first real account provisions its workspace
//      through OnUserSignedUp.
//   3) Hand back the registry + the in-memory store for the default workspace,
//      so pre-Phase-11 call sites that read s.workspace directly keep working
//      until they're migrated.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"floffi/internal/server/auth"

	"github.com/google/uuid"
)

const (
	legacyWorkspacePath   = ".data/workspace.json"
	legacyWorkspaceBackup = ".data/workspace.json.imported"
)

func bootstrapWorkspaces(authStore *auth.Store) (*workspaceRegistry, *workspaceStore, string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	registry := newWorkspaceRegistry(authStore)

	owner, err := resolveDefaultWorkspaceOwner(ctx, authStore)
	if err != nil {
		return nil, nil, "", err
	}
	if owner == nil {
		// Fresh install: no users yet. Signup will provision the first real
		// workspace through OnUserSignedUp, so startup can continue without a
		// synthetic admin account.
		return registry, nil, "", nil
	}

	rows, err := authStore.ListWorkspacesForUser(ctx, owner.ID)
	if err != nil {
		return nil, nil, "", fmt.Errorf("bootstrap: list default-owner workspaces: %w", err)
	}
	if len(rows) > 0 {
		id := rows[0].ID
		store, err := registry.For(ctx, id)
		if err != nil {
			return nil, nil, "", err
		}
		return registry, store, id, nil
	}

	initial, importedFromLegacy, err := loadInitialWorkspaceState()
	if err != nil {
		return nil, nil, "", err
	}

	workspaceID := uuid.NewString()
	normalized := normalizeWorkspaceState(initial)
	stateJSON, err := json.Marshal(normalized)
	if err != nil {
		return nil, nil, "", fmt.Errorf("bootstrap: marshal initial state: %w", err)
	}
	now := time.Now().Unix()
	if err := authStore.CreateWorkspace(ctx, auth.Workspace{
		ID:           workspaceID,
		Name:         "내 워크스페이스",
		OwnerID:      owner.ID,
		StateJSON:    string(stateJSON),
		WebhookToken: normalized.WebhookConfig.Token,
		CreatedAt:    now,
		UpdatedAt:    now,
	}); err != nil {
		return nil, nil, "", fmt.Errorf("bootstrap: create default workspace: %w", err)
	}

	if importedFromLegacy {
		if err := os.Rename(legacyWorkspacePath, legacyWorkspaceBackup); err != nil {
			logger.Warn("bootstrap: rename legacy workspace.json failed (continuing)", "err", err)
		} else {
			logger.Info("bootstrap: imported legacy workspace.json",
				"src", legacyWorkspacePath, "workspace", workspaceID, "backup", legacyWorkspaceBackup)
		}
		if err := migrateLegacyAttachments(workspaceID); err != nil {
			logger.Warn("bootstrap: migrate legacy attachments failed (continuing)", "err", err)
		}
	} else {
		logger.Info("bootstrap: seeded default workspace for bootstrap owner", "workspace", workspaceID, "owner", owner.ID)
	}

	store, err := registry.For(ctx, workspaceID)
	if err != nil {
		return nil, nil, "", err
	}
	return registry, store, workspaceID, nil
}

func resolveDefaultWorkspaceOwner(ctx context.Context, authStore *auth.Store) (*auth.User, error) {
	owner, err := authStore.FindUserByID(ctx, auth.SuperAdminID)
	if err == nil && owner != nil && owner.IsAdmin {
		return owner, nil
	}
	rows, lerr := authStore.ListAllUsers(ctx)
	if lerr != nil {
		if err != nil {
			return nil, fmt.Errorf("bootstrap: default-owner lookup: %w", err)
		}
		return nil, fmt.Errorf("bootstrap: default-owner list: %w", lerr)
	}
	if len(rows) == 0 {
		return nil, nil
	}
	ownerID := rows[0].ID
	for _, u := range rows {
		if u.IsAdmin {
			ownerID = u.ID
			break
		}
	}
	owner, err = authStore.FindUserByID(ctx, ownerID)
	if err != nil {
		return nil, fmt.Errorf("bootstrap: default-owner hydrate: %w", err)
	}
	return owner, nil
}

func loadInitialWorkspaceState() (workspaceState, bool, error) {
	data, err := os.ReadFile(legacyWorkspacePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return defaultWorkspaceState(), false, nil
		}
		return workspaceState{}, false, fmt.Errorf("read legacy workspace: %w", err)
	}
	if len(data) == 0 {
		return defaultWorkspaceState(), false, nil
	}
	var state workspaceState
	if err := json.Unmarshal(data, &state); err != nil {
		logger.Warn("bootstrap: legacy workspace.json unparseable, starting from default state",
			"err", err, "path", legacyWorkspacePath)
		return defaultWorkspaceState(), false, nil
	}
	return state, true, nil
}

func ensureDataDir() error {
	return os.MkdirAll(filepath.Dir(legacyWorkspacePath), 0o755)
}

func migrateLegacyAttachments(workspaceID string) error {
	legacyRoot := filepath.Join(".data", "attachments")
	entries, err := os.ReadDir(legacyRoot)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	newRoot := filepath.Join(legacyRoot, workspaceID)
	if err := os.MkdirAll(newRoot, 0o755); err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == workspaceID {
			continue
		}
		oldPath := filepath.Join(legacyRoot, entry.Name())
		newPath := filepath.Join(newRoot, entry.Name())
		if _, statErr := os.Stat(newPath); statErr == nil {
			continue
		}
		if err := os.Rename(oldPath, newPath); err != nil {
			logger.Warn("bootstrap: attachment move failed", "src", oldPath, "dst", newPath, "err", err)
		}
	}
	return nil
}
