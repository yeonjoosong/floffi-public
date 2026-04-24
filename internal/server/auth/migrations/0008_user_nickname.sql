-- 0008_user_nickname.sql — Phase 7: nickname column.
--
-- Signup is moving to email-only (no username field exposed to the
-- user). We keep the existing users.username column for backward
-- compatibility — it's now auto-generated server-side from the
-- email's local-part — but the display affordance throughout the UI
-- is a separate, user-editable nickname.
--
-- nickname is nullable: an empty value means "fall back to the
-- email local-part." Pre-existing rows get NULL (the migration sets
-- nothing) and the read path treats NULL the same as empty.

ALTER TABLE users ADD COLUMN nickname TEXT NOT NULL DEFAULT '';
