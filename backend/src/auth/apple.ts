import { verifyWithJwks } from "hono/jwt";
import * as jwtErrors from "hono/utils/jwt/types";

export const APPLE_PROVIDER = "apple";

// The issuer is a constant of Apple's protocol; the JWKS URL and accepted
// audiences come from env so tests can substitute their own keys, and because
// Apple uses different client ids for the native app vs the web Services ID.
const APPLE_ISSUER = "https://appleid.apple.com";

// hono's typed JWT errors all mean "this token failed validation". Anything
// else thrown by verifyWithJwks — JWKS fetch failure, malformed JWKS body —
// is an upstream problem that must not be blamed on the caller's token.
// The cast is safe: the module's only non-class export is an enum object,
// which the typeof filter drops.
const JWT_ERROR_CLASSES = Object.values(jwtErrors).filter(
  (value) => typeof value === "function",
) as (new (...args: never[]) => Error)[];

export type AppleClaims = { sub: string; email: string | undefined };

export type AppleVerification =
  | { ok: true; claims: AppleClaims }
  | { ok: false; failure: "invalid_token" | "jwks_unavailable"; reason: string };

export async function verifyAppleIdentityToken(
  identityToken: string,
  env: Env,
): Promise<AppleVerification> {
  const audiences = env.APPLE_CLIENT_IDS.split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  let payload;
  try {
    payload = await verifyWithJwks(
      identityToken,
      {
        jwks_uri: env.APPLE_JWKS_URL,
        allowedAlgorithms: ["RS256"],
        verification: { iss: APPLE_ISSUER, aud: audiences },
      },
      // Cache the JWKS at the edge: verifyWithJwks fetches it before checking
      // the signature, so without a cache any unauthenticated caller could
      // drive one origin hit per request. Apple rotates keys rarely.
      { cf: { cacheTtl: 3600, cacheEverything: true } },
    );
  } catch (error) {
    return {
      ok: false,
      failure: JWT_ERROR_CLASSES.some((cls) => error instanceof cls)
        ? "invalid_token"
        : "jwks_unavailable",
      reason:
        error instanceof Error ? `${error.constructor.name}: ${error.message}` : "unknown_error",
    };
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    return { ok: false, failure: "invalid_token", reason: "missing_sub" };
  }
  return {
    ok: true,
    claims: {
      sub: payload.sub,
      email: typeof payload.email === "string" ? payload.email : undefined,
    },
  };
}
