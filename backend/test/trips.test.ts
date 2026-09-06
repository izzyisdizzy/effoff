import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { activateAppleJwksMock, createTrip, signInIos } from "./apple";
import { req } from "./http";

beforeAll(async () => {
  await activateAppleJwksMock();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

async function acceptInvite(tripId: string, ownerToken: string, joinerToken: string) {
  const minted = await app.request(`/api/v1/trips/${tripId}/invites`, req("POST", ownerToken), env);
  expect(minted.status).toBe(201);
  const { invite } = (await minted.json()) as { invite: { token: string } };
  const joined = await app.request(
    `/api/v1/invites/${invite.token}/accept`,
    req("POST", joinerToken),
    env,
  );
  expect(joined.status).toBe(200);
}

describe("POST /api/v1/trips", () => {
  it("creates the trip with the creator as a member in one step", async () => {
    const owner = await signInIos("apple-sub-trip-create");
    const res = await app.request(
      "/api/v1/trips",
      req("POST", owner.token, { name: "Japan" }),
      env,
    );
    expect(res.status).toBe(201);
    const { trip } = (await res.json()) as {
      trip: { id: string; name: string; createdBy: string; createdAt: string; updatedAt: string };
    };
    expect(trip.name).toBe("Japan");
    expect(trip.createdBy).toBe(owner.user.id);

    // The membership row landed in the same batch: the creator can pass the
    // member guard immediately.
    const doc = await app.request(`/api/v1/trips/${trip.id}`, req("GET", owner.token), env);
    expect(doc.status).toBe(200);
  });

  it("400s a missing or empty name", async () => {
    const owner = await signInIos("apple-sub-trip-badname");
    for (const body of [{}, { name: "" }, { name: "   " }, { name: 7 }]) {
      const res = await app.request("/api/v1/trips", req("POST", owner.token, body), env);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: { code: "invalid_request", message: expect.any(String) },
      });
    }
  });
});

describe("GET /api/v1/trips", () => {
  it("lists only the caller's trips", async () => {
    const alice = await signInIos("apple-sub-list-alice");
    const bob = await signInIos("apple-sub-list-bob");
    const aliceTrip = await createTrip(alice.token, "Alice's trip");
    await createTrip(bob.token, "Bob's trip");

    const res = await app.request("/api/v1/trips", req("GET", alice.token), env);
    expect(res.status).toBe(200);
    const { trips } = (await res.json()) as { trips: { id: string; name: string }[] };
    expect(trips.map((t) => t.id)).toEqual([aliceTrip]);
  });
});

describe("GET /api/v1/trips/:id", () => {
  it("returns the full trip doc in one response", async () => {
    const owner = await signInIos("apple-sub-doc-owner", { email: "doc-owner@example.com" });
    const friend = await signInIos("apple-sub-doc-friend");
    const tripId = await createTrip(owner.token, "Doc trip");
    await acceptInvite(tripId, owner.token, friend.token);

    const cityRes = await app.request(
      `/api/v1/trips/${tripId}/cities`,
      req("POST", owner.token, { name: "Tokyo", timezone: "Asia/Tokyo" }),
      env,
    );
    expect(cityRes.status).toBe(201);
    const { city } = (await cityRes.json()) as { city: { id: string } };

    const itemRes = await app.request(
      `/api/v1/trips/${tripId}/items`,
      req("POST", owner.token, {
        kind: "activity",
        title: "TeamLab",
        cityId: city.id,
        startLocal: "2026-10-01T10:00",
      }),
      env,
    );
    expect(itemRes.status).toBe(201);

    const todoRes = await app.request(
      `/api/v1/trips/${tripId}/todos`,
      req("POST", owner.token, { title: "Book flights" }),
      env,
    );
    expect(todoRes.status).toBe(201);

    const res = await app.request(`/api/v1/trips/${tripId}`, req("GET", owner.token), env);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      trip: { id: string; name: string };
      members: { id: string; displayName: string; arrivalDate: string | null }[];
      cities: { id: string; position: number }[];
      items: { title: string; cityId: string | null }[];
      todos: { title: string; done: boolean }[];
    };
    expect(doc.trip.id).toBe(tripId);
    expect(doc.members.map((m) => m.id).toSorted()).toEqual([owner.user.id, friend.user.id].toSorted());
    // Presence window fields ride along on each member (null = whole trip).
    expect(doc.members[0]?.arrivalDate).toBe(null);
    expect(doc.cities).toEqual([expect.objectContaining({ id: city.id, position: 0 })]);
    expect(doc.items).toEqual([expect.objectContaining({ title: "TeamLab", cityId: city.id })]);
    expect(doc.todos).toEqual([expect.objectContaining({ title: "Book flights", done: false })]);
  });
});

describe("PATCH /api/v1/trips/:id", () => {
  it("renames, from any member, and bumps updatedAt", async () => {
    const owner = await signInIos("apple-sub-rename-owner");
    const friend = await signInIos("apple-sub-rename-friend");
    const tripId = await createTrip(owner.token, "Old name");
    await acceptInvite(tripId, owner.token, friend.token);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const res = await app.request(
      `/api/v1/trips/${tripId}`,
      req("PATCH", friend.token, { name: "New name" }),
      env,
    );
    expect(res.status).toBe(200);
    const { trip } = (await res.json()) as {
      trip: { name: string; createdAt: string; updatedAt: string };
    };
    expect(trip.name).toBe("New name");
    expect(trip.updatedAt > trip.createdAt).toBe(true);
  });

  it("400s a null or empty name", async () => {
    const owner = await signInIos("apple-sub-rename-bad");
    const tripId = await createTrip(owner.token);
    for (const body of [{ name: null }, { name: "" }]) {
      const res = await app.request(
        `/api/v1/trips/${tripId}`,
        req("PATCH", owner.token, body),
        env,
      );
      expect(res.status).toBe(400);
    }
  });
});

describe("DELETE /api/v1/trips/:id", () => {
  it("is creator-only and cascades to children", async () => {
    const owner = await signInIos("apple-sub-delete-owner");
    const friend = await signInIos("apple-sub-delete-friend");
    const tripId = await createTrip(owner.token);
    await acceptInvite(tripId, owner.token, friend.token);
    const cityRes = await app.request(
      `/api/v1/trips/${tripId}/cities`,
      req("POST", owner.token, { name: "Osaka", timezone: "Asia/Tokyo" }),
      env,
    );
    expect(cityRes.status).toBe(201);

    const forbidden = await app.request(
      `/api/v1/trips/${tripId}`,
      req("DELETE", friend.token),
      env,
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      error: { code: "not_trip_creator", message: expect.any(String) },
    });

    const res = await app.request(`/api/v1/trips/${tripId}`, req("DELETE", owner.token), env);
    expect(res.status).toBe(200);

    const gone = await app.request(`/api/v1/trips/${tripId}`, req("GET", owner.token), env);
    expect(gone.status).toBe(404);
    const orphans = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM trip_cities WHERE trip_id = ?1) + (SELECT COUNT(*) FROM trip_members WHERE trip_id = ?1) AS n",
    )
      .bind(tripId)
      .first<{ n: number }>();
    expect(orphans?.n).toBe(0);
  });
});
