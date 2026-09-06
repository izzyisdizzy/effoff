import { Hono } from "hono";
import { apiError } from "../api-error";
import { requireSession, requireTripMember } from "../auth/middleware";
import { MAX_NAME, readJsonObject } from "../validate";
import { deleteObjects } from "../attachments/storage";
import {
  publicAttachment,
  publicCity,
  publicItem,
  publicMember,
  publicTodo,
  publicTrip,
  type AppEnv,
  type AttachmentRow,
  type ItineraryItemRow,
  type MemberWithUserRow,
  type TodoRow,
  type TripCityRow,
  type TripRow,
} from "../types";

const trips = new Hono<AppEnv>();

trips.post("/trips", requireSession, async (c) => {
  const body: { name?: unknown } | null = await readJsonObject(c);
  if (body === null) {
    return apiError(c, 400, "invalid_request", "Request body must be a JSON object.");
  }
  const name = typeof body.name === "string" ? body.name.trim() : undefined;
  if (name === undefined || name.length === 0 || name.length > MAX_NAME) {
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
  const [tripRes, memberRes, cityRes, itemRes, todoRes, attachmentRes] = await c.env.DB.batch([
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
    c.env.DB.prepare("SELECT * FROM attachments WHERE trip_id = ? ORDER BY created_at").bind(
      tripId,
    ),
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
    attachments: ((attachmentRes?.results ?? []) as AttachmentRow[]).map(publicAttachment),
  });
});

trips.patch("/trips/:id", requireSession, requireTripMember, async (c) => {
  const tripId = c.req.param("id");
  const body: { name?: unknown } | null = await readJsonObject(c);
  if (body === null) {
    return apiError(c, 400, "invalid_request", "Request body must be a JSON object.");
  }
  const name = typeof body.name === "string" ? body.name.trim() : undefined;
  if (
    (body.name !== undefined && name === undefined) ||
    name?.length === 0 ||
    (name !== undefined && name.length > MAX_NAME)
  ) {
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
  // Attachment bytes live in R2, outside the cascade: remove them first, so a
  // storage failure leaves the trip intact to retry (a dangling row is
  // visible; an orphaned object is silent cost). Children (members, cities,
  // items, todos, invites, attachment rows) then go via ON DELETE CASCADE.
  const { results: keys } = await c.env.DB.prepare(
    "SELECT r2_key FROM attachments WHERE trip_id = ?",
  )
    .bind(tripId)
    .all<{ r2_key: string }>();
  try {
    await deleteObjects(
      c.env.ATTACHMENTS,
      keys.map((row) => row.r2_key),
    );
  } catch (error) {
    console.error("attachment_r2_delete_failed", error);
    return apiError(c, 503, "storage_unavailable", "Could not remove the trip's attachments.");
  }
  await c.env.DB.prepare("DELETE FROM trips WHERE id = ?").bind(tripId).run();
  return c.json({ ok: true });
});

export default trips;
