import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { activateAppleJwksMock, makeIdentityToken, signInIos } from "./apple";

beforeAll(async () => {
  await activateAppleJwksMock();
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

  it("ios client gets a bearer token that authenticates /me", async () => {
    const { token, user } = await signInIos("apple-sub-ios");
    expect(token).toEqual(expect.any(String));

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
