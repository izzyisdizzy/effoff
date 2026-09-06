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

// Attachment uploads are buffered in the Worker (the type sniff needs the
// bytes), so the cap is also the memory bound per request. 20 MB covers
// phone photos and multi-page PDF confirmations with room to spare.
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_FILENAME = 255;
