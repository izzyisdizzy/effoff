import { Hono } from "hono";
import { apiError } from "../api-error";
import { requireSession, requireTripMember } from "../auth/middleware";
import { findTripCity, UNKNOWN_CITY_MESSAGE } from "../trip-cities";
import { publicPlace, type AppEnv, type PlaceLink, type PlaceRow } from "../types";
import {
  isHttpUrl,
  MAX_LABEL,
  MAX_LINK,
  MAX_LINKS,
  MAX_NAME,
  MAX_NOTES,
  MAX_TAG,
  MAX_TAGS,
  readJsonObject,
} from "../validate";

const places = new Hono<AppEnv>();

const EXPECTED_SHAPE =
  "Expected { name, cityId?, googleMapsUrl?, sourceList?, note?, tags?, links? }.";

const PLACE_CONFLICT = "A place with this Google Maps URL is already on this trip.";

type PlaceBody = {
  name?: unknown;
  cityId?: unknown;
  googleMapsUrl?: unknown;
  sourceList?: unknown;
  note?: unknown;
  tags?: unknown;
  links?: unknown;
};

// Nullable string columns: absent leaves them alone, explicit null clears them.
const NULLABLE_TEXT = [
  ["cityId", MAX_NAME],
  ["googleMapsUrl", MAX_LINK],
  ["sourceList", MAX_NAME],
  ["note", MAX_NOTES],
] as const;

function shapeProblem(body: PlaceBody): string | null {
  if (
    body.name !== undefined &&
    (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.length > MAX_NAME)
  ) {
    return "name must be a non-empty string.";
  }
  for (const [field, cap] of NULLABLE_TEXT) {
    const value = body[field];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value !== "string") {
      return EXPECTED_SHAPE;
    }
    if (value.length > cap) {
      return `${field} must be at most ${cap} characters.`;
    }
  }
  if (typeof body.googleMapsUrl === "string" && !isHttpUrl(body.googleMapsUrl)) {
    return "googleMapsUrl must be an http(s) URL.";
  }
  return null;
}

// Tags and links are sets owned by the place, not columns: absent means "leave
// the stored set alone" and [] means "clear it". null has no third meaning
// here, so it is rejected rather than guessed at.
function tagsProblem(tags: unknown): string | null {
  if (!Array.isArray(tags)) {
    return "tags must be an array of strings; send [] to clear.";
  }
  if (tags.length > MAX_TAGS) {
    return `tags must have at most ${MAX_TAGS} entries.`;
  }
  for (const tag of tags) {
    if (typeof tag !== "string" || tag.trim().length === 0) {
      return "each tag must be a non-empty string.";
    }
    // Cap the normalized value, since that is what gets stored: lowercasing can
    // lengthen a string (U+0130 lowercases to two code units).
    if (normalizeTag(tag).length > MAX_TAG) {
      return `each tag must be at most ${MAX_TAG} characters.`;
    }
  }
  return null;
}

function linksProblem(links: unknown): string | null {
  if (!Array.isArray(links)) {
    return "links must be an array of { url, label? }; send [] to clear.";
  }
  if (links.length > MAX_LINKS) {
    return `links must have at most ${MAX_LINKS} entries.`;
  }
  for (const link of links) {
    if (typeof link !== "object" || link === null || Array.isArray(link)) {
      return "each link must be an object { url, label? }.";
    }
    const { url, label } = link as { url?: unknown; label?: unknown };
    if (typeof url !== "string" || url.length > MAX_LINK || !isHttpUrl(url)) {
      return "each link needs an http(s) url.";
    }
    if (label !== undefined && label !== null) {
      if (typeof label !== "string") {
        return "a link label must be a string.";
      }
      if (label.length > MAX_LABEL) {
        return `a link label must be at most ${MAX_LABEL} characters.`;
      }
    }
  }
  return null;
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

// Lowercased, trimmed, de-duplicated. Order is deliberately not set here: the
// write paths read the stored set back inside their own batch, so SQLite's
// ORDER BY is the single authority on tag order and a JS sort here could only
// disagree with it (the two use different collations for non-ASCII).
function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map(normalizeTag))];
}

