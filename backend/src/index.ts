import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>().basePath("/api");

// Proves the Worker runs and can round-trip to D1. Real endpoints live under
// /api/v1 (see docs/foundation.md) and arrive with later issues.
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

export default app;
