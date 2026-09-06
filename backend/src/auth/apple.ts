import { verifyWithJwks } from "hono/jwt";

export const APPLE_PROVIDER = "apple";

// The issuer is a constant of Apple's protocol; the JWKS URL and accepted
// audiences come from env so tests can substitute their own keys, and because
// Apple uses different client ids for the native app vs the web Services ID.
const APPLE_ISSUER = "https://appleid.apple.com";

export type AppleClaims = { sub: string; email: string | undefined };

export type AppleVerification = { ok: true; claims: AppleClaims } | { ok: false; reason: string };

export async function verifyAppleIdentityToken(
  identityToken: string,
  env: Env,
): Promise<AppleVerification> {
  const audiences = env.APPLE_CLIENT_IDS.split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  let payload;
  try {
    payload = await verifyWithJwks(identityToken, {
      jwks_uri: env.APPLE_JWKS_URL,
      allowedAlgorithms: ["RS256"],
      verification: { iss: APPLE_ISSUER, aud: audiences },
    });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.name : "verification_failed",
    };
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    return { ok: false, reason: "missing_sub" };
  }
  return {
    ok: true,
    claims: {
      sub: payload.sub,
      email: typeof payload.email === "string" ? payload.email : undefined,
    },
  };
}
