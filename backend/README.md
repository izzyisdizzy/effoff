# effoff backend

Cloudflare Worker (TypeScript, [Hono](https://hono.dev)) with a D1 database.
This is the API everything else (web SPA, iPhone app) talks to; the design
lives in [`../docs/foundation.md`](../docs/foundation.md).

## Layout

```
src/index.ts        Worker entry — Hono app, routes mounted under /api
migrations/         D1 migrations (wrangler d1 migrations)
test/               Vitest suite, runs inside workerd with a real local D1
wrangler.jsonc      Worker + D1 (binding: DB, db: effoff-db) + R2 (binding: ATTACHMENTS,
                    bucket: effoff-attachments) config
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
| `npm run deploy`     | Deploy the Worker to Cloudflare (needs `wrangler login`; see Deploying below)                   |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` after `wrangler.jsonc` changes                           |

## Migrations

```sh
npx wrangler d1 migrations create effoff-db <name>   # new migration file
npx wrangler d1 migrations apply effoff-db --local   # apply locally
npx wrangler d1 migrations apply effoff-db --remote  # apply to production
```

Tests apply all migrations to a fresh in-memory D1 automatically
(`test/apply-migrations.ts`, wired up in `vitest.config.ts`).

## Deploying

The R2 bucket is not created by `wrangler deploy` — it must exist (and R2
must be enabled on the account) before the first deploy that carries the
attachments binding:

```sh
npx wrangler r2 bucket create effoff-attachments   # once, per account
npx wrangler d1 migrations apply effoff-db --remote
npm run deploy
```

Local dev and tests need neither: wrangler and the Vitest pool serve the D1
and R2 bindings locally from `wrangler.jsonc`.

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
route (any route under `/trips/:id`) also requires trip membership — the
guards answer `401` (not signed in), `403` (`not_a_member`), or `404`
(`trip_not_found`) before any handler runs. Non-2xx responses are always
`{ "error": { "code", "message" } }`; a request body that isn't a JSON
object, or a field that fails validation, is a `400 invalid_request`.

Successful responses wrap the resource in a named envelope — `{ trip }`,
`{ trips }`, `{ city }`, `{ cities }`, `{ item }`, `{ todo }`, `{ place }` (plus
the trip doc's six keys below) — and every DELETE returns `200 { "ok": true }`.
PATCH is partial update everywhere: an absent field is unchanged, an explicit
`null` clears a nullable field. Responses are camelCase; every row carries
`createdAt`/`updatedAt` (ISO 8601 UTC). Free-text fields are length-capped
(`src/validate.ts`); names/titles max 300 chars.

### Trips

| Endpoint            | Behavior                                                                                                                                                                                             |
| :------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /trips`       | `{ name }` → 201. Creates the trip and the creator's membership in one transaction                                                                                                                   |
| `GET /trips`        | The caller's trips (summary shape)                                                                                                                                                                   |
| `GET /trips/:id`    | The full trip doc in one response: `trip`, `members` (public user + presence window), `cities` (by position), `items`, `todos`, `attachments` (metadata), `places` (tags and links nested per place) |
| `PATCH /trips/:id`  | `{ name? }`                                                                                                                                                                                          |
| `DELETE /trips/:id` | Creator only (`403 not_trip_creator` for other members); the trip's R2 objects are removed first (`503 storage_unavailable` leaves the trip intact), then children cascade                           |

### Cities

| Endpoint                           | Behavior                                                                                                                              |
| :--------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /trips/:id/cities`           | `{ name, timezone, arrivalDate?, departureDate? }` → 201, appended at the end                                                         |
| `PATCH /trips/:tripId/cities/:id`  | Name/timezone/dates — never position                                                                                                  |
| `PUT /trips/:id/cities/order`      | `{ cityIds }`, an exact permutation of the trip's city ids; positions rewritten 0..n‑1 atomically; returns the reordered `{ cities }` |
| `DELETE /trips/:tripId/cities/:id` | The city's items survive with `cityId` nulled (and `updatedAt` bumped) in the same transaction                                        |

Unknown or cross-trip city ids are `404 city_not_found`. `timezone` is a
validated IANA zone and the default zone for times on items in that city;
**changing it re-derives the UTC instants of items whose zone came from the
city** (an item end whose stored zone equals the city's previous zone follows
the city — explicitly different zones, like a flight's far end, stay put).
Dates are `YYYY-MM-DD` and nullable — an undated city is a real planning
state.

### Itinerary items

| Endpoint                          | Behavior                                  |
| :-------------------------------- | :---------------------------------------- |
| `POST /trips/:id/items`           | Create (shape below) → 201                |
| `PATCH /trips/:tripId/items/:id`  | Partial update, same validation as create |
| `DELETE /trips/:tripId/items/:id` | 404 `item_not_found` for cross-trip ids   |

Shape: `{ kind, title, cityId?, notes?, address?, confirmationNumber?,
links?, startLocal?, startTz?, endLocal?, endTz?, departureAirport?,
arrivalAirport?, position? }` with `kind ∈ flight | stay | reservation |
activity`. Airports are flight-only. `links` is an array of `http`/`https`
URL strings (max 50). A `cityId` that isn't a city of the trip is a
`400 unknown_city`.

The time model (see foundation.md): `startLocal`/`endLocal` are local
wall-clock ISO 8601 (`YYYY-MM-DDTHH:MM`, no offset) and are the source of
truth — they are stored and returned exactly as given, never shifted. Each
end's zone resolves independently (flights depart and arrive in different
zones): explicit `startTz`/`endTz` wins, else the item's city's `timezone`,
else the request is a 400. `startUtc`/`endUtc` are derived on every write
(`src/time.ts`) and exist only for ordering. Moving an item to a different
city re-derives any end whose zone was city-derived (same rule as a city
timezone change). Everything time/city/position is nullable — untimed,
undated, cityless items are real planning states. A stay is one row
(check-in = start, checkout = end); clients project it into two schedule
entries.

### To-dos

| Endpoint                          | Behavior                                                     |
| :-------------------------------- | :----------------------------------------------------------- |
| `POST /trips/:id/todos`           | `{ title, done?, dueLocal?, dueTz?, assigneeUserId? }` → 201 |
| `PATCH /trips/:tripId/todos/:id`  | Partial update; toggling is `{ done: true \| false }`        |
| `DELETE /trips/:tripId/todos/:id` | 404 `todo_not_found` for cross-trip ids                      |

`assigneeUserId` must be a member of the trip (`400 not_a_trip_member`). A
due time needs its zone (`dueTz`) — to-dos have no city to default from, and
no derived UTC (they are not ordered on a timeline).

### Attachments

Ticket / confirmation images and PDFs (#16): bytes in R2 (binding
`ATTACHMENTS`, key `trips/<tripId>/<attachmentId>`), metadata in the
`attachments` table. Every read goes through the Worker's membership check —
there is no public bucket and no signed URL.

| Endpoint                                | Behavior                                                                                                                                                                       |
| :-------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /trips/:id/attachments`           | `multipart/form-data` with a `file` part and an optional `itineraryItemId` text field → `201 { attachment }`; `503 storage_unavailable` if R2 rejects the write                |
| `GET /attachments/:id`                  | Streams the bytes (`Content-Type` from the stored sniffed type, `ETag`, `Cache-Control: private, max-age=3600`, `nosniff`, inline disposition); `If-None-Match` → 304          |
| `PATCH /trips/:tripId/attachments/:id`  | `{ itineraryItemId?: string \| null }` — the only mutable field (absent = unchanged, `null` clears); set after the fact because booking capture uploads before the item exists |
| `DELETE /trips/:tripId/attachments/:id` | Removes the R2 object, then the row (`503 storage_unavailable` on an R2 failure leaves both in place)                                                                          |

Attachment shape: `{ id, itineraryItemId, mimeType, byteSize, filename,
uploadedBy, createdAt, updatedAt }`. Clients build the stream URL from the
id.

- **The type comes from the bytes**, never from the client's declared
  `Content-Type` (`src/attachments/sniff.ts`): JPEG, PNG, WebP, GIF, and PDF
  are accepted; anything else — including a mislabeled HTML file — is
  `400 unsupported_type`. The schema pins `mime_type` to the same allowlist
  with a CHECK, so adding a format is a code change plus a migration. HEIC is deliberately unsupported (the Claude API
  used by Phase 2 extraction can't read it); the iOS app transcodes to JPEG
  before upload.
- Uploads are capped at 20 MB (`413 too_large`); an empty file is a 400.
- `itineraryItemId` must be an item on the same trip (`400 unknown_item`).
- `GET /attachments/:id` is not trip-scoped in the URL, so the trip comes
  from the row: unknown id → `404 attachment_not_found`, signed-in
  non-member → `403 not_a_member` (same as `requireTripMember`).
- **Deleting an itinerary item unlinks its attachments** (`itineraryItemId`
  nulled, `updatedAt` bumped, in the same transaction) — the booking is the
  source, so the ticket outlives the item. Deleting the trip deletes them.
- Write order is R2 then D1 on upload (a failed insert deletes the object)
  and R2 then D1 on delete, so a failure never leaves a paid-for orphan
  object; the worst case is a row whose object is gone, which reads as 404.

### Places

The place layer (#17): places from a member's Google Maps lists, decorated with
the tags, notes, and source links Maps can't hold. Maps stays the curation home
— this is a trip-scoped annotation layer, not a place database.

| Endpoint                           | Behavior                                                                        |
| :--------------------------------- | :------------------------------------------------------------------------------ |
| `POST /trips/:id/places`           | `{ name, cityId?, googleMapsUrl?, sourceList?, note?, tags?, links? }` → 201    |
| `PATCH /trips/:tripId/places/:id`  | Partial update; `name` cannot be cleared                                        |
| `DELETE /trips/:tripId/places/:id` | 404 `place_not_found` for cross-trip ids; tags and links cascade with the place |

- **`tags` and `links` are declarative sets, not columns.** Omit one and the
  stored set is untouched; send `[]` to clear it; `null` is a `400` (these are
  tables, so it has no clear-the-column meaning). `links` are
  `{ url, label? }` objects kept in the order you send them; a URL is a link's
  identity within a place, so the same URL twice collapses to one (first label
  wins).
- **Tags are canonicalized**: trimmed, lowercased, de-duplicated, and returned
  **sorted** — so a write response matches the next trip-doc read exactly. A
  client that echoes its own request array will disagree with the server.
- **`googleMapsUrl` is unique per trip** (`409 place_exists`) so re-importing a
  Maps list can't double up. URL-less hand-added places are unconstrained, and
  the same URL is fine on another trip. Dedupe is exact-string: two share-link
  forms of the same pin won't collide — normalizing them belongs to whatever
  import path ships later.
- `cityId` must be a city on the trip (`400 unknown_city`) and is optional: a
  place needn't belong to a city. **Deleting a city keeps its places** with
  `cityId` nulled and `updatedAt` bumped — the decoration is the point.
- **No import path ships here.** Places are created by plain API call; the
  Google Maps import route (share link / share sheet / Takeout) is still an open
  question in the root README, and the schema is the same for all three.

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
