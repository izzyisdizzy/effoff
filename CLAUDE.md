# CLAUDE.md

## What this is

`effoff` — a collaborative trip planning app plus in-trip phone companion.
Trips (cities, dates, itinerary items, to-dos) are planned together on web +
iPhone. Bookings are captured from uploaded tickets/confirmations
(auto-extracted, timezone-aware, image kept attached); hotels get first-class
check-in/checkout items and a per-trip hotel list. A lightweight place layer
imports places from the user's shared Google Maps lists and adds tags, notes,
and source links (Maps stays the curation home). During the trip the phone
gives a today view (city + day schedule), one-tap tickets, syncs the itinerary
to Apple Calendar and to-dos to Apple Reminders, and links each city to the
Maps lists. See `README.md` for the full vision and roadmap.

**Stack** (chosen 2026-09-04): native SwiftUI iPhone app (EventKit for
Calendar/Reminders); Cloudflare Workers (TypeScript) + D1 backend; TypeScript
web SPA served from the same Worker.

## Layout

Monorepo (per `docs/foundation.md`); only `backend/` exists so far — `web/`
(Phase 2) and `ios/` (Phase 3) come later.

- `backend/` — Cloudflare Worker (TypeScript, Hono) + D1 with
  `wrangler d1 migrations`. See `backend/README.md` for commands and
  conventions.
- `docs/` — design notes; `docs/foundation.md` is the backend plan.

## Running / testing the backend

From `backend/` (`npm install` first): `npm run dev` (local server on
`:8787`), `npm test` (Vitest inside workerd with a real migrated local D1),
`npm run typecheck`, `npm run lint`, `npm run format`, `npm run migrate`
(local D1), `npm run deploy`. Details in `backend/README.md`.

## Conventions

- TypeScript strict; Hono for routing; REST JSON under `/api/v1`
  (health check at `/api/health` is the exception).
- Lint/format: oxlint + oxfmt. Tests: Vitest with
  `@cloudflare/vitest-pool-workers`.
- `backend/worker-configuration.d.ts` is generated (`npm run cf-typegen`) —
  never hand-edit.
- Schema changes only via `wrangler d1 migrations` files in
  `backend/migrations/`.

## Ground rules

- Default branch: `main`. Remote: `github.com/izzyisdizzy/effoff`.
- This repo lives inside the `~/Development` workspace — follow the workspace
  `CLAUDE.md` anchoring rules (`git -C /Users/ibennett/Development/effoff ...`,
  absolute paths, never commit from the workspace root).
- The README is the source of truth for product direction — keep it in sync
  with any scope or stack decisions.
- Keep this file (how to run it, conventions, layout) and the stack column in
  the workspace `CLAUDE.md` repos table accurate as code lands.
