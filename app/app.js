/* ============================================================================
   SideTrip — proactive voice companion (PWA dashboard + engine)
   ----------------------------------------------------------------------------
   ENGINE CONTRACT (shared with the MCP-server track so the two can converge):
     Trigger: { id, type, title, dueAt, location?, amount?, items?, notes? }
       type: "appointment" | "deadline" | "bill" | "location" | "trip"
     Plan:    { title, leaveAt?, bring?, pay?, stops?, script }
       script = the short spoken call script that delivers the plan.
     evaluateTriggers(inputs) -> triggers due now
     buildPlan(trigger)       -> plan
     placeCall(plan, phone)   -> call result (DRY-RUN by default: builds the
                                  Vapi request, does NOT send a real call)
   ----------------------------------------------------------------------------
   HONEST ARCHITECTURE NOTE: a PWA cannot watch in the background on a real
   phone — especially iOS, which suspends web apps. The watching + calling
   runs server-side (the SideTrip watcher / MCP server or a hosted service);
   this PWA is the dashboard: plans, shared list, call scripts, setup, log.
   The engine below is the same logic the server runs, so plans previewed
   here match what the call will say.
   ========================================================================== */

"use strict";

/* ---------------- Config (defaults; editable in Settings) ---------------- */
const DEFAULTS = {
  vapiApiKey: "", // placeholder — never commit a real key; paste yours in Settings (stored only on this device)
  vapiAssistantId: "2a6b6f6d-a840-4c31-b555-f81c12bf66d4", // Brooke
  userPhone: "+14054718024", // Sean
  dryRun: true, // default: build the call request, do not send a real call
  callWindowMinutes: 360, // how far ahead a trigger counts as "due now" — 6h: the real 9:13 AM Joe Cooper call went out ~5h before the 2:15 PM appointment
  pricingModel: "subscription", // "subscription" ($2.99/mo, calls included) or "byo-vapi"
};
const VAPI_API_BASE = "https://api.vapi.ai";

/* ---------------- Shared list — Google Sheets (via Apps Script bridge) --- */
/* The family list lives in a Google Sheet so everyone shares one list.
   The Apps Script web app is the bridge (no sign-in needed):
   GET  -> {"items":[{id, name, store, addedBy, done}, ...]}
   POST {"action":"add","name","store","addedBy"}    -> {"ok":true,"id"}
   POST {"action":"toggle","id","done"}               -> {"ok":true}
   Writes use Content-Type: text/plain to avoid a CORS preflight.
   localStorage stays as the offline fallback — if the sheet is
   unreachable the app keeps working with the last synced list. */
const SHEET_API_URL = "https://script.google.com/macros/s/AKfycbw2KHfJQAGoFtjzm_nMbkgaATJv8POjCC-lH8jr1F-GD6g7FZPqH_rBQDcgFLE9vX5c/exec";

/* ---------------- Seed data (today: Thu Nov 12, 2026) -------------------- */
const SEED_TRIGGERS = [
  {
    id: "t-joecooper",
    type: "trip",
    title: "Joe Cooper Hyundai — Santa Fe appointment",
    dueAt: "2026-11-12T14:15:00-06:00",
    location: "Joe Cooper Hyundai, Yukon, OK",
    items: ["White microwave (under 17.7 in wide, ~$60) — Walmart", "F-150 floor mats, 2015–2020 SuperCab — O'Reilly"],
    notes: "Advisor Austin Baquera, confirmation X08RH6Q2RJ. Santa Fe in limp mode. Leave 1:15 PM — 45 min drive + stops on the way.",
  },
  {
    id: "t-cricket",
    type: "bill",
    title: "Cricket wireless bill",
    dueAt: "2026-11-29T23:59:00-06:00",
    amount: 95,
    notes: "About $95/mo. Pay in the myCricket app. $15 late-reactivation fee if it lapses.",
  },
  {
    id: "t-guardianship",
    type: "deadline",
    title: "Guardianship hearing — PG-2026-81",
    dueAt: "2026-11-19T11:00:00-06:00",
    location: "Canadian County Children's Justice Center, 7905 E Hwy 66, El Reno",
    notes: "Next hearing Thu Nov 19, 11:00 AM. Clashes with the 10:20 AM Dr. Shelly Jacobs video visit — move that visit; court wins.",
  },
  {
    id: "t-walmart",
    type: "location",
    title: "Near Walmart — 2 items on the family list",
    dueAt: "2026-11-12T09:00:00-06:00",
    location: "Walmart, Mustang, OK",
    items: ["White microwave (under 17.7 in wide)", "Milk & bread"],
    notes: "Location trigger: you're passing a store that has list items. Call with the list, don't just ping.",
  },
];

