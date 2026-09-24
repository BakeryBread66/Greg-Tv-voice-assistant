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
import { hotkeyFromEvent, hotkeyProblem, normaliseHotkey } from "./hotkey.js";

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

  // The talk key is chosen by pressing it, not by typing its name.
  $("set-talkkey")?.addEventListener("keydown", (event) => {
    if (event.key === "Tab") return; // still a way out of the box
    event.preventDefault();
    event.stopPropagation(); // Escape here must not close the dialog
    if (event.key === "Escape") return event.target.blur();
    if (event.key === "Backspace" || event.key === "Delete") {
      event.target.value = "";
    } else {
      const combo = hotkeyFromEvent(event);
      if (!combo) return; // only Ctrl or Alt so far: still reaching for the key
      event.target.value = normaliseHotkey(combo) || combo;
    }
    paintTalkKeyNote();
  });
  $("set-talkkey-clear")?.addEventListener("click", () => {
    $("set-talkkey").value = "";
    paintTalkKeyNote();
  });

  $("phone-enabled")?.addEventListener("change", (event) => phoneAction({ action: "enable", on: event.target.checked }));
  $("phone-keep")?.addEventListener("change", (event) => phoneAction({ action: "keep-running", on: event.target.checked }));
  $("phone-pair")?.addEventListener("click", () => phoneAction({ action: "pair" }));
  $("phone-pair-cancel")?.addEventListener("click", () => phoneAction({ action: "cancel-pair" }));

  $("brain-use")?.addEventListener("click", useChosenBrain);
  $("brain-key-save")?.addEventListener("click", saveBrainKey);
  $("brain-key-remove")?.addEventListener("click", removeBrainKey);
  $("brain-model")?.addEventListener("change", paintBrainButton);
  for (const radio of document.querySelectorAll('input[name="brain"]')) radio.addEventListener("change", paintBrainButton);
  $("brain-key")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveBrainKey();
    }
  });

  $("mem-add")?.addEventListener("click", addFact);
  $("mem-new")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addFact();
    }
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
  $("set-followup").value = l.followUpMode ?? (l.followUpEnabled === false ? "off" : "always");
  $("set-followup-secs").value = l.followUpSeconds ?? 7;
  $("set-barge").checked = l.bargeInEnabled !== false;
  $("set-barge-ms").value = l.bargeInSustainMs ?? 600;
  $("set-minlevel").value = l.minLevel ?? 0.012;
  $("set-floor").value = l.floorMultiple ?? 3.5;
  paintMicrophones(l.deviceId ?? "");

  $("set-talkkey").value = state.pushToTalk?.key ?? "";
  paintTalkKeyNote();
}

/**
 * What the talk key will do — and where, which depends on whether Greg.exe
 * managed to claim it from Windows. Never says "everywhere" unless it did.
 */
function paintTalkKeyNote() {
  const note = $("set-talkkey-note");
  if (!note) return;
  const typed = $("set-talkkey").value;
  const problem = hotkeyProblem(typed);
  if (problem) {
    note.textContent = problem;
    return;
  }
  const key = normaliseHotkey(typed);
  if (!key) {
    note.textContent = "Click the box and press a key. One press and he listens, with no wake word. F9, Pause, or a letter with Ctrl or Alt all work.";
    return;
  }
  const saved = current?.pushToTalk ?? {};
  const report = saved.key === key ? saved.global : null;
  if (key !== saved.key) note.textContent = `Press Apply to use ${key}.`;
  else if (report?.claimed) note.textContent = `${key} works in every program — Greg.exe has it.`;
  else if (report) note.textContent = `${key} only works while his window is in front: ${report.problem || "Windows would not give it to Greg.exe."}`;
  else note.textContent = `${key} works while his window is in front. Start him from Greg.exe and it works in every program.`;
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
      // The blocked case leads with the PROBLEM, not with "leave it as it is".
      // Reported by somebody who had just added a voice and was told to leave
      // things alone, with the actual fault trailing after a "Note:" — advice
      // about the dropdown where they needed the reason their voice failed.
      note.textContent = cloneBlocked
        ? `Cloned voices are unavailable. ${clone.fix}`
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
  // Read fresh every time it is shown: a reminder may have gone off, or he may
  // have learned something, since the dialog opened.
  if (name === "memory") loadMemory();
  if (name === "brain") loadBrain();
  if (name === "phone") loadPhone();
  else clearInterval(phoneTick);
}

