// What this machine can actually speak with.
//
// Personas name a voice, and a persona is a file somebody may have downloaded
// from a repository they did not write. So the name has to be resolved against
// what is genuinely on this disk, and a persona asking for a voice that is not
// here has to SAY so rather than quietly using a different one — an assistant
// that silently answers in the wrong voice is a small version of the failure
// this whole project is arranged against.
//
// Three kinds, and they are not interchangeable:
//
//   clone   a reference recording, voices/*.wav — someone's actual voice,
//           needs the Chatterbox sidecar and ~45 s to load
//   piper   a downloaded model, voices/*.onnx — about a second to swap
//   system  Windows' own, no file at all and instant
//
// Detection is by extension rather than by a list, so dropping a new reference
// clip or a new Piper model into voices/ is all it takes.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { initPiper, stopPiper, piperStatus } from "./tts-piper.js";
import { initClone, stopClone, cloneStatus } from "./tts-clone.js";
import { powerState } from "./power.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FOLDER = path.join(ROOT, "voices");

// Piper ships each model with a .onnx.json beside it. A lone .onnx is a
// half-finished download, and offering it would fail at load time with a
// confusing error rather than here with a clear absence.
const isComplete = (file, names) => names.includes(`${file}.json`);

/** Everything in voices/, sorted into what it can be used for. */
export function detectVoices({ folder = FOLDER } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return { clone: [], piper: [] };
  }

  const clone = names
    .filter((n) => n.toLowerCase().endsWith(".wav"))
    .map((n) => ({
      kind: "clone",
      id: path.basename(n, path.extname(n)),
      file: path.join("voices", n),
      // "greg-reference" reads as a filename; "greg" reads as a person.
      label: path.basename(n, path.extname(n)).replace(/[-_]?reference$/i, "") || path.basename(n, path.extname(n)),
    }));

  const piper = names
    .filter((n) => n.toLowerCase().endsWith(".onnx") && isComplete(n, names))
    .map((n) => ({
      kind: "piper",
      id: path.basename(n, ".onnx"),
      file: path.join("voices", n),
      label: path.basename(n, ".onnx"),
    }));

  return { clone, piper };
}

/** One flat list, clones first — a real person's voice is the better default. */
export function listVoices(options) {
  const { clone, piper } = detectVoices(options);
  return [...clone, ...piper];
}

/**
 * Find the voice a persona asked for.
 *
 * Matches the id, the label, or the bare filename, and folds hyphens and
 * underscores to spaces on both sides — the same fold personas needed, because
 * "flight-computer" is not what anybody says out loud and "greg reference" is
 * not what anybody types.
 *
 * Returns null for "not on this machine", which the caller must report rather
 * than paper over.
 */
export function resolveVoice(wanted, options) {
  const flatten = (text) => String(text ?? "").toLowerCase().replace(/[-_.]+/g, " ").replace(/\s+/g, " ").trim();
  const said = flatten(wanted);
  if (!said) return null;

  const all = listVoices(options);
  const keys = (v) => [flatten(v.id), flatten(v.label)];

  // Exact first.
  const exact = all.find((v) => keys(v).includes(said));
  if (exact) return exact;

  // Then a key sitting inside what was asked for — "use the greg reference".
  const inside = all
    .flatMap((v) => keys(v).map((key) => ({ v, key })))
    .sort((a, b) => b.key.length - a.key.length)
    .find(({ key }) => said.includes(key));
  if (inside) return inside.v;

  // Then the other direction: a persona naming "alan" when the file is called
  // en_GB-alan-medium, which is how anyone would actually write it. Only when
  // it identifies ONE voice — "medium" matches six, and picking one of those
  // would be guessing at which person you meant to sound like.
  if (said.length >= 3) {
    const partial = all.filter((v) => keys(v).some((key) => key.includes(said)));
    if (partial.length === 1) return partial[0];
  }

  return null;
}

/**
 * What a persona's `voice` field means for this machine, without changing
 * anything.
 *
 * Pure, so the decision can be proven without a sidecar: the swap itself needs
 * a running Greg, but which swap to attempt does not.
 */
