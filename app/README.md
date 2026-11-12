# SideTrip — standalone installable app (PWA)

SideTrip is a proactive voice companion. It watches a user's calendar,
bills, lists, messages and location — and **calls or texts** them with the
plan, instead of an app notification they'll miss.

Three use cases in the engine:
1. **Just-in-time calls** before appointments, deadlines and bills — with the
   plan (leave time, what to bring, what to pay).
2. **Location-triggered calls** — you're near a store that has items on the
   family list, so it calls you with the list.
3. **The trip call** — the original example: a 2:15 PM appointment at Joe
   Cooper Hyundai → a 9:13 AM call saying leave at 1:15, with stops at
   Walmart (microwave) and O'Reilly (floor mats) on the way.

## What's in this folder (`app/`)

| File | What it is |
|---|---|
| `index.html` | The app shell: Today/plans, shared list, call log, setup, settings |
| `app.js` | The trigger engine + all UI logic (see Engine contract below) |
| `styles.css` | Mobile-first styles |
| `manifest.webmanifest` | PWA manifest (name, icons, theme, standalone display) |
| `sw.js` | Service worker — caches the app shell for offline use |
| `icons/` | Real PNG icons generated for this build (192, 512, 512 maskable, 180 Apple touch) — teal "S" + road mark |

## Engine contract

Shared with the MCP-server track so the two can converge later:

- Trigger types: `appointment`, `deadline`, `bill`, `location`, `trip`
- Trigger: `{ id, type, title, dueAt, location?, amount?, items?, notes? }`
- Plan: `{ title, leaveAt?, bring?, pay?, stops?, script }` — `script` is the
  short spoken call script that delivers the plan.
- `evaluateTriggers(inputs)` → triggers due now
- `buildPlan(trigger)` → plan
- `placeCall(plan, phone)` → call result. **Dry-run by default**: builds the
  exact Vapi request and returns it without sending a real call.

## Install on your phone

**iPhone (Safari):** open the app URL in Safari → Share button → **Add to
Home Screen** → Add. It opens full-screen like a native app.
(Android Chrome: open the URL → menu → **Install app** / **Add to Home
screen**, or tap the install banner.)

**Run locally:** from this folder — `python3 -m http.server 8000` — then
open http://localhost:8000/ (or http://localhost:8000/index.html).
Service workers require localhost or HTTPS; plain `file://` will not
register the service worker or offer install.

## The honest architecture note

True background watching + calling **cannot run inside the PWA alone**
(especially on iOS, which suspends web apps when they're not on screen).
The watching/calling runs **server-side** — the SideTrip watcher / MCP
server or a hosted service — while this PWA is the dashboard, list, plan
view, and setup. The trigger-evaluation + plan-building engine lives in
`app.js` per the contract above, and it is the same logic the server runs,
so plans previewed here match what the call will say.

## Calling (Vapi)

Calls go through Vapi (`https://api.vapi.ai`). Settings (in the app's
Settings tab) hold clearly-marked placeholders — **no real secrets are in
this repo**:

- `VAPI_API_KEY` — blank by default; paste yours on-device only (stored in
  localStorage, never committed)
- Assistant id default: Brooke `2a6b6f6d-a840-4c31-b555-f81c12bf66d4`
- User phone default: Sean's `+14054718024` (configurable)
- Dry-run is **on by default** — `placeCall` builds the request and shows
  it; it sends nothing. Never place a real test call to Sean's phone.

The Vapi call-log webhook is already live at
`https://vapi-call-log-slander98-8432s-projects.vercel.app` — do not rebuild it.

## Open product decisions (defaults used here, configurable)

- **Name:** SideTrip (working name)
- **List home:** the shared Sean · Aimee · Echo list in this app (server
  sync is the watcher's job)
- **Pricing:** $2.99/mo subscription, calls included — **or** buyer brings
  their own Vapi account (new Vapi signups get $10 free credit,
  ~150–200 min)

## Files in the repo

This app lives under `app/` in `slander98-ship-it/sidetrip`. The MCP
add-on track lives under `mcp/` and the root README belongs to that track —
do not edit those from here.
