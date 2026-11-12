/**
 * SideTrip engine — pure functions, no network, no secrets.
 *
 * Shared contract with the standalone app track. The engine turns raw
 * life-inputs (appointments, bills, deadlines, trips, a shared errand
 * list, and the user's location) into *triggers* that are due now, and
 * turns a trigger into a *plan* with a short spoken call script.
 *
 * Trigger types: appointment | deadline | bill | location | trip
 */

// ---------------------------------------------------------------- types ---

export type TriggerType =
  | "appointment"
  | "deadline"
  | "bill"
  | "location"
  | "trip";

export interface Trigger {
  id: string;
  type: TriggerType;
  title: string;
  /** ISO 8601 timestamp of the thing itself (appointment time, bill due date). */
  dueAt: string;
  /** ISO 8601 timestamp SideTrip should act (call/text) by. */
  callAt: string;
  location?: string;
  address?: string;
  amount?: number;
  items?: string[];
  /** Grouped stops (store + items), for trip triggers. */
  stops?: PlanStop[];
  notes?: string;
  /** Minutes of travel the plan should budget for. */
  travelMinutes?: number;
  /** Why this trigger fired now. */
  reason: string;
}

export interface Plan {
  title: string;
  dueAt: string;
  /** ISO 8601 time the user should leave. */
  leaveAt?: string;
  bring?: string[];
  /** Amount to pay, for bill triggers. */
  pay?: number;
  stops?: PlanStop[];
  /** Short spoken script that delivers the whole plan on a call. */
  script: string;
}

export interface PlanStop {
  store: string;
  items: string[];
  note?: string;
}

export interface AppointmentInput {
  id?: string;
  title: string;
  dueAt: string;
  location?: string;
  address?: string;
  notes?: string;
  bring?: string[];
  travelMinutes?: number;
  /** Minutes before dueAt to call. Default: 300 (5h). */
  callLeadMinutes?: number;
}

export interface BillInput {
  id?: string;
  title: string;
  dueAt: string;
  amount?: number;
  payUrl?: string;
  notes?: string;
  /** Days before dueAt to call. Default: 1. */
  callLeadDays?: number;
}

export interface DeadlineInput {
  id?: string;
  title: string;
  dueAt: string;
  notes?: string;
  callLeadDays?: number;
}

export interface TripInput extends AppointmentInput {
  stops?: PlanStop[];
}

export interface ListItemInput {
  id?: string;
  item: string;
  store?: string;
  neededBy?: string;
  notes?: string;
}

export interface StoreInput {
  name: string;
  lat: number;
  lon: number;
  /** Miles from the store that counts as "near". Default: 2. */
  radiusMiles?: number;
}

export interface EvaluateInputs {
  now?: string;
  appointments?: AppointmentInput[];
  bills?: BillInput[];
  deadlines?: DeadlineInput[];
  trips?: TripInput[];
  /** The shared family errand list (Sean + Aimee + Echo). */
  list?: ListItemInput[];
  /** User's current location, when known. */
  location?: { lat: number; lon: number; label?: string };
  stores?: StoreInput[];
  defaults?: {
    appointmentCallLeadMinutes?: number;
    billCallLeadDays?: number;
    deadlineCallLeadDays?: number;
    travelMinutes?: number;
    /** Minutes budgeted per stop on the way. Default: 15. */
    stopMinutes?: number;
  };
}

export interface EngineOptions {
  appointmentCallLeadMinutes?: number;
  billCallLeadDays?: number;
  deadlineCallLeadDays?: number;
  travelMinutes?: number;
  stopMinutes?: number;
}

const DEFAULTS: Required<EngineOptions> = {
  appointmentCallLeadMinutes: 300, // 5h — call in the morning for an afternoon appointment
  billCallLeadDays: 1,
  deadlineCallLeadDays: 1,
  travelMinutes: 45,
  stopMinutes: 15,
};

function resolveOptions(
  inputs: EvaluateInputs,
  overrides?: EngineOptions,
): Required<EngineOptions> {
  const d = inputs.defaults ?? {};
  return {
    appointmentCallLeadMinutes:
      overrides?.appointmentCallLeadMinutes ??
      d.appointmentCallLeadMinutes ??
      DEFAULTS.appointmentCallLeadMinutes,
    billCallLeadDays:
      overrides?.billCallLeadDays ??
      d.billCallLeadDays ??
      DEFAULTS.billCallLeadDays,
    deadlineCallLeadDays:
      overrides?.deadlineCallLeadDays ??
      d.deadlineCallLeadDays ??
      DEFAULTS.deadlineCallLeadDays,
    travelMinutes:
      overrides?.travelMinutes ?? d.travelMinutes ?? DEFAULTS.travelMinutes,
    stopMinutes: overrides?.stopMinutes ?? d.stopMinutes ?? DEFAULTS.stopMinutes,
  };
}

