import { Hono } from "hono";
import { apiError } from "../api-error";
import { requireSession, requireTripMember } from "../auth/middleware";
import { isDateOnly, isValidTimeZone } from "../time";
import { publicCity, type AppEnv, type TripCityRow } from "../types";

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
  if (name !== undefined && (typeof name !== "string" || name.trim().length === 0)) {
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
  let body: { name?: unknown; timezone?: unknown; arrivalDate?: unknown; departureDate?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, 400, "invalid_request", "Request body must be JSON.");
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
  let body: { name?: unknown; timezone?: unknown; arrivalDate?: unknown; departureDate?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, 400, "invalid_request", "Request body must be JSON.");
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
  await c.env.DB.prepare(
    "UPDATE trip_cities SET name = ?, timezone = ?, arrival_date = ?, departure_date = ?, updated_at = ? WHERE id = ? AND trip_id = ?",
  )
    .bind(
      updated.name,
      updated.timezone,
      updated.arrival_date,
      updated.departure_date,
      updated.updated_at,
      cityId,
      tripId,
    )
    .run();
  return c.json({ city: publicCity(updated) });
});

cities.put("/trips/:id/cities/order", requireSession, requireTripMember, async (c) => {
  const tripId = c.req.param("id");
  let body: { cityIds?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, 400, "invalid_request", "Request body must be JSON.");
  }
  const { cityIds } = body;
  if (!Array.isArray(cityIds) || !cityIds.every((id): id is string => typeof id === "string")) {
    return apiError(c, 400, "invalid_request", "Expected { cityIds: [cityId, ...] }.");
  }
  const { results } = await c.env.DB.prepare("SELECT id FROM trip_cities WHERE trip_id = ?")
    .bind(tripId)
    .all<{ id: string }>();
  const current = new Set(results.map((row) => row.id));
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
  const now = new Date().toISOString();
  // All positions rewritten 0..n-1 in one transaction, so a concurrent
  // reorder resolves to one caller's complete ordering, never a blend.
  await c.env.DB.batch(
    cityIds.map((id, position) =>
      c.env.DB.prepare(
        "UPDATE trip_cities SET position = ?, updated_at = ? WHERE id = ? AND trip_id = ?",
      ).bind(position, now, id, tripId),
    ),
  );
  const reordered = await c.env.DB.prepare(
    "SELECT * FROM trip_cities WHERE trip_id = ? ORDER BY position",
  )
    .bind(tripId)
    .all<TripCityRow>();
  return c.json({ cities: reordered.results.map(publicCity) });
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
  // Null the items' city_id in app code, before the delete and in the same
  // transaction: the FK's ON DELETE SET NULL is only a backstop and would
  // not bump updated_at, which the sync layer relies on (0002_core_schema).
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE itinerary_items SET city_id = NULL, updated_at = ? WHERE trip_id = ? AND city_id = ?",
    ).bind(now, tripId, cityId),
    c.env.DB.prepare("DELETE FROM trip_cities WHERE id = ? AND trip_id = ?").bind(cityId, tripId),
  ]);
  return c.json({ ok: true });
});

export default cities;
