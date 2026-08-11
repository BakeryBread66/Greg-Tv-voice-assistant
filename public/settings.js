// The settings dialog.
//
// It holds no state of its own. Opening it reads /api/settings, applying posts a
// patch back, and the server broadcasts the result to every window — which is how
// a personality dial moved by VOICE moves the slider here, and a wake word
// changed here reaches the listener that has to match it. The page paints what
// the server last said; see lib/settings.js.
//
// Only the settings that take effect without a restart are here. A control that
// silently does nothing until you restart is worse than no control.

// The Music tab's wording, kept DOM-free so it can be tested — the same reason
// wake.js and mic-help.js exist.
import { spotifyGuidance } from "./spotify-help.js";

const $ = (id) => document.getElementById(id);

// Desktops worth offering, rather than only a colour wheel. The first is the
// Windows 98 teal this shipped with and stays the default; the second is the
// blue later versions actually used.
const DESKTOPS = [
  ["#008080", "Teal"],
  ["#3a6ea5", "Windows blue"],
  ["#5f9ea0", "Cadet"],
  ["#6a5acd", "Slate"],
  ["#808000", "Olive"],
  ["#000000", "Black"],
];

/**
 * The volume out of a settings state, 0..1.
 *
 * Absence means "full", not "silent" — an older config.json has no volume key at
 * all, and reading that as zero would open a silent Greg with a dialog claiming
 * 0%. Absence has to be tested for before conversion, which is the lesson
 * `Number(null)` being a perfectly finite 0 taught this project once already.
 */
const volumeOf = (state) => {
  const raw = state?.volume;
  if (raw === undefined || raw === null || raw === "") return 1;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
};

let current = null;   // the last state the server gave us
let pendingPlace = null; // a location chosen from search but not yet applied
let onApplied = () => {};
let meterTimer = null;
let readMic = () => null;
let listMics = async () => [];
let switchMic = async () => ({ error: "not wired" });
let onVolumePreview = () => {};

export function initSettings({ onApply, micReader, listMicrophones, switchMicrophone, volumePreview } = {}) {
  onApplied = onApply ?? (() => {});
  readMic = micReader ?? (() => null);
  listMics = listMicrophones ?? (async () => []);
  switchMic = switchMicrophone ?? (async () => ({ error: "not wired" }));
  onVolumePreview = volumePreview ?? (() => {});

  // Applied immediately rather than on OK: you need to talk and watch the meter
  // to know whether you picked the right one, and a control you cannot test
  // until you close the dialog is no better than editing the file.
  $("set-mic")?.addEventListener("change", async (event) => {
    const note = $("set-mic-note");
    note.textContent = "Switching…";
    const result = await switchMic(event.target.value || null);
    note.textContent = result.error
      ? result.error
      : `Listening to ${result.label}. Talk — the bar below should move.`;
    // Persist it so the choice survives a restart, and so an unplugged device
    // can be recognised and fallen back from next time.
    if (!result.error) apply();
  });

  $("settings-btn")?.addEventListener("click", open);
  $("settings-x")?.addEventListener("click", close);
  $("settings-cancel")?.addEventListener("click", close);
  $("settings-apply")?.addEventListener("click", () => apply());
  $("settings-ok")?.addEventListener("click", async () => {
    if (await apply()) close();
  });

  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => showTab(tab.dataset.tab));
  }

  // Escape closes, which is what a Win98 dialog did and what fingers expect.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("settings").hidden) close();
  });

  $("set-place-go")?.addEventListener("click", searchPlace);
  $("set-place")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    // Enter in the search box must not submit the dialog — this is a search,
    // and the OK button is several tab stops away for a reason.
    event.preventDefault();
    searchPlace();
  });

  // Choosing a place is also choosing "always use this place"; making the user
  // then find the radio button would be a trap.
  $("set-place-results")?.addEventListener("click", (event) => {
    const item = event.target.closest("li[data-lat]");
    if (!item) return;
    pendingPlace = {
      city: item.dataset.city,
      region: item.dataset.region,
      latitude: Number(item.dataset.lat),
      longitude: Number(item.dataset.lon),
    };
    setRadio("loc", "fixed");
    $("set-place-results").hidden = true;
    $("set-place").value = "";
    paintPlace();
  });

  $("set-vocoder-amount")?.addEventListener("input", (e) => {
    $("set-vocoder-out").value = e.target.value + "%";
  });

  // Live, on "input" rather than on Apply — a volume you have to commit to
  // before hearing is a worse control than the knob it duplicates, and the same
  // reasoning that makes the desktop colour preview as you pick it. Cancel needs
  // no special handling: close() repaints from the last server state.
  $("set-volume")?.addEventListener("input", (e) => {
    const percent = Number(e.target.value);
    $("set-volume-out").value = percent === 0 ? "mute" : percent + "%";
    onVolumePreview?.(percent / 100);
  });

  buildDials();

  // Deep link: /?settings or #settings opens straight into the dialog. Handy for
  // a bookmark, and it is the only way to see this thing rendered at the real
  // window size — the browser pane does not composite, so it cannot be
  // screenshotted, and nothing in here can be clicked from outside.
  const asked = new URLSearchParams(location.search).has("settings") || location.hash === "#settings";
  if (asked) open();
}

