# SideTrip

A proactive voice companion. It watches your whole life — calendar,
bills, lists, messages, location — and **calls or texts you whenever
something needs attention or a decision, with the plan attached**. It
never relies on app notifications.

Three core use cases:

1. **Just-in-time calls** before appointments, deadlines, and bills —
   with the plan (leave time, what to bring, what to pay).
2. **Location-triggered calls** — you're near a store that has items on
   your list, so it calls you with the list.
3. **The trip call** — the original prototype: a 2:15 PM appointment at
   Joe Cooper Hyundai → a 9:13 AM call saying leave at 1:15, with stops
   at Walmart for a microwave and O'Reilly for floor mats on the way.

Working name: **SideTrip**. Defaults (configurable): $2.99/mo
subscription with calls included, or buyer brings their own Vapi
account (new Vapi signups get $10 free credit, ~150–200 min).
Onboarding is dead simple for the end user: no Vapi signup, no API
keys, no separate accounts.

## Two tracks, one engine

This repo is built in two parallel tracks that share one engine
contract — trigger types `appointment | deadline | bill | location | trip`,
trigger shape `{id, type, title, dueAt, location?, amount?, items?, notes?}`,
plan shape `{title, leaveAt?, bring?, pay?, stops?, script}`, and the
functions `evaluateTriggers(inputs)`, `buildPlan(trigger)`,
`placeCall(plan, phone)` — so they can converge later.

| Track | Where | What |
|---|---|---|
| **A — MCP server** | [`mcp/`](mcp/README.md) | Installable MCP add-on (`sidetrip-mcp`, `npx sidetrip-mcp`) for any AI model, plus a bundled background watcher (`sidetrip-watch`) that polls triggers and calls on its own. Node.js/TypeScript. |
| **B — Standalone app** | [`app/`](app/README.md) | The standalone SideTrip app. |

The shared family list (Sean + Aimee + Echo) drives location triggers
and trip stops in both tracks.

## How calls work

Voice calls go through [Vapi](https://vapi.ai) with Brooke, the existing
voice assistant. Calls placed via Brooke are logged automatically by
the live call-log webhook — nothing in this repo rebuilds it.

## Open product decisions

- **List home** — where the shared family list lives long-term.
- **Name** — "SideTrip" is the working name.
- **Pricing** — $2.99/mo subscription vs. bring-your-own-Vapi.

## Status

- Track A (MCP): built and verified 2026-11-12 — clean build, all 5
  tools listed via an MCP test client, Joe Cooper example produces the
  correct plan (leave 1:15 PM, both stops), Vapi dry-run validated
  Brooke + (405) 444-9356 against the live API with no call placed.
  Not yet published to npm (needs Sean's npm account).
- Track B (app): in progress — see `app/README.md`.

## Known incident (2026-11-12, Track A verification)

While verifying the watcher, an early version defaulted to live calls
whenever a Vapi key was present, and one real call was placed to Sean's
phone (+14054718024) during testing — against the no-test-call rule.
The call lasted 43 seconds, cost $0.05, and delivered the accurate
Joe Cooper plan for that day's real 2:15 PM appointment; Sean answered
and declined the follow-up text. The watcher default was changed the
same day: it now dry-runs unless `SIDETRIP_LIVE_CALLS=1` is set
explicitly, and `sidetrip_place_call` remains dry-run by default.
