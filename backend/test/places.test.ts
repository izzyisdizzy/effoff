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

type Place = {
  id: string;
  cityId: string | null;
  name: string;
  googleMapsUrl: string | null;
  sourceList: string | null;
  note: string | null;
  tags: string[];
  links: { url: string; label: string | null }[];
  createdAt: string;
  updatedAt: string;
};

async function setup(
  sub: string,
): Promise<{ token: string; tripId: string; cityId: string; otherCityId: string }> {
  const user = await signInIos(sub);
  const tripId = await createTrip(user.token);
  const cityIds: string[] = [];
  for (const name of ["Tokyo", "Sapporo"]) {
    const res = await app.request(
      `/api/v1/trips/${tripId}/cities`,
      req("POST", user.token, { name, timezone: "Asia/Tokyo" }),
      env,
    );
    expect(res.status).toBe(201);
    const { city } = (await res.json()) as { city: { id: string } };
    cityIds.push(city.id);
  }
  const [cityId, otherCityId] = cityIds;
  return {
    token: user.token,
    tripId,
    cityId: cityId as string,
    otherCityId: otherCityId as string,
  };
}

async function createPlace(
  token: string,
  tripId: string,
  body: Record<string, unknown>,
): Promise<Place> {
  const res = await app.request(`/api/v1/trips/${tripId}/places`, req("POST", token, body), env);
  expect(res.status).toBe(201);
  const { place } = (await res.json()) as { place: Place };
  return place;
}

async function placesFromTripDoc(token: string, tripId: string): Promise<Place[]> {
  const res = await app.request(`/api/v1/trips/${tripId}`, req("GET", token), env);
  expect(res.status).toBe(200);
  const { places } = (await res.json()) as { places: Place[] };
  return places;
}

