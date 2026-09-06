# Foundation — data model & API exploration

Exploratory design for roadmap Phase 1: the data model and the Workers/D1 API
that everything else (web client, iPhone app) sits on. The README stays the
source of truth for *product* direction; this doc is the working plan for the
*backend* shape. Decisions marked **proposed** are recommendations to confirm
before code lands; **open** means genuinely unsettled.

## Scope

Phase 1 delivers a deployed Cloudflare Worker + D1 database exposing a JSON API
for: accounts, trips, members + invites, cities, itinerary items
(timezone-aware), to-dos, attachments (ticket/confirmation images), places with
tags/notes/links, and per-city map-list links. Booking-capture *extraction* is
specified here (it shapes the attachment and itinerary models) but ships with
Phase 2's web client, where there's a UI to review the extraction.

## Entities

```
User ─────< TripMember >───── Trip ─────< TripCity
                               │  │        │
                               │  ├──< ItineraryItem >── Attachment
                               │  ├──< Todo             (R2 object + row)
                               │  ├──< MapList  (per-city × category, + per-trip hotel list)
                               │  └──< Place ──< PlaceTag / PlaceLink
                               └──< Invite
```

### Trip, TripCity

- `trips` — id, name, created_by, timestamps. Trip dates are **derived** from
  its cities (**decided**): each `trip_cities` row carries `arrival_date`,
  `departure_date` — both **nullable** (**decided**) — a display order, and
  an IANA timezone (e.g. `Asia/Tokyo`). Deriving trip dates avoids a second
  source of truth that can drift from the city list. Nullable dates support
  the real early-planning state ("we want Tokyo and Sapporo, order TBD"):
  trip dates derive from whichever cities are dated and are null until one
  is; the today view and self-starting behavior need a dated city, which any
  trip has by the time it starts.
- The city's timezone is the default for itinerary items created in that city,
  so users almost never pick a zone by hand.

### ItineraryItem

One table, typed rows: `kind ∈ {flight, stay, reservation, activity}`.

- Common: trip_id, city_id (nullable — flights span cities), title, notes,
  address, confirmation_number, attachment refs, sort keys.
- **Time model** (**proposed**): store *local wall-clock time + IANA zone* as
  entered (`start_local`, `start_tz`, `end_local`, `end_tz`), plus derived UTC
  instants for ordering and calendar sync. The wall-clock value is the source
  of truth — "dinner at 19:00" must never shift because a device changed
  zones. Flights are the reason `start_tz`/`end_tz` are per-*end*, not
  per-item: departure in HND time, arrival in CTS time.
- Flight extras: departure/arrival airport codes.
- **Stays** (**proposed**): one `stay` row with check-in and checkout times —
  *not* two paired check-in/checkout rows. The today view and calendar sync
  *project* a stay into two schedule entries. Paired rows would need
  edit/delete to keep twins in sync forever; projection gets the same UX with
  no invariant to maintain. Stays with `kind = stay` also feed the per-trip
  hotel list for free — it's a query, not a separate list to curate.

### Todo

trip_id, title, done, optional due time (same local + tz model), optional
assignee. Carries a slot for the Apple Reminders identifier so the iOS app can
sync without a mapping table (**proposed**: sync mapping lives client-side on
device, not in D1 — Reminders IDs are per-device/per-account anyway).

### Attachment