/** The server changed something — repaint, whoever caused it. */
export function paintSettings(state) {
  current = state;
  if (!state) return;

  $("set-name").value = state.name ?? "";
  $("set-wake").value = (state.wakeWords ?? []).join("\n");
  paintSpotify(state.spotify);
  setRadio("temp", state.units?.temperature ?? "fahrenheit");
  setRadio("wind", state.units?.windSpeed ?? "mph");

  setRadio("loc", state.location?.auto ? "auto" : "fixed");
  paintPlace();

  const p = state.personality ?? {};
  for (const name of Object.keys(state.traits ?? {})) {
    const slider = $(`dial-${name}`);
    if (slider && p[name] !== undefined) {
      slider.value = p[name];
      slider.nextElementSibling.value = p[name];
    }
  }
  $("set-mirror").checked = p.mirror !== false;
  $("set-style").value = p.style ?? "";
  paintPersonas(state.personas);
  paintVoices(state.voices, state.currentVoice, state.clone);
  paintDesktop(state.appearance?.background ?? "#008080");

  $("set-subtitles").value = state.subtitles ?? "auto";

  const percent = Math.round(volumeOf(state) * 100);
  $("set-volume").value = percent;
  $("set-volume-out").value = percent === 0 ? "mute" : percent + "%";

  const v = state.vocoder ?? {};
  $("set-vocoder").checked = v.enabled === true;
  const amount = Math.round((Number(v.amount) || 0) * 100);
  $("set-vocoder-amount").value = amount;
  $("set-vocoder-out").value = amount + "%";

  const l = state.listening ?? {};
  $("set-followup").checked = l.followUpEnabled !== false;
  $("set-followup-secs").value = l.followUpSeconds ?? 7;
  $("set-barge").checked = l.bargeInEnabled !== false;
  $("set-barge-ms").value = l.bargeInSustainMs ?? 600;
  $("set-minlevel").value = l.minLevel ?? 0.012;
  $("set-floor").value = l.floorMultiple ?? 3.5;
  paintMicrophones(l.deviceId ?? "");
}

async function paintMicrophones(chosen) {
  const select = $("set-mic");
  const note = $("set-mic-note");
  if (!select) return;

  const mics = await listMics();
  select.innerHTML = "";

  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "Whatever Windows is using (default)";
  select.appendChild(auto);

  for (const mic of mics) {
    const option = document.createElement("option");
    option.value = mic.id;
    option.textContent = mic.label;
    select.appendChild(option);
  }

  // A saved device that is no longer present must still be visible, or the
  // picker silently shows "default" while the setting says otherwise.
  if (chosen && !mics.some((m) => m.id === chosen)) {
    const missing = document.createElement("option");
    missing.value = chosen;
    missing.textContent = "(saved device — not plugged in)";
    select.appendChild(missing);
  }
  select.value = chosen;

  if (!mics.length) {
    note.textContent = "No microphones listed yet — wake Greg once so Windows lets the page see them.";
  } else if (chosen && !mics.some((m) => m.id === chosen)) {
    note.textContent = "The saved microphone isn't plugged in. Pick one that is.";
  } else {
    note.textContent = "Pick one, then talk and watch the bar at the bottom of this tab.";
  }
}

function paintPlace() {
  const note = $("set-place-current");
  const chosen = pendingPlace;
  const saved = current?.location ?? {};

  if (chosen) {
    note.textContent = `Will use: ${[chosen.city, chosen.region].filter(Boolean).join(", ")} — not saved yet.`;
  } else if (saved.auto) {
    note.textContent = "Currently following your IP address.";
  } else if (saved.latitude != null) {
    note.textContent = `Currently pinned to ${[saved.city, saved.region].filter(Boolean).join(", ")}.`;
  } else {
    note.textContent = "No place pinned yet — search for one.";
  }
}

