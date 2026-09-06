import { Hono } from "hono";
import { apiError } from "./api-error";
import auth from "./routes/auth";
import cities from "./routes/cities";
import invites from "./routes/invites";
import items from "./routes/items";
import todos from "./routes/todos";
import trips from "./routes/trips";
import type { AppEnv } from "./types";

const app = new Hono<AppEnv>().basePath("/api");

// Proves the Worker runs and can round-trip to D1. The only route outside
// /api/v1 (see docs/foundation.md).
app.get("/health", async (c) => {
  try {
    const row = await c.env.DB.prepare(
      "SELECT value FROM meta WHERE key = 'schema_version'",
    ).first<{ value: string }>();
    if (row === null) {
      throw new Error("meta table has no schema_version row");
    }
    return c.json({ ok: true, db: true, schemaVersion: row.value });
  } catch (error) {
    // Pass the raw error so Workers observability captures it (with stack)
    // as structured log arguments.
    console.error("health_db_check_failed", error);
    return c.json({ ok: false, db: false }, 503);
  }
});

const v1 = new Hono<AppEnv>();
v1.route("/", auth);
v1.route("/", invites);
v1.route("/", trips);
v1.route("/", cities);
v1.route("/", items);
v1.route("/", todos);
app.route("/v1", v1);

// Keep the { error: { code, message } } contract on the paths Hono would
// otherwise answer with plain text: unknown routes and uncaught throws.
app.notFound((c) => apiError(c, 404, "not_found", "No such endpoint."));
app.onError((error, c) => {
  console.error("unhandled_error", error);
  return apiError(c, 500, "internal_error", "Something went wrong.");
});

export default app;
