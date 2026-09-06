import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { activateAppleJwksMock, seedTrip, signInIos } from "./apple";

beforeAll(async () => {
  await activateAppleJwksMock();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function post(token?: string): RequestInit {
  return {
    method: "POST",
    ...(token !== undefined ? { headers: { authorization: `Bearer ${token}` } } : {}),
  };
}

async function mintInvite(tripId: string, token: string): Promise<string> {
  const res = await app.request(`/api/v1/trips/${tripId}/invites`, post(token), env);
  expect(res.status).toBe(201);
  const body = (await res.json()) as { invite: { token: string } };
  return body.invite.token;
}

describe("POST /api/v1/trips/:id/invites", () => {
  it("lets a member mint an invite", async () => {
    const owner = await signInIos("apple-sub-owner-mint");
    const tripId = await seedTrip(owner.user.id);

    const res = await app.request(`/api/v1/trips/${tripId}/invites`, post(owner.token), env);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      invite: { token: string; tripId: string; expiresAt: string };
    };
    expect(body.invite.tripId).toBe(tripId);
    expect(body.invite.token).toEqual(expect.any(String));
    // Pin the 30-day TTL, not just "sometime in the future".
    const ttlMs = Date.parse(body.invite.expiresAt) - Date.now();
    expect(ttlMs).toBeGreaterThan(29 * 24 * 3600 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(30 * 24 * 3600 * 1000);
  });

  it("403s a signed-in non-member and 401s an unauthenticated caller", async () => {
    const owner = await signInIos("apple-sub-owner-guard");
    const outsider = await signInIos("apple-sub-outsider-guard");
    const tripId = await seedTrip(owner.user.id);

    const forbidden = await app.request(
      `/api/v1/trips/${tripId}/invites`,
      post(outsider.token),
      env,
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      error: { code: "not_a_member", message: expect.any(String) },
    });

    const anonymous = await app.request(`/api/v1/trips/${tripId}/invites`, post(), env);
    expect(anonymous.status).toBe(401);
  });

  it("404s for a trip that does not exist", async () => {
    const user = await signInIos("apple-sub-no-trip");
    const res = await app.request("/api/v1/trips/nope-not-a-trip/invites", post(user.token), env);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/v1/invites/:token/accept", () => {
  it("adds the accepting user as a member, idempotently", async () => {
    const owner = await signInIos("apple-sub-owner-accept");
    const joiner = await signInIos("apple-sub-joiner");
    const tripId = await seedTrip(owner.user.id);
    const invite = await mintInvite(tripId, owner.token);

    const first = await app.request(`/api/v1/invites/${invite}/accept`, post(joiner.token), env);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ tripId, alreadyMember: false });

    const membership = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM trip_members WHERE trip_id = ? AND user_id = ?",
    )
      .bind(tripId, joiner.user.id)
      .first<{ n: number }>();
    expect(membership?.n).toBe(1);

    // A member can now exercise member-only routes...
    const asMember = await app.request(`/api/v1/trips/${tripId}/invites`, post(joiner.token), env);
    expect(asMember.status).toBe(201);

    // ...and accepting again stays a no-op 200.
    const again = await app.request(`/api/v1/invites/${invite}/accept`, post(joiner.token), env);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ tripId, alreadyMember: true });
    const stillOne = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM trip_members WHERE trip_id = ? AND user_id = ?",
    )
      .bind(tripId, joiner.user.id)
      .first<{ n: number }>();
    expect(stillOne?.n).toBe(1);
  });

  it("404s an unknown token and 401s an unauthenticated caller", async () => {
    const user = await signInIos("apple-sub-unknown-invite");
    const unknown = await app.request(
      "/api/v1/invites/does-not-exist/accept",
      post(user.token),
      env,
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      error: { code: "invite_not_found", message: expect.any(String) },
    });

    const anonymous = await app.request("/api/v1/invites/does-not-exist/accept", post(), env);
    expect(anonymous.status).toBe(401);
  });

  it.each([
    [
      "expired",
      { expiresAt: new Date(Date.now() - 1000).toISOString(), revokedAt: null },
      "invite_expired",
    ],
    [
      "revoked",
      {
        expiresAt: new Date(Date.now() + 1000_000).toISOString(),
        revokedAt: new Date().toISOString(),
      },
      "invite_revoked",
    ],
  ])("410s an %s invite", async (label, state, code) => {
    const owner = await signInIos(`apple-sub-owner-${label}`);
    const joiner = await signInIos(`apple-sub-joiner-${label}`);
    const tripId = await seedTrip(owner.user.id);
    const token = `${label}-invite-token`;
    await env.DB.prepare(
      "INSERT INTO invites (token, trip_id, created_by, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(
        token,
        tripId,
        owner.user.id,
        new Date().toISOString(),
        state.expiresAt,
        state.revokedAt,
      )
      .run();

    const res = await app.request(`/api/v1/invites/${token}/accept`, post(joiner.token), env);
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({
      error: { code, message: expect.any(String) },
    });
  });
});
