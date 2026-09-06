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
`POST /auth/sign-out` revokes; `GET /me` returns the signed-in user. A bad
token gets 401; a JWKS/upstream failure gets 503 (`apple_unavailable`) so
clients don't treat an Apple outage as an invalid credential. Trip
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

## Trip planning API

The core planning surface (#8): trips, cities, itinerary items, to-dos. All
REST JSON under `/api/v1`. Every route requires a session; every trip-scoped
route (anything mentioning a `:tripId`) also requires trip membership — the
guards answer `401` (not signed in), `403` (`not_a_member`), or `404`
(`trip_not_found`) before any handler runs. Non-2xx responses are always
`{ "error": { "code", "message" } }`.

PATCH is partial update everywhere: an absent field is unchanged, an explicit
`null` clears a nullable field. Responses are camelCase; every row carries
`createdAt`/`updatedAt` (ISO 8601 UTC).

### Trips

| Endpoint            | Behavior                                                                                                                       |
| :------------------ | :----------------------------------------------------------------------------------------------------------------------------- |
| `POST /trips`       | `{ name }` → 201. Creates the trip and the creator's membership in one transaction                                             |
| `GET /trips`        | The caller's trips (summary shape)                                                                                             |
| `GET /trips/:id`    | The full trip doc in one response: `trip`, `members` (public user + presence window), `cities` (by position), `items`, `todos` |
| `PATCH /trips/:id`  | `{ name? }`                                                                                                                    |
| `DELETE /trips/:id` | Creator only (`403 not_trip_creator` for other members); children cascade                                                      |

### Cities

| Endpoint                           | Behavior                                                                                          |
| :--------------------------------- | :------------------------------------------------------------------------------------------------ |
| `POST /trips/:id/cities`           | `{ name, timezone, arrivalDate?, departureDate? }` → 201, appended at the end                     |
| `PATCH /trips/:tripId/cities/:id`  | Name/timezone/dates — never position                                                              |
| `PUT /trips/:id/cities/order`      | `{ cityIds }`, an exact permutation of the trip's city ids; positions rewritten 0..n‑1 atomically |
| `DELETE /trips/:tripId/cities/:id` | The city's items survive with `cityId` nulled (and `updatedAt` bumped) in the same transaction    |

`timezone` is a validated IANA zone and the default zone for times on items
in that city. Dates are `YYYY-MM-DD` and nullable — an undated city is a real
planning state.

### Itinerary items

| Endpoint                          | Behavior                                  |
| :-------------------------------- | :---------------------------------------- |
| `POST /trips/:id/items`           | Create (shape below) → 201                |
| `PATCH /trips/:tripId/items/:id`  | Partial update, same validation as create |
| `DELETE /trips/:tripId/items/:id` | 404 `item_not_found` for cross-trip ids   |

Shape: `{ kind, title, cityId?, notes?, address?, confirmationNumber?,
links?, startLocal?, startTz?, endLocal?, endTz?, departureAirport?,
arrivalAirport?, position? }` with `kind ∈ flight | stay | reservation |
activity`. Airports are flight-only. `links` is an array of URL strings.

The time model (see foundation.md): `startLocal`/`endLocal` are local
wall-clock ISO 8601 (`YYYY-MM-DDTHH:MM`, no offset) and are the source of
truth — they are stored and returned exactly as given, never shifted. Each
end's zone resolves independently (flights depart and arrive in different
zones): explicit `startTz`/`endTz` wins, else the item's city's `timezone`,
else the request is a 400. `startUtc`/`endUtc` are derived on every write
(`src/time.ts`) and exist only for ordering. Everything time/city/position is
nullable — untimed, undated, cityless items are real planning states. A stay
is one row (check-in = start, checkout = end); clients project it into two
schedule entries.

### To-dos

| Endpoint                          | Behavior                                                     |
| :-------------------------------- | :----------------------------------------------------------- |
| `POST /trips/:id/todos`           | `{ title, done?, dueLocal?, dueTz?, assigneeUserId? }` → 201 |
| `PATCH /trips/:tripId/todos/:id`  | Partial update; toggling is `{ done: true \| false }`        |
| `DELETE /trips/:tripId/todos/:id` | 404 `todo_not_found` for cross-trip ids                      |

`assigneeUserId` must be a member of the trip (`400 not_a_trip_member`). A
due time needs its zone (`dueTz`) — to-dos have no city to default from, and
no derived UTC (they are not ordered on a timeline).

There is deliberately no trip-lifecycle validation anywhere above: every
mutation behaves identically before, during, and after a trip
(foundation.md, "Trip lifecycle" — statelessness here is load-bearing).

## Conventions

- Real API endpoints live under `/api/v1` (REST JSON — see foundation.md);
  `/api/health` is the one exception.
- `worker-configuration.d.ts` is generated — never hand-edit; rerun
  `npm run cf-typegen` after config changes. It's excluded from lint/format.
- Compatibility date is capped by the workerd bundled with
  `@cloudflare/vitest-pool-workers` — if you bump it and tests fail to start
  with "newest date supported by this server binary", lower it or update the
  pool package.