export function planVoiceChange(wanted, { current = {}, options } = {}) {
  if (!wanted) return { change: false, reason: "the persona does not ask for a voice" };

  const found = resolveVoice(wanted, options);
  if (!found) {
    return {
      change: false,
      missing: true,
      reason: `there is no voice called "${wanted}" in the voices folder`,
    };
  }

  if (found.kind === "clone" && current.cloneReference === found.file) {
    return { change: false, voice: found, reason: "already using it" };
  }
  if (found.kind === "piper" && current.piperVoice === found.id) {
    return { change: false, voice: found, reason: "already using it" };
  }

  return {
    change: true,
    voice: found,
    // The clone reloads a model; Piper reloads a much smaller one. Worth saying
    // out loud, because one of them is a wait and the other is not.
    slow: found.kind === "clone",
  };
}

/**
 * What a WAV header says about itself, or null if it is not a PCM WAV.
 *
 * Deliberately reads the chunk table rather than assuming a 44-byte header —
 * plenty of encoders put a LIST or fact chunk before the data, and slicing at 44
 * then treats metadata as audio.
 */
export function describeWav(buffer, { fileSize = buffer?.length ?? 0 } = {}) {
  if (!buffer || buffer.length < 44) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") return null;

  const channels = buffer.readUInt16LE(22);
  const rate = buffer.readUInt32LE(24);
  const bits = buffer.readUInt16LE(34);
  if (!channels || !rate || !bits) return null;

  // `fileSize` is passed separately because the caller reads only the first few
  // kilobytes — reading a 350 MB file to find out it is too big would be the
  // problem this check exists to avoid, in miniature.
  let at = 12;
  let bytes = 0;
  while (at + 8 <= buffer.length) {
    const id = buffer.toString("ascii", at, at + 4);
    const size = buffer.readUInt32LE(at + 4);
    if (id === "data") { bytes = Math.min(size, Math.max(0, fileSize - at - 8)); break; }
    at += 8 + size + (size % 2);
  }
  if (!bytes) return null;

  return { channels, rate, bits, seconds: bytes / (rate * channels * (bits / 8)) };
}

// How long a cloning reference may be.
//
// IDEAL is what to aim for and what the docs tell people: ten seconds is as good
// as thirty — measured — so there is nothing to gain past that. greg-reference
// is 28.8 s and works well.
//
// MAX is the refusal line, and it is deliberately four times the top of the
// useful range rather than close to it. This is a safety net for a file nobody
// trimmed, not a style guide: refusing a 45-second clip somebody made on purpose
// would be officious, while half an hour kills the process outright.
export const IDEAL_REFERENCE_SECONDS = [10, 30];
export const MAX_REFERENCE_SECONDS = 120;

// And a flat byte ceiling, because duration is only knowable if the header can
// be trusted. 120 s of 96 kHz 24-bit stereo — far beyond anything sensible — is
// about 69 MB, so 100 MB clears every legitimate case while still catching the
// 350 MB recording that started this. A file this big is never a trimmed clip.
export const MAX_REFERENCE_BYTES = 100 * 1024 * 1024;

/**
 * Why this clip will not work as a cloning reference, or null if it is fine.
 *
 * Chatterbox is handed `audio_prompt_path` on EVERY generation, including the
 * warm-up before the sidecar reports READY, so the whole file is decoded and
 * processed each time. A 30-minute 48 kHz stereo clip is ~700 MB as float32
 * before any processing, on top of a 4 GB model — the process is killed and
 * Node reports `exited (null)`, which tells the user precisely nothing.
 *
 * Reported by a user who dropped a half-hour of game dialogue in. The clip was
 * the problem and nothing said so.
 *
 * The cap is deliberately generous. Ten seconds is as good as thirty — measured
 * — so anything past two minutes is already far beyond useful and is much more
 * likely to be a whole recording somebody has not trimmed yet.
 */
