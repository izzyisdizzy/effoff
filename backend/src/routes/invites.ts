import { Hono } from "hono";
import { apiError } from "../api-error";
import { requireSession, requireTripMember } from "../auth/middleware";
import { generateToken } from "../auth/sessions";
import type { AppEnv, InviteRow } from "../types";

const INVITE_TTL_SECONDS = 30 * 24 * 60 * 60;

const invites = new Hono<AppEnv>();

// Any member can mint (no roles in v1). Revocation exists only as the
// revoked_at column for now; the revoke endpoint ships with trip settings.
invites.post("/trips/:id/invites", requireSession, requireTripMember, async (c) => {
  const tripId = c.req.param("id");
  const now = new Date();
  const invite = {
    token: generateToken(16),
    tripId,
    expiresAt: new Date(now.getTime() + INVITE_TTL_SECONDS * 1000).toISOString(),
  };
  await c.env.DB.prepare(
    "INSERT INTO invites (token, trip_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(invite.token, tripId, c.get("user").id, now.toISOString(), invite.expiresAt)
    .run();
  return c.json({ invite }, 201);
});

invites.post("/invites/:token/accept", requireSession, async (c) => {
  const invite = await c.env.DB.prepare("SELECT * FROM invites WHERE token = ?")
    .bind(c.req.param("token"))
    .first<InviteRow>();
  if (invite === null) {
    return apiError(c, 404, "invite_not_found", "Invite not found.");
  }
  if (invite.revoked_at !== null) {
    return apiError(c, 410, "invite_revoked", "Invite has been revoked.");
  }
  if (invite.expires_at <= new Date().toISOString()) {
    return apiError(c, 410, "invite_expired", "Invite has expired.");
  }
  const userId = c.get("user").id;
  const membership = await c.env.DB.prepare(
    "SELECT user_id FROM trip_members WHERE trip_id = ? AND user_id = ?",
  )
    .bind(invite.trip_id, userId)
    .first<{ user_id: string }>();
  if (membership !== null) {
    return c.json({ tripId: invite.trip_id, alreadyMember: true });
  }
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "INSERT INTO trip_members (trip_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
  )
    .bind(invite.trip_id, userId, now, now)
    .run();
  return c.json({ tripId: invite.trip_id, alreadyMember: false });
});

export default invites;
