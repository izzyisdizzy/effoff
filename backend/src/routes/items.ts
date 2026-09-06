import { Hono } from "hono";
import { apiError } from "../api-error";
import { requireSession, requireTripMember } from "../auth/middleware";
import { isLocalDateTime, isValidTimeZone, localToUtc } from "../time";
import {
  ITEM_KINDS,
  publicItem,
  type AppEnv,
  type ItemKind,
  type ItineraryItemRow,
} from "../types";

const items = new Hono<AppEnv>();

const EXPECTED_SHAPE =
  'Expected { kind: "flight" | "stay" | "reservation" | "activity", title, cityId?, notes?, address?, confirmationNumber?, links?, startLocal?, startTz?, endLocal?, endTz?, departureAirport?, arrivalAirport?, position? }.';

type ItemBody = {
  kind?: unknown;
  title?: unknown;
  cityId?: unknown;
  notes?: unknown;
  address?: unknown;
  confirmationNumber?: unknown;
  links?: unknown;
  startLocal?: unknown;
  startTz?: unknown;
  endLocal?: unknown;
  endTz?: unknown;
  departureAirport?: unknown;
  arrivalAirport?: unknown;
  position?: unknown;
};

function isKind(value: unknown): value is ItemKind {
  return typeof value === "string" && (ITEM_KINDS as readonly string[]).includes(value);
}

// Primitive shape check: every present field has the right type. `null` is
// allowed on nullable columns (PATCH clears with it); kind/title are NOT NULL.
function shapeProblem(body: ItemBody): string | null {
  if (body.kind !== undefined && !isKind(body.kind)) {
    return EXPECTED_SHAPE;
  }
  if (
    body.title !== undefined &&
    (typeof body.title !== "string" || body.title.trim().length === 0)
  ) {
    return "title must be a non-empty string.";
  }
  const nullableStrings = [
    "cityId",
    "notes",
    "address",
    "confirmationNumber",
    "startLocal",
    "startTz",
    "endLocal",
    "endTz",
    "departureAirport",
    "arrivalAirport",
  ] as const;
  for (const field of nullableStrings) {
    const value = body[field];
    if (value !== undefined && value !== null && typeof value !== "string") {
      return EXPECTED_SHAPE;
    }
  }
  if (body.position !== undefined && body.position !== null && !Number.isInteger(body.position)) {
    return "position must be an integer or null.";
  }
  if (body.links !== undefined && body.links !== null) {
    if (
      !Array.isArray(body.links) ||
      !body.links.every((link): link is string => typeof link === "string")
    ) {
      return "links must be an array of URL strings.";
    }
    for (const link of body.links) {
      if (!URL.canParse(link)) {
        return `links contains an invalid URL: ${link}`;
      }
    }
  }
  return null;
}

// Cross-field validation and UTC derivation over the *merged* row, so POST
// and PATCH enforce identical invariants. Returns an error message or null;
// mutates the draft's tz/utc columns as it resolves them.
function finalizeItem(
  draft: ItineraryItemRow,
  cityTimezone: string | null,
): { error: string } | { error: null } {
  if (draft.departure_airport !== null || draft.arrival_airport !== null) {
    if (draft.kind !== "flight") {
      return { error: "departureAirport/arrivalAirport are only valid on a flight." };
    }
  }
  for (const end of ["start", "end"] as const) {
    const local = end === "start" ? draft.start_local : draft.end_local;
    let tz = end === "start" ? draft.start_tz : draft.end_tz;
    if (local === null) {
      // No wall-clock time: a zone alone is meaningless, clear the pair.
      tz = null;
    } else {
      if (!isLocalDateTime(local)) {
        return {
          error: `${end}Local must be local wall-clock ISO 8601 (YYYY-MM-DDTHH:MM, no offset).`,
        };
      }
      // Resolve the zone: explicit wins, else the item's city, else fail —
      // a wall-clock time without a zone has no place on the timeline.
      tz ??= cityTimezone;
      if (tz === null) {
        return {
          error: `${end}Tz is required when ${end}Local is set on an item with no city.`,
        };
      }
      if (!isValidTimeZone(tz)) {
        return { error: `${end}Tz must be a valid IANA zone (e.g. Asia/Tokyo).` };
      }
    }
    const utc = local === null || tz === null ? null : localToUtc(local, tz);
    if (end === "start") {
      draft.start_tz = tz;
      draft.start_utc = utc;
    } else {
      draft.end_tz = tz;
      draft.end_utc = utc;
    }
  }
  return { error: null };
}

