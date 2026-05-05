-- 0011_user_memories.sql — Stage 1 of plan/rag-and-memory-roadmap.md.
--
-- Per-user "long-term memory": short notes the user explicitly asks the agent
-- to remember. Injected into every LLM call the user triggers (priority sits
-- between system safety rules and the per-task instruction — see plan).
--
-- Scope rules:
--   * user_id NOT NULL — the row is always tied to one user, never shared
--     across workspace members. A row created by user A in a collaboration
--     workspace is invisible to user B even when B runs an agent in the
--     same workspace.
--   * workspace_id NULLABLE — NULL means "global to this user, applies in
--     every workspace they touch." A workspace_id value scopes the memory
--     to that one workspace. Stage 1 surfaces both forms in the UI but the
--     LLM inject path treats NULL as the common case.

CREATE TABLE IF NOT EXISTS user_memories (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      TEXT NOT NULL,
    workspace_id TEXT,                      -- NULL = global to user; else scoped
    content      TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_memories_user
    ON user_memories(user_id);

CREATE INDEX IF NOT EXISTS idx_user_memories_user_ws
    ON user_memories(user_id, workspace_id);
