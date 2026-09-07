import { Hono } from "hono";
import { apiError } from "../api-error";
import { requireSession, requireTripMember } from "../auth/middleware";
import { isDateOnly, isValidTimeZone, localToUtc } from "../time";
import { publicCity, type AppEnv, type ItineraryItemRow, type TripCityRow } from "../types";
import { MAX_NAME, readJsonObject } from "../validate";

const cities = new Hono<AppEnv>();

// Shared field checks for create and patch. `undefined` in a slot means the
// field was absent (allowed on PATCH; POST enforces its required set first).
function fieldError(fields: {
  name?: unknown;
  timezone?: unknown;
  arrivalDate?: unknown;
  departureDate?: unknown;
}): string | null {
  const { name, timezone, arrivalDate, departureDate } = fields;
  if (
    name !== undefined &&
    (typeof name !== "string" || name.trim().length === 0 || name.length > MAX_NAME)
  ) {
    return "name must be a non-empty string.";
  }
  if (timezone !== undefined && (typeof timezone !== "string" || !isValidTimeZone(timezone))) {
    return "timezone must be a valid IANA zone (e.g. Asia/Tokyo).";
  }
  for (const [label, value] of [
    ["arrivalDate", arrivalDate],
    ["departureDate", departureDate],
  ] as const) {
    if (
      value !== undefined &&
      value !== null &&
      (typeof value !== "string" || !isDateOnly(value))
    ) {
      return `${label} must be an ISO date (YYYY-MM-DD) or null.`;
    }
  }
  return null;
}

cities.post("/trips/:id/cities", requireSession, requireTripMember, async (c) => {
  const tripId = c.req.param("id");
  const body: {
    name?: unknown;
    timezone?: unknown;
    arrivalDate?: unknown;
    departureDate?: unknown;
  } | null = await readJsonObject(c);
  if (body === null) {
    return apiError(c, 400, "invalid_request", "Request body must be a JSON object.");
  }
  if (body.name === undefined || body.timezone === undefined) {
    return apiError(
      c,
      400,
      "invalid_request",
      "Expected { name, timezone, arrivalDate?, departureDate? }.",
    );
  }
  const problem = fieldError(body);
  if (problem !== null) {
    return apiError(c, 400, "invalid_request", problem);
  }
  const now = new Date().toISOString();
  // Appended at the end; racing appends can tie on position, which the
  // reorder endpoint repairs — last-write-wins is the v1 collaboration model.
  const next = await c.env.DB.prepare(
    "SELECT COALESCE(MAX(position) + 1, 0) AS position FROM trip_cities WHERE trip_id = ?",
  )
    .bind(tripId)
    .first<{ position: number }>();
  const city: TripCityRow = {
    id: crypto.randomUUID(),
    trip_id: tripId,
    name: (body.name as string).trim(),
    timezone: body.timezone as string,
    arrival_date: (body.arrivalDate as string | null | undefined) ?? null,
    departure_date: (body.departureDate as string | null | undefined) ?? null,
    position: next?.position ?? 0,
    created_at: now,
    updated_at: now,
  };
  await c.env.DB.prepare(
    "INSERT INTO trip_cities (id, trip_id, name, timezone, arrival_date, departure_date, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      city.id,
      city.trip_id,
      city.name,
      city.timezone,
      city.arrival_date,
      city.departure_date,
      city.position,
      city.created_at,
      city.updated_at,
    )
    .run();
  return c.json({ city: publicCity(city) }, 201);
});