function minutesBefore(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() - minutes * 60_000).toISOString();
}

function daysBefore(iso: string, days: number): string {
  return minutesBefore(iso, days * 24 * 60);
}

function isDue(now: Date, callAt: string, dueAt: string): boolean {
  return now >= new Date(callAt) && now < new Date(dueAt);
}

function haversineMiles(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 3958.8; // Earth radius in miles
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ------------------------------------------------------- evaluateTriggers ---

/**
 * Evaluate every trigger type against `now` and return the triggers that
 * are due — i.e. their call window has opened and the underlying event
 * has not yet happened. Triggers already past their dueAt are dropped
 * (they are late, not due); the caller dedups repeats via notified state.
 */
export function evaluateTriggers(
  inputs: EvaluateInputs,
  overrides?: EngineOptions,
): Trigger[] {
  const opts = resolveOptions(inputs, overrides);
  const now = new Date(inputs.now ?? new Date().toISOString());
  const out: Trigger[] = [];

  for (const a of inputs.appointments ?? []) {
    const lead = a.callLeadMinutes ?? opts.appointmentCallLeadMinutes;
    const callAt = minutesBefore(a.dueAt, lead);
    if (!isDue(now, callAt, a.dueAt)) continue;
    out.push({
      id: a.id ?? `appointment:${slug(a.title)}:${a.dueAt}`,
      type: "appointment",
      title: a.title,
      dueAt: a.dueAt,
      callAt,
      location: a.location,
      address: a.address,
      items: a.bring,
      notes: a.notes,
      travelMinutes: a.travelMinutes ?? opts.travelMinutes,
      reason: `Appointment in ${Math.round(lead / 60)}h — call window opened at ${callAt}.`,
    });
  }

  for (const t of inputs.trips ?? []) {
    const lead = t.callLeadMinutes ?? opts.appointmentCallLeadMinutes;
    const callAt = minutesBefore(t.dueAt, lead);
    if (!isDue(now, callAt, t.dueAt)) continue;
    out.push({
      id: t.id ?? `trip:${slug(t.title)}:${t.dueAt}`,
      type: "trip",
      title: t.title,
      dueAt: t.dueAt,
      callAt,
      location: t.location,
      address: t.address,
      items: [
        ...(t.bring ?? []),
        ...(t.stops ?? []).flatMap((s) => s.items),
      ],
      stops: t.stops,
      notes: t.notes,
      travelMinutes: t.travelMinutes ?? opts.travelMinutes,
      reason: `Trip in ${Math.round(lead / 60)}h with ${(t.stops ?? []).length} stop(s) on the way — call window opened at ${callAt}.`,
    });
  }

  for (const b of inputs.bills ?? []) {
    const leadDays = b.callLeadDays ?? opts.billCallLeadDays;
    const callAt = daysBefore(b.dueAt, leadDays);
    if (!isDue(now, callAt, b.dueAt)) continue;
    out.push({
      id: b.id ?? `bill:${slug(b.title)}:${b.dueAt}`,
      type: "bill",
      title: b.title,
      dueAt: b.dueAt,
      callAt,
      amount: b.amount,
      notes: [b.notes, b.payUrl ? `Pay at ${b.payUrl}` : ""]
        .filter(Boolean)
        .join(" "),
      reason: `Bill due in ${leadDays} day(s)${b.amount ? ` — $${b.amount.toFixed(2)}` : ""}.`,
    });
  }

  for (const d of inputs.deadlines ?? []) {
    const leadDays = d.callLeadDays ?? opts.deadlineCallLeadDays;
    const callAt = daysBefore(d.dueAt, leadDays);
    if (!isDue(now, callAt, d.dueAt)) continue;
    out.push({
      id: d.id ?? `deadline:${slug(d.title)}:${d.dueAt}`,
      type: "deadline",
      title: d.title,
      dueAt: d.dueAt,
      callAt,
      notes: d.notes,
      reason: `Deadline in ${leadDays} day(s).`,
    });
  }

  // Location triggers: user is near a store that carries items on the
  // shared list. One trigger per store, listing the items to grab.
  if (inputs.location && inputs.list?.length && inputs.stores?.length) {
    const openItems = inputs.list.filter((i) => i.item);
    for (const store of inputs.stores) {
      const dist = haversineMiles(
        inputs.location.lat,
        inputs.location.lon,
        store.lat,
        store.lon,
      );
      const radius = store.radiusMiles ?? 2;
      if (dist > radius) continue;
      const itemsHere = openItems.filter(
        (i) =>
          i.store &&
          i.store.toLowerCase().includes(store.name.toLowerCase().split(" ")[0]),
      );
      if (itemsHere.length === 0) continue;
      out.push({
        id: `location:${slug(store.name)}:${now.toISOString().slice(0, 13)}`,
        type: "location",
        title: `Near ${store.name} — ${itemsHere.length} list item(s) here`,
        dueAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
        callAt: now.toISOString(),
        location: store.name,
        items: itemsHere.map((i) => i.item),
        reason: `You're ${dist.toFixed(1)} mi from ${store.name} and ${itemsHere.length} item(s) on the shared list are sold there.`,
      });
    }
  }

  return out.sort((a, b) => a.callAt.localeCompare(b.callAt));
}

// ------------------------------------------------------------ buildPlan ---

export interface BuildPlanOptions extends EngineOptions {
  /** "HH:MM AM" style leave time is derived from dueAt; override for tests. */
  now?: string;
}

/** Short spoken time, e.g. "1:15 PM". */
export function spokenTime(iso: string, timeZone = "America/Chicago"): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(iso));
}