async function cityTimezoneFor(
  db: D1Database,
  tripId: string,
  cityId: string | null,
): Promise<{ found: boolean; timezone: string | null }> {
  if (cityId === null) {
    return { found: true, timezone: null };
  }
  const city = await db
    .prepare("SELECT timezone FROM trip_cities WHERE id = ? AND trip_id = ?")
    .bind(cityId, tripId)
    .first<{ timezone: string }>();
  if (city === null) {
    return { found: false, timezone: null };
  }
  return { found: true, timezone: city.timezone };
}

const ITEM_COLUMNS =
  "id, trip_id, city_id, kind, title, notes, address, confirmation_number, links, start_local, start_tz, end_local, end_tz, start_utc, end_utc, departure_airport, arrival_airport, position, created_at, updated_at";

function bindItem(db: D1Database, sql: string, item: ItineraryItemRow): D1PreparedStatement {
  return db
    .prepare(sql)
    .bind(
      item.id,
      item.trip_id,
      item.city_id,
      item.kind,
      item.title,
      item.notes,
      item.address,
      item.confirmation_number,
      item.links,
      item.start_local,
      item.start_tz,
      item.end_local,
      item.end_tz,
      item.start_utc,
      item.end_utc,
      item.departure_airport,
      item.arrival_airport,
      item.position,
      item.created_at,
      item.updated_at,
    );
}

