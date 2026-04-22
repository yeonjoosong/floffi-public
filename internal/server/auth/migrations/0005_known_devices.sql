-- 0005_known_devices.sql — Phase 6.3: "new login from an unfamiliar
-- device/IP" notifications.
--
-- We never store the raw IP or User-Agent string here; both are hashed
-- with sha256 before insert so a DB dump can't be used to build a
-- per-user location history. The trade-off is that the table can only
-- answer "have we seen this exact (ip, ua) pair before?", not "is
-- this in the same subnet as before" — see docs §15 for the rationale.
--
-- The composite UNIQUE constraint lets the upsert path use INSERT ON
-- CONFLICT to bump last_seen without a SELECT-then-UPDATE round-trip.

CREATE TABLE IF NOT EXISTS known_devices (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  ip_hash     TEXT NOT NULL,
  ua_hash     TEXT NOT NULL,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  UNIQUE (user_id, ip_hash, ua_hash),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_known_devices_user ON known_devices(user_id);
