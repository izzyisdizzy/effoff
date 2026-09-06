// The time model (docs/foundation.md): local wall-clock text + IANA zone is
// the source of truth; UTC instants are derived on write and used only for
// ordering. workerd ships full ICU, so Intl covers zone math without a
// dependency.

// Local wall-clock ISO 8601, no offset: YYYY-MM-DDTHH:MM or with :SS.
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function isValidTimeZone(zone: string): boolean {
  try {
    // Intl.DateTimeFormat is callable without `new`; an unknown zone throws.
    Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// Parses a local wall-clock string to the epoch ms it would be *if it were
// UTC* — the intermediate value zone resolution works from. Null when the
// text isn't a real calendar time (bad shape, 2026-02-30, hour 27, ...).
function parseLocalAsUtc(value: string): number | null {
  const m = LOCAL_RE.exec(value);
  if (m === null) {
    return null;
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  // Date.UTC silently rolls over out-of-range parts; a round-trip mismatch
  // means the input named a time that doesn't exist on the calendar.
  const roundTrip = new Date(ms);
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day ||
    roundTrip.getUTCHours() !== hour ||
    roundTrip.getUTCMinutes() !== minute ||
    roundTrip.getUTCSeconds() !== second
  ) {
    return null;
  }
  return ms;
}

export function isLocalDateTime(value: string): boolean {
  return parseLocalAsUtc(value) !== null;
}

// ISO 8601 date text (YYYY-MM-DD), the schema's convention for dates.
export function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && parseLocalAsUtc(`${value}T00:00`) !== null;
}

// The zone's UTC offset in ms at a given instant, via formatToParts — the
// only zone-offset primitive Intl exposes.
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (part === undefined) {
      throw new Error(`Intl.DateTimeFormat returned no ${type} part`);
    }
    return Number(part.value);
  };
  const zoneWallClockAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return zoneWallClockAsUtc - utcMs;
}

// Derives the UTC instant for a local wall-clock time in an IANA zone, as an
// ISO 8601 UTC string. Null when either input is invalid. Guess-and-refine:
// treat the local time as UTC, read the zone's offset there, adjust, and read
// once more so instants near a DST transition land on the offset actually in
// force. A time inside the spring-forward gap resolves to a stable instant
// within the skipped hour — good enough for a planner (nothing real is
// scheduled at a time that doesn't exist).
export function localToUtc(local: string, timeZone: string): string | null {
  const asIfUtc = parseLocalAsUtc(local);
  if (asIfUtc === null || !isValidTimeZone(timeZone)) {
    return null;
  }
  const firstGuess = zoneOffsetMs(asIfUtc, timeZone);
  const offset = zoneOffsetMs(asIfUtc - firstGuess, timeZone);
  return new Date(asIfUtc - offset).toISOString();
}