// ---------------------------------------------------------------------------
// The Memory tab
//
// Each change is sent the moment it is made, and the lists are repainted from
// what the server says is stored afterwards — never from what this page assumed
// its change did. Everything the user or the model wrote goes in as
// textContent: these strings came from speech and from a model, and neither is
// allowed to be markup.
// ---------------------------------------------------------------------------

async function loadMemory() {
  memoryProblem(null);
  try {
    paintMemory(await (await fetch("/api/memory", { cache: "no-store" })).json());
  } catch {
    memoryProblem("Couldn't reach Greg to read what he knows.");
  }
}

async function memoryAction(body) {
  memoryProblem(null);
  try {
    const res = await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await res.json();
    if (result.facts) paintMemory(result);
    if (result.error) memoryProblem(result.error);
    return !result.error;
  } catch {
    memoryProblem("Couldn't reach Greg to change that.");
    return false;
  }
}

function memoryProblem(text) {
  const box = $("mem-problem");
  if (!box) return;
  box.textContent = text ?? "";
  box.hidden = !text;
}

async function addFact() {
  const input = $("mem-new");
  const text = input.value.trim();
  if (!text) return;
  if (await memoryAction({ action: "remember", text })) input.value = "";
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, onClick) {
  const b = make("button", "btn", label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

/**
 * Delete takes two clicks: the first turns the button into "Sure?", and it only
 * acts if pressed again within a few seconds. There is no undo for a fact.
 */
function deleteButton(onConfirm, label = "Delete") {
  const b = button(label, () => {
    if (b.classList.contains("confirm")) return onConfirm();
    b.classList.add("confirm");
    b.textContent = "Sure?";
    setTimeout(() => {
      b.classList.remove("confirm");
      b.textContent = label;
    }, 4000);
  });
  return b;
}

function paintMemory({ facts = [], reminders = [] } = {}) {
  const factList = $("mem-facts");
  factList.replaceChildren();
  if (!facts.length) factList.append(make("li", "mem-empty", "Nothing yet. Tell him something about yourself, or add it below."));
  for (const fact of facts) factList.append(factRow(fact));

  const reminderList = $("mem-reminders");
  reminderList.replaceChildren();
  if (!reminders.length) reminderList.append(make("li", "mem-empty", "Nothing set."));
  for (const item of reminders) reminderList.append(reminderRow(item));
}

/** A text box that saves on Enter and gives up on Escape without closing the dialog. */
function editBox(value, maxLength, save) {
  const input = make("input");
  input.type = "text";
  input.maxLength = maxLength;
  input.value = value;
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") save();
    if (event.key === "Escape") {
      event.stopPropagation();
      loadMemory();
    }
  });
  return input;
}

function factRow(fact) {
  const row = make("li");
  const text = make("span", "mem-text", fact.text);
  if (fact.savedAt) text.append(make("span", "mem-when", `Saved ${dayAndTime(Date.parse(fact.savedAt))}`));
  row.append(
    text,
    button("Edit", () => {
      const save = () => memoryAction({ action: "edit-fact", was: fact.text, text: input.value });
      const input = editBox(fact.text, 300, save);
      row.replaceChildren(input, button("Save", save), button("Cancel", loadMemory));
      input.focus();
    }),
    deleteButton(() => memoryAction({ action: "forget-fact", text: fact.text }))
  );
  return row;
}

