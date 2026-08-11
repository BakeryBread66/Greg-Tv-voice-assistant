// How much of Greg is switched on.
//
// Exists because Greg and a game want the same 24 GB. Measured on this machine:
//
//   clone_server.py (the voice)   4238 MB, resident the whole time Greg runs
//   qwen2.5vl:7b    (the eyes)    5900 MB, resident for ~5 min after each look
//   whisper_server.py (the ears)   496 MB
//   gemma4:e4b      (the brain)   3400 MB, transient
//
// Gaming mode drops the first two, which is where the money is. The brain stays:
// it is the smallest of them and switching it off would leave nothing that could
// hear "gaming mode off" and act on it.
//
// Everything here reports rather than throws. These are driven by tool calls, and
// a model needs a result it can describe truthfully — CLAUDE.md's honesty rule
// depends on an `error` field meaning the action did not happen.

import { visionStatus, setVisionEnabled, unloadVisionModel, proveVision } from "./vision.js";
import { initClone, cloneStatus, stopClone } from "./tts-clone.js";

let cloneWanted = true;
let cloneBusy = false;
let notify = () => {};

/** server.js sets this so a change made by voice reaches the button, and vice versa. */
export function onPowerChange(fn) {
  if (typeof fn === "function") notify = fn;
}

export function powerState() {
  const eyes = visionStatus();
  const voice = cloneStatus();
  return {
    // Derived, never stored. Holding a separate flag let it disagree with the
    // switches it describes: turning the eyes back on by voice left gamingMode
    // reporting `true`, so the button showed gaming mode on with the eyes open.
    // Two sources of truth for one fact is one too many.
    gamingMode: !eyes.enabled && !cloneWanted,
    vision: {
      // `proven` is the eyesight test; `enabled` is the switch. Both surface, so
      // the UI can grey the control out rather than offer a lie.
      proven: eyes.proven,
      enabled: eyes.enabled,
      active: eyes.ok,
      reason: eyes.reason,
    },
    clonedVoice: {
      wanted: cloneWanted,
      state: voice.state,
      starting: cloneBusy,
      reference: voice.reference ?? null,
    },
  };
}

/** Eyes on or off. Refuses to enable what never passed the eyesight test. */
export async function setVision(on, config) {
  // With `vision.openAtStartup: false` the eyesight test is deferred rather than
  // failed, so this is where it finally happens — the first time somebody asks
  // to see something. Loading the model here rather than at boot is the entire
  // saving, and refusing without testing would be the proven/enabled conflation
  // wearing a config hat: "cannot turn eyes on, they failed" about a test that
  // was never run.
  //
  // No-op once checked, so an ordinary on/off has not changed at all.
  if (on) await proveVision(config ?? {});

  const result = setVisionEnabled(on);
  if (!result.ok) return { ...result, ...powerState() };

  // Withholding the tool is instant; the VRAM is not.
  let freed = null;
  if (!on) freed = await unloadVisionModel(config);

  notify(powerState());
  return { ok: true, enabled: result.enabled, unloaded: freed?.ok ?? null, ...powerState() };
}

/**
 * The cloned voice on or off.
 *
 * Off is instant. On costs about 45 seconds of model loading, so it returns as
 * soon as the load STARTS and says so — Greg must not claim his voice is back
 * while it is still loading. Piper carries him in the meantime, which is exactly
 * what the fallback chain in lib/tts.js is for.
 */
export async function setClonedVoice(on, config) {
  if (cloneBusy) return { ok: false, error: "the cloned voice is already starting up" };

  if (!on) {
    cloneWanted = false;
    stopClone();
    notify(powerState());
    return { ok: true, wanted: false, note: "voice dropped to Piper, about 4.2 GB freed", ...powerState() };
  }

  if (cloneStatus().state === "ready") {
    cloneWanted = true;
    return { ok: true, wanted: true, note: "already running", ...powerState() };
  }

  cloneWanted = true;
  cloneBusy = true;
  notify(powerState());

  // Deliberately not awaited: loading blocks for ~45 s and the caller is a voice
  // turn. Greg answers now and the voice changes under him when it is ready.
  initClone(config)
    .catch(() => false)
    .finally(() => {
      cloneBusy = false;
      notify(powerState());
    });

  return { ok: true, wanted: true, starting: true, note: "loading, about 45 seconds; Piper until then", ...powerState() };
}

/** Both switches at once. Gaming mode is exactly "both of them off". */
export async function setGamingMode(on, config) {
  const gaming = Boolean(on);

  const eyes = await setVision(!gaming, config);
  const voice = await setClonedVoice(!gaming, config);

  notify(powerState());
  return {
    ok: true,
    gamingMode: gaming,
    // Report each half separately: turning the eyes back on can legitimately fail
    // when the model never passed its eyesight test, and that must not be hidden
    // behind an overall success.
    eyes: eyes.ok ? (gaming ? "off, VRAM released" : "on") : `could not turn on — ${eyes.error}`,
    voice: voice.ok ? (gaming ? "dropped to Piper" : "cloned voice loading") : `unchanged — ${voice.error}`,
    ...powerState(),
  };
}
