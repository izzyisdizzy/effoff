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

**Stack** (chosen 2026-09-04, nothing built yet): native SwiftUI iPhone app
(EventKit for Calendar/Reminders); Cloudflare Workers (TypeScript) + D1
backend; TypeScript web SPA served from the same Worker.

## Ground rules

- Default branch: `main`. Remote: `github.com/izzyisdizzy/effoff`.
- This repo lives inside the `~/Development` workspace — follow the workspace
  `CLAUDE.md` anchoring rules (`git -C /Users/ibennett/Development/effoff ...`,
  absolute paths, never commit from the workspace root).
- The README is the source of truth for product direction until code exists —
  keep it in sync with any scope or stack decisions.
- Once real code lands, update this file (how to run it, conventions, layout)
  and keep the stack column in the workspace `CLAUDE.md` repos table accurate.
