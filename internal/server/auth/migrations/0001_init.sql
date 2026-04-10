-- Initial auth schema. Single-file migration; switch to versioned tooling
-- (golang-migrate) when we need multi-step upgrades.

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,        -- UUID
  email           TEXT NOT NULL UNIQUE,    -- normalized lowercase
  email_verified  INTEGER NOT NULL DEFAULT 0,
  username        TEXT NOT NULL UNIQUE,    -- display handle (a-z0-9_-, 3-32)
  password_hash   TEXT NOT NULL,           -- argon2id encoded string
  created_at      INTEGER NOT NULL,        -- unix seconds
  updated_at      INTEGER NOT NULL,
  locked_until    INTEGER NOT NULL DEFAULT 0,
  totp_secret     TEXT NOT NULL DEFAULT '',
  totp_enabled    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS refresh_sessions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL,           -- sha256 of the current refresh token
  parent_id       TEXT,                    -- previous session in rotation chain
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  last_used_at    INTEGER NOT NULL,
  user_agent      TEXT NOT NULL DEFAULT '',
  ip              TEXT NOT NULL DEFAULT '',
  revoked_at      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash       TEXT NOT NULL,
  used_at         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT,
  email           TEXT NOT NULL,
  ip              TEXT NOT NULL,
  user_agent      TEXT NOT NULL DEFAULT '',
  outcome         TEXT NOT NULL,
  at              INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT,
  event           TEXT NOT NULL,
  ip              TEXT NOT NULL,
  user_agent      TEXT NOT NULL DEFAULT '',
  meta            TEXT NOT NULL DEFAULT '',
  at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_email_at ON login_attempts(email, at);
CREATE INDEX IF NOT EXISTS idx_refresh_sessions_user   ON refresh_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_sessions_parent ON refresh_sessions(parent_id);
