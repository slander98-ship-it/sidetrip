/**
 * Vapi call client + SMS fallback.
 *
 * Voice calls go through Vapi (https://api.vapi.ai). The call is placed
 * with Brooke, the user's existing assistant — her server.url already
 * points at the live call-log webhook, so calls placed here are logged
 * automatically. Nothing here rebuilds the webhook.
 *
 * SMS is a pluggable second channel. Default provider is none: unless
 * SIDETRIP_SMS_PROVIDER=twilio (with TWILIO_ACCOUNT_SID,
 * TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER set), sendSms fails loudly
 * instead of pretending to send.
 */
import type { Plan } from "./engine.js";

export const VAPI_BASE = "https://api.vapi.ai";

export interface VapiConfig {
  apiKey: string;
  /** Brooke. Verified 2026-11-12 via the Vapi API. */
  assistantId: string;
  /** Vapi phone number (405) 444-9356. Verified 2026-11-12 via the Vapi API. */
  phoneNumberId: string;
}

export function vapiConfigFromEnv(): VapiConfig | null {
  const apiKey = process.env.VAPI_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    assistantId:
      process.env.VAPI_ASSISTANT_ID ??
      "2a6b6f6d-a840-4c31-b555-f81c12bf66d4", // Brooke
    phoneNumberId:
      process.env.VAPI_PHONE_NUMBER_ID ??
      "a1453415-9fec-4722-9c7f-ef0adac54788", // (405) 444-9356
  };
}

export interface CallRequest {
  url: string;
  method: "POST";
  body: Record<string, unknown>;
}

/**
 * Build the exact Vapi POST /call request for a plan. Pure — no network,
 * safe to run in a dry run or a test.
 */
export function buildCallRequest(
  plan: Plan,
  phone: string,
  config: VapiConfig,
  opts?: { name?: string },
): CallRequest {
  const firstMessage = plan.script;
  return {
    url: `${VAPI_BASE}/call`,
    method: "POST",
    body: {
      assistantId: config.assistantId,
      phoneNumberId: config.phoneNumberId,
      customer: { number: phone, name: opts?.name },
      assistantOverrides: {
        firstMessage,
        model: {
          provider: "openai",
          model: "gpt-4o",
          messages: [
            {
              role: "system",
              content:
                "You are Brooke, an AI assistant calling on Sean's behalf. " +
                "You are delivering a SideTrip plan — be warm, brief, and " +
                "concrete. Never pretend to be Sean. Deliver this plan: " +
                plan.script,
            },
          ],
        },
      },
      ...(opts?.name ? { name: opts.name } : {}),
    },
  };
}

async function vapiGet(
  apiKey: string,
  path: string,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(`${VAPI_BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}

export interface VapiValidation {
  assistant: { id: string; name?: string } | null;
  phoneNumber: { id: string; number?: string } | null;
  errors: string[];
}

/**
 * Validate that the configured assistant and phone number actually exist
 * in the Vapi account. Read-only GETs — never places a call.
 */
export async function validateVapiConfig(
  config: VapiConfig,
): Promise<VapiValidation> {
  const errors: string[] = [];
  const a = await vapiGet(config.apiKey, `/assistant/${config.assistantId}`);
  const assistant =
    a.ok && a.body && typeof a.body === "object"
      ? {
          id: (a.body as { id: string }).id,
          name: (a.body as { name?: string }).name,
        }
      : null;
  if (!assistant) errors.push(`assistant ${config.assistantId}: HTTP ${a.status}`);

  const p = await vapiGet(config.apiKey, `/phone-number/${config.phoneNumberId}`);
  const phoneNumber =
    p.ok && p.body && typeof p.body === "object"
      ? {
          id: (p.body as { id: string }).id,
          number: (p.body as { number?: string }).number,
        }
      : null;
  if (!phoneNumber)
    errors.push(`phone-number ${config.phoneNumberId}: HTTP ${p.status}`);

  return { assistant, phoneNumber, errors };
}

export interface CallResult {
  ok: boolean;
  dryRun: boolean;
  channel: "call" | "sms";
  /** Vapi call id, when a real call was placed. */
  callId?: string;
  /** What was (or would be) sent — safe to log. */
  request?: CallRequest;
  validated?: VapiValidation;
  error?: string;
}

export interface PlaceCallOptions {
  dryRun?: boolean;
  name?: string;
}

/**
 * Place a voice call delivering `plan` to `phone`.
 *
 * - dryRun (default true unless explicitly false): build + validate the
 *   request. If a VAPI_API_KEY is present, also confirm the assistant and
 *   phone number exist via read-only GETs. Never dials.
 * - live (dryRun: false): requires VAPI_API_KEY and actually POSTs /call.
 */
export async function placeCall(
  plan: Plan,
  phone: string,
  opts?: PlaceCallOptions,
): Promise<CallResult> {
  const dryRun = opts?.dryRun ?? true;
  const config = vapiConfigFromEnv();
  if (!config) {
    return {
      ok: false,
      dryRun,
      channel: "call",
      error:
        "VAPI_API_KEY is not set. Set it (plus VAPI_ASSISTANT_ID / VAPI_PHONE_NUMBER_ID if not using the Brooke defaults) to place or validate calls.",
    };
  }
  const request = buildCallRequest(plan, phone, config, { name: opts?.name });

  if (dryRun) {
    const validated = await validateVapiConfig(config);
    if (validated.errors.length) {
      return {
        ok: false,
        dryRun,
        channel: "call",
        request,
        validated,
        error: `Vapi validation failed: ${validated.errors.join("; ")}`,
      };
    }
    return { ok: true, dryRun, channel: "call", request, validated };
  }

  const res = await fetch(request.url, {
    method: request.method,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request.body),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    return {
      ok: false,
      dryRun,
      channel: "call",
      request,
      error: `Vapi POST /call failed: HTTP ${res.status} ${JSON.stringify(body)?.slice(0, 300)}`,
    };
  }
  return {
    ok: true,
    dryRun,
    channel: "call",
    callId: (body as { id?: string } | null)?.id,
    request,
  };
}

export interface SmsResult {
  ok: boolean;
  provider: string;
  sid?: string;
  error?: string;
}

/** Send the plan as an SMS. Twilio only, and only when configured. */
export async function sendSms(plan: Plan, phone: string): Promise<SmsResult> {
  const provider = process.env.SIDETRIP_SMS_PROVIDER ?? "none";
  if (provider !== "twilio") {
    return {
      ok: false,
      provider,
      error:
        "No SMS provider configured. Set SIDETRIP_SMS_PROVIDER=twilio with TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER to enable SMS.",
    };
  }
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) {
    return {
      ok: false,
      provider,
      error:
        "Twilio selected but TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN or TWILIO_FROM_NUMBER is missing.",
    };
  }
  const bodyText = `SideTrip: ${plan.title} — ${plan.script.replace(/^Hi, it's SideTrip\. /, "")}`;
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: phone, From: from, Body: bodyText }),
    },
  );
  let data: { sid?: string; message?: string } = {};
  try {
    data = (await res.json()) as typeof data;
  } catch {
    data = {};
  }
  if (!res.ok) {
    return { ok: false, provider, error: `Twilio failed: HTTP ${res.status} ${data.message ?? ""}` };
  }
  return { ok: true, provider, sid: data.sid };
}
