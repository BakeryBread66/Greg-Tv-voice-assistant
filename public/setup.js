// The setup screen: what this PC has, what Greg still needs, and a progress bar
// for each download. The server does the work (lib/setup.js) and reports over
// the event stream; this page only asks, shows and listens.
//
// It opens by itself once, on a first run that is missing something — and
// never again after "Not now", which is saved. Settings → General reopens it.

const $ = (id) => document.getElementById(id);

let state = null; // the last /api/setup answer
let running = false;
const progress = {}; // step id -> latest update

const mb = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`);

function machineLine(s) {
  const card = s.gpu ? `${s.gpu.name} (${Math.round(s.gpu.vramMB / 1024)} GB)` : "no NVIDIA graphics card, so he'll hear you on the processor";
  const ollama = s.ollama.running ? "Ollama is running" : s.ollama.installed ? "Ollama is installed but not running — start it from the Start menu" : "Ollama isn't installed yet — this will install it";
  const engines = s.whisperBuild ? "" : " His hearing and voice are set up by setup-greg.sh on this system.";
  return `This PC: ${card}. ${ollama}.${engines}`;
}

function statusOf(step) {
  const p = progress[step.id];
  if (p?.state === "failed") return { text: `Failed: ${p.error}`, bad: true };
  if (p?.state === "done" || (step.done && !p)) return { text: "Installed" };
  if (p?.state === "working") {
    if (p.total) return { text: `${Math.floor((100 * p.received) / p.total)}% of ${mb(p.total)}`, fraction: p.received / p.total };
    return { text: "Working…", fraction: null };
  }
  return { text: step.bytes ? mb(step.bytes) : step.note ?? "" };
}

function paint() {
  if (!state) return;
  const s = state.survey;
  $("setup-machine").textContent = machineLine(s);

  const list = $("setup-steps");
  list.replaceChildren();
  for (const step of state.steps) {
    const status = statusOf(step);
    const row = document.createElement("li");
    const text = document.createElement("span");
    text.className = "mem-text";
    text.textContent = step.label;
    const when = document.createElement("span");
    when.className = `mem-when${status.bad ? " bad" : ""}`;
    when.textContent = status.text;
    text.append(when);
    row.append(text);
    if (status.fraction !== undefined) {
      const bar = document.createElement("div");
      bar.className = "meter setup-meter";
      const fill = document.createElement("div");
      fill.className = "meter-fill";
      fill.style.width = status.fraction === null ? "100%" : `${Math.round(status.fraction * 100)}%`;
      if (status.fraction === null) fill.classList.add("busy");
      bar.append(fill);
      row.append(bar);
    }
    list.append(row);
  }

  $("setup-eyes-row").hidden = !s.eyesFit;
  const todo = state.steps.filter((step) => !step.done && progress[step.id]?.state !== "done");
  const bytes = todo.reduce((sum, step) => sum + (step.bytes || 0), 0);
  const free = state.freeBytes;
  $("setup-total").textContent = !todo.length
    ? "Everything he needs is installed."
    : `About ${mb(bytes)} to download${free ? `, with ${mb(free)} free here` : ""}.${free && free < bytes * 1.2 ? " That may not be enough room." : ""}`;

  const go = $("setup-go");
  go.disabled = running || !todo.length;
  go.textContent = running ? "Installing…" : "Install";
  $("setup-later").textContent = running || !todo.length ? "Close" : "Not now";
}

function problem(text) {
  $("setup-problem").textContent = text ?? "";
  $("setup-problem").hidden = !text;
}

async function load() {
  const eyes = $("setup-eyes").checked ? "1" : "0";
  state = await (await fetch(`/api/setup?eyes=${eyes}`, { cache: "no-store" })).json();
  if (state.run?.running) {
    running = true;
    Object.assign(progress, state.run.progress ?? {});
  }
}

export async function openSetup() {
  problem(null);
  try {
    await load();
  } catch {
    problem("Couldn't reach Greg to check what's installed.");
  }
  paint();
  $("setup").hidden = false;
}

/** On a first run that is missing something, once. */
export async function maybeOpenSetup() {
  try {
    await load();
    if (state.needed && !state.dismissed) {
      paint();
      $("setup").hidden = false;
    }
  } catch {
    /* a setup check failing must never stand in the way of Greg starting */
  }
}

async function install() {
  problem(null);
  running = true;
  for (const key of Object.keys(progress)) delete progress[key];
  paint();
  try {
    const res = await fetch("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "run", eyes: $("setup-eyes").checked }),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? `setup answered ${res.status}`);
  } catch (err) {
    running = false;
    problem(err.message);
    paint();
  }
}

async function later() {
  const nothingLeft = state && !state.steps.some((step) => !step.done);
  $("setup").hidden = true;
  // "Not now" is remembered; closing after it finished, or while it runs, is not a no.
  if (!running && !nothingLeft) {
    fetch("/api/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "dismiss" }) }).catch(() => {});
  }
}

/** Events from the server's run, pushed down the page's event stream. */
export function onSetupEvent(payload) {
  if (payload.type === "setup" && payload.run) {
    running = true;
    if (state) state.steps = payload.run.steps;
  } else if (payload.type === "setup-step") {
    progress[payload.id] = payload;
  } else if (payload.type === "setup-done") {
    running = false;
    if (payload.state) state = payload.state;
    const failed = Object.entries(payload.run?.results ?? {}).filter(([, v]) => v === "failed");
    problem(failed.length ? "Some of it didn't install — the reason is beside each one. Install tries those again." : null);
  }
  if (!$("setup").hidden) paint();
}

export function initSetup() {
  $("setup-go")?.addEventListener("click", install);
  $("setup-later")?.addEventListener("click", later);
  $("setup-x")?.addEventListener("click", () => ($("setup").hidden = true));
  $("setup-eyes")?.addEventListener("change", async () => {
    await load().catch(() => {});
    paint();
  });
}
