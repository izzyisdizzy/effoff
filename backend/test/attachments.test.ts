import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { MAX_ATTACHMENT_BYTES } from "../src/validate";
import { activateAppleJwksMock, createTrip, signInIos } from "./apple";
import { GIF, JPEG, PDF, PNG, WEBP } from "./fixtures";
import { multipart, req } from "./http";

beforeAll(async () => {
  await activateAppleJwksMock();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

type Attachment = {
  id: string;
  itineraryItemId: string | null;
  mimeType: string;
  byteSize: number;
  filename: string | null;
  uploadedBy: string;
  createdAt: string;
  updatedAt: string;
};

function form(
  bytes: Uint8Array,
  name = "ticket.png",
  type = "image/png",
  extra: Record<string, string> = {},
): FormData {
  const fd = new FormData();
  fd.append("file", new File([bytes], name, { type }));
  for (const [key, value] of Object.entries(extra)) {
    fd.append(key, value);
  }
  return fd;
}

async function upload(
  token: string,
  tripId: string,
  fd: FormData,
): Promise<{ status: number; body: { attachment?: Attachment; error?: { code: string } } }> {
  const res = await app.request(`/api/v1/trips/${tripId}/attachments`, multipart(token, fd), env);
  // Let the clock move so a later mutation's updated_at is strictly greater
  // than the upload's — otherwise both land in the same millisecond and a
  // missing UPDATE ... updated_at would go unnoticed.
  await new Promise((resolve) => setTimeout(resolve, 2));
  return { status: res.status, body: (await res.json()) as never };
}

async function createItem(token: string, tripId: string, title = "Flight"): Promise<string> {
  const res = await app.request(
    `/api/v1/trips/${tripId}/items`,
    req("POST", token, { kind: "flight", title }),
    env,
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

async function objectKeys(tripId: string): Promise<string[]> {
  const listed = await env.ATTACHMENTS.list({ prefix: `trips/${tripId}/` });
  return listed.objects.map((o) => o.key);
}

describe("POST /api/v1/trips/:id/attachments", () => {
  it("stores the bytes in R2 and the metadata row in D1", async () => {
    const owner = await signInIos("apple-sub-att-upload");
    const tripId = await createTrip(owner.token);
    const { status, body } = await upload(owner.token, tripId, form(PNG, "boarding pass.png"));
    expect(status).toBe(201);
    const attachment = body.attachment as Attachment;
    expect(attachment).toMatchObject({
      itineraryItemId: null,
      mimeType: "image/png",
      byteSize: PNG.byteLength,
      filename: "boarding pass.png",
      uploadedBy: owner.user.id,
    });

    const row = await env.DB.prepare("SELECT * FROM attachments WHERE id = ?")
      .bind(attachment.id)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      trip_id: tripId,
      itinerary_item_id: null,
      r2_key: `trips/${tripId}/${attachment.id}`,
      mime_type: "image/png",
      byte_size: PNG.byteLength,
      filename: "boarding pass.png",
      uploaded_by: owner.user.id,
    });
    expect(row?.created_at).toEqual(row?.updated_at);

    const object = await env.ATTACHMENTS.get(`trips/${tripId}/${attachment.id}`);
    expect(object).not.toBeNull();
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(PNG);
  });

  it("links to an itinerary item on upload and rejects one from another trip", async () => {
    const owner = await signInIos("apple-sub-att-link");
    const tripId = await createTrip(owner.token);
    const otherTripId = await createTrip(owner.token, "Other");
    const itemId = await createItem(owner.token, tripId);
    const foreignItemId = await createItem(owner.token, otherTripId);

    const linked = await upload(
      owner.token,
      tripId,
      form(PDF, "conf.pdf", "application/pdf", { itineraryItemId: itemId }),
    );
    expect(linked.status).toBe(201);
    expect(linked.body.attachment?.itineraryItemId).toBe(itemId);
    expect(linked.body.attachment?.mimeType).toBe("application/pdf");

    const foreign = await upload(
      owner.token,
      tripId,
      form(PDF, "conf.pdf", "application/pdf", { itineraryItemId: foreignItemId }),
    );
    expect(foreign.status).toBe(400);
    expect(foreign.body.error?.code).toBe("unknown_item");
    // Nothing was written for the rejected upload.
    expect(await objectKeys(tripId)).toHaveLength(1);
  });

  it("sniffs the type from the bytes, never the declared type", async () => {
    const owner = await signInIos("apple-sub-att-sniff");
    const tripId = await createTrip(owner.token);

    const lying = await upload(owner.token, tripId, form(PNG, "x.pdf", "application/pdf"));
    expect(lying.status).toBe(201);
    expect(lying.body.attachment?.mimeType).toBe("image/png");

    // The remaining allowed types round-trip through the real upload path.
    const webp = await upload(owner.token, tripId, form(WEBP, "sticker.webp", "image/webp"));
    expect(webp.status).toBe(201);
    expect(webp.body.attachment?.mimeType).toBe("image/webp");
    const gif = await upload(
      owner.token,
      tripId,
      form(GIF, "loop.gif", "application/octet-stream"),
    );
    expect(gif.status).toBe(201);
    expect(gif.body.attachment?.mimeType).toBe("image/gif");

    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    const evil = await upload(owner.token, tripId, form(html, "ticket.png", "image/png"));
    expect(evil.status).toBe(400);
    expect(evil.body.error?.code).toBe("unsupported_type");
  });

  it("400s malformed uploads and 413s oversized ones", async () => {
    const owner = await signInIos("apple-sub-att-bad");
    const tripId = await createTrip(owner.token);
    const url = `/api/v1/trips/${tripId}/attachments`;

    const json = await app.request(url, req("POST", owner.token, { file: "nope" }), env);
    expect(json.status).toBe(400);
    expect(await json.json()).toEqual({
      error: { code: "invalid_request", message: expect.any(String) },
    });

    const noFile = new FormData();
    noFile.append("itineraryItemId", "abc");
    const missing = await upload(owner.token, tripId, noFile);
    expect(missing.status).toBe(400);
    expect(missing.body.error?.code).toBe("invalid_request");

    const empty = await upload(owner.token, tripId, form(new Uint8Array()));
    expect(empty.status).toBe(400);
    expect(empty.body.error?.code).toBe("invalid_request");

    const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    big.set(JPEG);
    const tooLarge = await upload(owner.token, tripId, form(big, "huge.jpg", "image/jpeg"));
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body.error?.code).toBe("too_large");

    // Declared Content-Length over the cap short-circuits before parsing.
    const declared = await app.request(
      url,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner.token}`,
          "content-type": "multipart/form-data; boundary=x",
          "content-length": String(MAX_ATTACHMENT_BYTES + 1),
        },
        body: "--x--",
      },
      env,
    );
    expect(declared.status).toBe(413);
    expect(await objectKeys(tripId)).toHaveLength(0);
  });

  it("answers 503 and stores nothing when R2 rejects the write", async () => {
    const owner = await signInIos("apple-sub-att-put-503");
    const tripId = await createTrip(owner.token);
    const spy = vi.spyOn(env.ATTACHMENTS, "put").mockRejectedValueOnce(new Error("r2 down"));
    try {
      const { status, body } = await upload(owner.token, tripId, form(PNG));
      expect(status).toBe(503);
      expect(body.error?.code).toBe("storage_unavailable");
    } finally {
      spy.mockRestore();
    }
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM attachments WHERE trip_id = ?")
      .bind(tripId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
    expect(await objectKeys(tripId)).toHaveLength(0);
  });

  it("stores a safe basename and rejects a malformed Content-Length", async () => {
    const owner = await signInIos("apple-sub-att-filename");
    const tripId = await createTrip(owner.token);

    const traversal = await upload(
      owner.token,
      tripId,
      form(PNG, "../../etc/weird.png", "image/png"),
    );
    expect(traversal.status).toBe(201);
    expect(traversal.body.attachment?.filename).toBe("weird.png");

    const unnamed = await upload(owner.token, tripId, form(PNG, "."));
    expect(unnamed.status).toBe(201);
    expect(unnamed.body.attachment?.filename).toBeNull();
    const res = await app.request(
      `/api/v1/attachments/${unnamed.body.attachment!.id}`,
      req("GET", owner.token),
      env,
    );
    expect(res.headers.get("content-disposition")).toBe('inline; filename="attachment"');

    const malformed = await app.request(
      `/api/v1/trips/${tripId}/attachments`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner.token}`,
          "content-type": "multipart/form-data; boundary=x",
          "content-length": "lots",
        },
        body: "--x--",
      },
      env,
    );
    expect(malformed.status).toBe(400);
  });

  it("guards membership like every other trip route", async () => {
    const owner = await signInIos("apple-sub-att-guard-owner");
    const outsider = await signInIos("apple-sub-att-guard-outsider");
    const tripId = await createTrip(owner.token);

    const anon = await app.request(
      `/api/v1/trips/${tripId}/attachments`,
      { method: "POST", body: form(PNG) },
      env,
    );
    expect(anon.status).toBe(401);

    const forbidden = await upload(outsider.token, tripId, form(PNG));
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error?.code).toBe("not_a_member");

    // Every attachment route sits behind requireSession, including the
    // trip-scoped mutations.
    const someId = crypto.randomUUID();
    for (const init of [
      req("PATCH", undefined, { itineraryItemId: null }),
      req("DELETE"),
    ] as const) {
      const anonMutation = await app.request(
        `/api/v1/trips/${tripId}/attachments/${someId}`,
        init,
        env,
      );
      expect(anonMutation.status).toBe(401);
    }
  });
});

