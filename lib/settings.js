// The settings Greg can change while he is running.
//
// Deliberately NOT everything in config.json. The file also holds model names,
// voice models, ports and context sizes, and none of those mean anything until
// he restarts — a dialog that lets you move a control which then silently does
// nothing is worse than no dialog. What is here is the set that takes effect on
// the next question you ask.
//
// The arrangement is the one lib/power.js and lib/channels.js already use, for
// the reason recorded in CLAUDE.md: the server owns the value, every change is
// broadcast, and the page paints whatever it was last told. Two sources of truth
// for one fact is one too many.
//
// Personality is the exception and is deliberately delegated rather than copied:
// lib/personality.js already owns those dials, validates them, and saves them to
// personality.json so a change made by VOICE survives a restart. Writing them
// into config.json here as well would create exactly the disagreement this
// module exists to avoid.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { clearLocationCache, getLocation } from "./location.js";
import { getPersonality, setTrait, setStyle, setMirror, TRAITS } from "./personality.js";
import { listPersonas, resolvePersona, personaPatch } from "./personas.js";
import { planVoiceChange, switchVoice, currentVoice, listVoices, cloneAvailability, loadedVoiceId } from "./voices.js";
import { powerState } from "./power.js";
import { cloneStatus } from "./tts-clone.js";

/**
 * Why a cloned voice would not work if it were picked.
 *
 * The three facts live in three places on purpose — config says whether it is
 * switched on, power.js says whether gaming mode has it parked, and the sidecar
 * itself is the only thing that knows the venv is missing. This is the one
 * place they are read together.
 */
function cloneReport() {
  const live = cloneStatus();
  return cloneAvailability(config, {
    cloneWanted: powerState().clonedVoice?.wanted !== false,
    runtime: live.state,
    reason: live.reason ?? "",
    // The sidecar's last stderr. "exited (null)" on its own tells a user
    // nothing they can act on; the line above it usually names the real cause.
    clue: live.detail ?? "",
  });
}
// Read-only here. Spotify is not a setting the dialog can change — the client
// id lives in .env and needs a restart — but the dialog is where somebody goes
// looking for it, so it has to be able to SAY where they have got to.
import { status as spotifyStatus } from "./spotify.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILE = path.join(ROOT, "config.json");

let config = null;
let target = FILE;
let voiceSwitcher = switchVoice; // overridable, so tests do not restart a real sidecar
// Where to look for voices. Undefined means the real voices/ folder, which is
// what the server always wants. Injected for the same reason `file` is, and for
// a reason `file` did not have: voices/ is GITIGNORED, so its contents are a
// property of one person's machine. Two tests asserted against voices that
// happened to be downloaded here and were red on every fresh clone in the world.
let voicesFolder = undefined;
const voiceOptions = () => (voicesFolder ? { folder: voicesFolder } : undefined);
const listeners = new Set();

/**
 * Hand over the live config object — the same one the rest of the server reads.
 *
 * `file` exists so this module can be tested at all. It wrote to one hard-coded
 * path, which meant every check of its validation had to be a throwaway script
 * run against the user's real config.json — and this session wrote about twenty
 * of those and deleted them all, which is the exact habit the test suite exists
 * to end. A module that can only ever write to one place is untestable by
 * construction, the same structural problem voice.js had.
 */
export function initSettings(liveConfig, { file = FILE, switcher = switchVoice, voices } = {}) {
  config = liveConfig;
  target = file;
  voicesFolder = voices;
  // Injected for the same reason `file` is. A persona now carries a voice, so
  // applying one really does stop and restart a speech sidecar — which turned a
  // 500 ms test suite into a 60-second one the moment the butler learned to
  // sound different. Tests pass a spy and assert WHICH voice was asked for,
  // which is a better check than watching a model load anyway.
  voiceSwitcher = switcher;
  return settingsState();
}

export function onSettingsChange(listener) {
  listeners.add(listener);
}

function announce() {
  const state = settingsState();
  for (const listener of listeners) {
    try {
      listener(state);
    } catch (err) {
      console.warn("[settings] listener failed:", err.message);
    }
  }
}

