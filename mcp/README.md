# SideTrip MCP server

A proactive voice companion as an MCP server. SideTrip watches a user's
calendar, bills, deadlines, shared errand list, and location — then
**calls or texts them with the plan**. It never relies on app
notifications.

This package is Track A of the SideTrip repo. Track B (the standalone
app) lives in `app/` and implements the same engine contract
(`evaluateTriggers` / `buildPlan` / `placeCall`) so the two can converge.

## What it does

Three core use cases, all in one engine:

1. **Just-in-time calls** before appointments, deadlines, and bills —
   with the plan: leave time, what to bring, what to pay.
2. **Location-triggered calls** — you're near a store that has items on
   your shared list, so it calls you with the list.
3. **The trip call** — e.g. a 2:15 PM appointment at Joe Cooper Hyundai
   → a 9:13 AM call saying leave at 1:15, with stops at Walmart for a
   microwave and O'Reilly for floor mats on the way.

## Install

Requires Node.js 20+.

**From npm (once published):**

```bash
npm install -g sidetrip-mcp
# or run without installing:
npx sidetrip-mcp
```

> **Not published yet.** Publishing needs Sean's npm account. Until then,
> run it from a local checkout (verified with `npm link`):
>
> ```bash
> git clone https://github.com/slander98-ship-it/sidetrip.git
> cd sidetrip/mcp
> npm install
> npm run build
> npm link   # makes `sidetrip-mcp` and `sidetrip-watch` available
> ```

**From Docker:**

```bash
docker build -t sidetrip-mcp mcp/
docker run --env-file .env sidetrip-mcp          # MCP server on stdio
docker run --env-file .env sidetrip-mcp node dist/watch.js   # watcher
```

**Use in an MCP client** (e.g. Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "sidetrip": {
      "command": "npx",
      "args": ["-y", "sidetrip-mcp"],
      "env": {
        "VAPI_API_KEY": "<your Vapi key>",
        "USER_PHONE": "+14054718024"
      }
    }
  }
}
```

Local path instead of npm while unpublished:

```json
{ "command": "node", "args": ["/path/to/sidetrip/mcp/dist/server.js"] }
```

## Config

Env-based, minimal. Copy `.env.example` to `.env`. No other accounts
are required — no Vapi signup, no API keys, no separate accounts for
the end user beyond the one Vapi key the operator holds.

| Variable | Required | Default / notes |
|---|---|---|
| `VAPI_API_KEY` | for calls | Vapi API key. Without it, calls fail cleanly with an error — nothing dials. |
| `VAPI_ASSISTANT_ID` | no | Brooke: `2a6b6f6d-a840-4c31-b555-f81c12bf66d4` (verified 2026-11-12) |
| `VAPI_PHONE_NUMBER_ID` | no | (405) 444-9356: `a1453415-9fec-4722-9c7f-ef0adac54788` (verified 2026-11-12) |
| `USER_PHONE` | for calls | E.164 number to call, e.g. `+14054718024` |
| `SIDETRIP_INPUTS_FILE` | no | JSON file with appointments/bills/deadlines/trips/stores (see `examples/joe-cooper.json`) |
| `SIDETRIP_DATA_DIR` | no | Shared list + notified state. Default `~/.sidetrip` |
| `SIDETRIP_POLL_MINUTES` | no | Watcher poll interval. Default `15` |
| `SIDETRIP_LIVE_CALLS` | no | Set to `1` to let the watcher actually dial. **Default is dry-run only** — the watcher never places a real call unless you opt in explicitly |
| `SIDETRIP_SMS_PROVIDER` | no | `twilio` to enable SMS (needs `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`); unset = SMS reports "not configured" instead of pretending to send |

Calls placed via Brooke are logged automatically — her `server.url`
already points at the live call-log webhook. This repo does not rebuild
the webhook.

## Tools

| Tool | What it does |
|---|---|
| `sidetrip_check_triggers` | Evaluate all trigger types (`appointment`, `deadline`, `bill`, `location`, `trip`) against now; return what's due. Takes `inputsJson` or reads `$SIDETRIP_INPUTS_FILE`. |
| `sidetrip_build_plan` | Build a plan for a trigger: `leaveAt`, `bring`, `pay`, `stops`, and the spoken `script`. |
| `sidetrip_place_call` | Voice call via Vapi (Brooke) delivering the plan, or SMS. **Dry-run by default** — validates the request and confirms the assistant + phone number exist via read-only Vapi API calls, without dialing. Pass `dryRun: false` to actually place the call. |
| `sidetrip_get_list` | Read the shared family errand list (Sean + Aimee + Echo). |
| `sidetrip_update_list` | `add` / `done` / `undone` / `remove` / `clear-done` on the shared list. |

## The watcher (the proactive half)

MCP alone only answers when asked. `sidetrip-watch` polls on its own:

```bash
sidetrip-watch --once   # one pass, then exit
sidetrip-watch          # poll every $SIDETRIP_POLL_MINUTES forever
```

Each pass loads inputs (merging the live shared list), evaluates
triggers, builds a plan for each due trigger it hasn't notified about,
and places the call. Notified trigger ids are recorded in the data dir
so a trigger is never called about twice. **Live calls require
`SIDETRIP_LIVE_CALLS=1` plus `VAPI_API_KEY`; otherwise every pass is a
validated dry run.**

## Working example — the Joe Cooper trip

```bash
npm run build
npm run example
```

Evaluates `examples/joe-cooper.json` at 9:13 AM on Thu Nov 12, 2026:
one due trigger (the 2:15 PM trip to Joe Cooper Hyundai) and the plan —
leave at 1:15 PM, Walmart for the microwave, O'Reilly for floor mats —
plus the spoken script. The Cricket bill due Nov 29 is correctly not
due yet.

## Verify

```bash
npm run build   # TypeScript build
npm test        # MCP test client: lists tools, runs check_triggers +
                # build_plan on the Joe Cooper example, round-trips the list
node scripts/verify-vapi-dryrun.mjs   # end-to-end dry-run through the MCP
                # server using the Vapi credential surrogate; confirms Brooke
                # + (405) 444-9356 exist. Places NO call.
```

Verified 2026-11-12: clean build, all 5 tools listed, plan build
correct (leave 1:15 PM, both stops, full script), dry-run validation
confirmed Brooke + (405) 444-9356 via the live Vapi API, watcher
`--once` dry-run validated and deduped. No live test call was placed
during verification of the published code paths (see "Known incident"
note in the repo root README — one accidental live call occurred while
testing an earlier watcher default; the default is now dry-run-only).

## Engine contract (shared with the app track)

- Trigger types: `appointment`, `deadline`, `bill`, `location`, `trip`.
- Trigger: `{id, type, title, dueAt, location?, amount?, items?, notes?}`.
- Plan: `{title, leaveAt?, bring?, pay?, stops?, script}`.
- Functions: `evaluateTriggers(inputs)` → triggers due now;
  `buildPlan(trigger)` → plan; `placeCall(plan, phone)` → call result.
  All in `src/engine.ts` / `src/vapi.ts`.

## Open product decisions (configurable, not hard-coded)

- **List home** — currently a local JSON file (`~/.sidetrip/list.json`);
  the app track may move it to a shared store. The MCP tools read/write
  the same shape either way.
- **Name** — working name "SideTrip".
- **Pricing** — default model is $2.99/mo subscription (calls included),
  or buyer brings their own Vapi account (new Vapi signups get $10 free
  credit, ~150–200 min). Nothing in this package bills anyone.

## License

MIT — see `LICENSE`.
