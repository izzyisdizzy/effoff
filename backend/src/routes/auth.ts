import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { apiError } from "../api-error";
import { APPLE_PROVIDER, verifyAppleIdentityToken } from "../auth/apple";
import { requireSession } from "../auth/middleware";
import {
  createSession,
  deleteSession,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "../auth/sessions";
import { publicUser, type AppEnv, type UserRow } from "../types";

const auth = new Hono<AppEnv>();

// Apple only supplies the user's name (and reliably the email) client-side on
// the first authorization, so the client passes displayName along; after the
// first sign-in the stored name is never overwritten.
async function upsertUser(
  db: D1Database,
  subject: string,
  email: string | undefined,
  displayName: string | undefined,
): Promise<UserRow> {
  const select = db
    .prepare("SELECT * FROM users WHERE auth_provider = ? AND auth_subject = ?")
    .bind(APPLE_PROVIDER, subject);
  const existing = await select.first<UserRow>();
  if (existing !== null) {
    return existing;
  }
  const now = new Date().toISOString();
  const user: UserRow = {
    id: crypto.randomUUID(),
    auth_provider: APPLE_PROVIDER,
    auth_subject: subject,
    email: email ?? null,
    display_name: displayName?.trim() || email?.split("@")[0] || "Trip member",
    created_at: now,
    updated_at: now,
  };
  try {
    await db
      .prepare(
        "INSERT INTO users (id, auth_provider, auth_subject, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        user.id,
        user.auth_provider,
        user.auth_subject,
        user.email,
        user.display_name,
        user.created_at,
        user.updated_at,
      )
      .run();
  } catch (error) {
    // Two first sign-ins can race; the UNIQUE (auth_provider, auth_subject)
    // constraint makes one insert lose — that request uses the winner's row.
    const raced = await select.first<UserRow>();
    if (raced === null) {
      throw error;
    }
    return raced;
  }
  return user;
}

auth.post("/auth/sign-in", async (c) => {
  let body: { identityToken?: unknown; client?: unknown; displayName?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, 400, "invalid_request", "Request body must be JSON.");
  }
  const { identityToken, client, displayName } = body;
  if (
    typeof identityToken !== "string" ||
    identityToken.length === 0 ||
    (client !== "web" && client !== "ios") ||
    (displayName !== undefined && typeof displayName !== "string")
  ) {
    return apiError(
      c,
      400,
      "invalid_request",
      'Expected { identityToken, client: "web" | "ios", displayName? }.',
    );
  }
  const verification = await verifyAppleIdentityToken(identityToken, c.env);
  if (!verification.ok) {
    return apiError(
      c,
      401,
      "invalid_identity_token",
      "Apple identity token could not be verified.",
    );
  }
  const user = await upsertUser(
    c.env.DB,
    verification.claims.sub,
    verification.claims.email,
    displayName,
  );
  const { token } = await createSession(c.env.DB, user.id, client);
  if (client === "web") {
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });
    return c.json({ user: publicUser(user) });
  }
  return c.json({ user: publicUser(user), token });
});

auth.post("/auth/sign-out", requireSession, async (c) => {
  const session = c.get("session");
  await deleteSession(c.env.DB, session.token_hash);
  if (session.client === "web") {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
  }
  return c.json({ ok: true });
});

auth.get("/me", requireSession, (c) => {
  return c.json({ user: publicUser(c.get("user")) });
});

export default auth;