/** Everything the dialog shows, as it stands right now. */
export function settingsState() {
  const c = config ?? {};
  const location = c.location ?? {};
  const units = c.units ?? {};
  const followUp = c.followUp ?? {};
  const bargeIn = c.bargeIn ?? {};
  const listening = c.listening ?? {};

  return {
    name: c.name ?? "Greg",
    wakeWords: Array.isArray(c.wakeWords) ? [...c.wakeWords] : [],
    // Reported, never set. Three separate facts, kept apart because they need
    // three different things from the user: switched off, no client id yet, and
    // never authorised. Collapsing them would send somebody to create a Spotify
    // app they already have.
    spotify: spotifyStatus(),
    units: {
      temperature: units.temperature === "celsius" ? "celsius" : "fahrenheit",
      windSpeed: units.windSpeed === "kmh" ? "kmh" : "mph",
    },
    location: {
      auto: location.auto !== false,
      city: location.city ?? "",
      region: location.region ?? "",
      latitude: location.latitude ?? null,
      longitude: location.longitude ?? null,
    },
    // How loud he is, 0..1. Browser-side gain on his own output, so it applies
    // to the next thing he says rather than at a restart — which is what
    // qualifies it for this dialog. A percentage on screen, and the same value
    // the left-hand knob on the cabinet turns.
    //
    // Defaults to 1, deliberately: before this existed there was no gain in the
    // graph at all, so full is what every user already has. A new control that
    // quietly makes him quieter than he was yesterday is the "he started
    // swearing after an update" surprise wearing a different hat.
    volume: volumeOf(c.volume),
    // Page 888. "auto" shows them when he is muted, which is the state they
    // exist for: without them a muted Greg answers into silence and then
    // follows up as though he had told you something.
    subtitles: SUBTITLE_MODES.includes(c.subtitles) ? c.subtitles : "auto",
    // A browser-side effect on his voice, so it takes effect on the next thing
    // he says rather than on a restart — which is what qualifies it for this
    // dialog at all. Amount is 0..1 here and a percentage on screen.
    vocoder: {
      enabled: (c.vocoder ?? {}).enabled === true,
      amount: Number.isFinite(Number((c.vocoder ?? {}).amount)) ? Number(c.vocoder.amount) : 0.6,
    },
    appearance: {
      // The desktop behind the window. A CSS variable already, so changing it
      // is a live repaint rather than anything that waits for a restart —
      // which is what qualifies it for this dialog.
      background: normaliseColour(c.appearance?.background) ?? DEFAULT_DESKTOP,
    },
    personality: getPersonality(),
    // Read from the folder each time the dialog opens, so a persona dropped in
    // while Greg is running appears without a restart — the same reason
    // set_persona builds its options from there rather than from a list.
    personas: listPersonas().map((p) => ({ id: p.id, name: p.name, description: p.description })),
    voices: listVoices(voiceOptions()).map((v) => ({ id: v.id, label: v.label, kind: v.kind })),
    // Which voice is loaded now, so the dropdown can mark it rather than
    // guessing — the persona dropdown deliberately cannot do this, because
    // dials can be moved after a character is picked and there is no honest
    // answer. A voice has exactly one answer, so it gets shown.
    currentVoice: loadedVoiceId(config, voiceOptions()),
    // And why a cloned voice would not work if picked. Offering a list where
    // half the entries silently do nothing is the failure this whole project is
    // arranged against.
    clone: cloneReport(),
    traits: Object.fromEntries(
      Object.entries(TRAITS).map(([name, t]) => [name, { label: t.label, describes: t.describes }])
    ),
    listening: {
      followUpEnabled: followUp.enabled !== false,
      followUpSeconds: Number(followUp.seconds ?? 7),
      bargeInEnabled: bargeIn.enabled !== false,
      bargeInSustainMs: Number(bargeIn.sustainMs ?? 600),
      floorMultiple: Number(listening.floorMultiple ?? 3.5),
      minLevel: Number(listening.minLevel ?? 0.012),
      // Which microphone the browser should open. Empty means "whatever Windows
      // is using". Stored because Chrome pins a device per site and will happily
      // keep opening one that has been unplugged.
      deviceId: typeof listening.deviceId === "string" ? listening.deviceId : "",
    },
  };
}