describe("POST /api/v1/trips/:id/places", () => {
  it("creates a place with normalized tags and ordered links, and reads it back", async () => {
    const { token, tripId, cityId } = await setup("apple-sub-place-create");
    const place = await createPlace(token, tripId, {
      name: "  Ichiran  ",
      cityId,
      googleMapsUrl: "https://maps.app.goo.gl/ichiran",
      sourceList: "Tokyo food",
      note: "Queue before noon",
      tags: ["Ramen", " ramen ", "Casual"],
      links: [
        { url: "https://tabelog.com/ichiran", label: "Tabelog" },
        { url: "https://example.com/rec" },
      ],
    });
    expect(place).toMatchObject({
      name: "Ichiran",
      cityId,
      googleMapsUrl: "https://maps.app.goo.gl/ichiran",
      sourceList: "Tokyo food",
      note: "Queue before noon",
      // Lowercased, trimmed, de-duplicated, sorted.
      tags: ["casual", "ramen"],
      links: [
        { url: "https://tabelog.com/ichiran", label: "Tabelog" },
        { url: "https://example.com/rec", label: null },
      ],
    });

    // The storage round-trip must agree with the write response exactly.
    const [stored] = await placesFromTripDoc(token, tripId);
    expect(stored).toEqual(place);
  });

  it("creates a minimal place with everything optional omitted", async () => {
    const { token, tripId } = await setup("apple-sub-place-minimal");
    const place = await createPlace(token, tripId, { name: "A spot" });
    expect(place).toMatchObject({
      name: "A spot",
      cityId: null,
      googleMapsUrl: null,
      sourceList: null,
      note: null,
      tags: [],
      links: [],
    });
  });

  it("400s bad input", async () => {
    const { token, tripId } = await setup("apple-sub-place-bad");
    const ok = "https://example.com/x";
    const cases: [Record<string, unknown>, string][] = [
      [{}, "invalid_request"], // no name
      [{ name: "" }, "invalid_request"],
      [{ name: "   " }, "invalid_request"],
      [{ name: "x".repeat(301) }, "invalid_request"],
      [{ name: "ok", cityId: "not-a-city" }, "unknown_city"],
      [{ name: "ok", googleMapsUrl: "not a url" }, "invalid_request"],
      [{ name: "ok", googleMapsUrl: "javascript:alert(1)" }, "invalid_request"],
      [{ name: "ok", note: "x".repeat(10_001) }, "invalid_request"],
      [{ name: "ok", sourceList: "x".repeat(301) }, "invalid_request"],
      [{ name: "ok", tags: "ramen" }, "invalid_request"],
      [{ name: "ok", tags: null }, "invalid_request"],
      [{ name: "ok", tags: [7] }, "invalid_request"],
      [{ name: "ok", tags: [""] }, "invalid_request"],
      [{ name: "ok", tags: ["x".repeat(51)] }, "invalid_request"],
      [{ name: "ok", tags: Array.from({ length: 26 }, (_, i) => `t${i}`) }, "invalid_request"],
      [{ name: "ok", links: null }, "invalid_request"],
      [{ name: "ok", links: [ok] }, "invalid_request"], // bare string, not an object
      [{ name: "ok", links: [{}] }, "invalid_request"],
      [{ name: "ok", links: [{ url: "nope" }] }, "invalid_request"],
      [{ name: "ok", links: [{ url: ok, label: "x".repeat(101) }] }, "invalid_request"],
      [{ name: "ok", links: [{ url: ok, label: 7 }] }, "invalid_request"],
    ];
    for (const [body, code] of cases) {
      const res = await app.request(
        `/api/v1/trips/${tripId}/places`,
        req("POST", token, body),
        env,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: { code, message: expect.any(String) } });
    }
  });

  it("400s a body that is valid JSON but not an object", async () => {
    const { token, tripId } = await setup("apple-sub-place-nonobject");
    for (const raw of ["null", "[]", '"x"', "7"]) {
      const res = await app.request(
        `/api/v1/trips/${tripId}/places`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: raw,
        },
        env,
      );
      expect(res.status).toBe(400);
    }
  });

  it("409s a duplicate Maps URL on the same trip only", async () => {
    const { token, tripId } = await setup("apple-sub-place-dupe");
    const url = "https://maps.app.goo.gl/same-pin";
    await createPlace(token, tripId, { name: "First", googleMapsUrl: url });

    const dupe = await app.request(
      `/api/v1/trips/${tripId}/places`,
      req("POST", token, { name: "Second", googleMapsUrl: url }),
      env,
    );
    expect(dupe.status).toBe(409);
    expect(await dupe.json()).toEqual({
      error: { code: "place_exists", message: expect.any(String) },
    });

    // The index is partial: any number of URL-less places coexist.
    await createPlace(token, tripId, { name: "Hand-added one" });
    await createPlace(token, tripId, { name: "Hand-added two" });

    // And it is trip-scoped: the same pin belongs on another trip freely.
    const otherTrip = await createTrip(token, "Another trip");
    await createPlace(token, otherTrip, { name: "Same pin elsewhere", googleMapsUrl: url });
  });
});

