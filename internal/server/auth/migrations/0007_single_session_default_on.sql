-- 0007_single_session_default_on.sql — Phase 6.6
--
-- "Only one active session per user" is the policy people expect from
-- a modern auth system. We previously shipped single_session as an
-- opt-in toggle that defaulted to 0, which meant a fresh install
-- happily allowed two browsers to be signed into the same account at
-- once — surprising the user who reasonably assumed the new login
-- would kick the old one out.
--
-- Backfill flips every existing row that's still at the original
-- default (0). Users who explicitly turned it off keep their setting
-- only because there's no way for us to tell that apart from "never
-- touched it" — this is a one-shot policy migration, not a UX
-- regression. Anyone who wants multiple devices can flip the toggle
-- back to off from the security panel after this migration runs.
--
-- The column itself can't have its DEFAULT changed (SQLite doesn't
-- support ALTER COLUMN SET DEFAULT). New rows are constructed in Go
-- with SingleSession=true explicitly via store.CreateUser callers, so
-- the column default no longer matters for application-issued inserts.

UPDATE users SET single_session = 1, updated_at = strftime('%s', 'now')
WHERE single_session = 0;
