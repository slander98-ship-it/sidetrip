#!/usr/bin/env node
/**
 * Minimal MCP test client: spawns the SideTrip server over stdio,
 * lists its tools, then calls sidetrip_check_triggers and
 * sidetrip_build_plan against the Joe Cooper example inputs.
 *
 * Run: npm run build && npm test
 * Exits non-zero if the tool list is missing a tool or a call fails.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dir = dirname(fileURLToPath(import.meta.url));
const root = join(dir, "..");
const EXPECTED_TOOLS = [
  "sidetrip_check_triggers",
  "sidetrip_build_plan",
  "sidetrip_place_call",
  "sidetrip_get_list",
  "sidetrip_update_list",
];

const transport = new StdioClientTransport({
  command: "node",
  args: [join(root, "dist", "server.js")],
  env: { ...process.env, SIDETRIP_DATA_DIR: join(root, ".sidetrip-data") },
  stderr: "ignore",
});
const client = new Client({ name: "sidetrip-test-client", version: "0.1.0" }, { capabilities: {} });

try {
  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  console.log("TOOLS:", JSON.stringify(names));
  const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
  if (missing.length) throw new Error(`Missing tools: ${missing.join(", ")}`);
  console.log("All 5 expected tools present.");

  const inputs = JSON.parse(readFileSync(join(root, "examples", "joe-cooper.json"), "utf8"));
  const check = await client.callTool({
    name: "sidetrip_check_triggers",
    arguments: { inputsJson: JSON.stringify(inputs) },
  });
  const checkText = check.content[0].text;
  console.log("\nCHECK_TRIGGERS:\n" + checkText);
  const { triggers } = JSON.parse(checkText);
  if (triggers.length !== 1 || triggers[0].type !== "trip") {
    throw new Error(`Expected exactly 1 trip trigger, got ${triggers.length}`);
  }

  const planCall = await client.callTool({
    name: "sidetrip_build_plan",
    arguments: { trigger: triggers[0] },
  });
  const planText = planCall.content[0].text;
  console.log("\nBUILD_PLAN:\n" + planText);
  const plan = JSON.parse(planText);
  if (!plan.script || !plan.leaveAt) throw new Error("Plan missing script or leaveAt");
  console.log(`\nLeave at: ${plan.leaveAt} (expect ~13:15 local, i.e. 19:15Z)`);
  console.log(`Script: "${plan.script}"`);

  // List round-trip (uses a scratch data dir, not the user's real one).
  const add = await client.callTool({
    name: "sidetrip_update_list",
    arguments: { action: "add", item: "Test item — floor mats", store: "O'Reilly", addedBy: "test-client" },
  });
  console.log("\nUPDATE_LIST (add):\n" + add.content[0].text);
  const list = await client.callTool({ name: "sidetrip_get_list", arguments: {} });
  console.log("\nGET_LIST:\n" + list.content[0].text);

  // Dry-run call placement WITHOUT a Vapi key: must fail cleanly, not dial.
  const dry = await client.callTool({
    name: "sidetrip_place_call",
    arguments: { plan, phone: "+14054718024", channel: "call", dryRun: true },
  });
  console.log("\nPLACE_CALL (dry run, no key in this env):\n" + dry.content[0].text);

  console.log("\nTEST CLIENT: PASS");
} catch (err) {
  console.error("\nTEST CLIENT: FAIL —", err);
  process.exitCode = 1;
} finally {
  await client.close();
}
