import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { activateAppleJwksMock, makeIdentityToken, signInIos } from "./apple";

beforeAll(async () => {
  await activateAppleJwksMock();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function signInRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

const errorShape = {
  error: { code: expect.any(String), message: expect.any(String) },
};

describe("POST /api/v1/auth/sign-in", () => {
  it("signs in a new user and reuses the row (and name) on repeat sign-ins", async () => {
    const first = await signInIos("apple-sub-repeat", {
      email: "izzy@example.com",
      displayName: "Izzy B",
    });
    expect(first.user).toEqual({
      id: expect.any(String),
      email: "izzy@example.com",
      displayName: "Izzy B",
    });

    // Later sign-ins must reuse the user and never overwrite the name.
    const second = await signInIos("apple-sub-repeat", {
      email: "izzy@example.com",
      displayName: "Someone Else",
    });
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.displayName).toBe("Izzy B");

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE auth_subject = ?")
      .bind("apple-sub-repeat")
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("falls back to the email local-part, then 'Trip member', for display_name", async () => {
    const fromEmail = await signInIos("apple-sub-email-name", {
      email: "wanderer@example.com",
    });
    expect(fromEmail.user.displayName).toBe("wanderer");

    const bare = await signInIos("apple-sub-no-name");
    expect(bare.user.displayName).toBe("Trip member");
  });

  it("web client gets an HttpOnly session cookie that authenticates /me", async () => {
    const res = await app.request(
      "/api/v1/auth/sign-in",
      signInRequest({
        identityToken: await makeIdentityToken({ sub: "apple-sub-web" }),
        client: "web",
      }),
      env,
    );
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie");
    expect(cookie).toContain("effoff_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    // The token must not also leak through the JSON body on web.
    expect(await res.json()).not.toHaveProperty("token");

    const me = await app.request(
      "/api/v1/me",
      { headers: { cookie: (cookie ?? "").split(";")[0] ?? "" } },
      env,
    );
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: { displayName: string } };
    expect(body.user.displayName).toBe("Trip member");
  });

  it("ios client gets a bearer token (with its expiry) that authenticates /me", async () => {
    const res = await app.request(
      "/api/v1/auth/sign-in",
      signInRequest({
        identityToken: await makeIdentityToken({ sub: "apple-sub-ios" }),
        client: "ios",
      }),
      env,
    );
    expect(res.status).toBe(200);
    const { token, user, expiresAt } = (await res.json()) as {
      token: string;
      user: { id: string };
      expiresAt: string;
    };
    expect(token).toEqual(expect.any(String));
    // iOS must be told when the session dies so it can re-auth pre-emptively.
    const ttlMs = Date.parse(expiresAt) - Date.now();
    expect(ttlMs).toBeGreaterThan(89 * 24 * 3600 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(90 * 24 * 3600 * 1000);

    const me = await app.request(
      "/api/v1/me",
      { headers: { authorization: `Bearer ${token}` } },
      env,
    );
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: { id: string } };
    expect(body.user.id).toBe(user.id);
  });

  it.each([
    ["a bad signature", () => makeIdentityToken({ sub: "s" }, { wrongKey: true })],
    ["a wrong issuer", () => makeIdentityToken({ iss: "https://evil.example" })],
    ["a wrong audience", () => makeIdentityToken({ aud: "com.other.app" })],
    ["an expired token", () => makeIdentityToken({ exp: Math.floor(Date.now() / 1000) - 60 })],
  ])("rejects %s with 401 and the error shape", async (_label, make) => {
    const res = await app.request(
      "/api/v1/auth/sign-in",
      signInRequest({ identityToken: await make(), client: "ios" }),
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(errorShape);
  });

  it("accepts a token audienced for any configured client id", async () => {
    // Second entry of APPLE_CLIENT_IDS — exercises the list parsing.
    const res = await app.request(
      "/api/v1/auth/sign-in",
      signInRequest({
        identityToken: await makeIdentityToken({
          sub: "apple-sub-web-aud",
          aud: "com.effoff.test-web",
        }),
        client: "ios",
      }),
      env,
    );
    expect(res.status).toBe(200);
  });

  it("stores only a hash of the session token", async () => {
    const { token, user } = await signInIos("apple-sub-hash");
    const row = await env.DB.prepare("SELECT token_hash FROM sessions WHERE user_id = ?")
      .bind(user.id)
      .first<{ token_hash: string }>();
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.token_hash).not.toBe(token);
    expect(row?.token_hash).not.toContain(token);
  });

  it("503s (not 401) when the JWKS cannot be fetched", async () => {
    const identityToken = await makeIdentityToken({ sub: "apple-sub-outage" });
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("network down")));
    try {
      const res = await app.request(
        "/api/v1/auth/sign-in",
        signInRequest({ identityToken, client: "ios" }),
        env,
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: { code: "apple_unavailable", message: expect.any(String) },
      });
    } finally {
      await activateAppleJwksMock();
    }
  });

  it("rejects a malformed body with 400", async () => {
    const res = await app.request(
      "/api/v1/auth/sign-in",
      signInRequest({ identityToken: "x", client: "toaster" }),
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(errorShape);
  });
});

describe("GET /api/v1/me", () => {
  it("401s with no session and with a garbage session", async () => {
    const missing = await app.request("/api/v1/me", {}, env);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual(errorShape);

    const garbage = await app.request(
      "/api/v1/me",
      { headers: { authorization: "Bearer not-a-real-token" } },
      env,
    );
    expect(garbage.status).toBe(401);
    expect(await garbage.json()).toEqual(errorShape);
  });

  it("401s an expired session and deletes its row", async () => {
    const { token, user } = await signInIos("apple-sub-expired");
    // Sessions from other tests share the DB — expire only this user's.
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE user_id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), user.id)
      .run();

    const me = await app.request(
      "/api/v1/me",
      { headers: { authorization: `Bearer ${token}` } },
      env,
    );
    expect(me.status).toBe(401);

    const remaining = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?")
      .bind(user.id)
      .first<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });
});

describe("POST /api/v1/auth/sign-out", () => {
  it("deletes the session so the token stops working", async () => {
    const { token } = await signInIos("apple-sub-signout");
    const headers = { authorization: `Bearer ${token}` };

    const out = await app.request("/api/v1/auth/sign-out", { method: "POST", headers }, env);
    expect(out.status).toBe(200);

    const me = await app.request("/api/v1/me", { headers }, env);
    expect(me.status).toBe(401);
  });

  it("clears the cookie for web sessions", async () => {
    const res = await app.request(
      "/api/v1/auth/sign-in",
      signInRequest({
        identityToken: await makeIdentityToken({ sub: "apple-sub-web-out" }),
        client: "web",
      }),
      env,
    );
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const out = await app.request(
      "/api/v1/auth/sign-out",
      { method: "POST", headers: { cookie } },
      env,
    );
    expect(out.status).toBe(200);
    // deleteCookie serializes an immediate expiry.
    expect(out.headers.get("set-cookie")).toContain("effoff_session=;");
  });
});