const SEED_LIST = [
  { id: "l-microwave", name: "White microwave — under 17.7 in wide, ~$60", store: "Walmart", addedBy: "Sean", done: false },
  { id: "l-mats", name: "F-150 floor mats — 2015–2020 SuperCab", store: "O'Reilly", addedBy: "Sean", done: false },
  { id: "l-milk", name: "Milk & bread", store: "Walmart", addedBy: "Aimee", done: false },
  { id: "l-dogfood", name: "Dog food — Bluetick Coonhound", store: "Walmart", addedBy: "Aimee", done: true },
];

const SEED_CALL_LOG = [
  { id: "c-0913", time: "2026-11-12T09:13:00-06:00", to: "Sean", title: "Joe Cooper trip — leave at 1:15", outcome: "Delivered", detail: "Call placed 9:13 AM. Script: leave at 1:15, Walmart for the microwave, O'Reilly for the floor mats, then Joe Cooper by 2:15." },
];

/* ---------------- Engine -------------------------------------------------- */

/** Triggers due now: due within the call window, or location triggers flagged now. */
function evaluateTriggers(inputs) {
  const list = (inputs && inputs.triggers) || SEED_TRIGGERS;
  const now = (inputs && inputs.now) ? new Date(inputs.now) : new Date();
  const windowMs = ((inputs && inputs.callWindowMinutes) || DEFAULTS.callWindowMinutes) * 60 * 1000;
  return list.filter((t) => {
    if (t.type === "location") return !!(inputs && inputs.nearStore);
    const due = new Date(t.dueAt);
    return due.getTime() - now.getTime() <= windowMs && due.getTime() >= now.getTime() - 60 * 60 * 1000;
  }).sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
}

/** Build the plan (and spoken script) for one trigger. */
function buildPlan(trigger) {
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const fmtDay = (iso) => new Date(iso).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  const stops = (trigger.items || []).map((item, i) => ({
    id: trigger.id + "-stop-" + (i + 1),
    name: item,
    done: false,
  }));

  if (trigger.type === "trip" || trigger.type === "appointment") {
    const due = new Date(trigger.dueAt);
    const leave = new Date(due.getTime() - 60 * 60 * 1000); // 1 hr before, incl. stops
    const leaveStr = leave.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return {
      title: trigger.title,
      leaveAt: leave.toISOString(),
      stops,
      bring: trigger.type === "trip" ? ["Confirmation " + (trigger.notes.match(/confirmation (\S+)/i)?.[1] || ""), "Keys, insurance card"].filter(Boolean) : undefined,
      script:
        "Hey Sean, it's Echo. Heads up — " + trigger.title + " is today at " + fmtTime(trigger.dueAt) + ". " +
        "Leave at " + leaveStr + " and you'll make it with time for stops. " +
        (stops.length ? "On the way: " + stops.map((s) => s.name).join("; ") + ". " : "") +
        "Want me to mark anything off the list when you're done?",
    };
  }
  if (trigger.type === "bill") {
    return {
      title: trigger.title,
      pay: trigger.amount ? "$" + trigger.amount + " due " + fmtDay(trigger.dueAt) : undefined,
      script:
        "Hey Sean, it's Echo. Quick one — your " + trigger.title + " is due " + fmtDay(trigger.dueAt) +
        (trigger.amount ? ", about $" + trigger.amount + ". " : ". ") +
        (trigger.notes || "") + " Want me to remind you again tomorrow morning?",
    };
  }
  if (trigger.type === "deadline") {
    return {
      title: trigger.title,
      leaveAt: new Date(new Date(trigger.dueAt).getTime() - 60 * 60 * 1000).toISOString(),
      script:
        "Hey Sean, it's Echo. " + trigger.title + " is " + fmtDay(trigger.dueAt) + " at " + fmtTime(trigger.dueAt) + ". " +
        (trigger.notes || "") + " I'll call you the morning of with the plan.",
    };
  }
  // location
  return {
    title: trigger.title,
    stops,
    script:
      "Hey Sean, it's Echo. You're right by " + (trigger.location || "a store") + ", and the family list has " +
      stops.length + " thing" + (stops.length === 1 ? "" : "s") + " there: " +
      stops.map((s) => s.name).join("; ") + ". Grab them while you're passing?",
  };
}

