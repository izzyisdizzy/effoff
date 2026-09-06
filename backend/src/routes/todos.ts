import { Hono } from "hono";
import { apiError } from "../api-error";
import { isTripMember } from "../auth/membership";
import { requireSession, requireTripMember } from "../auth/middleware";
import { isLocalDateTime, isValidTimeZone } from "../time";
import { publicTodo, type AppEnv, type TodoRow } from "../types";
import { MAX_NAME, readJsonObject } from "../validate";

const todos = new Hono<AppEnv>();

type TodoBody = {
  title?: unknown;
  done?: unknown;
  dueLocal?: unknown;
  dueTz?: unknown;
  assigneeUserId?: unknown;
};

function shapeProblem(body: TodoBody): string | null {
  if (
    body.title !== undefined &&
    (typeof body.title !== "string" ||
      body.title.trim().length === 0 ||
      body.title.length > MAX_NAME)
  ) {
    return "title must be a non-empty string.";
  }
  if (body.done !== undefined && typeof body.done !== "boolean") {
    return "done must be a boolean.";
  }
  for (const field of ["dueLocal", "dueTz", "assigneeUserId"] as const) {
    const value = body[field];
    if (value !== undefined && value !== null && typeof value !== "string") {
      return "Expected { title, done?, dueLocal?, dueTz?, assigneeUserId? }.";
    }
  }
  return null;
}

// Cross-field checks on the merged row. To-dos have no city to default the
// zone from, so a due time requires its zone explicitly; there is no derived
// UTC (schema: to-dos are not ordered on a timeline).
function dueProblem(draft: TodoRow): string | null {
  if (draft.due_local === null) {
    draft.due_tz = null;
    return null;
  }
  if (!isLocalDateTime(draft.due_local)) {
    return "dueLocal must be local wall-clock ISO 8601 (YYYY-MM-DDTHH:MM, no offset).";
  }
  if (draft.due_tz === null) {
    return "dueTz is required when dueLocal is set.";
  }
  if (!isValidTimeZone(draft.due_tz)) {
    return "dueTz must be a valid IANA zone (e.g. Asia/Tokyo).";
  }
  return null;
}

todos.post("/trips/:id/todos", requireSession, requireTripMember, async (c) => {
  const tripId = c.req.param("id");
  const body: TodoBody | null = await readJsonObject(c);
  if (body === null) {
    return apiError(c, 400, "invalid_request", "Request body must be a JSON object.");
  }
  if (typeof body.title !== "string") {
    return apiError(
      c,
      400,
      "invalid_request",
      "Expected { title, done?, dueLocal?, dueTz?, assigneeUserId? }.",
    );
  }
  const problem = shapeProblem(body);
  if (problem !== null) {
    return apiError(c, 400, "invalid_request", problem);
  }
  const now = new Date().toISOString();
  const draft: TodoRow = {
    id: crypto.randomUUID(),
    trip_id: tripId,
    title: body.title.trim(),
    done: body.done === true ? 1 : 0,
    due_local: (body.dueLocal as string | null | undefined) ?? null,
    due_tz: (body.dueTz as string | null | undefined) ?? null,
    assignee_user_id: (body.assigneeUserId as string | null | undefined) ?? null,
    created_at: now,
    updated_at: now,
  };
  const due = dueProblem(draft);
  if (due !== null) {
    return apiError(c, 400, "invalid_request", due);
  }
  if (
    draft.assignee_user_id !== null &&
    !(await isTripMember(c.env.DB, tripId, draft.assignee_user_id))
  ) {
    return apiError(c, 400, "not_a_trip_member", "assigneeUserId is not a member of this trip.");
  }
  await c.env.DB.prepare(
    "INSERT INTO todos (id, trip_id, title, done, due_local, due_tz, assignee_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      draft.id,
      draft.trip_id,
      draft.title,
      draft.done,
      draft.due_local,
      draft.due_tz,
      draft.assignee_user_id,
      draft.created_at,
      draft.updated_at,
    )
    .run();
  return c.json({ todo: publicTodo(draft) }, 201);
});

// Partial update; toggling done lives here ({ done: true/false }).
todos.patch("/trips/:tripId/todos/:id", requireSession, requireTripMember, async (c) => {
  const tripId = c.req.param("tripId");
  const todoId = c.req.param("id");
  const body: TodoBody | null = await readJsonObject(c);
  if (body === null) {
    return apiError(c, 400, "invalid_request", "Request body must be a JSON object.");
  }
  if (body.title === null || body.done === null) {
    return apiError(c, 400, "invalid_request", "title and done cannot be cleared.");
  }
  const problem = shapeProblem(body);
  if (problem !== null) {
    return apiError(c, 400, "invalid_request", problem);
  }
  const existing = await c.env.DB.prepare("SELECT * FROM todos WHERE id = ? AND trip_id = ?")
    .bind(todoId, tripId)
    .first<TodoRow>();
  if (existing === null) {
    return apiError(c, 404, "todo_not_found", "To-do not found on this trip.");
  }
  const merged: TodoRow = {
    ...existing,
    title: body.title === undefined ? existing.title : (body.title as string).trim(),
    done: body.done === undefined ? existing.done : body.done === true ? 1 : 0,
    due_local: body.dueLocal === undefined ? existing.due_local : (body.dueLocal as string | null),
    due_tz: body.dueTz === undefined ? existing.due_tz : (body.dueTz as string | null),
    assignee_user_id:
      body.assigneeUserId === undefined
        ? existing.assignee_user_id
        : (body.assigneeUserId as string | null),
    updated_at: new Date().toISOString(),
  };
  const due = dueProblem(merged);
  if (due !== null) {
    return apiError(c, 400, "invalid_request", due);
  }
  if (
    merged.assignee_user_id !== null &&
    merged.assignee_user_id !== existing.assignee_user_id &&
    !(await isTripMember(c.env.DB, tripId, merged.assignee_user_id))
  ) {
    return apiError(c, 400, "not_a_trip_member", "assigneeUserId is not a member of this trip.");
  }
  await c.env.DB.prepare(
    "UPDATE todos SET title = ?, done = ?, due_local = ?, due_tz = ?, assignee_user_id = ?, updated_at = ? WHERE id = ? AND trip_id = ?",
  )
    .bind(
      merged.title,
      merged.done,
      merged.due_local,
      merged.due_tz,
      merged.assignee_user_id,
      merged.updated_at,
      todoId,
      tripId,
    )
    .run();
  return c.json({ todo: publicTodo(merged) });
});

todos.delete("/trips/:tripId/todos/:id", requireSession, requireTripMember, async (c) => {
  const tripId = c.req.param("tripId");
  const todoId = c.req.param("id");
  const result = await c.env.DB.prepare("DELETE FROM todos WHERE id = ? AND trip_id = ?")
    .bind(todoId, tripId)
    .run();
  if (result.meta.changes === 0) {
    return apiError(c, 404, "todo_not_found", "To-do not found on this trip.");
  }
  return c.json({ ok: true });
});

export default todos;
