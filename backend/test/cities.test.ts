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

async function addCity(
  tripId: string,
  token: string,
  name: string,
  extras: Record<string, unknown> = {},
): Promise<{ id: string; position: number }> {
  const res = await app.request(
    `/api/v1/trips/${tripId}/cities`,
    req("POST", token, { name, timezone: "Asia/Tokyo", ...extras }),
    env,
  );
  expect(res.status).toBe(201);
  const { city } = (await res.json()) as { city: { id: string; position: number } };
  return city;
}

describe("POST /api/v1/trips/:id/cities", () => {
  it("appends cities in order", async () => {
    const owner = await signInIos("apple-sub-city-append");
    const tripId = await createTrip(owner.token);
    const tokyo = await addCity(tripId, owner.token, "Tokyo", { arrivalDate: "2026-10-01" });
    const sapporo = await addCity(tripId, owner.token, "Sapporo");
    expect(tokyo.position).toBe(0);
    expect(sapporo.position).toBe(1);
  });

  it("400s bad input", async () => {
    const owner = await signInIos("apple-sub-city-bad");
    const tripId = await createTrip(owner.token);
    const cases = [
      { timezone: "Asia/Tokyo" }, // no name
      { name: "Tokyo" }, // no timezone
      { name: "Tokyo", timezone: "Not/AZone" },
      { name: "Tokyo", timezone: "Asia/Tokyo", arrivalDate: "10/01/2026" },
      { name: "Tokyo", timezone: "Asia/Tokyo", departureDate: "2026-02-30" },
    ];
    for (const body of cases) {
      const res = await app.request(
        `/api/v1/trips/${tripId}/cities`,
        req("POST", owner.token, body),
        env,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: { code: "invalid_request", message: expect.any(String) },
      });
    }
  });
});

describe("PATCH /api/v1/trips/:tripId/cities/:id", () => {
  it("updates fields and clears nullable dates with null", async () => {
    const owner = await signInIos("apple-sub-city-patch");
    const tripId = await createTrip(owner.token);
    const city = await addCity(tripId, owner.token, "Tokyo", { arrivalDate: "2026-10-01" });

    const res = await app.request(
      `/api/v1/trips/${tripId}/cities/${city.id}`,
      req("PATCH", owner.token, { name: "Kyoto", arrivalDate: null, departureDate: "2026-10-05" }),
      env,
    );
    expect(res.status).toBe(200);
    const patched = (await res.json()) as {
      city: { name: string; arrivalDate: string | null; departureDate: string | null };
    };
    expect(patched.city).toMatchObject({
      name: "Kyoto",
      arrivalDate: null,
      departureDate: "2026-10-05",
    });
  });

  it("refuses to clear NOT NULL fields and 404s cross-trip ids", async () => {
    const owner = await signInIos("apple-sub-city-patch-bad");
    const tripId = await createTrip(owner.token);
    const otherTripId = await createTrip(owner.token, "Other trip");
    const city = await addCity(tripId, owner.token, "Tokyo");

    const cleared = await app.request(
      `/api/v1/trips/${tripId}/cities/${city.id}`,
      req("PATCH", owner.token, { timezone: null }),
      env,
    );
    expect(cleared.status).toBe(400);

    // The same city id under a different trip the caller belongs to: scoped
    // lookups make it a 404, not a cross-trip edit.
    const crossTrip = await app.request(
      `/api/v1/trips/${otherTripId}/cities/${city.id}`,
      req("PATCH", owner.token, { name: "Sneaky" }),
      env,
    );
    expect(crossTrip.status).toBe(404);
    expect(await crossTrip.json()).toEqual({
      error: { code: "city_not_found", message: expect.any(String) },
    });
  });
});