/**
 * Place a call via Vapi. DRY-RUN BY DEFAULT: builds the exact request that
 * would be sent and returns it without sending. Set dryRun=false in
 * Settings (and paste a real VAPI_API_KEY) only to actually place a call.
 * Never call this in a test — do not place a real call to Sean's phone.
 */
async function placeCall(plan, phone, opts) {
  const cfg = Object.assign({}, loadSettings(), opts || {});
  const payload = {
    assistantId: cfg.vapiAssistantId,
    customer: { number: phone || cfg.userPhone },
    assistantOverrides: {
      firstMessage: plan.script,
      variableValues: { planTitle: plan.title },
    },
  };
  const request = {
    method: "POST",
    url: VAPI_API_BASE + "/call",
    headers: { Authorization: "Bearer " + (cfg.vapiApiKey ? "[key set on device]" : "[VAPI_API_KEY not set]"), "Content-Type": "application/json" },
    body: payload,
  };
  if (cfg.dryRun || !cfg.vapiApiKey) {
    return { status: "dry-run", sent: false, reason: cfg.dryRun ? "Dry-run mode is on (Settings)." : "No Vapi API key set (Settings).", request };
  }
  const res = await fetch(VAPI_API_BASE + "/call", {
    method: "POST",
    headers: { Authorization: "Bearer " + cfg.vapiApiKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.ok ? "placed" : "failed", sent: res.ok, httpStatus: res.status, request, response: data };
}

/* ---------------- State (localStorage; list + stops + setup persist) ------ */
const store = {
  get(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem("sidetrip:" + key)); return v === null || v === undefined ? fallback : v; }
    catch (e) { return fallback; }
  },
  set(key, value) { try { localStorage.setItem("sidetrip:" + key, JSON.stringify(value)); } catch (e) {} },
};

let listItems = store.get("list", SEED_LIST);
let callLog = store.get("callLog", SEED_CALL_LOG);
let stopState = store.get("stops", {}); // stopId -> done
let setupDone = store.get("setup", { s1: true, s2: false, s3: false });

function loadSettings() {
  return Object.assign({}, DEFAULTS, store.get("settings", {}));
}
function saveSettings(patch) {
  const next = Object.assign({}, loadSettings(), patch);
  store.set("settings", next);
  return next;
}

/* ---------------- Sheet sync ---------------------------------------------- */
async function sheetFetch() {
  try {
    const res = await fetch(SHEET_API_URL);
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.items) ? data.items : null;
  } catch (e) { return null; }
}

async function sheetPost(body) {
  try {
    const res = await fetch(SHEET_API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch (e) { return null; }
}

/** Pull the list from the sheet; if it comes back, it replaces the local list. */
async function syncListFromSheet() {
  const items = await sheetFetch();
  if (items) {
    listItems = items;
    store.set("list", listItems);
    renderList();
  }
  return items;
}

/* ---------------- Rendering ----------------------------------------------- */
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function pillFor(type) {
  return '<span class="pill ' + esc(type) + '">' + esc(type) + "</span>";
}

function renderPlans() {
  const triggers = evaluateTriggers({ triggers: SEED_TRIGGERS, now: "2026-11-12T09:30:00-06:00", nearStore: true });
  const wrap = $("#plans");
  if (!wrap) return;
  wrap.innerHTML = triggers.map((t) => {
    const plan = buildPlan(t);
    const leave = plan.leaveAt ? new Date(plan.leaveAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : null;
    const stopsHtml = (plan.stops || []).map((s) => {
      const done = !!stopState[s.id];
      return '<div class="stop' + (done ? " done" : "") + '">' +
        '<button class="check' + (done ? " on" : "") + '" data-stop="' + esc(s.id) + '" aria-label="Mark stop done">' + (done ? "✓" : "") + "</button>" +
        '<div><div class="stop-name">' + esc(s.name) + '</div><div class="stop-detail">Stop on the way — tap the circle when done</div></div></div>';
    }).join("");
    return '<article class="card">' + pillFor(t.type) +
      '<div class="plan-title">' + esc(plan.title) + "</div>" +
      '<p class="plan-meta">📅 ' + esc(new Date(t.dueAt).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })) +
      " · " + esc(new Date(t.dueAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })) + "</p>" +
      (t.location ? '<p class="plan-meta">📍 ' + esc(t.location) + "</p>" : "") +
      (leave ? '<p class="plan-meta">🚗 Leave at <span class="leave">' + esc(leave) + "</span></p>" : "") +
      (plan.pay ? '<p class="plan-meta">💵 Pay: <b>' + esc(plan.pay) + "</b></p>" : "") +
      (t.notes ? '<p class="muted">' + esc(t.notes) + "</p>" : "") +
      (stopsHtml ? "<h3>Stops</h3>" + stopsHtml : "") +
      '<div class="script">“' + esc(plan.script) + "”</div>" +
      '<div class="row"><button class="btn small" data-hear="' + esc(t.id) + '">▶ Hear the call</button>' +
      '<button class="btn small secondary" data-dryrun="' + esc(t.id) + '">Dry-run call</button></div>' +
      '<div class="dryrun-out" id="dryrun-' + esc(t.id) + '"></div>' +
      "</article>";
  }).join("") +
  '<p class="muted small">Plans are built by the SideTrip engine from your triggers — the same engine the server-side watcher runs, so what you see here is what the call will say.</p>';
}