// --- Validation -------------------------------------------------------------
//
// Every one of these is reachable from a text field, so none of them can be
// trusted. A NaN in minLevel would make the microphone threshold permanently
// unsatisfiable and there would be nothing on screen to explain why.

const num = (value, { min, max, fallback }) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};

/**
 * A coordinate, or NaN if there isn't one.
 *
 * `Number(null)` is 0 and `Number("")` is 0, and 0 is a perfectly finite
 * latitude — so a pin with missing coordinates passed validation as (0, 0),
 * which is in the Atlantic off the coast of Ghana. The module comment promises
 * a pin "needs real coordinates" and that he is never "pinned to nowhere", and
 * both were quietly untrue: Null Island is exactly nowhere.
 *
 * Absence has to be tested for before conversion, never after.
 */
const coord = (value) =>
  value === null || value === undefined || value === "" ? Number.NaN : Number(value);

/**
 * How loud he is, 0..1 — and absent means FULL, not silent.
 *
 * Written as its own reader rather than inline for the reason `coord()` above
 * is: `Number(null)` is 0 and `Number("")` is 0, and unlike a latitude, 0 here
 * is a state somebody could plausibly have chosen. A config.json written before
 * this setting existed has no volume key at all, and converting that to a
 * perfectly finite zero would open a silent Greg with a dialog agreeing that he
 * is muted — a fault that looks exactly like a decision. Absence has to be
 * tested for before conversion, never after.
 */
const volumeOf = (value) =>
  value === null || value === undefined || value === ""
    ? 1
    : num(value, { min: 0, max: 1, fallback: 1 });

// When the words go on the screen. See public/subtitles.js, which owns the rule
// itself — this end only decides what is a legal value to store.
export const SUBTITLE_MODES = ["auto", "always", "off"];

// The Windows 98 desktop teal, and the colour this shipped with.
export const DEFAULT_DESKTOP = "#008080";

/**
 * A colour, or null.
 *
 * Hex only, and normalised to lowercase six digits. It is interpolated into a
 * CSS custom property, so the shape of what gets in matters: `red; } body {
 * display: none` is a perfectly good string and a perfectly bad colour. CSS
 * would ignore most of it, but storing it means writing it back into the page
 * on every load, and "mostly harmless" is not a security argument.
 */
export function normaliseColour(value) {
  const text = String(value ?? "").trim().toLowerCase();
  const short = /^#([0-9a-f]{3})$/.exec(text);
  if (short) return `#${[...short[1]].map((c) => c + c).join("")}`;
  return /^#[0-9a-f]{6}$/.test(text) ? text : null;
}

function applyLocation(patch, problems) {
  const target = (config.location ??= {});
  // Captured before anything is written, because the fallback below needs to
  // know whether there was ever a usable pin — and `target` IS config.location,
  // so reading it afterwards would be reading what we just changed.
  const hadPin = Number.isFinite(coord(target.latitude));

  if (typeof patch.auto === "boolean") target.auto = patch.auto;

  if (target.auto) {
    // Following the connection again: forget the pinned values rather than
    // leaving them behind to be confusing next time the dialog is opened.
    target.city = "";
    target.region = "";
    target.latitude = null;
    target.longitude = null;
    clearLocationCache();
    return;
  }

  const lat = coord(patch.latitude);
  const lon = coord(patch.longitude);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    problems.push("Pick a place from the search results — a pinned location needs real coordinates.");
    // Never leave him pinned to nowhere: keep the previous pin if there was one,
    // otherwise fall back to following the connection, which is at least a real
    // answer.
    target.auto = !hadPin;
    return;
  }

  target.latitude = lat;
  target.longitude = lon;
  target.city = String(patch.city ?? "").trim().slice(0, 80) || "your area";
  target.region = String(patch.region ?? "").trim().slice(0, 80);
  clearLocationCache();
}

/**
 * Apply a patch from the settings dialog.
 *
 * Partial by design — the dialog sends only the tab you touched, so a failure in
 * one section cannot silently revert another.
 */
