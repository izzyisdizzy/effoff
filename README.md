# effoff

Tell everything else to eff off — plan the trip together, then live it off your
phone.

effoff is a trip planning app for you and the people you travel with. It covers
both halves of a trip: **planning** (on the web and iPhone) and **being on the
trip** (phone-first, wired into Apple Calendar and Reminders). It works *with*
the tools you already use — Google Maps lists, Apple Calendar, Apple Reminders —
instead of trying to replace them.

## What it does

### Before the trip — plan together

- Trips are collaborative by default: everyone going on the trip can view and
  edit the plan.
- A trip is made of cities and dates, itinerary items (flights, stays,
  reservations, activities — with times, addresses, and confirmation numbers),
  and trip to-dos (book X, check in online, pack).
- Each city links to your shared Google Maps lists (food, activities, coffee,
  bars), so the curation you already do in Maps stays where it is.
- Planning happens on the web or on the iPhone app — both are first-class,
  and switching between them is seamless: start building a trip on a laptop,
  pick it up later from the couch on a phone (or the other way around), and
  the trip is always current on every device.

### During the trip — live off your phone

- **Today view** — the day's plan at a glance: what's next, when, where, and
  the confirmation number to show at the desk.
- **Apple Calendar sync** — itinerary items land in a calendar, so the trip
  shows up everywhere your calendar does.
- **Apple Reminders sync** — trip to-dos land in Reminders with due times.
- **One-tap city lists** — open the current city's Google Maps lists to see
  your pinned spots on the map when deciding where to go.

## Design principles

- **Integrate, don't replace.** Google Maps lists, Apple Calendar, and Apple
  Reminders are already good at what they do. effoff links to them and syncs
  with them; it doesn't rebuild them.
- **A trip belongs to everyone going on it.** Sharing isn't a feature bolted on
  later — it's the default shape of a trip.
- **Plan anywhere, live it from your phone.** Planning is fully supported on
  both web and phone, and moving between devices mid-plan is seamless — no
  "finish this on the computer". The in-trip experience is built for the
  phone in your pocket.

## Non-goals (for now)

- Replacing Google Maps lists or building a place database.
- Booking flights, hotels, or anything else in-app — effoff organizes what you
  booked elsewhere.
- Android — explicitly later, not never.
- Social or discovery features. This is for your trips, not a feed.

## Stack

| Piece | Choice |
| :-- | :-- |
| iPhone app | Swift / SwiftUI, EventKit for Calendar + Reminders |
| Backend | Cloudflare Workers (TypeScript) + D1 (SQLite) |
| Web app | TypeScript SPA served from the same Worker (framework finalized when web work starts) |

## Roadmap

1. **Foundation** — data model and Workers/D1 API: accounts, trips, members,
   cities, itinerary items, to-dos, and per-city map-list links.
2. **Planning on the web** — web client for creating and editing trips
   collaboratively.
3. **iPhone app** — SwiftUI client: view/edit trips, today view, EventKit
   Calendar + Reminders sync, city map-list links.
4. **In-trip polish** — offline cache, widgets and notifications, better
   share/invite flow.
5. **Later** — Android, richer integrations.

## Status

Pre-code. This README is the source of truth for direction; the stack is
chosen but nothing is built yet.

## License

[Apache 2.0](LICENSE)