/** "Every weekday at 4:30 PM", "tomorrow at 3:00 PM", "Timer, goes off in 8 minutes". */
function whenOf(item) {
  if (item.kind === "timer") return `Timer, goes off in ${item.dueIn}`;
  if (item.every) return `${item.every[0].toUpperCase()}${item.every.slice(1)} at ${item.dueAtLocal}`;
  return dayAndTime(item.dueAt);
}

function dayAndTime(ms) {
  if (!Number.isFinite(ms)) return "";
  const when = new Date(ms);
  const today = new Date();
  const days = Math.round((new Date(ms).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  const clock = when.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  let day;
  if (days === 0) day = "today";
  else if (days === 1) day = "tomorrow";
  else if (days === -1) day = "yesterday";
  else if (Math.abs(days) < 7) day = when.toLocaleDateString("en-US", { weekday: "long" });
  else {
    day = when.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      ...(when.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
    });
  }
  return `${day} at ${clock}`;
}

function hhmm(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function reminderRow(item) {
  const row = make("li");
  const text = make("span", "mem-text", item.text);
  text.append(make("span", "mem-when", whenOf(item)));
  row.append(
    text,
    button("Edit", () => {
      let time = null;
      let repeat = null;
      const save = () =>
        memoryAction({
          action: "edit-reminder",
          id: item.id,
          text: input.value,
          ...(time ? { time: time.value, repeat: repeat.value } : {}),
        });
      const input = editBox(item.text, 200, save);
      const parts = [input];
      // A timer counts down from when it was set; only its name can change.
      if (item.kind !== "timer") {
        time = make("input");
        time.type = "time";
        time.value = hhmm(item.dueAt);
        repeat = make("select");
        for (const [value, label] of [["none", "Once"], ["daily", "Every day"], ["weekdays", "Weekdays"]]) {
          const option = make("option", "", label);
          option.value = value;
          repeat.append(option);
        }
        repeat.value = item.repeat ?? "none";
        parts.push(time, repeat);
      }
      row.replaceChildren(...parts, button("Save", save), button("Cancel", loadMemory));
      input.focus();
    }),
    deleteButton(() => memoryAction({ action: "cancel-reminder", id: item.id }))
  );
  return row;
}

// ---------------------------------------------------------------------------
// The Brain tab
//
// Acts on its own buttons, like Memory. The page never holds the key after
// sending it: the box is emptied as soon as the server answers, whether or not
// the key was accepted, and the server only ever reports whether one is saved.
// ---------------------------------------------------------------------------

let brainNow = null; // the last state the server gave

async function loadBrain() {
  brainProblem(null);
  try {
    paintBrain(await (await fetch("/api/brain", { cache: "no-store" })).json());
  } catch {
    brainProblem("Couldn't reach Greg to see which brain he's using.");
  }
}

function brainProblem(text, { warning = false } = {}) {
  const box = $("brain-problem");
  if (!box) return;
  box.textContent = text ?? "";
  box.hidden = !text;
  box.classList.toggle("warning", warning);
}

/** Buttons off while Anthropic is being asked, so nobody presses twice. */
function brainBusy(busy, label) {
  for (const id of ["brain-use", "brain-key-save", "brain-key-remove"]) {
    const b = $(id);
    if (b) b.disabled = busy;
  }
  if (busy && label) {
    const note = $("brain-now");
    if (note) note.textContent = label;
  }
}

async function brainAction(body, busyLabel) {
  brainProblem(null);
  brainBusy(true, busyLabel);
  try {
    const res = await fetch("/api/brain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await res.json();
    if (result.state) paintBrain(result.state);
    if (result.error) brainProblem(result.error);
    else if (result.warning) brainProblem(result.warning, { warning: true });
    return !result.error;
  } catch {
    brainProblem("Couldn't reach Greg to change that.");
    if (brainNow) paintBrain(brainNow);
    return false;
  } finally {
    brainBusy(false);
    // Busy re-enabled every button; "Use this PC" while already on this PC
    // must go back to being disabled.
    if (brainNow) paintBrainButton();
  }
}

const chosenBrain = () => document.querySelector('input[name="brain"]:checked')?.value ?? "local";

function paintBrain(state) {
  brainNow = state;
  const active = state.active ?? {};
  const modelName = (id) => state.models?.find((m) => m.id === id)?.label.split(" — ")[0] ?? id;

  $("brain-now").textContent = !active.running
    ? "He has no brain running right now, so he's in basic mode."
    : state.using === "claude"
    ? `He's thinking with ${modelName(state.model)}, on Anthropic's servers.`
    : `He's thinking on this PC, with ${active.label}.`;

  setRadio("brain", state.using);

  const select = $("brain-model");
  select.replaceChildren();
  for (const model of state.models ?? []) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label;
    select.append(option);
  }
  select.value = state.model;

  $("brain-key-state").textContent = state.keySaved
    ? `A key is saved${state.keyEnding ? `, ending ${state.keyEnding}` : ""}. Paste a new one to replace it.`
    : "No key saved yet.";
  $("brain-key-remove").hidden = !state.keySaved;
  paintBrainButton();
}

/** The button says exactly what pressing it will do. */
function paintBrainButton() {
  const state = brainNow ?? {};
  const want = chosenBrain();
  const model = $("brain-model").value;
  const button = $("brain-use");
  $("brain-model").disabled = want !== "claude";
  if (want === "local") {
    button.textContent = "Use this PC";
    button.disabled = state.using === "local";
  } else if (state.using === "claude" && model !== state.model) {
    button.textContent = "Change model";
    button.disabled = false;
  } else {
    button.textContent = "Use Claude";
    button.disabled = state.using === "claude";
  }
}

async function useChosenBrain() {
  const brain = chosenBrain();
  const model = $("brain-model").value;
  await brainAction(
    { action: "use", brain, model },
    brain === "claude" ? "Checking the key with Anthropic…" : "Switching to this PC…"
  );
}

async function saveBrainKey() {
  const input = $("brain-key");
  const key = input.value.trim();
  if (!key) return;
  // Emptied before the answer comes back, not after: nothing on the page
  // should hold it a moment longer than the request needs.
  input.value = "";
  await brainAction({ action: "save-key", key, model: $("brain-model").value }, "Checking the key with Anthropic…");
}

let removeArmed = null;
async function removeBrainKey() {
  const button = $("brain-key-remove");
  // Two presses, like Delete in the Memory tab.
  if (!removeArmed) {
    button.textContent = "Sure?";
    removeArmed = setTimeout(() => {
      removeArmed = null;
      button.textContent = "Remove key";
    }, 4000);
    return;
  }
  clearTimeout(removeArmed);
  removeArmed = null;
  button.textContent = "Remove key";
  await brainAction({ action: "remove-key" }, "Removing the key…");
}

// ---------------------------------------------------------------------------
// The Phone tab
//
// Acts at once, like Memory and Brain. It never sees a phone's token — only
// names, dates and whether each wants notifications. The pairing code is shown
// here because this is the only place one can be made.
// ---------------------------------------------------------------------------

let phoneNow = null;
let phoneTick = null;

async function loadPhone() {
  phoneProblem(null);
  try {
    paintPhone(await (await fetch("/api/phone", { cache: "no-store" })).json());
  } catch {
    phoneProblem("Couldn't reach Greg to see the phone settings.");
  }
}

function phoneProblem(text) {
  const box = $("phone-problem");
  if (!box) return;
  box.textContent = text ?? "";
  box.hidden = !text;
}

async function phoneAction(body) {
  phoneProblem(null);
  try {
    const res = await fetch("/api/phone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await res.json();
    if (result.state) paintPhone(result.state);
    if (result.error) phoneProblem(result.error);
    return result;
  } catch {
    phoneProblem("Couldn't reach Greg to change that.");
    return {};
  }
}

function copyButton(text) {
  const b = make("button", "btn", "Copy");
  b.type = "button";
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      b.textContent = "Copied";
      setTimeout(() => (b.textContent = "Copy"), 1500);
    } catch {
      b.textContent = "Select it";
    }
  });
  return b;
}

