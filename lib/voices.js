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