export function referenceProblem(
  wav,
  { maxSeconds = MAX_REFERENCE_SECONDS, bytes = 0, maxBytes = MAX_REFERENCE_BYTES } = {}
) {
  // Size first, and independent of the header. A file whose duration cannot be
  // worked out is exactly the file whose duration should not be trusted, and
  // "not a PCM WAV" is unhelpful when the real answer is that it is 350 MB.
  if (bytes > maxBytes) {
    return (
      `that file is ${(bytes / 1024 / 1024).toFixed(0)} MB. A cloning reference should be about ten ` +
      `seconds of speech — a short clip, not a whole recording. Trim it and try again`
    );
  }
  if (!wav) return "that file is not a PCM WAV — save it as 16-bit PCM WAV and try again";
  if (wav.seconds > maxSeconds) {
    const mins = wav.seconds >= 90 ? `${(wav.seconds / 60).toFixed(1)} minutes` : `${Math.round(wav.seconds)} seconds`;
    return (
      `that clip is ${mins} long. Cloning re-reads the whole reference every time it speaks, ` +
      `so a long one runs the machine out of memory before it can start. Trim it to about ten ` +
      `seconds of clear speech — ten is as good as thirty, so there is nothing to gain by more`
    );
  }
  if (wav.seconds < 3) return `that clip is only ${wav.seconds.toFixed(1)}s — about ten seconds of speech works best`;
  return null;
}

/**
 * Why picking a cloned voice would not work, BEFORE anyone picks one.
 *
 * cloneAction below answers the same question at the moment of a switch, and
 * its wording is built for that — "Saved X as the cloned voice, but…". A
 * settings dialog needs it in advance and in the other order: what is wrong,
 * and what to do about it. Offering a list of voices where half of them
 * silently do nothing is the shape of failure this project exists to remove.
 *
 * `runtime` is cloneStatus().state, which is the only place the most likely
 * real failure shows up: the venv missing because nobody ran the clone setup.
 * Config cannot see that — it says enabled, and the sidecar simply never
 * started.
 *
 * Pure, so the states can be proven without spawning a 4 GB model.
 */
export function cloneAvailability(config, { cloneWanted = true, runtime = null, reason = "", clue = "" } = {}) {
  if (!config?.clonedVoice) {
    return { ready: false, fix: "The cloned voice has never been set up. Run setup-greg.ps1 -Clone." };
  }
  if (!config.clonedVoice.enabled) {
    return { ready: false, fix: "Cloned speech is switched off. Set clonedVoice.enabled in config.json and restart." };
  }
  if (!cloneWanted) {
    return { ready: false, fix: "Gaming mode has the cloned voice parked to save graphics memory. Turn it off first." };
  }
  if (runtime === "unavailable") {
    // Carries the sidecar's own reason AND its last stderr, because the reason
    // alone is often useless. Reported by a user: "cloned voice exited (null)",
    // which says a signal killed it and nothing about why. The detail was sitting
    // in cloneStatus() the whole time and this function threw it away.
    const detail = String(clue ?? "").trim();
    const why = [reason, detail].filter(Boolean).join(" — ");
    return {
      ready: false,
      fix: why
        ? `The cloned voice could not start: ${why}`
        : "The cloned voice could not start, and gave no reason. Check the console where Greg is running.",
    };
  }
  return { ready: true, fix: "" };
}

/**
 * Whether the clone can actually be started right now, and what to say if not.
 *
 * Pure and exported so the four states can be proven without spawning anything.
 * The first attempt at testing this DID spawn: in a fresh process power.js
 * defaults to wanting the clone, so a test walked straight past the guards and
 * began loading a 4 GB model. **A test that does real work is not thorough.**
 */
export function cloneAction(config, voice, cloneWanted) {
  const label = voice?.label ?? "that voice";

  if (!config.clonedVoice?.enabled) {
    return {
      stop: true,
      result: {
        switched: false, saved: true, needsRestart: true, kind: "clone", to: label,
        note:
          `Saved ${label} as the cloned voice, but cloned speech is switched off — set clonedVoice.enabled ` +
          `to true in config.json and restart. Until then you sound exactly as you did.`,
      },
    };
  }

  // Gaming mode has it parked. Starting it here would quietly take back the
  // 4.2 GB that mode exists to free — undoing a deliberate choice as a side
  // effect of picking a character. Saved and said, not done.
  if (!cloneWanted) {
    return {
      stop: true,
      result: {
        switched: false, saved: true, kind: "clone", to: label,
        note:
          `Saved ${label} as the cloned voice, but the cloned voice is currently off to save graphics memory — ` +
          `gaming mode. Turn gaming mode off and it will load with that voice.`,
      },
    };
  }

  return { stop: false };
}