/** A line of text to copy, as a read-only box and a button. */
function copyRow(text) {
  const row = make("div", "search-row");
  const box = make("input");
  box.type = "text";
  box.readOnly = true;
  box.value = text;
  box.addEventListener("focus", () => box.select());
  row.append(box, copyButton(text));
  return row;
}

/** How the phone gets to this PC: what Tailscale says, and the next step. */
function paintRoute(state) {
  const route = $("phone-route");
  route.replaceChildren();
  const t = state.tailscale ?? {};
  const say = (text) => route.append(make("p", "field-note", text));

  if (!t.installed) {
    say("Your phone reaches this PC through Tailscale, a free private network. Nothing is opened to the internet.");
    say("1. Install Tailscale on this PC and on your phone, from tailscale.com/download, and sign in to the same account on both.");
    say("2. Then run this once on this PC, in a terminal:");
    route.append(copyRow(t.serveCommand ?? "tailscale serve --bg 4757"));
    say("3. Come back here: the phone's address will show.");
    return;
  }
  if (!t.running) {
    say("Tailscale is installed but not connected. Open it from the system tray and sign in.");
    return;
  }
  if (!t.serving) {
    say("Tailscale is connected. One step left: run this once on this PC, in a terminal, to let your phone reach Greg's phone door:");
    route.append(copyRow(t.serveCommand));
    say("If Tailscale asks you to turn on HTTPS for your network, say yes — phones only allow the microphone over HTTPS.");
    return;
  }
  say("Open this on your phone, then add it to the home screen:");
  route.append(copyRow(t.address));
  if (!state.listening) say("Greg's phone door isn't open yet. Tick “Let my phone reach Greg” above.");
}