/**
 * Turn a due trigger into a plan: when to leave, what to bring, what to
 * pay, which stops to make on the way, and the spoken script that
 * delivers it all on a call.
 */
export function buildPlan(
  trigger: Trigger,
  opts?: BuildPlanOptions,
): Plan {
  const stopMinutes = opts?.stopMinutes ?? DEFAULTS.stopMinutes;
  const travel = trigger.travelMinutes ?? opts?.travelMinutes ?? DEFAULTS.travelMinutes;
  const stops: PlanStop[] = [];
  if (trigger.type === "trip" && trigger.stops?.length) {
    stops.push(...trigger.stops);
  } else if (trigger.type === "trip" && trigger.items?.length) {
    // Trip with items but no grouped stops: keep them as one "on the way" list.
    stops.push({ store: "On the way", items: trigger.items });
  }

  const stopCount = stops.reduce((n, s) => n + s.items.length, 0);
  const leaveAt =
    trigger.type === "location"
      ? undefined
      : minutesBefore(trigger.dueAt, travel + stopCount * stopMinutes);

  const bring = trigger.items?.filter((i) => trigger.type !== "trip") ?? [];
  const pay = trigger.type === "bill" ? trigger.amount : undefined;

  const parts: string[] = [];
  const when = spokenTime(trigger.dueAt);
  if (trigger.type === "appointment" || trigger.type === "trip") {
    const where =
      trigger.location &&
      !trigger.title.toLowerCase().includes(trigger.location.toLowerCase())
        ? ` at ${trigger.location}`
        : "";
    parts.push(`Heads up — ${trigger.title} is at ${when}${where}.`);
    if (leaveAt) {
      parts.push(
        `Leave by ${spokenTime(leaveAt)} to make it${stopCount ? ` with ${stopCount} quick stop${stopCount > 1 ? "s" : ""} on the way` : ""}.`,
      );
    }
    if (stops.length) {
      for (const s of stops) {
        parts.push(`${s.store}: ${s.items.join(", ")}.`);
      }
    }
    if (bring.length) parts.push(`Bring: ${bring.join(", ")}.`);
  } else if (trigger.type === "bill") {
    parts.push(
      `${trigger.title} is due ${when}${pay ? ` — $${pay.toFixed(2)}` : ""}.`,
    );
    if (trigger.notes) parts.push(trigger.notes);
  } else if (trigger.type === "deadline") {
    parts.push(`${trigger.title} is due ${when}.`);
    if (trigger.notes) parts.push(trigger.notes);
  } else if (trigger.type === "location") {
    parts.push(
      `You're right by ${trigger.location} — ${trigger.items?.join(", ") ?? "items on your list"} ${trigger.items?.length === 1 ? "is" : "are"} on the shared list and sold there.`,
    );
  }
  if (trigger.notes && trigger.type !== "bill" && trigger.type !== "deadline") {
    parts.push(trigger.notes);
  }

  return {
    title: trigger.title,
    dueAt: trigger.dueAt,
    leaveAt,
    bring: bring.length ? bring : undefined,
    pay,
    stops: stops.length ? stops : undefined,
    script: `Hi, it's SideTrip. ${parts.join(" ")} Want me to text you the details?`,
  };
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
