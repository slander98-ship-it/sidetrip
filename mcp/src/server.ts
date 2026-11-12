#!/usr/bin/env node
/**
 * SideTrip MCP server (stdio).
 *
 * Tools:
 *   sidetrip_check_triggers — evaluate all trigger types, return what's due now
 *   sidetrip_build_plan     — build a plan (leave time, bring, pay, stops, script)
 *   sidetrip_place_call     — voice call via Vapi (Brooke) or SMS, dry-run by default
 *   sidetrip_get_list       — read the shared family errand list
 *   sidetrip_update_list    — add / complete / remove / clear items on that list
 *
 * Config is env-based; see .env.example. No secrets are ever stored here.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  buildPlan,
  evaluateTriggers,
  type EvaluateInputs,
  type Trigger,
} from "./engine.js";
import {
  addListItem,
  clearDoneItems,
  getList,
  markListItem,
  removeListItem,
} from "./store.js";
import { placeCall, sendSms, vapiConfigFromEnv } from "./vapi.js";
import { promises as fs } from "node:fs";

const VERSION = "0.1.0";

const server = new McpServer({ name: "sidetrip-mcp", version: VERSION });

const TriggerSchema = z.object({
  id: z.string(),
  type: z.enum(["appointment", "deadline", "bill", "location", "trip"]),
  title: z.string(),
  dueAt: z.string(),
  callAt: z.string(),
  location: z.string().optional(),
  address: z.string().optional(),
  amount: z.number().optional(),
  items: z.array(z.string()).optional(),
  stops: z
    .array(
      z.object({
        store: z.string(),
        items: z.array(z.string()),
        note: z.string().optional(),
      }),
    )
    .optional(),
  notes: z.string().optional(),
  travelMinutes: z.number().optional(),
  reason: z.string().optional(),
});

function text(payload: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

async function loadInputs(inputsJson?: string): Promise<EvaluateInputs> {
  if (inputsJson) return JSON.parse(inputsJson) as EvaluateInputs;
  const file = process.env.SIDETRIP_INPUTS_FILE;
  if (file) return JSON.parse(await fs.readFile(file, "utf8")) as EvaluateInputs;
  // Fall back to the shared list in the data dir so location triggers
  // work even with no inputs file.
  const list = await getList();
  return {
    list: list
      .filter((i) => !i.done)
      .map((i) => ({ id: i.id, item: i.item, store: i.store })),
  };
}

server.tool(
  "sidetrip_check_triggers",
  "Evaluate all SideTrip trigger types (appointment, deadline, bill, location, trip) against now and return the ones due for a call or text. Pass inputs as JSON, or set SIDETRIP_INPUTS_FILE to a file with calendar/bills/list/location data.",
  {
    inputsJson: z
      .string()
      .optional()
      .describe("JSON EvaluateInputs object: {now?, appointments?, bills?, deadlines?, trips?, list?, location?, stores?, defaults?}"),
    now: z.string().optional().describe("ISO timestamp to evaluate as 'now' (default: current time)."),
  },
  async ({ inputsJson, now }) => {
    const inputs = await loadInputs(inputsJson);
    if (now) inputs.now = now;
    const triggers = evaluateTriggers(inputs);
    return text({ count: triggers.length, triggers });
  },
);

server.tool(
  "sidetrip_build_plan",
  "Build a SideTrip plan for a due trigger: leave time, what to bring, what to pay, stops on the way, and the short spoken script that delivers the plan on a call.",
  { trigger: TriggerSchema },
  async ({ trigger }) => {
    const plan = buildPlan(trigger as Trigger);
    return text(plan);
  },
);

server.tool(
  "sidetrip_place_call",
  "Place a SideTrip voice call via Vapi (Brooke) delivering a plan, or send the plan as SMS. DRY RUN BY DEFAULT: validates the request and (with VAPI_API_KEY set) confirms the assistant and phone number exist, without dialing. Pass dryRun:false to actually place the call. Never place a real call during testing.",
  {
    plan: z.object({
      title: z.string(),
      dueAt: z.string(),
      leaveAt: z.string().optional(),
      bring: z.array(z.string()).optional(),
      pay: z.number().optional(),
      stops: z
        .array(z.object({ store: z.string(), items: z.array(z.string()), note: z.string().optional() }))
        .optional(),
      script: z.string(),
    }),
    phone: z
      .string()
      .optional()
      .describe("E.164 phone to call/text. Default: $USER_PHONE."),
    channel: z.enum(["call", "sms"]).default("call"),
    dryRun: z.boolean().default(true),
  },
  async ({ plan, phone, channel, dryRun }) => {
    const to = phone ?? process.env.USER_PHONE;
    if (!to) {
      return text({
        ok: false,
        error: "No phone number: pass `phone` or set USER_PHONE.",
      });
    }
    if (channel === "sms") {
      const result = await sendSms(plan, to);
      return text({ ...result, channel: "sms", dryRun });
    }
    const result = await placeCall(plan, to, { dryRun });
    return text(result);
  },
);

server.tool(
  "sidetrip_get_list",
  "Read the shared family errand list (Sean + Aimee + Echo). Drives location triggers and trip stops.",
  {},
  async () => {
    const list = await getList();
    return text({ count: list.length, items: list });
  },
);

server.tool(
  "sidetrip_update_list",
  "Update the shared family errand list: add an item (optionally with the store that sells it), mark one done/undone, remove one, or clear finished items.",
  {
    action: z.enum(["add", "done", "undone", "remove", "clear-done"]),
    item: z.string().optional().describe("Item text (for add)."),
    store: z.string().optional().describe("Store that sells it, e.g. Walmart (for add)."),
    id: z.string().optional().describe("List item id (for done/undone/remove)."),
    addedBy: z.string().optional(),
  },
  async ({ action, item, store, id, addedBy }) => {
    if (action === "add") {
      if (!item) return text({ ok: false, error: "`item` is required for add." });
      const entry = await addListItem(item, store, addedBy);
      return text({ ok: true, item: entry });
    }
    if (action === "clear-done") {
      const cleared = await clearDoneItems();
      return text({ ok: true, cleared });
    }
    if (!id) return text({ ok: false, error: "`id` is required for this action." });
    if (action === "done" || action === "undone") {
      const entry = await markListItem(id, action === "done");
      if (!entry) return text({ ok: false, error: `No list item with id ${id}.` });
      return text({ ok: true, item: entry });
    }
    const removed = await removeListItem(id);
    return text({ ok: removed, id });
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const vapi = vapiConfigFromEnv();
  console.error(
    `[sidetrip-mcp v${VERSION}] listening on stdio. ` +
      `Vapi: ${vapi ? `configured (assistant ${vapi.assistantId.slice(0, 8)}…, number ${vapi.phoneNumberId.slice(0, 8)}…)` : "not configured (VAPI_API_KEY missing — calls will dry-run as errors)"}. ` +
      `USER_PHONE: ${process.env.USER_PHONE ? "set" : "not set"}.`,
  );
}

main().catch((err) => {
  console.error("[sidetrip-mcp] fatal:", err);
  process.exit(1);
});
