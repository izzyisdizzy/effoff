import { Hono } from "hono";
import { apiError } from "../api-error";
import { attachmentKey, deleteObjects } from "../attachments/storage";
import { sniffMime } from "../attachments/sniff";
import { isTripMember } from "../auth/membership";
import { requireSession, requireTripMember } from "../auth/middleware";
import { publicAttachment, type AppEnv, type AttachmentRow } from "../types";
import { MAX_ATTACHMENT_BYTES, MAX_FILENAME, MAX_NAME, readJsonObject } from "../validate";

const attachments = new Hono<AppEnv>();

const UPLOAD_SHAPE =
  "Expected multipart/form-data with a `file` part (image or PDF) and an optional `itineraryItemId` field.";

// The original upload name is display-only, but it is echoed into
// Content-Disposition, so reduce it to a plain basename: no path segments,
// no control characters, capped. Empty after cleanup means "no name".
function sanitizeFilename(raw: string): string | null {
  // Multipart parsing percent-encodes the three characters a filename part
  // cannot carry literally (WHATWG: `"` → %22, LF → %0A, CR → %0D); restore
  // the quote and drop the line breaks so the stored name is the real one.
  const decoded = raw.replace(/%22/g, '"').replace(/%0[AD]/gi, "");
  const base = decoded.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") {
    return null;
  }
  return cleaned.slice(0, MAX_FILENAME);
}

