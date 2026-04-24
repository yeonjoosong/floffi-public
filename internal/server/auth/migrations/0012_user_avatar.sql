-- 0012_user_avatar.sql — user-editable avatar, independent of nickname.
--
-- Until now the topbar avatar was just the first code point of the
-- nickname (avatarInitial). This lets a user set the avatar separately
-- — typically a single emoji — without touching their display name.
--
-- Empty means "fall back to the nickname's first code point" (the old
-- behaviour), so existing rows need no backfill.

ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT '';