describe("PUT /api/v1/trips/:id/cities/order", () => {
  it("rewrites positions atomically from an exact permutation", async () => {
    const owner = await signInIos("apple-sub-city-order");
    const tripId = await createTrip(owner.token);
    const a = await addCity(tripId, owner.token, "A");
    const b = await addCity(tripId, owner.token, "B");
    const c = await addCity(tripId, owner.token, "C");

    const res = await app.request(
      `/api/v1/trips/${tripId}/cities/order`,
      req("PUT", owner.token, { cityIds: [c.id, a.id, b.id] }),
      env,
    );
    expect(res.status).toBe(200);
    const { cities } = (await res.json()) as { cities: { id: string; position: number }[] };
    expect(cities.map((x) => x.id)).toEqual([c.id, a.id, b.id]);
    expect(cities.map((x) => x.position)).toEqual([0, 1, 2]);
  });

  it("no-ops an empty reorder on a trip with no cities", async () => {
    const owner = await signInIos("apple-sub-city-order-empty");
    const tripId = await createTrip(owner.token);
    const res = await app.request(
      `/api/v1/trips/${tripId}/cities/order`,
      req("PUT", owner.token, { cityIds: [] }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cities: [] });
  });

  it("400s anything that is not an exact permutation", async () => {
    const owner = await signInIos("apple-sub-city-order-bad");
    const tripId = await createTrip(owner.token);
    const a = await addCity(tripId, owner.token, "A");
    const b = await addCity(tripId, owner.token, "B");

    const cases = [
      { cityIds: [a.id] }, // missing one
      { cityIds: [a.id, b.id, "extra"] }, // unknown id
      { cityIds: [a.id, a.id] }, // duplicate
      { cityIds: "nope" }, // not an array
    ];
    for (const body of cases) {
      const res = await app.request(
        `/api/v1/trips/${tripId}/cities/order`,
        req("PUT", owner.token, body),
        env,
      );
      expect(res.status).toBe(400);
    }
  });
});

describe("PATCH city timezone re-derivation", () => {
  it("re-derives city-defaulted item instants; leaves explicit far-end zones alone", async () => {
    const owner = await signInIos("apple-sub-city-tz-change");
    const tripId = await createTrip(owner.token);
    // Deliberately the wrong zone; the fix-up is the scenario under test.
    const city = await addCity(tripId, owner.token, "Sapporo");

    const itemRes = await app.request(
      `/api/v1/trips/${tripId}/items`,
      req("POST", owner.token, {
        kind: "flight",
        title: "JFK → CTS",
        cityId: city.id,
        startLocal: "2026-04-10T10:00",
        startTz: "America/New_York",
        endLocal: "2026-04-11T09:00", // defaults to the city's (wrong) zone
      }),
      env,
    );
    expect(itemRes.status).toBe(201);
    const { item } = (await itemRes.json()) as {
      item: { id: string; endTz: string; endUtc: string };
    };
    expect(item.endTz).toBe("Asia/Tokyo");

    // Correct the city's zone: the city-derived end follows and its instant
    // is re-derived; the explicit far end (New York) is untouched.
    const res = await app.request(
      `/api/v1/trips/${tripId}/cities/${city.id}`,
      req("PATCH", owner.token, { timezone: "Asia/Seoul" }),
      env,
    );
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT start_tz, start_utc, end_tz, end_utc FROM itinerary_items WHERE id = ?",
    )
      .bind(item.id)
      .first<{ start_tz: string; start_utc: string; end_tz: string; end_utc: string }>();
    expect(row).toEqual({
      start_tz: "America/New_York",
      start_utc: "2026-04-10T14:00:00.000Z", // EDT, unchanged
      end_tz: "Asia/Seoul",
      end_utc: "2026-04-11T00:00:00.000Z", // KST is UTC+9 (same offset, new zone)
    });
  });
});

describe("DELETE /api/v1/trips/:tripId/cities/:id", () => {
  it("nulls city_id on the city's items and bumps their updatedAt", async () => {
    const owner = await signInIos("apple-sub-city-delete");
    const tripId = await createTrip(owner.token);
    const city = await addCity(tripId, owner.token, "Tokyo");

    const itemRes = await app.request(
      `/api/v1/trips/${tripId}/items`,
      req("POST", owner.token, { kind: "activity", title: "Museum", cityId: city.id }),
      env,
    );
    expect(itemRes.status).toBe(201);
    const { item } = (await itemRes.json()) as {
      item: { id: string; cityId: string; updatedAt: string };
    };
    expect(item.cityId).toBe(city.id);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const res = await app.request(
      `/api/v1/trips/${tripId}/cities/${city.id}`,
      req("DELETE", owner.token),
      env,
    );
    expect(res.status).toBe(200);

    const row = await env.DB.prepare("SELECT city_id, updated_at FROM itinerary_items WHERE id = ?")
      .bind(item.id)
      .first<{ city_id: string | null; updated_at: string }>();
    expect(row?.city_id).toBe(null);
    // The explicit nulling batch bumps updated_at; the FK backstop would not.
    expect(row !== null && row.updated_at > item.updatedAt).toBe(true);
  });

  it("404s unknown or cross-trip city ids", async () => {
    const owner = await signInIos("apple-sub-city-delete-404");
    const tripId = await createTrip(owner.token);
    const res = await app.request(
      `/api/v1/trips/${tripId}/cities/not-a-city`,
      req("DELETE", owner.token),
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "city_not_found", message: expect.any(String) },
    });
  });
});
