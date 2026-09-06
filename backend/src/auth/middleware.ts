import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { apiError } from "../api-error";
import type { AppEnv } from "../types";
import { getSessionWithUser, SESSION_COOKIE } from "./sessions";

// Loads the signed-in user (and their session row) onto the context, from
// either transport: `Authorization: Bearer <token>` (iOS) or the session
// cookie (web). Bearer wins when both are present. 401 otherwise.
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const authorization = c.req.header("Authorization");
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
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

// Guards a trip-scoped route (param `:id` or `:tripId`): 401 when not signed
// in, 404 when the trip doesn't exist, 403 when signed in but not a member.
// Chain after requireSession; every trip data endpoint (#8 onward) reuses it.
export const requireTripMember = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (user === undefined) {
    return apiError(c, 401, "unauthenticated", "Sign in required.");
  }
  const tripId = c.req.param("id") ?? c.req.param("tripId");
  if (tripId === undefined) {
    return apiError(c, 404, "trip_not_found", "Trip not found.");
  }
  const trip = await c.env.DB.prepare("SELECT id FROM trips WHERE id = ?")
    .bind(tripId)
    .first<{ id: string }>();
  if (trip === null) {
    return apiError(c, 404, "trip_not_found", "Trip not found.");
  }
  const membership = await c.env.DB.prepare(
    "SELECT user_id FROM trip_members WHERE trip_id = ? AND user_id = ?",
  )
    .bind(tripId, user.id)
    .first<{ user_id: string }>();
  if (membership === null) {
    return apiError(c, 403, "not_a_member", "You are not a member of this trip.");
  }
  await next();
});
