package auth

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// UserMemory mirrors a row in `user_memories`. See migration 0010 for the
// scope rules (per-user always; per-workspace optional).
type UserMemory struct {
	ID          int64  `json:"id"`
	UserID      string `json:"userId"`
	WorkspaceID string `json:"workspaceId,omitempty"` // empty when global to user
	Content     string `json:"content"`
	CreatedAt   int64  `json:"createdAt"`
	UpdatedAt   int64  `json:"updatedAt"`
}

var ErrMemoryNotFound = errors.New("memory not found")

// CreateUserMemory inserts a new memory row and returns the assigned ID.
// workspaceID may be empty to create a "global" memory (applies in every
// workspace the user touches).
func (s *Store) CreateUserMemory(ctx context.Context, userID, workspaceID, content string) (UserMemory, error) {
	now := time.Now().Unix()
	var wsArg any
	if workspaceID == "" {
		wsArg = nil
	} else {
		wsArg = workspaceID
	}
	res, err := s.db.ExecContext(ctx, `
		INSERT INTO user_memories (user_id, workspace_id, content, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?)`,
		userID, wsArg, content, now, now,
	)
	if err != nil {
		return UserMemory{}, err
	}
	id, _ := res.LastInsertId()
	return UserMemory{
		ID:          id,
		UserID:      userID,
		WorkspaceID: workspaceID,
		Content:     content,
		CreatedAt:   now,
		UpdatedAt:   now,
	}, nil
}

// ListUserMemoriesForPrompt returns every memory that should be injected into
// an LLM call run by `userID` inside `workspaceID`. The query unions:
//   - global memories (workspace_id IS NULL)
//   - workspace-scoped memories that match the active workspace_id
//
// Ordering: newest-first so the prompt assembly can truncate from the tail
// if the budget is tight.
func (s *Store) ListUserMemoriesForPrompt(ctx context.Context, userID, workspaceID string) ([]UserMemory, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, user_id, COALESCE(workspace_id, ''), content, created_at, updated_at
		FROM user_memories
		WHERE user_id = ?
		  AND (workspace_id IS NULL OR workspace_id = ?)
		ORDER BY updated_at DESC, id DESC`,
		userID, workspaceID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMemories(rows)
}

// ListAllUserMemories returns every memory owned by the user, scoped or not.
// Used by the management UI ("내 메모리" tab) — separate from the prompt path
// so the UI can show "applies in: 워크스페이스 X" / "전역" labels without
// re-querying.
func (s *Store) ListAllUserMemories(ctx context.Context, userID string) ([]UserMemory, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, user_id, COALESCE(workspace_id, ''), content, created_at, updated_at
		FROM user_memories
		WHERE user_id = ?
		ORDER BY updated_at DESC, id DESC`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMemories(rows)
}

func scanMemories(rows *sql.Rows) ([]UserMemory, error) {
	out := []UserMemory{}
	for rows.Next() {
		var m UserMemory
		if err := rows.Scan(&m.ID, &m.UserID, &m.WorkspaceID, &m.Content, &m.CreatedAt, &m.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// UpdateUserMemory rewrites the content (the only mutable field). Returns
// ErrMemoryNotFound when the row doesn't exist or belongs to a different user;
// the user_id check is part of the WHERE so a forged ID can't edit someone
// else's row.
func (s *Store) UpdateUserMemory(ctx context.Context, userID string, id int64, content string) (UserMemory, error) {
	now := time.Now().Unix()
	res, err := s.db.ExecContext(ctx, `
		UPDATE user_memories
		SET content = ?, updated_at = ?
		WHERE id = ? AND user_id = ?`,
		content, now, id, userID,
	)
	if err != nil {
		return UserMemory{}, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return UserMemory{}, ErrMemoryNotFound
	}
	// Re-fetch so the response carries the full row (including timestamps
	// and workspace_id, which the caller may not have remembered).
	row := s.db.QueryRowContext(ctx, `
		SELECT id, user_id, COALESCE(workspace_id, ''), content, created_at, updated_at
		FROM user_memories WHERE id = ?`, id)
	var m UserMemory
	if err := row.Scan(&m.ID, &m.UserID, &m.WorkspaceID, &m.Content, &m.CreatedAt, &m.UpdatedAt); err != nil {
		return UserMemory{}, err
	}
	return m, nil
}

// DeleteUserMemory removes a row. As with Update, the user_id check is part
// of the WHERE so cross-user deletion can't happen even if the caller forges
// an ID.
func (s *Store) DeleteUserMemory(ctx context.Context, userID string, id int64) error {
	res, err := s.db.ExecContext(ctx, `
		DELETE FROM user_memories WHERE id = ? AND user_id = ?`,
		id, userID,
	)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrMemoryNotFound
	}
	return nil
}