/**
 * The character list, from the server's own folder.
 *
 * Deliberately starts on "Keep as is" rather than guessing which persona the
 * current dials came from. There is no reliable answer to that — you can move a
 * slider after picking a character, and a dropdown claiming you are still the
 * butler when you are not would be a small lie of exactly the kind this project
 * spends its time removing.
 */
function paintPersonas(personas) {
  const select = $("set-persona");
  const note = $("set-persona-note");
  if (!select) return;

  select.innerHTML = `<option value="">Keep as is</option>`;
  for (const persona of personas ?? []) {
    const option = document.createElement("option");
    option.value = persona.id;
    option.textContent = persona.name;
    option.dataset.description = persona.description ?? "";
    select.appendChild(option);
  }

  const describe = () => {
    const chosen = select.selectedOptions[0];
    note.textContent = select.value
      ? `${chosen.dataset.description || ""} Applying this sets the name and all six dials.`.trim()
      : "Pick a character to change his name, what he thinks he is, and every dial at once.";
  };
  select.onchange = describe;
  describe();
}

/**
 * The voice list, from the same folder listing the server reads.
 *
 * Unlike the character dropdown this one CAN honestly show what is selected —
 * a voice has exactly one answer, where "which persona did these dials come
 * from" has none once you have moved a slider.
 *
 * Two things it must be straight about, both of which a naive dropdown gets
 * wrong by omission:
 *
 *   - A cloned voice takes about 45 seconds and he keeps talking in the old one
 *     meanwhile. Applying and hearing no change is indistinguishable from a
 *     broken control unless it says so first.
 *   - Cloned voices can be listed and unusable — switched off in config, parked
 *     by gaming mode, or the sidecar never started. Offering them without
 *     saying that is a menu where half the entries silently do nothing.
 */
function paintVoices(voices, current, clone) {
  const select = $("set-voice");
  const note = $("set-voice-note");
  if (!select) return;

  const list = voices ?? [];
  const cloneBlocked = clone && clone.ready === false;

  select.innerHTML = `<option value="">Keep as is</option>`;
  for (const voice of list) {
    const option = document.createElement("option");
    option.value = voice.id;
    // The kind matters to the person choosing: one is a real person's voice and
    // slow to load, the other is instant. Saying which is not decoration.
    const isClone = voice.kind === "clone";
    option.textContent = `${voice.label}${isClone ? " — cloned" : ""}${voice.id === current ? " (current)" : ""}`;
    option.dataset.kind = voice.kind;
    // Left selectable on purpose even when blocked. The choice is still SAVED,
    // which is what makes "turn gaming mode off and it will load" a delay
    // rather than a dead end — so disabling it would remove a working path.
    if (isClone && cloneBlocked) option.textContent += " — unavailable";
    select.appendChild(option);
  }

  if (!list.length) {
    select.innerHTML = `<option value="">No voices found</option>`;
  }

  const describe = () => {
    const chosen = select.selectedOptions[0];
    const kind = chosen?.dataset.kind;

    if (!list.length) {
      note.textContent = "Nothing in the voices folder yet. Greg downloads one on his first run.";
      return;
    }
    if (!select.value) {
      note.textContent = cloneBlocked
        ? `Leave it as it is. Note: ${clone.fix}`
        : "Pick a voice. Drop a .wav in the voices folder to clone somebody from about ten seconds of recording.";
      return;
    }
    if (kind === "clone" && cloneBlocked) {
      // The choice is saved either way; say what is actually true.
      note.textContent = `This will be saved, but he will not change voice yet. ${clone.fix}`;
      return;
    }
    note.textContent =
      kind === "clone"
        ? "A cloned voice takes about 45 seconds to load. He keeps talking in his current voice until it is ready."
        : "This one loads in about a second, so it applies to the next thing he says.";
  };
  select.onchange = describe;
  describe();
}

/**
 * The desktop colour: presets plus a picker.
 *
 * Painted live as you touch it, and NOT only on Apply — the whole point is
 * choosing a colour you can see, and a swatch you have to commit to before
 * looking at is a worse control than the text field it replaced.
 */
function paintDesktop(colour) {
  const input = $("set-bg");
  const hex = $("set-bg-hex");
  const row = $("set-bg-swatches");
  if (!input) return;

  const show = (value) => {
    input.value = value;
    hex.value = value;
    document.documentElement.style.setProperty("--desktop", value);
    for (const button of row.querySelectorAll("button")) {
      button.setAttribute("aria-pressed", String(button.dataset.colour === value));
    }
  };

  if (!row.childElementCount) {
    for (const [value, label] of DESKTOPS) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.colour = value;
      button.style.background = value;
      button.title = label;
      button.setAttribute("aria-label", label);
      button.addEventListener("click", () => show(value));
      row.appendChild(button);
    }
    input.addEventListener("input", () => show(input.value));
  }

  show(colour);
}