describe("GET /api/v1/attachments/:id", () => {
  it("streams the bytes to a member with the sniffed type and caching headers", async () => {
    const owner = await signInIos("apple-sub-att-read");
    const tripId = await createTrip(owner.token);
    const { body } = await upload(owner.token, tripId, form(JPEG, 'my "ticket".jpg', "image/jpeg"));
    const id = body.attachment!.id;

    const res = await app.request(`/api/v1/attachments/${id}`, req("GET", owner.token), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("content-length")).toBe(String(JPEG.byteLength));
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="my ticket.jpg"');
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG);

    const cached = await app.request(
      `/api/v1/attachments/${id}`,
      { headers: { authorization: `Bearer ${owner.token}`, "if-none-match": etag! } },
      env,
    );
    expect(cached.status).toBe(304);
    expect(cached.headers.get("etag")).toBe(etag);
  });

  it("ignores If-Match and 404s a row whose object is gone", async () => {
    const owner = await signInIos("apple-sub-att-read-edge");
    const tripId = await createTrip(owner.token);
    const { body } = await upload(owner.token, tripId, form(PNG));
    const id = body.attachment!.id;

    // A failed If-Match must not masquerade as a 304 — it is simply ignored.
    const ifMatch = await app.request(
      `/api/v1/attachments/${id}`,
      { headers: { authorization: `Bearer ${owner.token}`, "if-match": '"stale"' } },
      env,
    );
    expect(ifMatch.status).toBe(200);
    expect(ifMatch.headers.get("content-length")).toBe(String(PNG.byteLength));

    await env.ATTACHMENTS.delete(`trips/${tripId}/${id}`);
    const gone = await app.request(`/api/v1/attachments/${id}`, req("GET", owner.token), env);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({
      error: { code: "attachment_not_found", message: expect.any(String) },
    });
  });

  it("401s anonymous, 403s non-members, 404s unknown ids", async () => {
    const owner = await signInIos("apple-sub-att-read-owner");
    const outsider = await signInIos("apple-sub-att-read-outsider");
    const tripId = await createTrip(owner.token);
    const { body } = await upload(owner.token, tripId, form(PNG));
    const id = body.attachment!.id;

    expect((await app.request(`/api/v1/attachments/${id}`, {}, env)).status).toBe(401);

    const forbidden = await app.request(
      `/api/v1/attachments/${id}`,
      req("GET", outsider.token),
      env,
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      error: { code: "not_a_member", message: expect.any(String) },
    });

    const missing = await app.request(
      `/api/v1/attachments/${crypto.randomUUID()}`,
      req("GET", outsider.token),
      env,
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: "attachment_not_found", message: expect.any(String) },
    });
  });
});

