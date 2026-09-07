-- Migration number: 0005 	 2026-09-06T23:19:49.951Z
--
-- The place layer: places imported from a member's Google Maps lists, plus the
-- decoration Maps cannot hold — tags, notes, and source links. See
-- docs/foundation.md (Place, PlaceTag, PlaceLink). Maps stays the curation
-- home; this is a trip-scoped annotation layer, not a place database.
--
-- Conventions follow 0002_core_schema.sql: TEXT ids from app code, ISO 8601
-- UTC timestamps, trip-scoped tables cascade on trip delete.
--
-- city_id is nullable and SET NULL for the same reasons as
-- itinerary_items.city_id: a place can exist before anyone assigns it to a city
-- (an importer knows a list, not an itinerary), and deleting a city must not
-- throw away the tags and notes a member typed — that decoration is the whole
-- point of this layer. Same caveat as there: the FK action does not bump
-- updated_at, so app-level city deletion nulls the column explicitly (with
-- updated_at) in the same batch, leaving the FK action as a backstop.
--
-- google_maps_url is an imported place's identity: the partial unique index
-- below makes re-importing a list idempotent per trip while leaving hand-added
-- places (NULL url) out of the index entirely. Dedupe is exact-string on the
-- stored URL — normalizing the share-link variants that point at the same pin
-- is the importer's job, and the import path is deliberately out of scope here
-- (README open question).
--
-- source_list is the free-text name of the Maps list a place came from. It is
-- deliberately NOT a foreign key to a map_lists table: that table's shape is
-- still being reconciled with issue #14, and a text label is what every
-- candidate import path has in hand anyway.
CREATE TABLE places (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  city_id TEXT REFERENCES trip_cities(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  google_maps_url TEXT,
  source_list TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Tags and links are value sets owned by their place, not entities: no id, no
-- timestamps. The place write path replaces them wholesale and bumps
-- places.updated_at — the signal the sync layer reads — so per-row timestamps
-- would be a second, redundant clock. This is a deliberate deviation from
-- 0002's "every mutable row carries created_at/updated_at": these rows are
-- never updated, only inserted and deleted.
--
-- The composite PK *is* the dedupe rule (one row per place per tag), and its
-- leftmost column indexes place_id for the cascade, so no extra index is needed
-- — the same reasoning as trip_members in 0002.
--
-- Tags are stored lowercase and trimmed. App code normalizes with JS
-- (Unicode-aware); this CHECK is the storage backstop, and its reach is
-- honestly limited: SQLite's lower()/trim() without ICU are ASCII-only, so it
-- catches 'Ramen' and ' ramen ' but not 'CAFÉ'. App normalization is strictly
-- stronger, and nothing but app code writes here.
CREATE TABLE place_tags (
  place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  tag TEXT NOT NULL CHECK (length(tag) > 0 AND tag = lower(tag) AND tag = trim(tag)),
  PRIMARY KEY (place_id, tag)
);

-- Source links (Tabelog, a friend's rec, a review). The URL is a link's
-- identity within a place — the same URL twice under two labels is a duplicate,
-- not two links — so it is the PK's second column. position keeps the order the
-- client sent, which is display order (itinerary_items.links is an ordered JSON
-- array for the same reason). label is optional: a bare URL is a real link.
CREATE TABLE place_links (
  place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  label TEXT,
  position INTEGER NOT NULL,
  PRIMARY KEY (place_id, url)
);

-- Re-importing a Google Maps list must not double up: one place per
-- (trip, google_maps_url). Partial, so the many hand-added places with no URL
-- are simply not in the index rather than relying on NULLs being distinct
-- inside it.
CREATE UNIQUE INDEX idx_places_trip_google_maps_url
  ON places(trip_id, google_maps_url)
  WHERE google_maps_url IS NOT NULL;

-- The trip-doc read and the trip-delete cascade both scan by trip_id alone, and
-- a partial index cannot serve a query that does not imply its predicate, so
-- trip_id needs a plain index of its own. city_id is the other FK child column
-- whose parent gets deleted. place_tags/place_links are covered by the leftmost
-- column of their composite PKs.
CREATE INDEX idx_places_trip ON places(trip_id);
CREATE INDEX idx_places_city ON places(city_id);

INSERT INTO meta (key, value) VALUES ('schema_version', '5')
  ON CONFLICT (key) DO UPDATE SET value = excluded.value;