export async function applySettings(patch = {}) {
  if (!config) return { error: "settings are not initialised" };
  const problems = [];
  let voiceResult = null;

  // A whole character at once: name, identity and all six dials.
  //
  // FIRST, because everything below reads `patch` — resolved after the name had
  // already been applied, the persona's own name would be written into the patch
  // that nothing looks at again, and you would get the butler's dials under
  // Greg's name.
  //
  // Picking one WINS over the name box and the sliders in the same patch, and
  // that is deliberate rather than lazy. The dialog sends whatever those
  // controls happen to read, and they are showing the OLD character while you
  // choose a new one — letting them win would apply the butler's name with
  // Greg's dials, which is neither character. The dialog repaints from the
  // response afterwards so the sliders catch up.
  if (typeof patch.persona === "string" && patch.persona) {
    const found = resolvePersona(patch.persona);
    if (!found) problems.push(`There is no character called "${patch.persona}".`);
    else patch = { ...patch, ...personaPatch(found) };
  }

  if (typeof patch.name === "string") {
    const name = patch.name.trim().slice(0, 30);
    if (name) config.name = name;
    else problems.push("A name can't be empty.");
  }

  // The sentence that finishes "You are <name> — ...". Flattened and capped
  // because it is interpolated into the system prompt; see lib/personas.js.
  if (typeof patch.identity === "string") {
    const identity = patch.identity.replace(/\s+/g, " ").trim().slice(0, 240);
    if (identity) config.identity = identity;
    else problems.push("An identity can't be empty — it is the sentence that says what he is.");
  }

  if (Array.isArray(patch.wakeWords)) {
    const words = patch.wakeWords
      .map((w) => String(w ?? "").trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 20);
    // Losing every wake word would leave no way to talk to him except typing,
    // and no way to discover that from the face.
    if (words.length) config.wakeWords = words;
    else problems.push("Keep at least one wake word, or you can only reach him by typing.");
  }

  if (patch.units) {
    config.units ??= {};
    if (patch.units.temperature) {
      config.units.temperature = patch.units.temperature === "celsius" ? "celsius" : "fahrenheit";
    }
    if (patch.units.windSpeed) {
      config.units.windSpeed = patch.units.windSpeed === "kmh" ? "kmh" : "mph";
    }
  }

  // Changing which voice is loaded. Attempted before the reply is built so the
  // result can be reported honestly — Piper really has swapped by the time this
  // returns, and the clone really has not.
  if (typeof patch.voice === "string" && patch.voice) {
    const plan = planVoiceChange(patch.voice, { current: currentVoice(config), options: voiceOptions() });
    if (plan.missing) {
      // Named a voice this machine does not have. Said out loud rather than
      // quietly using a different one: answering in the wrong voice with no
      // error anywhere is the shape of failure this project exists to avoid.
      problems.push(`${plan.reason}. He is still using the voice he had.`);
    } else if (plan.change) {
      voiceResult = await voiceSwitcher(plan, config);
      if (voiceResult.error) problems.push(`The voice didn't change: ${voiceResult.error}`);
    }
  }

  if (patch.appearance) {
    const colour = normaliseColour(patch.appearance.background);
    if (colour) {
      config.appearance = { ...(config.appearance ?? {}), background: colour };
    } else if (patch.appearance.background !== undefined) {
      problems.push("That isn't a colour I can use — pick one, or give a hex value like #008080.");
    }
  }

  // Sent on its own by the knob on the cabinet and alongside everything else by
  // the dialog, so it has to survive being the only key in the patch. `num`
  // falls back rather than rejecting: a NaN here would reach a GainNode and
  // silence him with nothing on screen to say why.
  if (patch.volume !== undefined) {
    // Through the same reader the state uses, so an empty field cannot mute him
    // by arriving as a finite zero. A patch that says nothing about the volume
    // leaves it alone; one that says something unusable falls back to what he
    // already had rather than to full, which would be louder than anybody asked.
    config.volume =
      patch.volume === null || patch.volume === ""
        ? volumeOf(config.volume)
        : num(patch.volume, { min: 0, max: 1, fallback: volumeOf(config.volume) });
  }

  // Refused rather than coerced if it is not one of the three: an unknown mode
  // stored here would reach the page, which falls back to "auto" — so accepting
  // it would leave the dialog showing something that is not what he is doing.
  if (patch.subtitles !== undefined) {
    if (SUBTITLE_MODES.includes(patch.subtitles)) config.subtitles = patch.subtitles;
    else problems.push(`Subtitles can be ${SUBTITLE_MODES.join(", ")} — not "${patch.subtitles}".`);
  }

  if (patch.vocoder) {
    config.vocoder ??= {};
    if (typeof patch.vocoder.enabled === "boolean") config.vocoder.enabled = patch.vocoder.enabled;
    config.vocoder.amount = num(patch.vocoder.amount, { min: 0, max: 1, fallback: config.vocoder.amount ?? 0.6 });
  }

  if (patch.location) applyLocation(patch.location, problems);

  // Straight through to the module that owns them, so a dial moved here and one
  // moved by voice end up in the same place and save the same way.
  if (patch.personality) {
    for (const [name, value] of Object.entries(patch.personality)) {
      if (name === "style") {
        setStyle(value);
      } else if (name === "mirror") {
        setMirror(value);
      } else if (TRAITS[name]) {
        const result = setTrait(name, value);
        if (result.error) problems.push(result.error);
      }
    }
  }

  if (patch.listening) {
    const l = patch.listening;
    config.followUp ??= {};
    config.bargeIn ??= {};
    config.listening ??= {};

    if (typeof l.followUpEnabled === "boolean") config.followUp.enabled = l.followUpEnabled;
    if (l.followUpSeconds !== undefined) {
      config.followUp.seconds = num(l.followUpSeconds, { min: 2, max: 30, fallback: 7 });
    }
    if (typeof l.bargeInEnabled === "boolean") config.bargeIn.enabled = l.bargeInEnabled;
    if (l.bargeInSustainMs !== undefined) {
      // Below SILENCE_TO_END (850 ms) the sustain check is doing real work; the
      // floor here is well under that on purpose, because the measurement it
      // uses is sustainedLoudFor(), not the lingering `speaking` flag.
      config.bargeIn.sustainMs = num(l.bargeInSustainMs, { min: 200, max: 3000, fallback: 600 });
    }
    if (l.floorMultiple !== undefined) {
      config.listening.floorMultiple = num(l.floorMultiple, { min: 1.2, max: 12, fallback: 3.5 });
    }
    // Opaque to us — it is a browser-generated handle, only meaningful to the
    // page that will pass it back to getUserMedia. Bounded and typed, not parsed.
    if (typeof l.deviceId === "string") config.listening.deviceId = l.deviceId.slice(0, 200);
    if (l.minLevel !== undefined) {
      // The lower bound is not zero: at zero the trigger becomes the noise floor
      // alone and he fires on room tone continuously.
      config.listening.minLevel = num(l.minLevel, { min: 0.001, max: 0.2, fallback: 0.012 });
    }
  }

  const saved = persist();
  if (!saved.ok) problems.push(`Couldn't save to config.json: ${saved.error}`);

  announce();

  const state = settingsState();
  // Resolve the location now rather than on the next weather question, so the
  // dialog can show what he actually settled on — an IP lookup that disagrees
  // with the city you typed is worth seeing immediately.
  let resolved = null;
  try {
    resolved = await getLocation(config);
  } catch {
    // Not fatal; the dialog just won't show a resolved line.
  }

  return { ok: !problems.length, problems, state, resolved, voice: voiceResult ?? undefined };
}

/**
 * Write config.json back.
 *
 * The live object is the source, so `_comment` keys and every setting this
 * module does not touch survive untouched. Written through a temporary file and
 * renamed, and that still matters now lib/config.js has a fallback: the fallback
 * covers a config.json that is MISSING, and deliberately refuses to overwrite
 * one that exists and will not parse — which is exactly what a process killed
 * mid-write would leave behind. A torn file still costs a boot, on purpose.
 */
function persist() {
  try {
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    fs.renameSync(temp, target);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
