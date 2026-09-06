-- Migration number: 0003 	 2026-09-05T00:00:00.000Z
--
-- Auth tables: sessions (Worker-issued opaque tokens) and invites (trip
-- share links). See docs/foundation.md (Auth, User/TripMember/Invite).
--
-- Conventions follow 0002_core_schema.sql: TEXT ids from app code, ISO 8601
-- UTC timestamps, trip-scoped tables cascade on trip delete, user-side
-- references never cascade (no account-deletion flow in v1).

-- One row per live sign-in. The PK is the SHA-256 hex of the raw token the
-- client holds — the raw token is never stored, so a leaked D1 snapshot
-- cannot be replayed as live sessions. Fixed expiry, no sliding refresh in
-- v1; revocation is a row delete. client records which transport minted the
-- session ('web' cookie vs 'ios' bearer).
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  client TEXT NOT NULL CHECK (client IN ('web', 'ios')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Trip share links. Opening one while signed in joins the trip. Links
-- expire 30 days after creation and can be revoked early (revoked_at set by
-- the trip-settings flow; the column lands now, the endpoint comes later).
CREATE TABLE invites (
  token TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

-- FK child columns whose parents get deleted (invites.trip_id) or that back
-- a read path (sessions.user_id: sign-out-everywhere / session listing).
-- invites.created_by and sessions.user_id reference users, which are never
-- deleted in v1; sessions.user_id is indexed for the read path, not the FK.
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_invites_trip ON invites(trip_id);

INSERT INTO meta (key, value) VALUES ('schema_version', '3')
  ON CONFLICT (key) DO UPDATE SET value = excluded.value;
