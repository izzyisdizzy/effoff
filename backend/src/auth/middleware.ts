import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { apiError } from "../api-error";
import type { AppEnv } from "../types";
import { getSessionWithUser, SESSION_COOKIE } from "./sessions";

// Loads the signed-in user (and their session row) onto the context, from
// either transport: `Authorization: Bearer <token>` (iOS) or the session
// cookie (web). Bearer wins when both are present. 401 otherwise.
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  // The auth scheme is case-insensitive per RFC 7235.
  const bearer = c.req.header("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const token = bearer ?? getCookie(c, SESSION_COOKIE);
  if (token === undefined || token.length === 0) {
    return apiError(c, 401, "unauthenticated", "Sign in required.");
  }
  const resolved = await getSessionWithUser(c.env.DB, token);
  if (resolved === null) {
    return apiError(c, 401, "unauthenticated", "Session is invalid or expired.");
  }
  c.set("user", resolved.user);
  c.set("session", resolved.session);
  await next();
});

// Guards a trip-scoped route (param `:tripId` or `:id`): 401 when not signed
// in, 404 when the trip doesn't exist, 403 when signed in but not a member.
// Chain after requireSession; every trip data endpoint (#8 onward) reuses it.
// `:tripId` wins so nested routes like /trips/:tripId/todos/:id guard the
// trip, not the inner resource.
export const requireTripMember = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (user === undefined) {
    // The Variables type says user is always set, but nothing forces a route
    // to chain requireSession first — runtime backstop for a mis-mounted
    // route, deliberately untypeable.
    return apiError(c, 401, "unauthenticated", "Sign in required.");
  }
  const tripId = c.req.param("tripId") ?? c.req.param("id");
  if (tripId === undefined) {
    return apiError(c, 404, "trip_not_found", "Trip not found.");
  }
  // One query answers both "does the trip exist" (404) and "is the caller a
  // member" (403) — this guard runs on every trip-scoped request.
  const row = await c.env.DB.prepare(
    "SELECT t.id AS trip_id, m.user_id AS member_id FROM trips t LEFT JOIN trip_members m ON m.trip_id = t.id AND m.user_id = ? WHERE t.id = ?",
  )
    .bind(user.id, tripId)
    .first<{ trip_id: string; member_id: string | null }>();
  if (row === null) {
    return apiError(c, 404, "trip_not_found", "Trip not found.");
  }
  if (row.member_id === null) {
    return apiError(c, 403, "not_a_member", "You are not a member of this trip.");
  }
  await next();
});