// Header-safe form of the stored name for Content-Disposition: printable
// ASCII only, no quotes or backslashes (RFC 5987 encoding is a later nicety).
function dispositionFilename(filename: string | null): string {
  const ascii = (filename ?? "").replace(/["\\]/g, "").replace(/[^\x20-\x7e]/g, "_");
  return ascii.length === 0 ? "attachment" : ascii;
}

async function itemBelongsToTrip(db: D1Database, tripId: string, itemId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS yes FROM itinerary_items WHERE id = ? AND trip_id = ?")
    .bind(itemId, tripId)
    .first<{ yes: number }>();
  return row !== null;
}

function isValidItemId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_NAME;
}

attachments.post("/trips/:id/attachments", requireSession, requireTripMember, async (c) => {
  const tripId = c.req.param("id");
  // Content-Length is advisory (chunked bodies omit it), but when present it
  // lets an oversized upload fail before the Worker buffers any of it.
  const declaredLength = Number(c.req.header("Content-Length") ?? "0");
  if (declaredLength > MAX_ATTACHMENT_BYTES) {
    return apiError(
      c,
      413,
      "too_large",
      `Attachments are limited to ${MAX_ATTACHMENT_BYTES} bytes.`,
    );
  }
  if (!/^multipart\/form-data(;|$)/i.test(c.req.header("Content-Type") ?? "")) {
    return apiError(c, 400, "invalid_request", UPLOAD_SHAPE);
  }
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return apiError(c, 400, "invalid_request", UPLOAD_SHAPE);
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return apiError(c, 400, "invalid_request", UPLOAD_SHAPE);
  }
  const itemField = form.get("itineraryItemId");
  if (itemField !== null && !isValidItemId(itemField)) {
    return apiError(c, 400, "invalid_request", UPLOAD_SHAPE);
  }
  if (file.size === 0) {
    return apiError(c, 400, "invalid_request", "The uploaded file is empty.");
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return apiError(
      c,
      413,
      "too_large",
      `Attachments are limited to ${MAX_ATTACHMENT_BYTES} bytes.`,
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  // The declared file.type is ignored on purpose: the stored type is what the
  // object is served back as, so it has to come from the bytes.
  const mime = sniffMime(bytes);
  if (mime === null) {
    return apiError(
      c,
      400,
      "unsupported_type",
      "Only JPEG, PNG, WebP, GIF images and PDF files can be attached.",
    );
  }
  if (itemField !== null && !(await itemBelongsToTrip(c.env.DB, tripId, itemField))) {
    return apiError(
      c,
      400,
      "unknown_item",
      "itineraryItemId does not refer to an itinerary item on this trip.",
    );
  }
  const now = new Date().toISOString();
  const row: AttachmentRow = {
    id: crypto.randomUUID(),
    trip_id: tripId,
    itinerary_item_id: itemField,
    r2_key: "",
    mime_type: mime,
    byte_size: bytes.byteLength,
    filename: sanitizeFilename(file.name),
    uploaded_by: c.get("user").id,
    created_at: now,
    updated_at: now,
  };
  row.r2_key = attachmentKey(tripId, row.id);
  // Bytes first, then the row: a row must never point at an object that was
  // not written. If the insert fails, drop the object so nothing is orphaned.
  await c.env.ATTACHMENTS.put(row.r2_key, bytes, { httpMetadata: { contentType: mime } });
  try {
    await c.env.DB.prepare(
      "INSERT INTO attachments (id, trip_id, itinerary_item_id, r2_key, mime_type, byte_size, filename, uploaded_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        row.id,
        row.trip_id,
        row.itinerary_item_id,
        row.r2_key,
        row.mime_type,
        row.byte_size,
        row.filename,
        row.uploaded_by,
        row.created_at,
        row.updated_at,
      )
      .run();
  } catch (error) {
    await c.env.ATTACHMENTS.delete(row.r2_key).catch((cleanupError: unknown) => {
      console.error("attachment_orphan_cleanup_failed", cleanupError);
    });
    throw error;
  }
  return c.json({ attachment: publicAttachment(row) }, 201);
});

// Not trip-scoped in the URL (docs/foundation.md API shape), so the trip —
// and therefore the membership check — comes from the row. 403 for a
// non-member matches requireTripMember everywhere else; ids are UUIDs, so
// existence is not a meaningful leak.
attachments.get("/attachments/:id", requireSession, async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM attachments WHERE id = ?")
    .bind(c.req.param("id"))
    .first<AttachmentRow>();
  if (row === null) {
    return apiError(c, 404, "attachment_not_found", "Attachment not found.");
  }
  if (!(await isTripMember(c.env.DB, row.trip_id, c.get("user").id))) {
    return apiError(c, 403, "not_a_member", "You are not a member of this trip.");
  }
  // onlyIf with the request headers makes R2 evaluate If-None-Match etc.;
  // a failed precondition comes back as a body-less R2Object.
  const object = await c.env.ATTACHMENTS.get(row.r2_key, { onlyIf: c.req.raw.headers });
  if (object === null) {
    // Only a failed delete sequence can produce a row without its object.
    console.error("attachment_object_missing", { id: row.id, key: row.r2_key });
    return apiError(c, 404, "attachment_not_found", "Attachment not found.");
  }
  const headers = new Headers({
    "Content-Type": row.mime_type,
    ETag: object.httpEtag,
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `inline; filename="${dispositionFilename(row.filename)}"`,
  });
  if (!("body" in object)) {
    return new Response(null, { status: 304, headers });
  }
  headers.set("Content-Length", String(row.byte_size));
  return new Response(object.body, { status: 200, headers });
});

// The only mutable field: which itinerary item the booking belongs to. Set
// after the fact because booking capture uploads before the item exists.
attachments.patch(
  "/trips/:tripId/attachments/:id",
  requireSession,
  requireTripMember,
  async (c) => {
    const tripId = c.req.param("tripId");
    const attachmentId = c.req.param("id");
    const body: { itineraryItemId?: unknown } | null = await readJsonObject(c);
    if (body === null) {
      return apiError(c, 400, "invalid_request", "Request body must be a JSON object.");
    }
    const itemId = body.itineraryItemId;
    if (itemId !== null && !isValidItemId(itemId)) {
      return apiError(c, 400, "invalid_request", "Expected { itineraryItemId: string | null }.");
    }
    const existing = await c.env.DB.prepare(
      "SELECT * FROM attachments WHERE id = ? AND trip_id = ?",
    )
      .bind(attachmentId, tripId)
      .first<AttachmentRow>();
    if (existing === null) {
      return apiError(c, 404, "attachment_not_found", "Attachment not found on this trip.");
    }
    if (itemId !== null && !(await itemBelongsToTrip(c.env.DB, tripId, itemId))) {
      return apiError(
        c,
        400,
        "unknown_item",
        "itineraryItemId does not refer to an itinerary item on this trip.",
      );
    }
    const updated: AttachmentRow = {
      ...existing,
      itinerary_item_id: itemId,
      updated_at: new Date().toISOString(),
    };
    await c.env.DB.prepare(
      "UPDATE attachments SET itinerary_item_id = ?, updated_at = ? WHERE id = ? AND trip_id = ?",
    )
      .bind(updated.itinerary_item_id, updated.updated_at, attachmentId, tripId)
      .run();
    return c.json({ attachment: publicAttachment(updated) });
  },
);

attachments.delete(
  "/trips/:tripId/attachments/:id",
  requireSession,
  requireTripMember,
  async (c) => {
    const tripId = c.req.param("tripId");
    const attachmentId = c.req.param("id");
    const existing = await c.env.DB.prepare(
      "SELECT r2_key FROM attachments WHERE id = ? AND trip_id = ?",
    )
      .bind(attachmentId, tripId)
      .first<{ r2_key: string }>();
    if (existing === null) {
      return apiError(c, 404, "attachment_not_found", "Attachment not found on this trip.");
    }
    // Object first, then the row (see the trip delete for the reasoning).
    try {
      await deleteObjects(c.env.ATTACHMENTS, [existing.r2_key]);
    } catch (error) {
      console.error("attachment_r2_delete_failed", error);
      return apiError(c, 503, "storage_unavailable", "Could not remove the attachment.");
    }
    await c.env.DB.prepare("DELETE FROM attachments WHERE id = ? AND trip_id = ?")
      .bind(attachmentId, tripId)
      .run();
    return c.json({ ok: true });
  },
);

export default attachments;
