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

- Trips are collaborative by default: invite the people you're traveling
  with, and everyone on the trip can view and edit the plan.
- **Not everyone flies together.** On group trips, each member can have their
  own arrival and departure — join two days late, duck out early — and the
  app knows whose trip runs when.
- A trip is made of cities and dates, itinerary items (flights, stays,
  reservations, activities — with times, addresses, and confirmation numbers),
  and trip to-dos (book X, check in online, pack).
- **Booking capture.** A trip starts with bookings: upload or screenshot a
  flight ticket or hotel confirmation and effoff extracts the details — times,
  airports, addresses, check-in/checkout, confirmation numbers — into itinerary
  items. The original image stays attached, one tap away when you need to show
  it at a desk.
- **Flights know their timezones.** Flight times are shown in the local time of
  the departure and arrival airports, because that's the only way flight times
  make sense.
- **Hotels are first-class.** Check-in and checkout become itinerary items with
  their own times, and every hotel on the trip is pinned to one per-*trip*
  hotel list — the one list that spans cities — so routing back to the hotel
  (or seeing what's near it) is always one tap.
- Each city links to your shared Google Maps lists (food, activities, coffee,
  bars — one list per category, each with its own icon), so the curation you
  already do in Maps stays where it is.
- **A lightweight place layer on top of your lists.** Places are imported from
  your Google Maps lists — Maps stays the home for curating and seeing them on
  the map — and effoff adds what Maps can't: tags ("ramen", "casual", "shoes"),
  notes, and links to other sources (Tabelog for Japan, a friend's rec, a
  review). effoff never asks you to curate places twice.
- **Share the whole trip's lists at once.** Per-city × per-category lists are
  great to use and a pain to share one by one. effoff holds every list link for
  the trip and hands the full set to each trip member in one shot.
- Planning happens on the web or on the iPhone app — both are first-class,
  and switching between them is seamless: start building a trip on a laptop,
  pick it up later from the couch on a phone (or the other way around), and
  the trip is always current on every device.

### During the trip — live off your phone

- **The trip starts itself.** When the start date arrives, the app leads with
  the in-trip experience on its own — going by *your* dates on trips where
  members arrive late or leave early. No mode to toggle.
- **Planning never closes.** An active trip is still a fully editable one:
  book a dinner mid-trip, push tomorrow's activity back a day, add a whole
  new reservation from the hotel lobby. Planning and being on the trip are
  views of the same plan, not phases.
- **Today view** — the city you're in at the top, then the day as a schedule:
  "check out at 11:00", "flight from HND to CTS at 14:30", "check in at
  16:00", dinner reservation at 19:00 — with what's next highlighted, and the
  address or confirmation number right there when you need it.
- **Tickets on tap** — the flight ticket or booking confirmation you captured
  while planning opens in one tap when you're at the desk or the gate.
- **Apple Calendar sync** — itinerary items land in a calendar, so the trip
  shows up everywhere your calendar does.
- **Apple Reminders sync** — trip to-dos land in Reminders with due times.
- **One-tap city lists** — open the current city's Google Maps lists to see
  your pinned spots on the map when deciding where to go.
- **Filter your places** — when the group can't decide, filter the current
  city's places by tag: "ramen", "dessert", "park", "casual".

## Design principles

- **Integrate, don't replace.** Google Maps lists, Apple Calendar, and Apple
  Reminders are already good at what they do. effoff links to them and syncs
  with them; it doesn't rebuild them. The place layer follows the same rule:
  Maps is where places are curated and mapped, effoff only decorates them with
  tags, notes, and links.
- **A trip belongs to everyone going on it.** Sharing isn't a feature bolted on
  later — it's the default shape of a trip.
- **Plan anywhere, live it from your phone.** Planning is fully supported on
  both web and phone, and moving between devices mid-plan is seamless — no
  "finish this on the computer". The in-trip experience is built for the
  phone in your pocket.
- **Nothing is set in stone.** A trip is a living plan: anything can be
  added, moved, or dropped at any moment, before or during the trip. "Active"
  is just a date arriving — it never locks anything.
- **The booking is the source.** You booked it somewhere else; effoff's job is
  to capture that artifact once, extract what matters, and keep the original
  close at hand.

## Non-goals (for now)

- Building a global place database or replacing Google Maps curation. The
  place layer is trip-scoped and imported from your own lists — effoff is not
  a directory of the world's restaurants.
- Booking flights, hotels, or anything else in-app — effoff organizes what you
  booked elsewhere.
- Android — explicitly later, not never.
- Social or discovery features. This is for your trips, not a feed.
- Expense tracking in the first versions — a settle-up area is a Phase 5
  idea (see the roadmap), not in v1.

## Stack

| Piece | Choice |
| :-- | :-- |
| iPhone app | Swift / SwiftUI, EventKit for Calendar + Reminders |
| Backend | Cloudflare Workers (TypeScript) + D1 (SQLite) |
| Web app | TypeScript SPA served from the same Worker (framework finalized when web work starts) |

## Roadmap

Phases 1–4 correspond to the tracker's `phase-1`–`phase-4` issue labels.
Phase 5 is a list of ideas, not commitments.

### Phase 1 — Foundation

- Scaffold the Cloudflare Workers + D1 API project.
- D1 schema for trips, members, cities, itinerary items (timezone-aware),
  and to-dos.
- Auth, sessions, and trip invites.
- CRUD API endpoints for trips, cities, itinerary items, and to-dos.
- The fuller data-model and API plan — including attachments, places, and
  map lists — lives in [`docs/foundation.md`](docs/foundation.md).

### Phase 2 — Planning on the web

- Scaffold the web app: sign-in, trip list, trip overview, invites.
- Collaborative itinerary and to-do editing.
- Booking capture: upload a ticket or confirmation, auto-extract the
  itinerary item, keep the image attached.

### Phase 3 — iPhone app

- SwiftUI app with the core planning views: trips, cities, itinerary, and
  to-dos — the same collaborative plan, phone-first, including booking
  capture from screenshots.

### Phase 4 — In-trip polish

- The today view: current city, the day as a schedule, what's next
  highlighted, tickets on tap.
- Sync the itinerary to Apple Calendar and trip to-dos to Apple Reminders
  (EventKit).
- One-tap links to each city's Google Maps lists.

### Phase 5 — Later

- Android.
- Booking-confirmation email import.
- Offline support, widgets, and notifications.
- Trip recaps / photo journal.
- **Settle up** — a bills area for figuring out who owes who during and
  after the trip, likely by making the `payback` engine extensible and
  building on it rather than rewriting the money math.
- Richer share/invite flows and integrations.

## Open questions

- **Importing places from Google Maps lists.** Google has no official API for
  saved lists, so the place layer's import path is one of: parsing a list's
  share link, an iOS share-sheet "add to effoff" from Maps, or a Google
  Takeout CSV import. To be settled when the place layer is built; the vision
  doesn't depend on which one wins.

## Status

In progress. This README is the source of truth for direction. The backend
scaffold is in place (`backend/`: Cloudflare Worker + Hono + D1 with
migrations and a tested health endpoint); the web SPA and iPhone app are not
started yet.

## License

[Apache 2.0](LICENSE)