function renderList() {
  const wrap = $("#family-list");
  if (!wrap) return;
  wrap.innerHTML = listItems.map((it) => {
    return '<li class="' + (it.done ? "done" : "") + '">' +
      '<button class="check' + (it.done ? " on" : "") + '" data-item="' + esc(it.id) + '" aria-label="Check off item">' + (it.done ? "✓" : "") + "</button>" +
      '<div style="flex:1"><div class="item-name">' + esc(it.name) + '</div>' +
      '<div class="item-meta">' + esc(it.store) + " · added by " + esc(it.addedBy) + "</div></div>" +
      '<span class="tag">' + esc(it.addedBy) + "</span></li>";
  }).join("");
  const open = listItems.filter((i) => !i.done).length;
  $("#list-count").textContent = open + " open · " + listItems.length + " total";
}

function renderLog() {
  const wrap = $("#call-log");
  if (!wrap) return;
  wrap.innerHTML = callLog.slice().reverse().map((c) => {
    return '<div class="log"><div class="log-time">' + esc(new Date(c.time).toLocaleDateString("en-US", { month: "short", day: "numeric" })) +
      " " + esc(new Date(c.time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })) +
      " — " + esc(c.title) + '</div><div class="muted">' + esc(c.outcome) + ". " + esc(c.detail || "") + "</div></div>";
  }).join("");
}

function renderSetup() {
  const steps = [
    { key: "s1", title: "Download & sign in", body: "Install SideTrip from your home screen, sign in with your phone number. That's the account — no passwords to remember." },
    { key: "s2", title: "Grant calendar & location", body: "SideTrip reads your calendar and location so it can spot trips, deadlines and nearby stores. Nothing else is read without asking." },
    { key: "s3", title: "Add your family", body: "Add the people who share your list — Sean, Aimee, Echo. Everyone sees the same list; anyone can add to it." },
  ];
  $("#setup-steps").innerHTML = steps.map((s, i) =>
    '<li class="' + (setupDone[s.key] ? "done" : "") + '"><b>' + esc(s.title) + "</b><br><span class='muted'>" + esc(s.body) + "</span><br>" +
    '<button class="btn small ' + (setupDone[s.key] ? "secondary" : "") + '" data-setup="' + s.key + '">' + (setupDone[s.key] ? "Done ✓ — undo" : "Mark done") + "</button></li>"
  ).join("");
}

function renderSettings() {
  const s = loadSettings();
  $("#set-key").value = s.vapiApiKey || "";
  $("#set-assistant").value = s.vapiAssistantId || "";
  $("#set-phone").value = s.userPhone || "";
  $("#set-dryrun").checked = !!s.dryRun;
  $("#set-pricing").value = s.pricingModel || "subscription";
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.style.display = "block";
  setTimeout(() => { t.style.display = "none"; }, 2600);
}

