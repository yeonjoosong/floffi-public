-- 0006_user_admin.sql — Phase 6.4: admin-view permission flag.
--
-- We avoid a full role/permission system for now — floffi only needs
-- one elevated bit ("can see other users' activity, unlock accounts")
-- and a boolean column is dramatically simpler than a join table.
--
-- ALTER TABLE ADD COLUMN can't say IF NOT EXISTS in SQLite; the migrate
-- runner swallows the resulting "duplicate column name" error so re-
-- running the migration on an existing DB is safe.

ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
