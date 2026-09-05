import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();

const api = new Hono<{ Bindings: Env }>();

// Proves the Worker runs and can round-trip to D1. Real endpoints live under
// /api/v1 (see docs/foundation.md) and arrive with later issues.
api.get("/health", async (c) => {
  try {
    const row = await c.env.DB.prepare(
      "SELECT value FROM meta WHERE key = 'schema_version'",
    ).first<{ value: string }>();
    if (row === null) {
      throw new Error("meta table has no schema_version row");
    }
    return c.json({ ok: true, db: true, schemaVersion: row.value });
  } catch (error) {
    console.error(JSON.stringify({ event: "health_db_check_failed", error: String(error) }));
    return c.json({ ok: false, db: false }, 503);
  }
});

app.route("/api", api);

export default app;
