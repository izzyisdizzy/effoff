import { describe, expect, it } from "vitest";
import { isLocalDateTime, isValidTimeZone, localToUtc } from "../src/time";

describe("isValidTimeZone", () => {
  it("accepts real IANA zones", () => {
    expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });

  it("rejects junk", () => {
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("GMT+9000")).toBe(false);
  });
});

describe("isLocalDateTime", () => {
  it("accepts wall-clock ISO with and without seconds", () => {
    expect(isLocalDateTime("2026-04-10T09:00")).toBe(true);
    expect(isLocalDateTime("2026-04-10T09:00:30")).toBe(true);
  });

  it("rejects offsets, dates without times, and impossible times", () => {
    expect(isLocalDateTime("2026-04-10T09:00:00Z")).toBe(false);
    expect(isLocalDateTime("2026-04-10T09:00+09:00")).toBe(false);
    expect(isLocalDateTime("2026-04-10")).toBe(false);
    expect(isLocalDateTime("2026-02-30T09:00")).toBe(false);
    expect(isLocalDateTime("2026-04-10T27:00")).toBe(false);
    expect(isLocalDateTime("garbage")).toBe(false);
  });
});

describe("localToUtc", () => {
  it("derives a fixed-offset zone", () => {
    // Japan has no DST: 09:00 in Tokyo is always midnight UTC.
    expect(localToUtc("2026-04-10T09:00", "Asia/Tokyo")).toBe("2026-04-10T00:00:00.000Z");
    expect(localToUtc("2026-12-25T09:00", "Asia/Tokyo")).toBe("2026-12-25T00:00:00.000Z");
  });

  it("keeps a per-end-zone flight's ends independently derived and ordered", () => {
    // LAX 13:00 local → HND 17:05 *next day* local: each end resolves in its
    // own zone (the foundation.md reason start_tz/end_tz are per-end).
    const departure = localToUtc("2026-04-10T13:00", "America/Los_Angeles");
    const arrival = localToUtc("2026-04-11T17:05", "Asia/Tokyo");
    expect(departure).toBe("2026-04-10T20:00:00.000Z");
    expect(arrival).toBe("2026-04-11T08:05:00.000Z");
    // The wall-clock gap is ~28h; the real flight is ~12h. Ordering must
    // come from the derived instants, and it does.
    expect(Date.parse(arrival as string) - Date.parse(departure as string)).toBe(
      (12 * 60 + 5) * 60 * 1000,
    );
  });

  it("applies the offset in force across the spring-forward boundary", () => {
    // US DST 2026 starts Sun 2026-03-08 02:00 → noon is EST (-5) the day
    // before and EDT (-4) the day after.
    expect(localToUtc("2026-03-07T12:00", "America/New_York")).toBe("2026-03-07T17:00:00.000Z");
    expect(localToUtc("2026-03-08T12:00", "America/New_York")).toBe("2026-03-08T16:00:00.000Z");
  });

  it("applies the offset in force across the fall-back boundary", () => {
    // US DST 2026 ends Sun 2026-11-01 02:00.
    expect(localToUtc("2026-10-31T12:00", "America/New_York")).toBe("2026-10-31T16:00:00.000Z");
    expect(localToUtc("2026-11-01T12:00", "America/New_York")).toBe("2026-11-01T17:00:00.000Z");
  });

  it("resolves a nonexistent spring-forward wall-clock time to a real instant", () => {
    // 02:30 on 2026-03-08 never happens in New York; the derivation must
    // still return a stable instant at the boundary, not throw or drift.
    // Guess-and-refine lands it just before the jump (06:30Z = 01:30 EST).
    const derived = localToUtc("2026-03-08T02:30", "America/New_York");
    expect(derived).toBe("2026-03-08T06:30:00.000Z");
  });

  it("returns null on invalid input", () => {
    expect(localToUtc("2026-04-10T09:00", "Not/AZone")).toBe(null);
    expect(localToUtc("2026-02-30T09:00", "Asia/Tokyo")).toBe(null);
    expect(localToUtc("not-a-time", "Asia/Tokyo")).toBe(null);
  });
});
