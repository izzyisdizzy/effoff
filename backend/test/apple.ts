// Test-only Sign in with Apple stand-in: a WebCrypto RSA keypair signs
// identity tokens, and a stubbed global fetch serves the matching JWKS at
// the URL that vitest.config.ts points APPLE_JWKS_URL at (the Worker under
// test runs in this same isolate, so its outbound JWKS fetch hits the stub).
// No Apple credentials anywhere.
import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { vi } from "vitest";
import app from "../src/index";

export const APPLE_ISSUER = "https://appleid.apple.com";
// First entry of APPLE_CLIENT_IDS in vitest.config.ts.
export const TEST_AUDIENCE = "com.effoff.test-ios";
const KID = "test-key-1";

type TestKeys = {
  privateJwk: JsonWebKey & { kid: string };
  jwks: { keys: (JsonWebKey & { kid: string })[] };
};

async function generateKeys(): Promise<TestKeys> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const privateJwk = {
    ...((await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey),
    kid: KID,
  };
  const publicJwk = {
    ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey),
    kid: KID,
  };
  return { privateJwk, jwks: { keys: [publicJwk] } };
}

let keysPromise: Promise<TestKeys> | undefined;
function testKeys(): Promise<TestKeys> {
  keysPromise ??= generateKeys();
  return keysPromise;
}

// A second keypair published under the SAME kid, so tokens it signs match a
// JWKS key but fail signature verification.
let wrongKeysPromise: Promise<TestKeys> | undefined;
function wrongKeys(): Promise<TestKeys> {
  wrongKeysPromise ??= generateKeys();
  return wrongKeysPromise;
}

// Call from beforeAll in each test file that exercises sign-in. Any other
// outbound fetch is an error: these tests must never touch the network.
export async function activateAppleJwksMock(): Promise<void> {
  const { jwks } = await testKeys();
  vi.stubGlobal("fetch", (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === env.APPLE_JWKS_URL) {
      return Promise.resolve(Response.json(jwks));
    }
    return Promise.reject(new Error(`unexpected outbound fetch in tests: ${url}`));
  });
}

export async function makeIdentityToken(
  overrides: Record<string, unknown> = {},
  options: { wrongKey?: boolean } = {},
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    iss: APPLE_ISSUER,
    aud: TEST_AUDIENCE,
    sub: "apple-sub-default",
    iat: nowSeconds,
    exp: nowSeconds + 3600,
    ...overrides,
  };
  const { privateJwk } = options.wrongKey ? await wrongKeys() : await testKeys();
  return sign(payload, privateJwk, "RS256");
}

type PublicUser = { id: string; email: string | null; displayName: string };

export async function signInIos(
  sub: string,
  extras: { email?: string; displayName?: string } = {},
): Promise<{ token: string; user: PublicUser }> {
  const identityToken = await makeIdentityToken({
    sub,
    ...(extras.email !== undefined ? { email: extras.email } : {}),
  });
  const res = await app.request(
    "/api/v1/auth/sign-in",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        identityToken,
        client: "ios",
        ...(extras.displayName !== undefined ? { displayName: extras.displayName } : {}),
      }),
    },
    env,
  );
  if (res.status !== 200) {
    throw new Error(`test sign-in failed with ${res.status}`);
  }
  return (await res.json()) as { token: string; user: PublicUser };
}

// Creates a trip through the real API (#8) as the given signed-in user.
export async function createTrip(token: string, name = "Test trip"): Promise<string> {
  const res = await app.request(
    "/api/v1/trips",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ name }),
    },
    env,
  );
  if (res.status !== 201) {
    throw new Error(`test trip creation failed with ${res.status}`);
  }
  const body = (await res.json()) as { trip: { id: string } };
  return body.trip.id;
}
