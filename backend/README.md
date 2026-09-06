# effoff backend

Cloudflare Worker (TypeScript, [Hono](https://hono.dev)) with a D1 database.
This is the API everything else (web SPA, iPhone app) talks to; the design
lives in [`../docs/foundation.md`](../docs/foundation.md).

## Layout

```
src/index.ts        Worker entry — Hono app, routes mounted under /api
migrations/         D1 migrations (wrangler d1 migrations)
test/               Vitest suite, runs inside workerd with a real local D1
wrangler.jsonc      Worker + D1 binding config (binding: DB, db: effoff-db)
```

## Commands

All run from `backend/`. Requires Node + npm; `npm install` first.

| Command              | What it does                                                                                    |
| :------------------- | :---------------------------------------------------------------------------------------------- |
| `npm run dev`        | Local dev server on `http://localhost:8787` (local D1, no account needed)                       |
| `npm test`           | Vitest via `@cloudflare/vitest-pool-workers` — tests run in workerd against a fresh migrated D1 |
| `npm run typecheck`  | `tsc --noEmit`                                                                                  |
| `npm run lint`       | oxlint                                                                                          |
| `npm run format`     | oxfmt (in place; `npx oxfmt --check` to verify only)                                            |
| `npm run migrate`    | Apply migrations to the **local** D1 (`--remote` variant below for prod)                        |
| `npm run deploy`     | Deploy the Worker to Cloudflare (needs `wrangler login`)                                        |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` after `wrangler.jsonc` changes                           |

## Migrations

```sh
npx wrangler d1 migrations create effoff-db <name>   # new migration file
npx wrangler d1 migrations apply effoff-db --local   # apply locally
npx wrangler d1 migrations apply effoff-db --remote  # apply to production
```

Tests apply all migrations to a fresh in-memory D1 automatically
(`test/apply-migrations.ts`, wired up in `vitest.config.ts`).

## Health check

`GET /api/health` → `200 {"ok":true,"db":true,"schemaVersion":"<version>"}` —
`schemaVersion` echoes the `meta` table's current `schema_version` row (seeded
by the migrations; the migration files are the source of truth for its value),
and `db` reflects that real query, so the endpoint proves the Worker↔D1
round-trip, not just that the Worker is up.

## Auth

Sign in with Apple only (see foundation.md, decided). `POST /api/v1/auth/sign-in`
takes `{ identityToken, client: "web" | "ios", displayName? }`: the Worker
verifies the Apple identity token (RS256 against Apple's JWKS), upserts the
user by `(auth_provider, auth_subject)`, and issues an opaque 90-day session —
an HttpOnly `effoff_session` cookie for `web`, a bearer token in the JSON body
for `ios`. Only the SHA-256 of the token is stored (`sessions` table).
`POST /auth/sign-out` revokes; `GET /me` returns the signed-in user. Trip
membership is granted via invite links: any member mints one
(`POST /trips/:id/invites`, 30-day expiry) and a signed-in user joins with
`POST /invites/:token/accept`. All trip-scoped routes sit behind the
`requireSession` + `requireTripMember` middleware (`src/auth/middleware.ts`).

Env vars (in `wrangler.jsonc`, overridden for tests in `vitest.config.ts`):

| Var                | Value                                                                                                                          |
| :----------------- | :----------------------------------------------------------------------------------------------------------------------------- |
| `APPLE_JWKS_URL`   | Apple's JWKS endpoint (`https://appleid.apple.com/auth/keys` in production)                                                    |
| `APPLE_CLIENT_IDS` | Comma-separated accepted token audiences: iOS bundle id + web Services ID (placeholders until the clients register with Apple) |

Tests never contact Apple: `test/apple.ts` signs identity tokens with a
generated RSA key and serves the matching JWKS from a stubbed `fetch`.

## Conventions

- Real API endpoints live under `/api/v1` (REST JSON — see foundation.md);
  `/api/health` is the one exception.
- `worker-configuration.d.ts` is generated — never hand-edit; rerun
  `npm run cf-typegen` after config changes. It's excluded from lint/format.
- Compatibility date is capped by the workerd bundled with
  `@cloudflare/vitest-pool-workers` — if you bump it and tests fail to start
  with "newest date supported by this server binary", lower it or update the
  pool package.
