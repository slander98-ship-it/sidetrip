#!/usr/bin/env node
/**
 * SideTrip worked example — the Joe Cooper Hyundai case.
 *
 * At 9:13 AM on Thu Nov 12, 2026, SideTrip evaluates the sample inputs in
 * joe-cooper.json: a 2:15 PM appointment at Joe Cooper Hyundai with two
 * stops on the way (Walmart for a microwave, O'Reilly for floor mats),
 * plus a Cricket bill due Nov 29 (not due yet — correctly ignored).
 *
 * Expected output: one due trigger (the trip), and a plan that says
 * leave at 1:15 PM with the two stops and the spoken call script.
 *
 * Run:  npm run build && npm run example
 *        (or: node examples/run-example.js after building)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlan, evaluateTriggers } from "../dist/engine.js";

const dir = dirname(fileURLToPath(import.meta.url));
const inputs = JSON.parse(readFileSync(join(dir, "joe-cooper.json"), "utf8"));

const triggers = evaluateTriggers(inputs);
console.log(`\n== Triggers due at ${inputs.now} ==`);
console.log(JSON.stringify(triggers, null, 2));

for (const trigger of triggers) {
  const plan = buildPlan(trigger);
  console.log(`\n== Plan for "${trigger.title}" ==`);
  console.log(JSON.stringify(plan, null, 2));
  console.log(`\nSpoken script:\n"${plan.script}"`);
}

console.log(
  `\nDone. ${triggers.length} trigger(s) due — the Cricket bill is correctly not due yet (call window opens Nov 28).`,
);
