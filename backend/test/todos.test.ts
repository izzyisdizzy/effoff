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

describe("POST /api/v1/trips/:id/todos", () => {
  it("creates a todo, not done, and accepts a member assignee", async () => {
    const owner = await signInIos("apple-sub-todo-create");
    const tripId = await createTrip(owner.token);
    const res = await app.request(
      `/api/v1/trips/${tripId}/todos`,
      req("POST", owner.token, {
        title: "Book flights",
        dueLocal: "2026-09-20T18:00",
        dueTz: "America/New_York",
        assigneeUserId: owner.user.id,
      }),
      env,
    );
    expect(res.status).toBe(201);
    const { todo } = (await res.json()) as { todo: Record<string, unknown> };
    expect(todo).toMatchObject({
      title: "Book flights",
      done: false,
      dueLocal: "2026-09-20T18:00",
      dueTz: "America/New_York",
      assigneeUserId: owner.user.id,
    });
  });

  it("400s bad input, including a non-member assignee", async () => {
    const owner = await signInIos("apple-sub-todo-bad");
    const outsider = await signInIos("apple-sub-todo-outsider");
    const tripId = await createTrip(owner.token);
    const cases: [Record<string, unknown>, string][] = [
      [{}, "invalid_request"], // no title
      [{ title: "  " }, "invalid_request"],
      [{ title: "Due, no zone", dueLocal: "2026-09-20T18:00" }, "invalid_request"],
      [{ title: "Bad zone", dueLocal: "2026-09-20T18:00", dueTz: "Not/AZone" }, "invalid_request"],
      [{ title: "Bad due", dueLocal: "whenever", dueTz: "UTC" }, "invalid_request"],
      [{ title: "Outsider", assigneeUserId: outsider.user.id }, "not_a_trip_member"],
    ];
    for (const [body, code] of cases) {
      const res = await app.request(
        `/api/v1/trips/${tripId}/todos`,
        req("POST", owner.token, body),
        env,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: { code, message: expect.any(String) } });
    }
  });
});

describe("PATCH /api/v1/trips/:tripId/todos/:id", () => {
  it("toggles done both ways and clears nullable fields with null", async () => {
    const owner = await signInIos("apple-sub-todo-toggle");
    const tripId = await createTrip(owner.token);
    const created = await app.request(
      `/api/v1/trips/${tripId}/todos`,
      req("POST", owner.token, {
        title: "Pack",
        dueLocal: "2026-09-20T18:00",
        dueTz: "UTC",
        assigneeUserId: owner.user.id,
      }),
      env,
    );
    const { todo } = (await created.json()) as { todo: { id: string } };
    const url = `/api/v1/trips/${tripId}/todos/${todo.id}`;

    const done = await app.request(url, req("PATCH", owner.token, { done: true }), env);
    expect(done.status).toBe(200);
    expect(((await done.json()) as { todo: { done: boolean } }).todo.done).toBe(true);

    const undone = await app.request(
      url,
      req("PATCH", owner.token, { done: false, dueLocal: null, assigneeUserId: null }),
      env,
    );
    expect(undone.status).toBe(200);
    const body = (await undone.json()) as { todo: Record<string, unknown> };
    // Clearing dueLocal drops the zone with it — a zone alone is meaningless.
    expect(body.todo).toMatchObject({
      done: false,
      dueLocal: null,
      dueTz: null,
      assigneeUserId: null,
    });
  });

  it("404s unknown and cross-trip todo ids", async () => {
    const owner = await signInIos("apple-sub-todo-404");
    const tripId = await createTrip(owner.token);
    const otherTripId = await createTrip(owner.token, "Other");
    const created = await app.request(
      `/api/v1/trips/${otherTripId}/todos`,
      req("POST", owner.token, { title: "Elsewhere" }),
      env,
    );
    expect(created.status).toBe(201);
    const { todo } = (await created.json()) as { todo: { id: string } };

    const res = await app.request(
      `/api/v1/trips/${tripId}/todos/${todo.id}`,
      req("PATCH", owner.token, { done: true }),
      env,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "todo_not_found", message: expect.any(String) },
    });
  });
});

describe("DELETE /api/v1/trips/:tripId/todos/:id", () => {
  it("deletes once, then 404s", async () => {
    const owner = await signInIos("apple-sub-todo-delete");
    const tripId = await createTrip(owner.token);
    const created = await app.request(
      `/api/v1/trips/${tripId}/todos`,
      req("POST", owner.token, { title: "Doomed" }),
      env,
    );
    expect(created.status).toBe(201);
    const { todo } = (await created.json()) as { todo: { id: string } };

    const first = await app.request(
      `/api/v1/trips/${tripId}/todos/${todo.id}`,
      req("DELETE", owner.token),
      env,
    );
    expect(first.status).toBe(200);
    const second = await app.request(
      `/api/v1/trips/${tripId}/todos/${todo.id}`,
      req("DELETE", owner.token),
      env,
    );
    expect(second.status).toBe(404);
  });
});