/* ---------------- Events --------------------------------------------------- */
document.addEventListener("click", (e) => {
  const stopBtn = e.target.closest("[data-stop]");
  if (stopBtn) {
    const id = stopBtn.getAttribute("data-stop");
    stopState[id] = !stopState[id];
    store.set("stops", stopState);
    renderPlans();
    toast(stopState[id] ? "Stop marked done ✓" : "Stop marked open");
    return;
  }
  const itemBtn = e.target.closest("[data-item]");
  if (itemBtn) {
    const id = itemBtn.getAttribute("data-item");
    listItems = listItems.map((it) => it.id === id ? Object.assign({}, it, { done: !it.done }) : it);
    store.set("list", listItems);
    renderList();
    const toggled = listItems.find((it) => it.id === id);
    if (toggled) sheetPost({ action: "toggle", id, done: toggled.done });
    return;
  }
  const setupBtn = e.target.closest("[data-setup]");
  if (setupBtn) {
    const k = setupBtn.getAttribute("data-setup");
    setupDone[k] = !setupDone[k];
    store.set("setup", setupDone);
    renderSetup();
    return;
  }
  const hearBtn = e.target.closest("[data-hear]");
  if (hearBtn) {
    const t = SEED_TRIGGERS.find((x) => x.id === hearBtn.getAttribute("data-hear"));
    if (t) {
      const plan = buildPlan(t);
      const box = $("#script-preview");
      box.innerHTML = "<h3>Hear the call — " + esc(plan.title) + '</h3><div class="script">“' + esc(plan.script) + "”</div>" +
        '<p class="muted small">Spoken by Brooke (Vapi voice assistant) when the trigger fires. Audio playback is a bonus — the script above is exactly what she says.</p>';
      if (box.scrollIntoView) box.scrollIntoView({ behavior: "smooth", block: "center" });
      if ("speechSynthesis" in window) {
        try {
          speechSynthesis.cancel();
          const u = new SpeechSynthesisUtterance(plan.script);
          speechSynthesis.speak(u);
          toast("Playing the call script 🔊");
        } catch (err) { /* speech is a bonus; script text is the deliverable */ }
      }
    }
    return;
  }
  const dryBtn = e.target.closest("[data-dryrun]");
  if (dryBtn) {
    const t = SEED_TRIGGERS.find((x) => x.id === dryBtn.getAttribute("data-dryrun"));
    if (t) {
      const plan = buildPlan(t);
      placeCall(plan).then((result) => {
        const out = $("#dryrun-" + t.id);
        out.innerHTML = '<details open><summary>Dry-run call request (nothing was sent)</summary><pre class="payload">' +
          esc(JSON.stringify(result.request, null, 2)) + "</pre><p class='muted small'>" + esc(result.reason || result.status) + "</p></details>";
      });
    }
    return;
  }
  const tab = e.target.closest("[data-tab]");
  if (tab) {
    document.querySelectorAll("nav.tabs button").forEach((b) => b.classList.toggle("active", b === tab));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + tab.getAttribute("data-tab")));
    window.scrollTo({ top: 0 });
  }
});

document.addEventListener("submit", (e) => {
  if (e.target.id === "add-item-form") {
    e.preventDefault();
    const name = $("#new-item-name").value.trim();
    const storeName = $("#new-item-store").value.trim() || "Anywhere";
    if (!name) return;
    listItems = listItems.concat([{ id: "l-" + Date.now(), name, store: storeName, addedBy: "Sean", done: false }]);
    store.set("list", listItems);
    e.target.reset();
    renderList();
    toast("Added to the family list ✓");
    // Sync to the sheet; re-fetch so the item picks up the sheet's canonical ID.
    sheetPost({ action: "add", name, store: storeName, addedBy: "Sean" }).then(() => syncListFromSheet());
  }
  if (e.target.id === "settings-form") {
    e.preventDefault();
    saveSettings({
      vapiApiKey: $("#set-key").value.trim(),
      vapiAssistantId: $("#set-assistant").value.trim(),
      userPhone: $("#set-phone").value.trim(),
      dryRun: $("#set-dryrun").checked,
      pricingModel: $("#set-pricing").value,
    });
    toast("Settings saved on this device ✓");
  }
});

/* ---------------- Boot ------------------------------------------------------ */
renderPlans();
renderList();
renderLog();
renderSetup();
renderSettings();
syncListFromSheet(); // load the shared list from Google Sheets (localStorage stays as offline fallback)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").then(
      () => console.log("[SideTrip] service worker registered"),
      (err) => console.warn("[SideTrip] service worker failed:", err)
    );
  });
}
