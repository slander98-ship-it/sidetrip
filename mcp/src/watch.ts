#!/usr/bin/env node
/**
 * sidetrip-watch — the proactive half of SideTrip.
 *
 * MCP alone only answers when asked. This watcher polls on its own:
 * every SIDETRIP_POLL_MINUTES (default 15) it loads inputs from
 * $SIDETRIP_INPUTS_FILE, evaluates triggers, builds a plan for each due
 * trigger it hasn't already notified about, and places the call (or
 * sends the SMS). Notified trigger ids are recorded in the data dir so
 * a trigger is never called about twice.
 *
 * Usage:
 *   sidetrip-watch            # poll forever (dry-run unless live calls enabled)
 *   sidetrip-watch --once     # one pass, then exit
 *   SIDETRIP_LIVE_CALLS=1 sidetrip-watch --once   # actually dial (needs VAPI_API_KEY)
 *
 * Live calls happen ONLY when SIDETRIP_LIVE_CALLS=1 AND VAPI_API_KEY is
 * set. In every other configuration the watcher dry-runs: it builds the
 * plan, validates it against the Vapi API when a key is present, logs
 * what it would do, and never dials. This default exists because a
 * watcher that dials by accident is a real phone call to a real person.
 */
import { promises as fs } from "node:fs";
import { buildPlan, evaluateTriggers, type EvaluateInputs } from "./engine.js";
import { getList, markNotified, wasNotified } from "./store.js";
import { placeCall } from "./vapi.js";

const POLL_MINUTES = Number(process.env.SIDETRIP_POLL_MINUTES ?? 15);

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function loadInputs(): Promise<EvaluateInputs> {
  const file = process.env.SIDETRIP_INPUTS_FILE;
  let inputs: EvaluateInputs = {};
  if (file) {
    try {
      inputs = JSON.parse(await fs.readFile(file, "utf8")) as EvaluateInputs;
    } catch (err) {
      log(`WARN: could not read SIDETRIP_INPUTS_FILE=${file}: ${err}`);
    }
  }
  // Always merge the live shared list so location triggers + trip stops
  // reflect what the family actually needs right now.
  const list = await getList();
  const open = list.filter((i) => !i.done);
  inputs.list = [
    ...open.map((i) => ({ id: i.id, item: i.item, store: i.store })),
    ...(inputs.list ?? []),
  ];
  return inputs;
}

async function runOnce(): Promise<void> {
  const inputs = await loadInputs();
  const triggers = evaluateTriggers(inputs);
  if (triggers.length === 0) {
    log("No triggers due.");
    return;
  }
  const phone = process.env.USER_PHONE;
  if (!phone) {
    log("WARN: USER_PHONE not set — triggers due but nowhere to call:");
    for (const t of triggers) log(`  - ${t.type}: ${t.title} (${t.id})`);
    return;
  }
  const dryRun =
    process.env.SIDETRIP_LIVE_CALLS !== "1" || !process.env.VAPI_API_KEY;
  for (const trigger of triggers) {
    if (await wasNotified(trigger.id)) {
      log(`Skipping already-notified trigger ${trigger.id}`);
      continue;
    }
    const plan = buildPlan(trigger);
    log(`Due: ${trigger.type} — ${trigger.title}. Plan: ${plan.script}`);
    const result = await placeCall(plan, phone, { dryRun });
    if (result.ok) {
      log(
        dryRun
          ? `Dry run OK (validated against Vapi). Would call ${phone}.`
          : `Call placed: ${result.callId ?? "(no id returned)"}`,
      );
      await markNotified(trigger.id);
    } else {
      log(`Call failed for ${trigger.id}: ${result.error}`);
    }
  }
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  log(
    `sidetrip-watch starting (poll every ${POLL_MINUTES} min, data dir: ${process.env.SIDETRIP_DATA_DIR ?? "~/.sidetrip"}). ` +
      `Live calls: ${process.env.SIDETRIP_LIVE_CALLS === "1" && process.env.VAPI_API_KEY ? "ENABLED (SIDETRIP_LIVE_CALLS=1)" : "off — dry-run only"}.`,
  );
  await runOnce();
  if (once) return;
  setInterval(() => {
    runOnce().catch((err) => log(`Poll error: ${err}`));
  }, POLL_MINUTES * 60_000);
}

main().catch((err) => {
  console.error("[sidetrip-watch] fatal:", err);
  process.exit(1);
});
