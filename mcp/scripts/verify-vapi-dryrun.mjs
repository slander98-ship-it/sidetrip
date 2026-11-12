#!/usr/bin/env node
/**
 * Verify the Vapi dry-run path end to end through the MCP server.
 *
 * Fetches the `custom.vapi` SURROGATE (hsurr:...) from authd — never the
 * raw key — and passes it as VAPI_API_KEY to the MCP server. The platform
 * swaps the surrogate for the real credential in transit, exactly like
 * the Python vapi.py CLI does. The script never prints the surrogate.
 *
 * It then calls sidetrip_place_call (dryRun) for the Joe Cooper plan and
 * expects validation to confirm Brooke + (405) 444-9356 exist. No real
 * call is placed.
 *
 * Run: npm run build && node scripts/verify-vapi-dryrun.mjs
 */
import net from "node:net";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const AUTH_SOCK = process.env.JARVIS_AUTHD_SOCK ?? "/run/hatch/auth/authd.sock";

function getSurrogate(credentialName) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ name: credentialName });
    const req =
      `POST /v1/credentials/surrogate HTTP/1.1\r\n` +
      `Host: authd.local\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n` +
      body;
    const conn = net.connect(AUTH_SOCK);
    let raw = "";
    conn.on("connect", () => conn.write(req));
    conn.on("data", (c) => (raw += c.toString("utf8")));
    conn.on("end", () => {
      try {
        const json = JSON.parse(raw.split("\r\n\r\n").slice(1).join("\r\n\r\n"));
        const entry = (json.credentials ?? []).find((e) => e.name === "access_token");
        if (!entry?.surrogate?.startsWith("hsurr:")) {
          reject(new Error("authd did not return an hsurr: surrogate"));
          return;
        }
        resolve(entry.surrogate);
      } catch (e) {
        reject(new Error(`could not parse authd response: ${e.message}`));
      }
    });
    conn.on("error", reject);
    setTimeout(() => reject(new Error("authd timed out")), 5000);
  });
}

const dir = dirname(fileURLToPath(import.meta.url));
const root = join(dir, "..");

const surrogate = await getSurrogate("custom.vapi");
console.log("Got Vapi surrogate from authd (value not shown).");

const inputs = JSON.parse(readFileSync(join(root, "examples", "joe-cooper.json"), "utf8"));
const transport = new StdioClientTransport({
  command: "node",
  args: [join(root, "dist", "server.js")],
  env: {
    ...process.env,
    VAPI_API_KEY: surrogate,
    USER_PHONE: "+14054718024",
    SIDETRIP_DATA_DIR: join(root, ".sidetrip-data"),
  },
  stderr: "ignore",
});
const client = new Client({ name: "sidetrip-verify", version: "0.1.0" }, { capabilities: {} });
try {
  await client.connect(transport);
  const check = await client.callTool({
    name: "sidetrip_check_triggers",
    arguments: { inputsJson: JSON.stringify(inputs) },
  });
  const { triggers } = JSON.parse(check.content[0].text);
  const planCall = await client.callTool({
    name: "sidetrip_build_plan",
    arguments: { trigger: triggers[0] },
  });
  const plan = JSON.parse(planCall.content[0].text);
  console.log("Plan stops:", JSON.stringify(plan.stops));
  console.log("Script:", plan.script);

  const dry = await client.callTool({
    name: "sidetrip_place_call",
    arguments: { plan, phone: "+14054718024", channel: "call", dryRun: true },
  });
  const result = JSON.parse(dry.content[0].text);
  console.log("\nDRY-RUN RESULT:", JSON.stringify(result, null, 2));
  if (!result.ok) throw new Error(`Dry run failed: ${result.error}`);
  const { assistant, phoneNumber } = result.validated;
  if (assistant?.name !== "Brooke") throw new Error("Assistant is not Brooke");
  if (phoneNumber?.number !== "+14054449356") throw new Error("Phone number mismatch");
  console.log("\nVERIFY: PASS — Brooke + (405) 444-9356 confirmed via Vapi API; request built, no call placed.");
} catch (err) {
  console.error("\nVERIFY: FAIL —", err);
  process.exitCode = 1;
} finally {
  await client.close();
}
