// The guard matrix the issue's acceptance criteria demand: EVERY trip-scoped
// route from #8 must 401 an unauthenticated caller, 403 a signed-in
// non-member, and 404 an unknown trip. The guards run before any body
// parsing, so requests here carry no body — a guard that let a bodyless
// request through to the handler would fail loudly, which is the point.
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

// Every trip-scoped route this issue ships (child ids are placeholders — the
// trip guard rejects before any child lookup happens).
const ROUTES: [method: string, path: (tripId: string) => string][] = [
  ["GET", (t) => `/api/v1/trips/${t}`],
  ["PATCH", (t) => `/api/v1/trips/${t}`],
  ["DELETE", (t) => `/api/v1/trips/${t}`],
  ["POST", (t) => `/api/v1/trips/${t}/cities`],
  ["PATCH", (t) => `/api/v1/trips/${t}/cities/some-city`],
  ["PUT", (t) => `/api/v1/trips/${t}/cities/order`],
  ["DELETE", (t) => `/api/v1/trips/${t}/cities/some-city`],
  ["POST", (t) => `/api/v1/trips/${t}/items`],
  ["PATCH", (t) => `/api/v1/trips/${t}/items/some-item`],
  ["DELETE", (t) => `/api/v1/trips/${t}/items/some-item`],
  ["POST", (t) => `/api/v1/trips/${t}/todos`],
  ["PATCH", (t) => `/api/v1/trips/${t}/todos/some-todo`],
  ["DELETE", (t) => `/api/v1/trips/${t}/todos/some-todo`],
];

let tripId: string;
let memberToken: string;
let outsiderToken: string;

beforeAll(async () => {
  const owner = await signInIos("apple-sub-matrix-owner");
  const outsider = await signInIos("apple-sub-matrix-outsider");
  tripId = await createTrip(owner.token);
  memberToken = owner.token;
  outsiderToken = outsider.token;
});

describe("trip-scoped route guard matrix", () => {
  it.each(ROUTES)("%s %s", async (method, path) => {
    const unauthenticated = await app.request(path(tripId), req(method), env);
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toEqual({
      error: { code: "unauthenticated", message: expect.any(String) },
    });

    const nonMember = await app.request(path(tripId), req(method, outsiderToken), env);
    expect(nonMember.status).toBe(403);
    expect(await nonMember.json()).toEqual({
      error: { code: "not_a_member", message: expect.any(String) },
    });

    const unknownTrip = await app.request(path("no-such-trip"), req(method, memberToken), env);
    expect(unknownTrip.status).toBe(404);
    expect(await unknownTrip.json()).toEqual({
      error: { code: "trip_not_found", message: expect.any(String) },
    });
  });
});
