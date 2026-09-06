import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/index";

describe("GET /api/health", () => {
  it("returns 200 with a real D1 round-trip", async () => {
    const res = await app.request("/api/health", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      db: true,
      schemaVersion: "4",
    });
  });

  it("404s for unknown routes", async () => {
    const res = await app.request("/api/nope", {}, env);
    expect(res.status).toBe(404);
  });
});