describe("PATCH /api/v1/trips/:tripId/attachments/:id", () => {
  it("sets and clears the itinerary item link", async () => {
    const owner = await signInIos("apple-sub-att-patch");
    const tripId = await createTrip(owner.token);
    const otherTripId = await createTrip(owner.token, "Other");
    const itemId = await createItem(owner.token, tripId);
    const foreignItemId = await createItem(owner.token, otherTripId);
    const { body } = await upload(owner.token, tripId, form(PNG));
    const attachment = body.attachment!;
    const url = `/api/v1/trips/${tripId}/attachments/${attachment.id}`;

    const set = await app.request(url, req("PATCH", owner.token, { itineraryItemId: itemId }), env);
    expect(set.status).toBe(200);
    const linked = ((await set.json()) as { attachment: Attachment }).attachment;
    expect(linked.itineraryItemId).toBe(itemId);
    expect(linked.updatedAt > attachment.updatedAt).toBe(true);

    const foreign = await app.request(
      url,
      req("PATCH", owner.token, { itineraryItemId: foreignItemId }),
      env,
    );
    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toEqual({
      error: { code: "unknown_item", message: expect.any(String) },
    });

    const bad = await app.request(url, req("PATCH", owner.token, { itineraryItemId: 7 }), env);
    expect(bad.status).toBe(400);

    const cleared = await app.request(
      url,
      req("PATCH", owner.token, { itineraryItemId: null }),
      env,
    );
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { attachment: Attachment }).attachment.itineraryItemId).toBe(
      null,
    );
  });

  it("treats an absent field as unchanged, like every other PATCH", async () => {
    const owner = await signInIos("apple-sub-att-patch-noop");
    const tripId = await createTrip(owner.token);
    const itemId = await createItem(owner.token, tripId);
    const { body } = await upload(
      owner.token,
      tripId,
      form(PNG, "t.png", "image/png", { itineraryItemId: itemId }),
    );
    const url = `/api/v1/trips/${tripId}/attachments/${body.attachment!.id}`;

    const noop = await app.request(url, req("PATCH", owner.token, {}), env);
    expect(noop.status).toBe(200);
    expect(((await noop.json()) as { attachment: Attachment }).attachment.itineraryItemId).toBe(
      itemId,
    );
  });

  it("404s cross-trip ids and 403s non-members", async () => {
    const owner = await signInIos("apple-sub-att-patch-404");
    const outsider = await signInIos("apple-sub-att-patch-outsider");
    const tripId = await createTrip(owner.token);
    const otherTripId = await createTrip(owner.token, "Other");
    const { body } = await upload(owner.token, otherTripId, form(PNG));
    const id = body.attachment!.id;

    const crossTrip = await app.request(
      `/api/v1/trips/${tripId}/attachments/${id}`,
      req("PATCH", owner.token, { itineraryItemId: null }),
      env,
    );
    expect(crossTrip.status).toBe(404);
    expect(await crossTrip.json()).toEqual({
      error: { code: "attachment_not_found", message: expect.any(String) },
    });

    const forbidden = await app.request(
      `/api/v1/trips/${otherTripId}/attachments/${id}`,
      req("PATCH", outsider.token, { itineraryItemId: null }),
      env,
    );
    expect(forbidden.status).toBe(403);
  });
});

