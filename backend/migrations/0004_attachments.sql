-- Migration number: 0004 	 2026-09-06T00:00:00.000Z
--
-- Attachments: ticket/confirmation images and PDFs. Bytes live in R2 (binding
-- ATTACHMENTS, key trips/<trip_id>/<id>); this table is the metadata and the
-- authorization record — every read goes through the Worker, which checks
-- trip membership against trip_id before streaming. See docs/foundation.md
-- (Attachment).
--
-- Conventions follow 0002_core_schema.sql: TEXT ids from app code, ISO 8601
-- UTC timestamps, trip-scoped tables cascade on trip delete, user-side
-- references never cascade (no account-deletion flow in v1).
--
-- itinerary_item_id is the optional link to the item the booking belongs to.
-- It is nullable because booking capture uploads the ticket *before* the
-- item exists, and it is SET NULL (not CASCADE) on item deletion: the booking
-- is the source, so deleting the item must not throw away the ticket. Same
-- caveat as itinerary_items.city_id — the FK action does not bump updated_at,
-- so app-level item deletion nulls the link explicitly (with updated_at) in
-- the same batch, leaving the FK action as a backstop.
--
-- mime_type is what the Worker sniffed from the bytes (never the client's
-- declared type) and is what the object is served back as. filename is the
-- original upload name, kept for display and Content-Disposition only.
-- Trip deletion in app code removes the R2 objects before the rows cascade.
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  itinerary_item_id TEXT REFERENCES itinerary_items(id) ON DELETE SET NULL,
  r2_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  filename TEXT,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- FK child columns whose parents get deleted (trip cascade, item SET NULL);
-- trip_id also backs the trip-doc read. uploaded_by references users, which
-- are never deleted in v1, so it is deliberately unindexed.
CREATE INDEX idx_attachments_trip ON attachments(trip_id);
CREATE INDEX idx_attachments_item ON attachments(itinerary_item_id);

INSERT INTO meta (key, value) VALUES ('schema_version', '4')
  ON CONFLICT (key) DO UPDATE SET value = excluded.value;
