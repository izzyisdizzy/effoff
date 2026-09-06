import type { Context } from "hono";

// Shared request plumbing for the JSON API routes.

// Parses the request body and returns it only when it is a JSON *object*.
// `null`, arrays, and bare primitives all parse as valid JSON — so they get
// past a try/catch around req.json() — but would throw on property access in
// a handler, turning a malformed request into a 500.
export async function readJsonObject(c: Context): Promise<Record<string, unknown> | null> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

// Only web links belong in `links` — it is rendered to other trip members,
// so javascript:/data:/etc. schemes are rejected outright.
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// Free-text length caps: generous for real planning content, small enough
// that nothing passes validation only to fail inside D1 (row limit ~2 MB)
// as a 500. Format-validated fields (zones, times, dates) need no cap.
export const MAX_NAME = 300; // trip/city names, item/todo titles
export const MAX_NOTES = 10_000;
export const MAX_ADDRESS = 1_000;
export const MAX_CONFIRMATION = 200;
export const MAX_AIRPORT = 10;
export const MAX_LINK = 2_000;
export const MAX_LINKS = 50;

// Place tags are one-word decorations ("ramen", "casual", "shoes"); a place
// with more than a couple dozen of them is writing a note, not tagging. The
// pair bounds a place's tag rows at ~1 KB.
export const MAX_TAG = 50;
export const MAX_TAGS = 25;
// A place link's display label ("Tabelog", "Marie's rec"). Link URLs reuse
// MAX_LINK and the per-place count reuses MAX_LINKS — same knob as itinerary
// item links, so there is one answer to "how many links may a thing have".
export const MAX_LABEL = 100;

// Attachment uploads are buffered in the Worker (the type sniff needs the
// bytes), so the cap is also the memory bound per request. 20 MB covers
// phone photos and multi-page PDF confirmations with room to spare.
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_FILENAME = 255;