describe("item and trip deletion", () => {
  it("deleting an item unlinks its attachments and keeps them", async () => {
    const owner = await signInIos("apple-sub-att-item-delete");
    const tripId = await createTrip(owner.token);
    const itemId = await createItem(owner.token, tripId);
    const { body } = await upload(
      owner.token,
      tripId,
      form(PNG, "t.png", "image/png", { itineraryItemId: itemId }),
    );
    const attachment = body.attachment!;

    const del = await app.request(
      `/api/v1/trips/${tripId}/items/${itemId}`,
      req("DELETE", owner.token),
      env,
    );
    expect(del.status).toBe(200);

    const doc = await app.request(`/api/v1/trips/${tripId}`, req("GET", owner.token), env);
    const { attachments } = (await doc.json()) as { attachments: Attachment[] };
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ id: attachment.id, itineraryItemId: null });
    expect(attachments[0]!.updatedAt > attachment.updatedAt).toBe(true);
    expect(await objectKeys(tripId)).toHaveLength(1);
  });

  it("deleting a trip removes every object from R2", async () => {
    const owner = await signInIos("apple-sub-att-trip-delete");
    const tripId = await createTrip(owner.token);
    await upload(owner.token, tripId, form(PNG));
    await upload(owner.token, tripId, form(JPEG, "b.jpg", "image/jpeg"));
    expect(await objectKeys(tripId)).toHaveLength(2);

    const del = await app.request(`/api/v1/trips/${tripId}`, req("DELETE", owner.token), env);
    expect(del.status).toBe(200);
    expect(await objectKeys(tripId)).toHaveLength(0);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM attachments WHERE trip_id = ?")
      .bind(tripId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it("a storage failure on trip delete leaves the trip intact", async () => {
    const owner = await signInIos("apple-sub-att-trip-503");
    const tripId = await createTrip(owner.token);
    await upload(owner.token, tripId, form(PNG));
    const spy = vi.spyOn(env.ATTACHMENTS, "delete").mockRejectedValueOnce(new Error("r2 down"));
    try {
      const del = await app.request(`/api/v1/trips/${tripId}`, req("DELETE", owner.token), env);
      expect(del.status).toBe(503);
      expect(await del.json()).toEqual({
        error: { code: "storage_unavailable", message: expect.any(String) },
      });
    } finally {
      spy.mockRestore();
    }
    const doc = await app.request(`/api/v1/trips/${tripId}`, req("GET", owner.token), env);
    expect(doc.status).toBe(200);
    expect(await objectKeys(tripId)).toHaveLength(1);
  });
});

describe("DELETE /api/v1/trips/:tripId/attachments/:id", () => {
  it("a storage failure leaves the row and object intact for a retry", async () => {
    const owner = await signInIos("apple-sub-att-delete-503");
    const tripId = await createTrip(owner.token);
    const { body } = await upload(owner.token, tripId, form(PNG));
    const id = body.attachment!.id;
    const url = `/api/v1/trips/${tripId}/attachments/${id}`;
    const spy = vi.spyOn(env.ATTACHMENTS, "delete").mockRejectedValueOnce(new Error("r2 down"));
    try {
      const failed = await app.request(url, req("DELETE", owner.token), env);
      expect(failed.status).toBe(503);
      expect(await failed.json()).toEqual({
        error: { code: "storage_unavailable", message: expect.any(String) },
      });
    } finally {
      spy.mockRestore();
    }
    expect(await objectKeys(tripId)).toHaveLength(1);
    const retry = await app.request(url, req("DELETE", owner.token), env);
    expect(retry.status).toBe(200);
    expect(await objectKeys(tripId)).toHaveLength(0);
  });

  it("removes the row and the object", async () => {
    const owner = await signInIos("apple-sub-att-delete");
    const tripId = await createTrip(owner.token);
    const { body } = await upload(owner.token, tripId, form(PNG));
    const id = body.attachment!.id;
    const url = `/api/v1/trips/${tripId}/attachments/${id}`;

    const del = await app.request(url, req("DELETE", owner.token), env);
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });
    expect(await objectKeys(tripId)).toHaveLength(0);

    const gone = await app.request(`/api/v1/attachments/${id}`, req("GET", owner.token), env);
    expect(gone.status).toBe(404);

    const again = await app.request(url, req("DELETE", owner.token), env);
    expect(again.status).toBe(404);
  });

  it("403s non-members and 404s cross-trip ids", async () => {
    const owner = await signInIos("apple-sub-att-delete-owner");
    const outsider = await signInIos("apple-sub-att-delete-outsider");
    const tripId = await createTrip(owner.token);
    const otherTripId = await createTrip(owner.token, "Other");
    const { body } = await upload(owner.token, tripId, form(PNG));
    const id = body.attachment!.id;

    const forbidden = await app.request(
      `/api/v1/trips/${tripId}/attachments/${id}`,
      req("DELETE", outsider.token),
      env,
    );
    expect(forbidden.status).toBe(403);

    const crossTrip = await app.request(
      `/api/v1/trips/${otherTripId}/attachments/${id}`,
      req("DELETE", owner.token),
      env,
    );
    expect(crossTrip.status).toBe(404);
    expect(await objectKeys(tripId)).toHaveLength(1);
  });
});

describe("GET /api/v1/trips/:id", () => {
  it("includes attachments in the trip doc", async () => {
    const owner = await signInIos("apple-sub-att-doc");
    const tripId = await createTrip(owner.token);
    const { body } = await upload(owner.token, tripId, form(PDF, "conf.pdf", "application/pdf"));

    const doc = await app.request(`/api/v1/trips/${tripId}`, req("GET", owner.token), env);
    expect(doc.status).toBe(200);
    const { attachments } = (await doc.json()) as { attachments: Attachment[] };
    expect(attachments).toEqual([body.attachment]);
  });
});