function buildDials() {
  // Built from whatever the server says the dials are, rather than a copy of the
  // list — lib/personality.js owns TRAITS, and a second copy here would be one
  // release away from disagreeing with it.
  const host = $("set-dials");
  if (!host) return;
  host.innerHTML = "";
}

function renderDials(traits, values) {
  const host = $("set-dials");
  if (!host || host.childElementCount) return; // built once
  for (const [name, meta] of Object.entries(traits ?? {})) {
    const row = document.createElement("label");
    row.className = "dial";
    row.title = meta.describes ?? "";
    row.innerHTML =
      `<span>${meta.label}</span>` +
      `<input id="dial-${name}" type="range" min="0" max="100" step="1" value="${values?.[name] ?? 50}" />` +
      `<output>${values?.[name] ?? 50}</output>`;
    host.appendChild(row);
    const slider = row.querySelector("input");
    slider.addEventListener("input", () => {
      row.querySelector("output").value = slider.value;
    });
  }
}

async function open() {
  const dialog = $("settings");
  pendingPlace = null;
  problem(null);

  try {
    const state = await (await fetch("/api/settings", { cache: "no-store" })).json();
    renderDials(state.traits, state.personality);
    paintSettings(state);
  } catch {
    problem("Couldn't reach Greg to read his settings.");
  }

  dialog.hidden = false;
  showTab("general");
  startMeter();
}

function close() {
  $("settings").hidden = true;
  pendingPlace = null;
  stopMeter();
  // Throw away anything typed but not applied, so reopening shows the truth
  // rather than a half-edited form.
  if (current) {
    paintSettings(current);
    // And put the sound back where the server has it. The volume slider previews
    // as you drag it, so unlike every other control in here it has already
    // changed something outside this dialog — Cancel has to undo that, or you
    // are left quieter than the setting says you are with nothing on screen
    // disagreeing. The desktop colour gets this for free because paintSettings
    // repaints the CSS variable; this one is a live audio node and does not.
    onVolumePreview(volumeOf(current));
  }
}

function showTab(name) {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
  }
  for (const page of document.querySelectorAll(".tab-page")) {
    page.hidden = page.dataset.page !== name;
  }
}

function problem(text) {
  const box = $("settings-problem");
  box.textContent = text ?? "";
  box.hidden = !text;
}

function setRadio(group, value) {
  for (const input of document.querySelectorAll(`input[name="${group}"]`)) {
    input.checked = input.value === value;
  }
}

const radio = (group) => document.querySelector(`input[name="${group}"]:checked`)?.value;

/** Everything the form is currently showing, as a patch for the server. */
function collect() {
  const auto = radio("loc") === "auto";
  const saved = current?.location ?? {};

  return {
    name: $("set-name").value,
    wakeWords: $("set-wake").value.split("\n").map((w) => w.trim()).filter(Boolean),
    units: { temperature: radio("temp"), windSpeed: radio("wind") },
    location: auto
      ? { auto: true }
      : {
          auto: false,
          // A place picked from search this time, otherwise whatever is already
          // pinned — so switching tabs and pressing Apply doesn't wipe it.
          ...(pendingPlace ?? {
            city: saved.city,
            region: saved.region,
            latitude: saved.latitude,
            longitude: saved.longitude,
          }),
        },
    // Empty means "leave him as he is". When it is set the server overrides the
    // name and the dials below with the character's own, because those controls
    // are still showing the person he is now rather than the one being chosen.
    appearance: { background: $("set-bg")?.value ?? "#008080" },
    persona: $("set-persona")?.value ?? "",
    // Empty means "leave the voice alone", same as the character box. A persona
    // in the same patch WINS over this — resolved at the top of applySettings —
    // because picking a character and a voice at once should give you the
    // character's voice, not a hybrid of the two.
    voice: $("set-voice")?.value ?? "",
    volume: Number($("set-volume").value) / 100,
    subtitles: $("set-subtitles").value,
    vocoder: {
      enabled: $("set-vocoder").checked,
      amount: Number($("set-vocoder-amount").value) / 100,
    },
    personality: {
      ...Object.fromEntries(
        Object.keys(current?.traits ?? {}).map((name) => [name, Number($(`dial-${name}`)?.value ?? 50)])
      ),
      mirror: $("set-mirror").checked,
      style: $("set-style").value,
    },
    listening: {
      followUpEnabled: $("set-followup").checked,
      followUpSeconds: Number($("set-followup-secs").value),
      bargeInEnabled: $("set-barge").checked,
      bargeInSustainMs: Number($("set-barge-ms").value),
      minLevel: Number($("set-minlevel").value),
      floorMultiple: Number($("set-floor").value),
      deviceId: $("set-mic")?.value ?? "",
    },
  };
}

