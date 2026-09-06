import { Hono } from "hono";
import { apiError } from "../api-error";
import { requireSession, requireTripMember } from "../auth/middleware";
import {
  publicCity,
  publicItem,
  publicMember,
  publicTodo,
  publicTrip,
  type AppEnv,
  type ItineraryItemRow,
  type MemberWithUserRow,
  type TodoRow,
  type TripCityRow,
  type TripRow,
} from "../types";

const trips = new Hono<AppEnv>();

trips.post("/trips", requireSession, async (c) => {
  let body: { name?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, 400, "invalid_request", "Request body must be JSON.");
  }
  const name = typeof body.name === "string" ? body.name.trim() : undefined;
  if (name === undefined || name.length === 0) {
    return apiError(c, 400, "invalid_request", "Expected { name }.");
  }
  const now = new Date().toISOString();
  const trip: TripRow = {
    id: crypto.randomUUID(),
    name,
    created_by: c.get("user").id,
    created_at: now,
    updated_at: now,
  };
  // One batch: a trip without its creator's membership row would be
  // unreachable (requireTripMember would 403 everyone, including the creator).
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO trips (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(trip.id, trip.name, trip.created_by, trip.created_at, trip.updated_at),
    c.env.DB.prepare(
      "INSERT INTO trip_members (trip_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).bind(trip.id, trip.created_by, now, now),
  ]);
  return c.json({ trip: publicTrip(trip) }, 201);
});

trips.get("/trips", requireSession, async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT t.* FROM trips t JOIN trip_members m ON m.trip_id = t.id WHERE m.user_id = ? ORDER BY t.created_at DESC",
  )
    .bind(c.get("user").id)
    .all<TripRow>();
  return c.json({ trips: results.map(publicTrip) });
});

// The full trip doc: everything both clients need to open a trip, in one
// response (docs/foundation.md, API shape). No version counter / 304s yet —
// that is build-order step 7.
trips.get("/trips/:id", requireSession, requireTripMember, async (c) => {
  const tripId = c.req.param("id");
  const [tripRes, memberRes, cityRes, itemRes, todoRes] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT * FROM trips WHERE id = ?").bind(tripId),
    c.env.DB.prepare(
      "SELECT m.user_id, m.arrival_date, m.departure_date, u.email, u.display_name FROM trip_members m JOIN users u ON u.id = m.user_id WHERE m.trip_id = ? ORDER BY m.created_at",
    ).bind(tripId),
    c.env.DB.prepare("SELECT * FROM trip_cities WHERE trip_id = ? ORDER BY position").bind(tripId),
    c.env.DB.prepare(
      // Timed items in timeline order first, then untimed by manual position.
      "SELECT * FROM itinerary_items WHERE trip_id = ? ORDER BY start_utc IS NULL, start_utc, position IS NULL, position, created_at",
    ).bind(tripId),
    c.env.DB.prepare("SELECT * FROM todos WHERE trip_id = ? ORDER BY created_at").bind(tripId),
  ]);
  const trip = tripRes?.results[0] as TripRow | undefined;
  if (trip === undefined) {
    // The guard saw the trip, so only a concurrent delete lands here.
    return apiError(c, 404, "trip_not_found", "Trip not found.");
  }
  return c.json({
    trip: publicTrip(trip),
    members: ((memberRes?.results ?? []) as MemberWithUserRow[]).map(publicMember),
    cities: ((cityRes?.results ?? []) as TripCityRow[]).map(publicCity),
    items: ((itemRes?.results ?? []) as ItineraryItemRow[]).map(publicItem),
    todos: ((todoRes?.results ?? []) as TodoRow[]).map(publicTodo),
  });
});

trips.patch("/trips/:id", requireSession, requireTripMember, async (c) => {
  const tripId = c.req.param("id");
  let body: { name?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, 400, "invalid_request", "Request body must be JSON.");
  }
  const name = typeof body.name === "string" ? body.name.trim() : undefined;
  if ((body.name !== undefined && name === undefined) || name?.length === 0) {
    return apiError(c, 400, "invalid_request", "Expected { name? }.");
  }
  const existing = await c.env.DB.prepare("SELECT * FROM trips WHERE id = ?")
    .bind(tripId)
    .first<TripRow>();
  if (existing === null) {
    return apiError(c, 404, "trip_not_found", "Trip not found.");
  }
  const updated: TripRow = {
    ...existing,
    name: name ?? existing.name,
    updated_at: new Date().toISOString(),
  };
  await c.env.DB.prepare("UPDATE trips SET name = ?, updated_at = ? WHERE id = ?")
    .bind(updated.name, updated.updated_at, tripId)
    .run();
  return c.json({ trip: publicTrip(updated) });
});

// The one permission carve-out in v1 (docs/foundation.md: no roles): every
// member edits everything, but only the creator deletes the trip.
trips.delete("/trips/:id", requireSession, requireTripMember, async (c) => {
  const tripId = c.req.param("id");
  const trip = await c.env.DB.prepare("SELECT * FROM trips WHERE id = ?")
    .bind(tripId)
    .first<TripRow>();
  if (trip === null) {
    return apiError(c, 404, "trip_not_found", "Trip not found.");
  }
  if (trip.created_by !== c.get("user").id) {
    return apiError(c, 403, "not_trip_creator", "Only the trip creator can delete the trip.");
  }
  // Children (members, cities, items, todos, invites) go via ON DELETE CASCADE.
  await c.env.DB.prepare("DELETE FROM trips WHERE id = ?").bind(tripId).run();
  return c.json({ ok: true });
});

export default trips;