items.post("/trips/:id/items", requireSession, requireTripMember, async (c) => {
  const tripId = c.req.param("id");
  let body: ItemBody;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, 400, "invalid_request", "Request body must be JSON.");
  }
  if (!isKind(body.kind) || typeof body.title !== "string") {
    return apiError(c, 400, "invalid_request", EXPECTED_SHAPE);
  }
  const problem = shapeProblem(body);
  if (problem !== null) {
    return apiError(c, 400, "invalid_request", problem);
  }
  const now = new Date().toISOString();
  const draft: ItineraryItemRow = {
    id: crypto.randomUUID(),
    trip_id: tripId,
    city_id: (body.cityId as string | null | undefined) ?? null,
    kind: body.kind,
    title: body.title.trim(),
    notes: (body.notes as string | null | undefined) ?? null,
    address: (body.address as string | null | undefined) ?? null,
    confirmation_number: (body.confirmationNumber as string | null | undefined) ?? null,
    links: body.links === undefined || body.links === null ? null : JSON.stringify(body.links),
    start_local: (body.startLocal as string | null | undefined) ?? null,
    start_tz: (body.startTz as string | null | undefined) ?? null,
    end_local: (body.endLocal as string | null | undefined) ?? null,
    end_tz: (body.endTz as string | null | undefined) ?? null,
    start_utc: null,
    end_utc: null,
    departure_airport: (body.departureAirport as string | null | undefined) ?? null,
    arrival_airport: (body.arrivalAirport as string | null | undefined) ?? null,
    position: (body.position as number | null | undefined) ?? null,
    created_at: now,
    updated_at: now,
  };
  const city = await cityTimezoneFor(c.env.DB, tripId, draft.city_id);
  if (!city.found) {
    return apiError(c, 400, "unknown_city", "cityId does not refer to a city on this trip.");
  }
  const finalized = finalizeItem(draft, city.timezone);
  if (finalized.error !== null) {
    return apiError(c, 400, "invalid_request", finalized.error);
  }
  await bindItem(
    c.env.DB,
    `INSERT INTO itinerary_items (${ITEM_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    draft,
  ).run();
  return c.json({ item: publicItem(draft) }, 201);
});

items.patch("/trips/:tripId/items/:id", requireSession, requireTripMember, async (c) => {
  const tripId = c.req.param("tripId");
  const itemId = c.req.param("id");
  let body: ItemBody;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, 400, "invalid_request", "Request body must be JSON.");
  }
  if (body.kind === null || body.title === null) {
    return apiError(c, 400, "invalid_request", "kind and title cannot be cleared.");
  }
  const problem = shapeProblem(body);
  if (problem !== null) {
    return apiError(c, 400, "invalid_request", problem);
  }
  const existing = await c.env.DB.prepare(
    "SELECT * FROM itinerary_items WHERE id = ? AND trip_id = ?",
  )
    .bind(itemId, tripId)
    .first<ItineraryItemRow>();
  if (existing === null) {
    return apiError(c, 404, "item_not_found", "Itinerary item not found on this trip.");
  }
  const merged: ItineraryItemRow = {
    ...existing,
    kind: body.kind === undefined ? existing.kind : (body.kind as ItemKind),
    title: body.title === undefined ? existing.title : (body.title as string).trim(),
    city_id: body.cityId === undefined ? existing.city_id : (body.cityId as string | null),
    notes: body.notes === undefined ? existing.notes : (body.notes as string | null),
    address: body.address === undefined ? existing.address : (body.address as string | null),
    confirmation_number:
      body.confirmationNumber === undefined
        ? existing.confirmation_number
        : (body.confirmationNumber as string | null),
    links:
      body.links === undefined
        ? existing.links
        : body.links === null
          ? null
          : JSON.stringify(body.links),
    start_local:
      body.startLocal === undefined ? existing.start_local : (body.startLocal as string | null),
    start_tz: body.startTz === undefined ? existing.start_tz : (body.startTz as string | null),
    end_local: body.endLocal === undefined ? existing.end_local : (body.endLocal as string | null),
    end_tz: body.endTz === undefined ? existing.end_tz : (body.endTz as string | null),
    departure_airport:
      body.departureAirport === undefined
        ? existing.departure_airport
        : (body.departureAirport as string | null),
    arrival_airport:
      body.arrivalAirport === undefined
        ? existing.arrival_airport
        : (body.arrivalAirport as string | null),
    position: body.position === undefined ? existing.position : (body.position as number | null),
    updated_at: new Date().toISOString(),
  };
  const city = await cityTimezoneFor(c.env.DB, tripId, merged.city_id);
  if (!city.found) {
    return apiError(c, 400, "unknown_city", "cityId does not refer to a city on this trip.");
  }
  const finalized = finalizeItem(merged, city.timezone);
  if (finalized.error !== null) {
    return apiError(c, 400, "invalid_request", finalized.error);
  }
  await c.env.DB.prepare(
    "UPDATE itinerary_items SET city_id = ?, kind = ?, title = ?, notes = ?, address = ?, confirmation_number = ?, links = ?, start_local = ?, start_tz = ?, end_local = ?, end_tz = ?, start_utc = ?, end_utc = ?, departure_airport = ?, arrival_airport = ?, position = ?, updated_at = ? WHERE id = ? AND trip_id = ?",
  )
    .bind(
      merged.city_id,
      merged.kind,
      merged.title,
      merged.notes,
      merged.address,
      merged.confirmation_number,
      merged.links,
      merged.start_local,
      merged.start_tz,
      merged.end_local,
      merged.end_tz,
      merged.start_utc,
      merged.end_utc,
      merged.departure_airport,
      merged.arrival_airport,
      merged.position,
      merged.updated_at,
      itemId,
      tripId,
    )
    .run();
  return c.json({ item: publicItem(merged) });
});

items.delete("/trips/:tripId/items/:id", requireSession, requireTripMember, async (c) => {
  const tripId = c.req.param("tripId");
  const itemId = c.req.param("id");
  const result = await c.env.DB.prepare("DELETE FROM itinerary_items WHERE id = ? AND trip_id = ?")
    .bind(itemId, tripId)
    .run();
  if (result.meta.changes === 0) {
    return apiError(c, 404, "item_not_found", "Itinerary item not found on this trip.");
  }
  return c.json({ ok: true });
});

export default items;
