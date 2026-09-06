import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

// Exercises the core schema from 0002_core_schema.sql against the migrated
// local D1: the happy-path object graph, FK enforcement, CHECK and UNIQUE
// constraints, and trip-deletion cascade behavior.

const NOW = "2026-09-05T12:00:00Z";

// D1 state persists across tests in this suite, so start each test from an
// empty schema (children before parents to satisfy FKs).
beforeEach(async () => {
  for (const table of [
    "attachments",
    "todos",
    "itinerary_items",
    "trip_cities",
    "trip_members",
    "trips",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

async function seedTrip() {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, auth_provider, auth_subject, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind("user-1", "apple", "sub-1", "izzy@example.com", "Izzy", NOW, NOW),
    env.DB.prepare(
      "INSERT INTO trips (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind("trip-1", "Japan 2027", "user-1", NOW, NOW),
    env.DB.prepare(
      "INSERT INTO trip_members (trip_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).bind("trip-1", "user-1", NOW, NOW),
    env.DB.prepare(
      "INSERT INTO trip_cities (id, trip_id, name, timezone, arrival_date, departure_date, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind("city-tyo", "trip-1", "Tokyo", "Asia/Tokyo", "2027-02-10", "2027-02-14", 0, NOW, NOW),
    env.DB.prepare(
      "INSERT INTO trip_cities (id, trip_id, name, timezone, arrival_date, departure_date, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind("city-cts", "trip-1", "Sapporo", "Asia/Tokyo", "2027-02-14", null, 1, NOW, NOW),
    // A flight: no city (it spans two), per-end local times + zones, airports.
    env.DB.prepare(
      "INSERT INTO itinerary_items (id, trip_id, city_id, kind, title, start_local, start_tz, end_local, end_tz, start_utc, end_utc, departure_airport, arrival_airport, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "item-flight",
      "trip-1",
      null,
      "flight",
      "HND → CTS",
      "2027-02-14T09:30",
      "Asia/Tokyo",
      "2027-02-14T11:05",
      "Asia/Tokyo",
      "2027-02-14T00:30:00Z",
      "2027-02-14T02:05:00Z",
      "HND",
      "CTS",
      NOW,
      NOW,
    ),
    // A stay: one row, check-in as start and checkout as end.
    env.DB.prepare(
      "INSERT INTO itinerary_items (id, trip_id, city_id, kind, title, confirmation_number, links, start_local, start_tz, end_local, end_tz, start_utc, end_utc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "item-stay",
      "trip-1",
      "city-tyo",
      "stay",
      "Shibuya Hotel",
      "ABC123",
      JSON.stringify(["https://example.com/booking"]),
      "2027-02-10T15:00",
      "Asia/Tokyo",
      "2027-02-14T10:00",
      "Asia/Tokyo",
      "2027-02-10T06:00:00Z",
      "2027-02-14T01:00:00Z",
      NOW,
      NOW,
    ),
    // An untimed activity: all time columns NULL, ordered manually by position.
    env.DB.prepare(
      "INSERT INTO itinerary_items (id, trip_id, city_id, kind, title, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind("item-idea", "trip-1", "city-cts", "activity", "Ski day (sometime)", 0, NOW, NOW),
    env.DB.prepare(
      "INSERT INTO todos (id, trip_id, title, done, assignee_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind("todo-1", "trip-1", "Book rail passes", 0, "user-1", NOW, NOW),
    // The stay's confirmation PDF (0004): metadata row for an R2 object.
    env.DB.prepare(
      "INSERT INTO attachments (id, trip_id, itinerary_item_id, r2_key, mime_type, byte_size, filename, uploaded_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "att-1",
      "trip-1",
      "item-stay",
      "trips/trip-1/att-1",
      "application/pdf",
      1234,
      "confirmation.pdf",
      "user-1",
      NOW,
      NOW,
    ),
  ]);
}

describe("core schema (0002)", () => {
  it("stores a full trip graph and reads it back", async () => {
    await seedTrip();

    // A bare ORDER BY start_utc would sort NULLs (untimed items) first; the
    // timeline query must push them after the timed schedule, by position.
    const items = await env.DB.prepare(
      "SELECT * FROM itinerary_items WHERE trip_id = ? ORDER BY start_utc IS NULL, start_utc, position",
    )
      .bind("trip-1")
      .all<Record<string, unknown>>();
    expect(items.results.map((r) => r.id)).toEqual(["item-stay", "item-flight", "item-idea"]);

    const flight = items.results[1];
    expect(flight?.city_id).toBeNull();
    expect(flight?.departure_airport).toBe("HND");
    expect(flight?.arrival_airport).toBe("CTS");
    expect(flight?.start_tz).toBe("Asia/Tokyo");

    const stay = items.results[0];
    expect(stay?.kind).toBe("stay");
    expect(JSON.parse(stay?.links as string)).toEqual(["https://example.com/booking"]);

    expect(await count("trip_members")).toBe(1);
    expect(await count("trip_cities")).toBe(2);
    expect(await count("todos")).toBe(1);
  });

  it("rejects rows that violate foreign keys", async () => {
    await expect(
      env.DB.prepare(
        "INSERT INTO todos (id, trip_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind("todo-orphan", "no-such-trip", "Orphan", NOW, NOW)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it("rejects an unknown itinerary item kind", async () => {
    await seedTrip();
    await expect(
      env.DB.prepare(
        "INSERT INTO itinerary_items (id, trip_id, kind, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind("item-bad", "trip-1", "teleport", "Beam me up", NOW, NOW)
        .run(),
    ).rejects.toThrow(/CHECK/i);
  });

  it("rejects a duplicate auth identity and a duplicate membership", async () => {
    await seedTrip();
    await expect(
      env.DB.prepare(
        "INSERT INTO users (id, auth_provider, auth_subject, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind("user-2", "apple", "sub-1", "Imposter", NOW, NOW)
        .run(),
    ).rejects.toThrow(/UNIQUE/i);
    await expect(
      env.DB.prepare(
        "INSERT INTO trip_members (trip_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
        .bind("trip-1", "user-1", NOW, NOW)
        .run(),
    ).rejects.toThrow(/UNIQUE/i);
  });

  it("rejects a todo done value outside 0/1", async () => {
    await seedTrip();
    await expect(
      env.DB.prepare(
        "INSERT INTO todos (id, trip_id, title, done, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind("todo-bad", "trip-1", "Overdone", 7, NOW, NOW)
        .run(),
    ).rejects.toThrow(/CHECK/i);
  });

  it("deleting a city keeps its items (city_id set to NULL)", async () => {
    await seedTrip();
    await env.DB.prepare("DELETE FROM trip_cities WHERE id = ?").bind("city-tyo").run();

    const stay = await env.DB.prepare("SELECT city_id FROM itinerary_items WHERE id = ?")
      .bind("item-stay")
      .first<{ city_id: string | null }>();
    expect(stay?.city_id).toBeNull();
  });

  it("deleting an item keeps its attachments (itinerary_item_id set to NULL)", async () => {
    await seedTrip();
    await env.DB.prepare("DELETE FROM itinerary_items WHERE id = ?").bind("item-stay").run();

    const attachment = await env.DB.prepare(
      "SELECT itinerary_item_id FROM attachments WHERE id = ?",
    )
      .bind("att-1")
      .first<{ itinerary_item_id: string | null }>();
    expect(attachment).not.toBeNull();
    expect(attachment?.itinerary_item_id).toBeNull();
  });

  it("rejects an attachment mime type outside the sniffer's allowlist", async () => {
    await seedTrip();
    await expect(
      env.DB.prepare(
        "INSERT INTO attachments (id, trip_id, r2_key, mime_type, byte_size, uploaded_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind("att-html", "trip-1", "trips/trip-1/att-html", "text/html", 10, "user-1", NOW, NOW)
        .run(),
    ).rejects.toThrow(/CHECK/i);
  });

  it("rejects an attachment with a non-positive size or duplicate key", async () => {
    await seedTrip();
    await expect(
      env.DB.prepare(
        "INSERT INTO attachments (id, trip_id, r2_key, mime_type, byte_size, uploaded_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind("att-empty", "trip-1", "trips/trip-1/att-empty", "image/png", 0, "user-1", NOW, NOW)
        .run(),
    ).rejects.toThrow(/CHECK/i);
    await expect(
      env.DB.prepare(
        "INSERT INTO attachments (id, trip_id, r2_key, mime_type, byte_size, uploaded_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
        .bind("att-dup", "trip-1", "trips/trip-1/att-1", "image/png", 10, "user-1", NOW, NOW)
        .run(),
    ).rejects.toThrow(/UNIQUE/i);
  });

  it("deleting a trip cascades all trip-scoped rows but keeps users", async () => {
    await seedTrip();
    await env.DB.prepare("DELETE FROM trips WHERE id = ?").bind("trip-1").run();

    expect(await count("trips")).toBe(0);
    expect(await count("trip_members")).toBe(0);
    expect(await count("trip_cities")).toBe(0);
    expect(await count("itinerary_items")).toBe(0);
    expect(await count("todos")).toBe(0);
    expect(await count("attachments")).toBe(0);
    expect(await count("users")).toBe(1);
  });
});
