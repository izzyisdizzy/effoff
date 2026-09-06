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

async function setup(sub: string): Promise<{ token: string; tripId: string; cityId: string }> {
  const user = await signInIos(sub);
  const tripId = await createTrip(user.token);
  const cityRes = await app.request(
    `/api/v1/trips/${tripId}/cities`,
    req("POST", user.token, { name: "Tokyo", timezone: "Asia/Tokyo" }),
    env,
  );
  expect(cityRes.status).toBe(201);
  const { city } = (await cityRes.json()) as { city: { id: string } };
  return { token: user.token, tripId, cityId: city.id };
}

describe("POST /api/v1/trips/:id/items", () => {
  it("derives per-end UTC instants for a flight and returns wall-clock unshifted", async () => {
    const { token, tripId } = await setup("apple-sub-item-flight");
    const res = await app.request(
      `/api/v1/trips/${tripId}/items`,
      req("POST", token, {
        kind: "flight",
        title: "LAX → HND",
        startLocal: "2026-10-01T13:00",
        startTz: "America/Los_Angeles",
        endLocal: "2026-10-02T17:05",
        endTz: "Asia/Tokyo",
        departureAirport: "LAX",
        arrivalAirport: "HND",
      }),
      env,
    );
    expect(res.status).toBe(201);
    const { item } = (await res.json()) as {
      item: Record<string, unknown>;
    };
    expect(item).toMatchObject({
      kind: "flight",
      startLocal: "2026-10-01T13:00", // stored wall-clock comes back untouched
      startTz: "America/Los_Angeles",
      endLocal: "2026-10-02T17:05",
      endTz: "Asia/Tokyo",
      startUtc: "2026-10-01T20:00:00.000Z", // PDT is UTC-7 on that date
      endUtc: "2026-10-02T08:05:00.000Z", // JST is UTC+9
      departureAirport: "LAX",
      arrivalAirport: "HND",
    });
  });

  it("defaults a timed item's zone from its city", async () => {
    const { token, tripId, cityId } = await setup("apple-sub-item-citytz");
    const res = await app.request(
      `/api/v1/trips/${tripId}/items`,
      req("POST", token, {
        kind: "stay",
        title: "Shinjuku hotel",
        cityId,
        startLocal: "2026-10-01T15:00",
        endLocal: "2026-10-04T11:00",
      }),
      env,
    );
    expect(res.status).toBe(201);
    const { item } = (await res.json()) as { item: Record<string, unknown> };
    expect(item).toMatchObject({
      startTz: "Asia/Tokyo",
      endTz: "Asia/Tokyo",
      startUtc: "2026-10-01T06:00:00.000Z",
      endUtc: "2026-10-04T02:00:00.000Z",
    });
  });

  it("accepts a fully untimed item and stores links as an array", async () => {
    const { token, tripId } = await setup("apple-sub-item-untimed");
    const res = await app.request(
      `/api/v1/trips/${tripId}/items`,
      req("POST", token, {
        kind: "activity",
        title: "Maybe teamLab?",
        links: ["https://example.com/tickets"],
      }),
      env,
    );
    expect(res.status).toBe(201);
    const { item } = (await res.json()) as { item: Record<string, unknown> };
    expect(item).toMatchObject({
      cityId: null,
      startLocal: null,
      startUtc: null,
      position: null,
      links: ["https://example.com/tickets"],
    });
  });

  it("400s the validation failure cases", async () => {
    const { token, tripId } = await setup("apple-sub-item-invalid");
    const cases: [Record<string, unknown>, string][] = [
      [{ kind: "party", title: "Nope" }, "invalid_request"], // bad kind
      [{ kind: "activity", title: "Nope", departureAirport: "LAX" }, "invalid_request"], // airports on non-flight
      [{ kind: "activity", title: "Nope", startLocal: "2026-10-01T10:00" }, "invalid_request"], // time, no tz, no city
      [
        { kind: "activity", title: "Nope", startLocal: "10am tomorrow", startTz: "Asia/Tokyo" },
        "invalid_request",
      ],
      [
        { kind: "activity", title: "Nope", startLocal: "2026-10-01T10:00", startTz: "Not/AZone" },
        "invalid_request",
      ],
      [{ kind: "activity", title: "Nope", links: ["not a url"] }, "invalid_request"],
      [{ kind: "activity", title: "Nope", cityId: "not-a-city" }, "unknown_city"],
    ];
    for (const [body, code] of cases) {
      const res = await app.request(`/api/v1/trips/${tripId}/items`, req("POST", token, body), env);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: { code, message: expect.any(String) } });
    }
  });
});

describe("PATCH /api/v1/trips/:tripId/items/:id", () => {
  it("recomputes UTC on time edits and clears the pair when local is nulled", async () => {
    const { token, tripId, cityId } = await setup("apple-sub-item-patch");
    const created = await app.request(
      `/api/v1/trips/${tripId}/items`,
      req("POST", token, {
        kind: "reservation",
        title: "Dinner",
        cityId,
        startLocal: "2026-10-01T19:00",
      }),
      env,
    );
    expect(created.status).toBe(201);
    const { item } = (await created.json()) as { item: { id: string } };

    const moved = await app.request(
      `/api/v1/trips/${tripId}/items/${item.id}`,
      req("PATCH", token, { startLocal: "2026-10-01T20:00" }),
      env,
    );
    expect(moved.status).toBe(200);
    const movedBody = (await moved.json()) as { item: Record<string, unknown> };
    expect(movedBody.item).toMatchObject({
      startLocal: "2026-10-01T20:00",
      startUtc: "2026-10-01T11:00:00.000Z",
    });

    const cleared = await app.request(
      `/api/v1/trips/${tripId}/items/${item.id}`,
      req("PATCH", token, { startLocal: null }),
      env,
    );
    expect(cleared.status).toBe(200);
    const clearedBody = (await cleared.json()) as { item: Record<string, unknown> };
    expect(clearedBody.item).toMatchObject({ startLocal: null, startTz: null, startUtc: null });
  });

  it("404s cross-trip item ids", async () => {
    const { token, tripId } = await setup("apple-sub-item-cross");
    const other = await setup("apple-sub-item-cross-other");
    const created = await app.request(
      `/api/v1/trips/${other.tripId}/items`,
      req("POST", other.token, { kind: "activity", title: "Elsewhere" }),
      env,
    );
    const { item } = (await created.json()) as { item: { id: string } };

    // A real item id, but under a trip it does not belong to.
    const res = await app.request(
      `/api/v1/trips/${tripId}/items/${item.id}`,
      req("PATCH", token, { title: "Hijack" }),
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "item_not_found", message: expect.any(String) },
    });
  });
});

describe("DELETE /api/v1/trips/:tripId/items/:id", () => {
  it("deletes once, then 404s", async () => {
    const { token, tripId } = await setup("apple-sub-item-delete");
    const created = await app.request(
      `/api/v1/trips/${tripId}/items`,
      req("POST", token, { kind: "activity", title: "Doomed" }),
      env,
    );
    const { item } = (await created.json()) as { item: { id: string } };

    const first = await app.request(
      `/api/v1/trips/${tripId}/items/${item.id}`,
      req("DELETE", token),
      env,
    );
    expect(first.status).toBe(200);
    const second = await app.request(
      `/api/v1/trips/${tripId}/items/${item.id}`,
      req("DELETE", token),
      env,
    );
    expect(second.status).toBe(404);
  });
});
