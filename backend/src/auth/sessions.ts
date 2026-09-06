import type { SessionRow, UserRow } from "../types";

export const SESSION_COOKIE = "effoff_session";
export const SESSION_TTL_SECONDS = 90 * 24 * 60 * 60;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateToken(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

// Only the SHA-256 of a session token is ever stored: a leaked D1 snapshot
// must not be replayable as live sessions.
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createSession(
  db: D1Database,
  userId: string,
  client: "web" | "ios",
): Promise<{ token: string; expiresAt: string }> {
  const token = generateToken(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
  await db
    .prepare(
      "INSERT INTO sessions (token_hash, user_id, client, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(await sha256Hex(token), userId, client, now.toISOString(), expiresAt)
    .run();
  return { token, expiresAt };
}

// Resolves a raw client token to its session + user, or null if the token is
// unknown or expired. Expired rows are deleted on sight (the only cleanup
// v1 has; there is no background sweep).
export async function getSessionWithUser(
  db: D1Database,
  token: string,
): Promise<{ session: SessionRow; user: UserRow } | null> {
  const hash = await sha256Hex(token);
  const session = await db
    .prepare("SELECT * FROM sessions WHERE token_hash = ?")
    .bind(hash)
    .first<SessionRow>();
  if (session === null) {
    return null;
  }
  if (session.expires_at <= new Date().toISOString()) {
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(hash).run();
    return null;
  }
  const user = await db
    .prepare("SELECT * FROM users WHERE id = ?")
    .bind(session.user_id)
    .first<UserRow>();
  if (user === null) {
    return null;
  }
  return { session, user };
}

export async function deleteSession(db: D1Database, tokenHash: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
}
