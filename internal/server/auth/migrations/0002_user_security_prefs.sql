-- Per-user security prefs. Currently a single flag: when set, a successful
-- login on one device revokes every other active refresh session for the
-- same user. Defaults to 0 (off) so existing deployments are unaffected.
ALTER TABLE users ADD COLUMN single_session INTEGER NOT NULL DEFAULT 0;
