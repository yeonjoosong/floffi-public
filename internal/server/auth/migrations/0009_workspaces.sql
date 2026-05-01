-- 0009_workspaces.sql — Phase 11 multi-tenant workspaces.
--
-- Pre-Phase-11 the server kept a single .data/workspace.json file
-- shared by every authenticated user (legacy single-operator model).
-- This migration introduces per-workspace state + membership so each
-- user has their own workspace(s) and can opt into collaboration by
-- inviting others.
--
-- Three new tables:
--
--   workspaces            — one row per workspace. state_json holds
--                           the same shape as the legacy workspace.json
--                           (board title, tasks, teams, reports, …).
--                           Owner is the user who created it; mode
--                           (personal vs collaborative) is derived
--                           from the row count in workspace_members.
--
--   workspace_members     — (workspace_id, user_id, role). Plus a
--                           joined_at timestamp so future audit / UI
--                           can show "joined 3 weeks ago".
--
--   workspace_invitations — pending invites. raw token is returned to
--                           the inviter exactly once (admin reset-
--                           password pattern); we store only the
--                           sha256 hash so a DB dump can't replay.
--
-- Plus users.workspace_cap_override — per-user override that lets a
-- super admin lift the workspace cap for a specific operator. NULL
-- means "use the global default" (resolved at runtime).

CREATE TABLE IF NOT EXISTS workspaces (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    owner_id      TEXT NOT NULL,
    -- state_json holds the full workspaceState (tasks, sections, teams,
    -- reports, …). Kept as a JSON blob rather than normalized into
    -- per-table rows because (a) the schema is wide and shaped for the
    -- UI rather than relational queries, and (b) the legacy
    -- workspace.json migration becomes a single INSERT instead of an
    -- ETL job. SQLite's JSON1 still lets us query into it when needed.
    state_json    TEXT NOT NULL,
    webhook_token TEXT NOT NULL UNIQUE,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    -- deleted_at != 0 means soft-deleted. Lock the workspace away from
    -- listings + member access without immediate destruction so an
    -- accidental delete can be reversed within a retention window.
    deleted_at    INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_id);

CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    role         TEXT NOT NULL,         -- 'owner' | 'member'
    joined_at    INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, user_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id);

CREATE TABLE IF NOT EXISTS workspace_invitations (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL,
    invited_email TEXT NOT NULL,
    invited_by    TEXT NOT NULL,
    token_hash    TEXT NOT NULL,
    expires_at    INTEGER NOT NULL,
    used_at       INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_invitations_workspace ON workspace_invitations(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_invitations_token ON workspace_invitations(token_hash);

-- users.workspace_cap_override: per-user workspace count limit. NULL
-- means "use the global default" (FLOFFI_WORKSPACE_CAP env var or
-- the hardcoded fallback). A super admin can lift this for specific
-- operators via /api/auth/admin/users/{id}/workspace-cap.
ALTER TABLE users ADD COLUMN workspace_cap_override INTEGER;
