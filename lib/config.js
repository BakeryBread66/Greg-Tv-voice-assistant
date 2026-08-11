// Reading config.json, and surviving not having one.
//
// config.json is gitignored — it carries the user's coordinates — so a fresh
// clone does not have one. server.js used to read it with a bare
// `JSON.parse(fs.readFileSync(...))`, no try and no fallback, which meant the
// first thing anybody cloning this repo ever saw was an ENOENT stack trace. The
// README does say to copy the example across; nothing enforced that and nothing
// survived not doing it, so the fix belongs in the code rather than the docs.
//
// MISSING and UNPARSEABLE are different facts, and collapsing them would be the
// expensive mistake here. Missing is a first run: copy the example across, say
// so, carry on. A file that EXISTS and will not parse is somebody's settings —
// hand-edited, or torn by a process killed mid-write — and replacing it with the
// defaults would silently discard everything they had chosen. Say what is wrong
// and refuse to start.
//
// It lives in its own module rather than inline in server.js for the reason
// lib/settings.js records about itself: a function that can only ever read one
// hard-coded path is untestable by construction, and importing server.js to
// exercise it runs its top-level code and starts a second Greg. `file` and
// `example` are injected so test/config.test.js can point them at a scratch
// directory.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const CONFIG_FILE = path.join(ROOT, "config.json");
export const CONFIG_EXAMPLE = path.join(ROOT, "config.example.json");

/**
 * Config that could not be loaded, with a message written for the console.
 *
 * Thrown rather than exiting here so the module stays testable — the caller
 * decides that an unusable config is fatal, which is a decision about running a
 * server and not about reading a file.
 */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

// Whether THIS process created config.json, which is the one unambiguous signal
// that nothing has ever been downloaded on this machine. Kept here rather than
// returned, so the shape of loadConfig's return value stays what every caller
// already expects.
let created = false;

/**
 * What to warn about before a long, silent startup.
 *
 * The first start downloads speech models — Piper's voice is 60–140 MB and
 * Whisper's is larger — and none of that prints anything until it finishes. The
 * console just sits there. Reported as "it didn't work", then as "it did work,
 * it just took a while", which is the same experience twice: nothing on screen
 * said the wait was expected.
 *
 * Pure apart from an injected `exists`, so the decision can be tested without
 * downloading anything. Returns null when there is nothing to warn about —
 * saying "this may take a while" on every single start would train people to
 * ignore it, which is the alert-fatigue argument the weather watcher makes.
 */
export function firstRunNotice(config, { root = ROOT, exists = fs.existsSync, wasCreated = created } = {}) {
  const wanted = [];

  const voice = config?.localVoice?.voice;
  if (config?.localVoice?.enabled !== false && voice && !exists(path.join(root, "voices", `${voice}.onnx`))) {
    wanted.push(`his voice (${voice}, 60-140 MB)`);
  }

  // A freshly created config means nothing else can have been fetched either.
  if (wasCreated && config?.speech?.mode !== "off") {
    wanted.push("the speech recognition model");
  }

  if (!wanted.length) return null;

  return (
    `First run: downloading ${wanted.join(" and ")}. This happens once and can take ` +
    `a few minutes on a slow connection.\n` +
    // ASCII on purpose. This is read on a first run, on a machine nobody has
    // configured, and the default Windows console mangles non-ASCII - the same
    // reason the startup banner avoids box-drawing characters. A message about
    // things being fine should not itself arrive looking broken.
    `Nothing is wrong if this window looks idle - it is downloading. Greg prints a ` +
    `banner when he is ready.`
  );
}

/**
 * Load the live config, creating it from the example on a first run.
 *
 * Returns the parsed object. Throws ConfigError when there is nothing usable to
 * return; anything it can recover from is reported through `warn` and does not
 * stop Greg starting.
 */
export function loadConfig({
  file = CONFIG_FILE,
  example = CONFIG_EXAMPLE,
  log = console.log,
  warn = console.warn,
} = {}) {
  let raw;

  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new ConfigError(`Could not read ${path.basename(file)}: ${err.message}`);
    }
    raw = firstRun({ file, example, log, warn });
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(
      `${path.basename(file)} is not valid JSON: ${err.message}\n` +
      `It has NOT been overwritten — that is your settings file. Fix the JSON, or ` +
      `move it aside and restart to get a fresh copy from ${path.basename(example)}.`
    );
  }
}

/**
 * No config.json. Copy the example across and return its text.
 *
 * A checkout somebody cannot write to still starts: Greg runs from the example
 * in memory and says that settings will not stick. Failing outright there would
 * turn "you cannot save" into "you cannot run", which is the wrong trade for a
 * thing whose whole job is to work on a machine it has never seen.
 */
function firstRun({ file, example, log, warn }) {
  let text;
  try {
    text = fs.readFileSync(example, "utf8");
  } catch {
    throw new ConfigError(
      `No ${path.basename(file)}, and no ${path.basename(example)} to build one from.\n` +
      `Expected one of them in ${path.dirname(file)}. Re-clone, or restore ${path.basename(example)}.`
    );
  }

  // "wx" fails if the file appeared since the read above, so a second process
  // racing us here loses rather than clobbering a config that is already live.
  try {
    fs.writeFileSync(file, text, { encoding: "utf8", flag: "wx" });
    created = true;
    log(
      `First run: created ${path.basename(file)} from ${path.basename(example)}. ` +
      `Edit it to taste — location, wake words and voice all live in there.`
    );
  } catch (err) {
    warn(
      `Could not write ${path.basename(file)} (${err.message}). Running from ` +
      `${path.basename(example)} — settings you change will not survive a restart.`
    );
  }

  return text;
}