// First occurrence of a URL wins (so its label sticks); the (place_id, url)
// primary key would reject the duplicate anyway, and silently collapsing it is
// kinder to an importer concatenating lists than a 400 would be.
function normalizeLinks(links: { url: string; label?: unknown }[]): PlaceLink[] {
  const seen = new Set<string>();
  const normalized: PlaceLink[] = [];
  for (const link of links) {
    if (seen.has(link.url)) {
      continue;
    }
    seen.add(link.url);
    const label = typeof link.label === "string" ? link.label.trim() : "";
    normalized.push({ url: link.url, label: label.length === 0 ? null : label });
  }
  return normalized;
}

// The partial unique index in 0005_places.sql is the only enforcement of "one
// place per (trip, googleMapsUrl)". This turns it into an honest 409, and
// re-running it inside a failed write's catch classifies the race between two
// concurrent writers without parsing a driver error string. selfId excludes the
// row being written, so re-sending a place's own URL is a no-op, not a conflict.
async function conflictingPlaceId(
  db: D1Database,
  tripId: string,
  url: string | null,
  selfId: string,
): Promise<string | null> {
  if (url === null) {
    return null;
  }
  const row = await db
    .prepare(
      "SELECT id FROM places WHERE trip_id = ? AND google_maps_url IS NOT NULL AND google_maps_url = ? AND id != ?",
    )
    .bind(tripId, url, selfId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

function insertTagStatements(
  db: D1Database,
  placeId: string,
  tags: string[],
): D1PreparedStatement[] {
  return tags.map((tag) =>
    db.prepare("INSERT INTO place_tags (place_id, tag) VALUES (?, ?)").bind(placeId, tag),
  );
}

function insertLinkStatements(
  db: D1Database,
  placeId: string,
  links: PlaceLink[],
): D1PreparedStatement[] {
  return links.map((link, index) =>
    db
      .prepare("INSERT INTO place_links (place_id, url, label, position) VALUES (?, ?, ?, ?)")
      .bind(placeId, link.url, link.label, index),
  );
}

// Read the stored tag and link sets back as the last two statements of the
// write's own batch. Doing it inside the batch (rather than before or after) is
// what makes the response the truth: it sees exactly what this transaction
// wrote, a concurrent writer cannot slip in between, and the ORDER BY is the
// same one the trip doc uses — so a write response and the next GET /trips/:id
// agree by construction instead of by two sort implementations matching.
function readSetStatements(db: D1Database, placeId: string): D1PreparedStatement[] {
  return [
    db.prepare("SELECT tag FROM place_tags WHERE place_id = ? ORDER BY tag").bind(placeId),
    db
      .prepare("SELECT url, label FROM place_links WHERE place_id = ? ORDER BY position, url")
      .bind(placeId),
  ];
}

function readSets(results: D1Result[]): { tags: string[]; links: PlaceLink[] } {
  const tagRes = results.at(-2);
  const linkRes = results.at(-1);
  return {
    tags: ((tagRes?.results ?? []) as { tag: string }[]).map((row) => row.tag),
    links: ((linkRes?.results ?? []) as { url: string; label: string | null }[]).map((row) => ({
      url: row.url,
      label: row.label,
    })),
  };
}

places.post("/trips/:id/places", requireSession, requireTripMember, async (c) => {
  const tripId = c.req.param("id");
  const body: PlaceBody | null = await readJsonObject(c);
  if (body === null) {
    return apiError(c, 400, "invalid_request", "Request body must be a JSON object.");
  }
  if (typeof body.name !== "string") {
    return apiError(c, 400, "invalid_request", EXPECTED_SHAPE);
  }
  const problem = shapeProblem(body);
  if (problem !== null) {
    return apiError(c, 400, "invalid_request", problem);
  }
  // Absent tags/links on create simply mean "none".
  const rawTags = body.tags === undefined ? [] : body.tags;
  const tagProblem = tagsProblem(rawTags);
  if (tagProblem !== null) {
    return apiError(c, 400, "invalid_request", tagProblem);
  }
  const rawLinks = body.links === undefined ? [] : body.links;
  const linkProblem = linksProblem(rawLinks);
  if (linkProblem !== null) {
    return apiError(c, 400, "invalid_request", linkProblem);
  }
  const now = new Date().toISOString();
  const draft: PlaceRow = {
    id: crypto.randomUUID(),
    trip_id: tripId,
    city_id: (body.cityId as string | null | undefined) ?? null,
    name: body.name.trim(),
    google_maps_url: (body.googleMapsUrl as string | null | undefined) ?? null,
    source_list: (body.sourceList as string | null | undefined) ?? null,
    note: (body.note as string | null | undefined) ?? null,
    created_at: now,
    updated_at: now,
  };
  if (!(await findTripCity(c.env.DB, tripId, draft.city_id)).found) {
    return apiError(c, 400, "unknown_city", UNKNOWN_CITY_MESSAGE);
  }
  if ((await conflictingPlaceId(c.env.DB, tripId, draft.google_maps_url, draft.id)) !== null) {
    return apiError(c, 409, "place_exists", PLACE_CONFLICT);
  }
  const statements = [
    c.env.DB.prepare(
      "INSERT INTO places (id, trip_id, city_id, name, google_maps_url, source_list, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      draft.id,
      draft.trip_id,
      draft.city_id,
      draft.name,
      draft.google_maps_url,
      draft.source_list,
      draft.note,
      draft.created_at,
      draft.updated_at,
    ),
    ...insertTagStatements(c.env.DB, draft.id, normalizeTags(rawTags as string[])),
    ...insertLinkStatements(
      c.env.DB,
      draft.id,
      normalizeLinks(rawLinks as { url: string; label?: unknown }[]),
    ),
    ...readSetStatements(c.env.DB, draft.id),
  ];
  let results: D1Result[];
  try {
    results = await c.env.DB.batch(statements);
  } catch (error) {
    // D1 surfaces constraint failures as opaque errors, so classify by
    // re-reading state rather than matching an error message: another writer
    // can have taken this URL between the check above and the batch. The
    // classification is itself a query, so a failure there (the likely case
    // when the batch failed for an infrastructural reason) must surface the
    // original error rather than replace it.
    try {
      if ((await conflictingPlaceId(c.env.DB, tripId, draft.google_maps_url, draft.id)) !== null) {
        return apiError(c, 409, "place_exists", PLACE_CONFLICT);
      }
    } catch {
      throw error;
    }
    throw error;
  }
  const { tags, links } = readSets(results);
  return c.json({ place: publicPlace(draft, tags, links) }, 201);
});

// Partial update. tags/links are declarative sets: omit one to leave it alone,
// send [] to clear it.
places.patch("/trips/:tripId/places/:id", requireSession, requireTripMember, async (c) => {
  const tripId = c.req.param("tripId");
  const placeId = c.req.param("id");
  const body: PlaceBody | null = await readJsonObject(c);
  if (body === null) {
    return apiError(c, 400, "invalid_request", "Request body must be a JSON object.");
  }
  if (body.name === null) {
    return apiError(c, 400, "invalid_request", "name cannot be cleared.");
  }
  const problem = shapeProblem(body);
  if (problem !== null) {
    return apiError(c, 400, "invalid_request", problem);
  }
  if (body.tags !== undefined) {
    const tagProblem = tagsProblem(body.tags);
    if (tagProblem !== null) {
      return apiError(c, 400, "invalid_request", tagProblem);
    }
  }
  if (body.links !== undefined) {
    const linkProblem = linksProblem(body.links);
    if (linkProblem !== null) {
      return apiError(c, 400, "invalid_request", linkProblem);
    }
  }
  const existing = await c.env.DB.prepare("SELECT * FROM places WHERE id = ? AND trip_id = ?")
    .bind(placeId, tripId)
    .first<PlaceRow>();
  if (existing === null) {
    return apiError(c, 404, "place_not_found", "Place not found on this trip.");
  }
  const merged: PlaceRow = {
    ...existing,
    city_id: body.cityId === undefined ? existing.city_id : (body.cityId as string | null),
    name: body.name === undefined ? existing.name : (body.name as string).trim(),
    google_maps_url:
      body.googleMapsUrl === undefined
        ? existing.google_maps_url
        : (body.googleMapsUrl as string | null),
    source_list:
      body.sourceList === undefined ? existing.source_list : (body.sourceList as string | null),
    note: body.note === undefined ? existing.note : (body.note as string | null),
    updated_at: new Date().toISOString(),
  };
  if (!(await findTripCity(c.env.DB, tripId, merged.city_id)).found) {
    return apiError(c, 400, "unknown_city", UNKNOWN_CITY_MESSAGE);
  }
  if ((await conflictingPlaceId(c.env.DB, tripId, merged.google_maps_url, placeId)) !== null) {
    return apiError(c, 409, "place_exists", PLACE_CONFLICT);
  }
  // The place UPDATE always runs, so the batch is never empty and updated_at
  // bumps even on a tags-only edit — the child rows carry no timestamps of
  // their own, so the place's is the only signal the sync layer can read.
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      "UPDATE places SET city_id = ?, name = ?, google_maps_url = ?, source_list = ?, note = ?, updated_at = ? WHERE id = ? AND trip_id = ?",
    ).bind(
      merged.city_id,
      merged.name,
      merged.google_maps_url,
      merged.source_list,
      merged.note,
      merged.updated_at,
      placeId,
      tripId,
    ),
  ];
  // Only the sets the request actually carried are replaced; the others are
  // left untouched and simply read back with the rest.
  if (body.tags !== undefined) {
    statements.push(
      c.env.DB.prepare("DELETE FROM place_tags WHERE place_id = ?").bind(placeId),
      ...insertTagStatements(c.env.DB, placeId, normalizeTags(body.tags as string[])),
    );
  }
  if (body.links !== undefined) {
    statements.push(
      c.env.DB.prepare("DELETE FROM place_links WHERE place_id = ?").bind(placeId),
      ...insertLinkStatements(
        c.env.DB,
        placeId,
        normalizeLinks(body.links as { url: string; label?: unknown }[]),
      ),
    );
  }
  statements.push(...readSetStatements(c.env.DB, placeId));
  let results: D1Result[];
  try {
    results = await c.env.DB.batch(statements);
  } catch (error) {
    // Same state-based classification as POST, and the same rule about not
    // letting a failing classification query hide the original error. A
    // concurrent delete is the other race here: when this request replaces a
    // set, its child inserts hit an FK violation and land in this catch. A
    // request that replaces nothing has no statement to fail, so it returns 200
    // for a row that has just gone — last-write-wins, as elsewhere in the API.
    try {
      if ((await conflictingPlaceId(c.env.DB, tripId, merged.google_maps_url, placeId)) !== null) {
        return apiError(c, 409, "place_exists", PLACE_CONFLICT);
      }
      const stillThere = await c.env.DB.prepare(
        "SELECT 1 AS yes FROM places WHERE id = ? AND trip_id = ?",
      )
        .bind(placeId, tripId)
        .first<{ yes: number }>();
      if (stillThere === null) {
        return apiError(c, 404, "place_not_found", "Place not found on this trip.");
      }
    } catch {
      throw error;
    }
    throw error;
  }
  const { tags, links } = readSets(results);
  return c.json({ place: publicPlace(merged, tags, links) });
});

places.delete("/trips/:tripId/places/:id", requireSession, requireTripMember, async (c) => {
  const tripId = c.req.param("tripId");
  const placeId = c.req.param("id");
  // The tags and links go with it via ON DELETE CASCADE (0005_places.sql).
  const result = await c.env.DB.prepare("DELETE FROM places WHERE id = ? AND trip_id = ?")
    .bind(placeId, tripId)
    .run();
  if (result.meta.changes === 0) {
    return apiError(c, 404, "place_not_found", "Place not found on this trip.");
  }
  return c.json({ ok: true });
});

export default places;