R2 for bytes, D1 for metadata: id, trip_id, optional itinerary_item_id, R2
key, mime type, byte size, uploaded_by, created_at. Images and PDFs. All
access goes through the Worker (auth check → stream from R2); no public
bucket, no signed URLs in v1. **Decided (#16):** the item link is set after
upload via `PATCH /trips/:id/attachments/:id` (booking capture uploads before
the item exists), attachments can be deleted, deleting an item unlinks rather
than deletes its attachments, and the stored MIME type is sniffed from the
bytes — see `backend/README.md` (Attachments).

### Place, PlaceTag, PlaceLink, MapList

- `map_lists` — trip_id, city_id (nullable for the per-trip hotel list),
  category, icon, Google Maps share URL. This is what "share the whole trip's
  lists at once" reads from.
- `places` — trip_id, city_id, name, optional Google Maps URL/reference,
  source list, free-text note. Imported, per the README's open question, by a
  path TBD (share-link parse / iOS share sheet / Takeout CSV) — the schema is
  the same for all three, so this doesn't block Phase 1.
- `place_tags` — (place_id, tag), lowercase, free-form. `place_links` —
  (place_id, url, label) for Tabelog / a friend's rec / a review.

### User, TripMember, Invite

- `users` — id, auth provider + subject (see Auth), email, display name.
- `trip_members` — (trip_id, user_id), plus **optional personal
  `arrival_date` / `departure_date`** for members who join late or leave
  early. Null means "the whole trip". These are the member's *presence
  window*, used by lifecycle logic (below) — they never restrict what the
  member can see or edit.
- **Proposed: no roles in v1** — the README says a trip belongs to everyone
  on it; every member can edit everything. One carve-out: only the creator
  can delete the trip.
- `invites` — token, trip_id, created_by, `expires_at`, `revoked_at`. Share
  a link; opening it while signed in joins the trip. **Decided: both expiry
  and revocation** — links expire 30 days after creation *and* can be
  revoked early from trip settings (revoke = set `revoked_at`; "new link" =
  revoke + create). No per-email invites in v1 (people share trip links in
  the group chat anyway).

## Trip lifecycle (**proposed**)

There is **no trip status column and no phase state on the server**. "The
trip started" is a pure function the clients evaluate: today's date falls
inside the trip's derived date range, clipped to the viewing member's
personal presence window when one is set. That's what makes the app lead
with the in-trip experience on the right day *per member* — the friend
joining two days late stays in planning mode while everyone else is already
on the ground.

Corollary, and a load-bearing product rule: **nothing locks when a trip goes
active.** Planning and in-trip are views over the same rows; every mutation
endpoint behaves identically before, during, and after the trip. Phase 1
must not grow validation like "can't edit past items" or "trip is
read-only after end date" — flexibility is the requirement, and statelessness
here is what keeps it free.

## Auth (**decided**)

**Sign in with Apple only, v1.** It works natively on iOS and via Apple's JS
on the web, so both clients share one identity system, and the target user
(iPhone-owning trip groups) always has it. The Worker verifies Apple's
identity token, upserts the user, and issues its own session: an HttpOnly
cookie for the web SPA, an opaque bearer token for the iOS app — both random
IDs looked up in a `sessions` table (D1 hit per request is fine at this
scale, and revocation stays trivial).

Known gap, accepted: a rare collaborator with no Apple ID can't join in v1.
Magic-link email is the designated later addition and slots in as just
another provider row on `users`.

## API shape

REST JSON under `/api/v1`, trip-scoped:

```
POST   /trips                          GET  /trips
GET    /trips/:id   (full trip doc)    PATCH /trips/:id      DELETE /trips/:id
POST   /trips/:id/invites              POST /invites/:token/accept
CRUD   /trips/:id/cities, /items, /todos, /map-lists, /places
POST   /trips/:id/attachments  (multipart upload → R2)
GET    /attachments/:id        (auth-checked stream from R2)
POST   /trips/:id/extract      (Phase 2: image/PDF → draft itinerary item)
```

`GET /trips/:id` returns the whole trip (cities, items, todos, lists, places)
in one response — trips are small (hundreds of rows at most), and one
round-trip beats N for both clients' "open trip" path.

## Sync & collaboration (**proposed**)

v1 is **poll + last-write-wins per row**, not real-time:

- Every mutable row carries `updated_at`. Clients refetch the trip doc on
  foreground/focus and after every mutation; `GET /trips/:id` supports
  `If-None-Match` on a trip-level version counter so polls are cheap 304s.
- Concurrent edits to the *same row* resolve last-write-wins. For a
  small-group planning tool this is the right cost/benefit: conflicts are
  rare, and the failure mode ("your edit to the dinner time lost to Sam's")
  is minor and self-evident.
- The seams for later live sync are kept clean: a trip-level version counter
  already exists, so upgrading to a Durable Object per trip pushing
  WebSocket "trip changed, refetch" events is additive — D1 stays the source
  of truth either way. Not in Phase 1.

## Booking capture (extraction)

- Endpoint: `POST /trips/:id/extract` with an already-uploaded attachment id.
- The Worker calls the Claude API (TypeScript SDK, model `claude-opus-5`)
  with the image/PDF as a content block and a structured-output schema
  (`output_config.format`) matching a draft itinerary item: kind, title,
  start/end local times + zones, airports, address, confirmation number.
- The response is a **draft** — the client shows it pre-filled for the user
  to confirm or fix; nothing is committed to the itinerary without review.
  The attachment stays linked so the original is one tap away.
- Failure path: extraction that comes back empty/low-confidence just opens
  the manual item form with the attachment linked. Capture never blocks on
  the model.
- Ops notes: `ANTHROPIC_API_KEY` as a Worker secret; extraction only ever
  runs on an explicit user action, so cost is bounded by usage.

## Deliberately out of scope (but not blocked)

**Settle up / who-owes-who** is a Phase 5 roadmap idea, not Phase 1 — no
expense tables in this schema. Nothing here blocks it: expenses would arrive
as new trip-scoped tables (expense, payer, splits) keyed to `trip_members`,
and the likely path is extracting the `payback` repo's money math into a
reusable engine rather than rewriting it. The one Phase 1 obligation is
keeping `trip_members` a real table with stable ids — which it is — so
future expenses have something durable to point at.

## Repo layout (**proposed**)

```
backend/    Cloudflare Worker (TypeScript): API, D1 schema + migrations, wrangler.jsonc
web/        Phase 2 — SPA, served as static assets from the same Worker
ios/        Phase 3 — SwiftUI app
docs/       this doc and future design notes
```

Monorepo, one deploy for backend + web. `wrangler d1 migrations` for schema.

## Build order within Phase 1

1. Worker scaffold + wrangler config + D1 with migrations; deploy a health
   endpoint.
2. Auth: Sign in with Apple verification, users, sessions.
3. Trips + members + invites.
4. Cities + itinerary items (the time model is the hard part — test it
   first: flight HND→CTS, a stay projection, a DST-crossing trip).
5. Todos, map lists, places/tags/links.
6. Attachments (R2 upload/stream).
7. Trip-doc GET with version counter + 304s.

## Decisions (settled 2026-09-04)

- **Auth: Sign in with Apple only for v1.** The no-Apple-ID gap is accepted;
  magic-link email is the designated later addition.
- **City dates are nullable.** Dateless cities are a real early-planning
  state; trip dates derive from whichever cities are dated.
- **Invite links: 30-day expiry *and* revocable** from trip settings.
- **Calendar/Reminders sync clips to your presence window by default**, with
  a per-trip toggle to sync the whole trip instead. (Implementation lands
  with the EventKit work in Phase 4 — In-trip polish; the presence-window
  data it needs ships in Phase 1.)

## Open questions

- Carried from the README: the Google Maps list **import path** (share link
  vs share sheet vs Takeout) — still deferred to the place-layer work.