/** What is speaking right now, in the shape planVoiceChange() expects. */
export function currentVoice(config = {}) {
  return {
    // `clonedVoice`, NOT `clone`. The first version of this read `config.clone`
    // — a key nothing writes and nothing reads — so a clone swap set a field
    // into space, restarted the sidecar, and had it report "disabled in config".
    // Silently doing nothing, from guessing a key name instead of opening the
    // file that consumes it.
    cloneReference: config.clonedVoice?.reference ?? null,
    piperVoice: config.localVoice?.voice ?? null,
  };
}

/**
 * Actually change the voice.
 *
 * Both sidecars take their voice from config when they START, so a swap is a
 * stop and a restart. **Stop first, always** — this project has already stranded
 * 4.2 GB of VRAM by spawning a second clone sidecar without stopping the first,
 * and it was invisible until somebody looked at the card.
 *
 * The two are reported differently on purpose. Piper reloads in about a second
 * and is awaited, so by the time this returns he really does sound different.
 * The clone takes roughly forty-five seconds and is NOT awaited: Greg keeps
 * talking in the voice he has while the new one loads underneath him, and
 * saying "done" would be claiming something that has not happened yet.
 */
export async function switchVoice(plan, config) {
  if (!plan?.change || !plan.voice) return { switched: false, reason: plan?.reason ?? "nothing to do" };

  const voice = plan.voice;

  if (voice.kind === "piper") {
    const before = config.localVoice?.voice;
    config.localVoice = { ...(config.localVoice ?? {}), voice: voice.id };
    try {
      stopPiper();
      const ready = await initPiper(config);
      if (!ready) throw new Error(piperStatus().reason ?? "the voice did not load");
      return { switched: true, kind: "piper", to: voice.label };
    } catch (err) {
      // Put the old one back rather than leaving config naming a voice that is
      // not loaded — the cache key reads this, and disagreeing with reality
      // there means serving the wrong audio from disk with no error anywhere.
      config.localVoice.voice = before;
      stopPiper();
      await initPiper(config).catch(() => {});
      return { switched: false, kind: "piper", error: err.message };
    }
  }

  // --- A cloned voice -------------------------------------------------------
  //
  // The choice is SAVED first, unconditionally. That is what makes this work at
  // all when the sidecar cannot start right now: a restart reads config and
  // picks it up, so "it needs a restart" is a delay rather than a dead end.
  config.clonedVoice = { ...(config.clonedVoice ?? {}), reference: voice.file };

  const decision = cloneAction(config, voice, powerState().clonedVoice.wanted);
  if (decision.stop) return decision.result;

  stopClone();
  const loading = initClone(config);

  // Racing the load rather than duplicating its guards. A missing venv or a
  // missing clip resolves false almost immediately and can be reported now; a
  // real load takes about forty-five seconds and must NOT be waited for, or the
  // settings dialog hangs and Greg goes quiet mid-conversation.
  const outcome = await Promise.race([
    loading.then((ok) => ({ ok })).catch((err) => ({ ok: false, error: err.message })),
    new Promise((resolve) => setTimeout(() => resolve({ pending: true }), 2000)),
  ]);

  if (outcome.pending) {
    return {
      switched: false,
      switching: true,
      saved: true,
      kind: "clone",
      to: voice.label,
      note: `Loading ${voice.label}'s voice — about 45 seconds. Until it finishes you still sound like you did.`,
    };
  }

  if (outcome.ok) return { switched: true, kind: "clone", to: voice.label };

  // It failed fast, which means a reason worth repeating rather than a wait.
  // The reference stays saved: fix the install, restart, and it is already set.
  return {
    switched: false,
    saved: true,
    needsRestart: true,
    kind: "clone",
    to: voice.label,
    error: cloneStatus().reason ?? outcome.error ?? "the cloned voice could not start",
  };
}