async function apply() {
  problem(null);
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collect()),
    });
    const result = await res.json();

    if (result.state) {
      pendingPlace = null;
      paintSettings(result.state);
      onApplied(result.state);
    }

    if (result.problems?.length) {
      problem(result.problems.join(" "));
      return false;
    }
    return true;
  } catch {
    problem("Couldn't reach Greg to save that.");
    return false;
  }
}

async function searchPlace() {
  const query = $("set-place").value.trim();
  const list = $("set-place-results");
  if (!query) return;

  list.innerHTML = "<li>Searching…</li>";
  list.hidden = false;

  try {
    const { results } = await (await fetch(`/api/geocode?q=${encodeURIComponent(query)}`)).json();
    if (!results?.length) {
      list.innerHTML = "<li>Nothing found.</li>";
      return;
    }
    list.innerHTML = "";
    for (const r of results) {
      const city = r.city ?? r.name ?? "";
      const region = r.region ?? r.admin1 ?? "";
      const item = document.createElement("li");
      item.dataset.lat = r.latitude;
      item.dataset.lon = r.longitude;
      item.dataset.city = city;
      item.dataset.region = region;
      item.innerHTML = `${city}<span class="muted">, ${[region, r.country].filter(Boolean).join(", ")}</span>`;
      list.appendChild(item);
    }
  } catch {
    list.innerHTML = "<li>Search failed.</li>";
  }
}

// --- The live level meter ---------------------------------------------------
//
// The mic trigger is the one setting you cannot choose sensibly in the abstract:
// 0.012 means nothing until you can see where your own voice lands against it.
// Same reasoning as the ?mic readout, put where the control is.

function startMeter() {
  stopMeter();
  meterTimer = setInterval(() => {
    const mic = readMic();
    const fill = $("set-meter-fill");
    const mark = $("set-meter-mark");
    const text = $("set-meter-text");
    if (!fill) return;

    if (!mic) {
      fill.style.width = "0%";
      mark.style.left = "0%";
      text.textContent = "level — · no offline microphone on this page";
      return;
    }

    // 0.08 full scale: normal speech lands around a third to half of it.
    const pct = (v) => Math.max(0, Math.min(100, (v / 0.08) * 100));
    const trigger = Number($("set-minlevel").value) || mic.threshold;
    fill.style.width = `${pct(mic.level)}%`;
    mark.style.left = `${pct(Math.max(trigger, mic.floor * (Number($("set-floor").value) || 3.5)))}%`;
    text.textContent =
      `level ${mic.level.toFixed(4)} · room ${mic.floor.toFixed(4)} · fires at ` +
      `${Math.max(trigger, mic.floor * (Number($("set-floor").value) || 3.5)).toFixed(4)}`;
  }, 120);
}

function stopMeter() {
  clearInterval(meterTimer);
  meterTimer = null;
}


/**
 * Fill the Music tab in.
 *
 * Reports rather than sets: the client id lives in .env and needs a restart, so
 * there is no honest control to offer here. What there IS is the one live step
 * — authorising — which takes effect immediately and therefore earns its place
 * in a dialog, by the same rule that keeps model names and ports out of it.
 */
function paintSpotify(status) {
  const line = $("set-spotify-state");
  const steps = $("set-spotify-steps");
  if (!line || !steps) return;

  const guide = spotifyGuidance(status ?? {}, location.origin);

  line.textContent = guide.headline;
  line.className = "field-note" + (guide.state === "connected" ? " ok" : "");

  steps.replaceChildren();
  const list = document.createElement("ol");
  list.className = "steps";
  for (const step of guide.steps) {
    const item = document.createElement("li");
    item.textContent = step;
    list.appendChild(item);
  }
  steps.appendChild(list);

  if (guide.action) {
    // A real link rather than a button: it has to open in an ordinary window
    // with an address bar, because Spotify's approval page is somewhere you
    // should be able to see the URL of before you approve anything.
    const link = document.createElement("a");
    link.href = guide.action.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = guide.action.label;
    link.className = "btn";
    steps.appendChild(link);
  }
}