describe("PATCH /api/v1/trips/:tripId/places/:id", () => {
  it("replaces only the sets it is given", async () => {
    const { token, tripId } = await setup("apple-sub-place-replace");
    const link = { url: "https://example.com/a", label: "A" };
    const place = await createPlace(token, tripId, {
      name: "Spot",
      tags: ["a", "b"],
      links: [link],
    });

    // tags replace wholesale; links are untouched because they were omitted.
    const tagsOnly = await app.request(
      `/api/v1/trips/${tripId}/places/${place.id}`,
      req("PATCH", token, { tags: ["c"] }),
      env,
    );
    expect(tagsOnly.status).toBe(200);
    expect(((await tagsOnly.json()) as { place: Place }).place).toMatchObject({
      tags: ["c"],
      links: [link],
    });

    // [] clears; tags stay as they were.
    const clearLinks = await app.request(
      `/api/v1/trips/${tripId}/places/${place.id}`,
      req("PATCH", token, { links: [] }),
      env,
    );
    expect(((await clearLinks.json()) as { place: Place }).place).toMatchObject({
      tags: ["c"],
      links: [],
    });

    // A scalar-only patch touches neither set.
    const renamed = await app.request(
      `/api/v1/trips/${tripId}/places/${place.id}`,
      req("PATCH", token, { name: "Renamed" }),
      env,
    );
    expect(((await renamed.json()) as { place: Place }).place).toMatchObject({
      name: "Renamed",
      tags: ["c"],
      links: [],
    });

    const [stored] = await placesFromTripDoc(token, tripId);
    expect(stored).toMatchObject({ name: "Renamed", tags: ["c"], links: [] });
  });

  it("bumps updatedAt on a tags-only edit", async () => {
    const { token, tripId } = await setup("apple-sub-place-touch");
    const place = await createPlace(token, tripId, { name: "Spot", tags: ["a"] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const res = await app.request(
      `/api/v1/trips/${tripId}/places/${place.id}`,
      req("PATCH", token, { tags: ["b"] }),
      env,
    );
    const updated = ((await res.json()) as { place: Place }).place;
    expect(updated.updatedAt > place.updatedAt).toBe(true);
    expect(updated.createdAt).toBe(place.createdAt);
  });

  it("moves, clears, and rejects a city", async () => {
    const { token, tripId, cityId, otherCityId } = await setup("apple-sub-place-city");
    const place = await createPlace(token, tripId, { name: "Spot", cityId });

    const moved = await app.request(
      `/api/v1/trips/${tripId}/places/${place.id}`,
      req("PATCH", token, { cityId: otherCityId }),
      env,
    );
    expect(((await moved.json()) as { place: Place }).place.cityId).toBe(otherCityId);

    const cleared = await app.request(
      `/api/v1/trips/${tripId}/places/${place.id}`,
      req("PATCH", token, { cityId: null }),
      env,
    );
    expect(((await cleared.json()) as { place: Place }).place.cityId).toBeNull();

    const bad = await app.request(
      `/api/v1/trips/${tripId}/places/${place.id}`,
      req("PATCH", token, { cityId: "nope" }),
      env,
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({
      error: { code: "unknown_city", message: expect.any(String) },
    });
  });

  it("409s moving onto another place's URL but allows re-sending its own", async () => {
    const { token, tripId } = await setup("apple-sub-place-patch-dupe");
    const urlA = "https://maps.app.goo.gl/a";
    await createPlace(token, tripId, { name: "A", googleMapsUrl: urlA });
    const b = await createPlace(token, tripId, {
      name: "B",
      googleMapsUrl: "https://maps.app.goo.gl/b",
    });

    const collide = await app.request(
      `/api/v1/trips/${tripId}/places/${b.id}`,
      req("PATCH", token, { googleMapsUrl: urlA }),
      env,
    );
    expect(collide.status).toBe(409);

    // Re-sending a place's own URL is a no-op, not a self-conflict.
    const same = await app.request(
      `/api/v1/trips/${tripId}/places/${b.id}`,
      req("PATCH", token, { googleMapsUrl: "https://maps.app.goo.gl/b", note: "still fine" }),
      env,
    );
    expect(same.status).toBe(200);
    expect(((await same.json()) as { place: Place }).place.note).toBe("still fine");
  });

  it("400s clearing the name", async () => {
    const { token, tripId } = await setup("apple-sub-place-noname");
    const place = await createPlace(token, tripId, { name: "Spot" });
    const res = await app.request(
      `/api/v1/trips/${tripId}/places/${place.id}`,
      req("PATCH", token, { name: null }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("404s a place id from another trip", async () => {
    const { token, tripId } = await setup("apple-sub-place-crosstrip");
    const otherTrip = await createTrip(token, "Other trip");
    const place = await createPlace(token, otherTrip, { name: "Elsewhere" });

    for (const method of ["PATCH", "DELETE"]) {
      const res = await app.request(
        `/api/v1/trips/${tripId}/places/${place.id}`,
        req(method, token, method === "PATCH" ? { name: "Hijacked" } : undefined),
        env,
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: "place_not_found", message: expect.any(String) },
      });
    }
  });
});

describe("DELETE /api/v1/trips/:tripId/places/:id", () => {
  it("deletes the place with its tags and links, then 404s", async () => {
    const { token, tripId } = await setup("apple-sub-place-delete");
    const place = await createPlace(token, tripId, {
      name: "Spot",
      tags: ["a", "b"],
      links: [{ url: "https://example.com/a", label: "A" }],
    });

    const res = await app.request(
      `/api/v1/trips/${tripId}/places/${place.id}`,
      req("DELETE", token),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // The API never returns the child rows directly, so check the cascade in D1.
    const tags = await env.DB.prepare("SELECT COUNT(*) AS n FROM place_tags WHERE place_id = ?")
      .bind(place.id)
      .first<{ n: number }>();
    const links = await env.DB.prepare("SELECT COUNT(*) AS n FROM place_links WHERE place_id = ?")
      .bind(place.id)
      .first<{ n: number }>();
    expect(tags?.n).toBe(0);
    expect(links?.n).toBe(0);

    const again = await app.request(
      `/api/v1/trips/${tripId}/places/${place.id}`,
      req("DELETE", token),
      env,
    );
    expect(again.status).toBe(404);
  });
});

describe("GET /api/v1/trips/:id (places)", () => {
  it("nests each place's own tags and links without leaking across places", async () => {
    const { token, tripId } = await setup("apple-sub-place-tripdoc");
    await createPlace(token, tripId, {
      name: "First",
      tags: ["alpha"],
      links: [{ url: "https://example.com/1", label: "One" }],
    });
    await createPlace(token, tripId, {
      name: "Second",
      tags: ["beta", "gamma"],
      links: [{ url: "https://example.com/2", label: null }],
    });
    await createPlace(token, tripId, { name: "Bare" });

    const places = await placesFromTripDoc(token, tripId);
    expect(places).toHaveLength(3);
    const byName = new Map(places.map((place) => [place.name, place]));
    expect(byName.get("First")).toMatchObject({
      tags: ["alpha"],
      links: [{ url: "https://example.com/1", label: "One" }],
    });
    expect(byName.get("Second")).toMatchObject({
      tags: ["beta", "gamma"],
      links: [{ url: "https://example.com/2", label: null }],
    });
    expect(byName.get("Bare")).toMatchObject({ tags: [], links: [] });

    // created_at only has millisecond resolution, so places written in the same
    // tick tie on it; the id tiebreak in the trip-doc query is what makes the
    // order stable across reads. That stability is the guarantee — not that it
    // matches insertion order.
    const again = await placesFromTripDoc(token, tripId);
    expect(again.map((place) => place.id)).toEqual(places.map((place) => place.id));
  });

  it("keeps places when their city is deleted, clearing cityId and bumping updatedAt", async () => {
    const { token, tripId, cityId } = await setup("apple-sub-place-citydelete");
    const place = await createPlace(token, tripId, {
      name: "Spot",
      cityId,
      tags: ["keepme"],
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const res = await app.request(
      `/api/v1/trips/${tripId}/cities/${cityId}`,
      req("DELETE", token),
      env,
    );
    expect(res.status).toBe(200);

    const [stored] = await placesFromTripDoc(token, tripId);
    expect(stored?.cityId).toBeNull();
    // The decoration survives, and the row looks changed to the sync layer.
    expect(stored?.tags).toEqual(["keepme"]);
    expect((stored?.updatedAt ?? "") > place.updatedAt).toBe(true);
  });
});