// Position is deliberately not patchable — reordering goes through the
// atomic PUT /cities/order below, because concurrent per-city position
// PATCHes race into duplicate/holey orderings.
cities.patch("/trips/:tripId/cities/:id", requireSession, requireTripMember, async (c) => {
  const tripId = c.req.param("tripId");
  const cityId = c.req.param("id");
  const body: {
    name?: unknown;
    timezone?: unknown;
    arrivalDate?: unknown;
    departureDate?: unknown;
  } | null = await readJsonObject(c);
  if (body === null) {
    return apiError(c, 400, "invalid_request", "Request body must be a JSON object.");
  }
  if (body.name === null || body.timezone === null) {
    return apiError(c, 400, "invalid_request", "name and timezone cannot be cleared.");
  }
  const problem = fieldError(body);
  if (problem !== null) {
    return apiError(c, 400, "invalid_request", problem);
  }
  const existing = await c.env.DB.prepare("SELECT * FROM trip_cities WHERE id = ? AND trip_id = ?")
    .bind(cityId, tripId)
    .first<TripCityRow>();
  if (existing === null) {
    return apiError(c, 404, "city_not_found", "City not found on this trip.");
  }
  const updated: TripCityRow = {
    ...existing,
    name: body.name === undefined ? existing.name : (body.name as string).trim(),
    timezone: body.timezone === undefined ? existing.timezone : (body.timezone as string),
    arrival_date:
      body.arrivalDate === undefined ? existing.arrival_date : (body.arrivalDate as string | null),
    departure_date:
      body.departureDate === undefined
        ? existing.departure_date
        : (body.departureDate as string | null),
    updated_at: new Date().toISOString(),
  };
  const statements = [
    c.env.DB.prepare(
      "UPDATE trip_cities SET name = ?, timezone = ?, arrival_date = ?, departure_date = ?, updated_at = ? WHERE id = ? AND trip_id = ?",
    ).bind(
      updated.name,
      updated.timezone,
      updated.arrival_date,
      updated.departure_date,
      updated.updated_at,
      cityId,
      tripId,
    ),
  ];
  if (updated.timezone !== existing.timezone) {
    // The city's zone is what item times default to, so correcting it must
    // re-derive the affected items' UTC instants — otherwise the timeline
    // keeps ordering on instants computed from the wrong zone. An end whose
    // stored zone equals the city's previous zone is treated as city-derived
    // and follows the city; an end with a different explicit zone (e.g. a
    // flight's far end) is left alone. Wall-clock values never shift.
    const { results: affected } = await c.env.DB.prepare(
      "SELECT * FROM itinerary_items WHERE trip_id = ? AND city_id = ?",
    )
      .bind(tripId, cityId)
      .all<ItineraryItemRow>();
    for (const item of affected) {
      const startFollows = item.start_local !== null && item.start_tz === existing.timezone;
      const endFollows = item.end_local !== null && item.end_tz === existing.timezone;
      if (!startFollows && !endFollows) {
        continue;
      }
      const startTz = startFollows ? updated.timezone : item.start_tz;
      const endTz = endFollows ? updated.timezone : item.end_tz;
      statements.push(
        c.env.DB.prepare(
          "UPDATE itinerary_items SET start_tz = ?, start_utc = ?, end_tz = ?, end_utc = ?, updated_at = ? WHERE id = ?",
        ).bind(
          startTz,
          item.start_local === null || startTz === null
            ? null
            : localToUtc(item.start_local, startTz),
          endTz,
          item.end_local === null || endTz === null ? null : localToUtc(item.end_local, endTz),
          updated.updated_at,
          item.id,
        ),
      );
    }
  }
  await c.env.DB.batch(statements);
  return c.json({ city: publicCity(updated) });
});

cities.put("/trips/:id/cities/order", requireSession, requireTripMember, async (c) => {
  const tripId = c.req.param("id");
  const body: { cityIds?: unknown } | null = await readJsonObject(c);
  if (body === null) {
    return apiError(c, 400, "invalid_request", "Request body must be a JSON object.");
  }
  const { cityIds } = body;
  if (!Array.isArray(cityIds) || !cityIds.every((id): id is string => typeof id === "string")) {
    return apiError(c, 400, "invalid_request", "Expected { cityIds: [cityId, ...] }.");
  }
  const { results } = await c.env.DB.prepare("SELECT * FROM trip_cities WHERE trip_id = ?")
    .bind(tripId)
    .all<TripCityRow>();
  const current = new Map(results.map((row) => [row.id, row]));
  const submitted = new Set(cityIds);
  if (
    cityIds.length !== current.size ||
    submitted.size !== cityIds.length ||
    !cityIds.every((id) => current.has(id))
  ) {
    return apiError(
      c,
      400,
      "invalid_request",
      "cityIds must be an exact permutation of the trip's city ids.",
    );
  }
  // A cityless trip's only valid permutation is the empty one — a no-op,
  // returned early because D1 rejects an empty batch.
  if (cityIds.length === 0) {
    return c.json({ cities: [] });
  }
  const now = new Date().toISOString();
  // All positions rewritten 0..n-1 in one transaction, so a concurrent
  // reorder resolves to one caller's complete ordering, never a blend. The
  // response is built from this caller's ordering for the same reason — a
  // re-query could observe a later writer.
  await c.env.DB.batch(
    cityIds.map((id, position) =>
      c.env.DB.prepare(
        "UPDATE trip_cities SET position = ?, updated_at = ? WHERE id = ? AND trip_id = ?",
      ).bind(position, now, id, tripId),
    ),
  );
  const reordered = cityIds.map((id, position) =>
    // The permutation check guarantees every id resolves.
    publicCity({ ...(current.get(id) as TripCityRow), position, updated_at: now }),
  );
  return c.json({ cities: reordered });
});

cities.delete("/trips/:tripId/cities/:id", requireSession, requireTripMember, async (c) => {
  const tripId = c.req.param("tripId");
  const cityId = c.req.param("id");
  const existing = await c.env.DB.prepare("SELECT id FROM trip_cities WHERE id = ? AND trip_id = ?")
    .bind(cityId, tripId)
    .first<{ id: string }>();
  if (existing === null) {
    return apiError(c, 404, "city_not_found", "City not found on this trip.");
  }
  // Every table with a nullable city_id gets nulled in app code, before the
  // delete and in the same transaction: the FK's ON DELETE SET NULL is only a
  // backstop and would not bump updated_at, which the sync layer relies on
  // (0002_core_schema). Adding such a table means adding it here too.
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE itinerary_items SET city_id = NULL, updated_at = ? WHERE trip_id = ? AND city_id = ?",
    ).bind(now, tripId, cityId),
    c.env.DB.prepare(
      "UPDATE places SET city_id = NULL, updated_at = ? WHERE trip_id = ? AND city_id = ?",
    ).bind(now, tripId, cityId),
    c.env.DB.prepare("DELETE FROM trip_cities WHERE id = ? AND trip_id = ?").bind(cityId, tripId),
  ]);
  return c.json({ ok: true });
});

export default cities;