function paintPhone(state) {
  phoneNow = state;
  $("phone-enabled").checked = state.enabled;
  $("phone-keep").checked = state.keepRunning;
  $("phone-keep").disabled = !state.enabled;
  $("phone-keep-note").textContent = !state.launcher
    ? "Only applies when he was started from Greg.exe. Started any other way, he runs until you close his console."
    : "Otherwise he stops when his window closes, and the phone can't reach him. The PC must also be awake.";
  $("phone-pair").disabled = !state.enabled;
  paintRoute(state);

  const list = $("phone-list");
  list.replaceChildren();
  if (!state.phones?.length) list.append(make("li", "mem-empty", "No phones paired yet."));
  for (const phone of state.phones ?? []) {
    const row = make("li");
    const text = make("span", "mem-text", phone.name);
    const seen = phone.lastSeen ? dayAndTime(Date.parse(phone.lastSeen)) : "never";
    text.append(make("span", "mem-when", `Last used ${seen}. Reminders ${phone.notifications ? "on" : "off"}.`));
    row.append(text, deleteButton(() => phoneAction({ action: "remove", id: phone.id }), "Remove"));
    list.append(row);
  }

  clearInterval(phoneTick);
  const pairing = $("phone-pairing");
  if (state.pairing) {
    pairing.hidden = false;
    $("phone-code").textContent = state.pairing.code.replace(/(\d{3})(\d{3})/, "$1 $2");
    const tick = () => {
      const left = Math.max(0, state.pairing.expiresAt - Date.now());
      if (!left) {
        clearInterval(phoneTick);
        loadPhone();
        return;
      }
      $("phone-code-left").textContent = `Good for ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")} more.`;
    };
    tick();
    phoneTick = setInterval(tick, 1000);
  } else {
    pairing.hidden = true;
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
      followUpMode: $("set-followup").value,
      followUpSeconds: Number($("set-followup-secs").value),
      bargeInEnabled: $("set-barge").checked,
      bargeInSustainMs: Number($("set-barge-ms").value),
      minLevel: Number($("set-minlevel").value),
      floorMultiple: Number($("set-floor").value),
      deviceId: $("set-mic")?.value ?? "",
    },
    pushToTalk: { key: $("set-talkkey").value },
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
