// Greg's cloned voice: manages the Chatterbox process and forwards text to it.
//
// Same contract as lib/tts-piper.js — init returns false rather than throwing, so
// a machine without the venv still starts and simply falls through to Piper.
//
// The one real difference is which interpreter runs it. Greg's other sidecars
// run on whatever `py` resolves to; this one points at .venv-clone explicitly,
// because chatterbox drags in a large and version-sensitive dependency tree that
// has no business being installed system-wide.
//
// It used to need Python 3.12 exactly. It does not any more — chatterbox asks
// for torch>=2.9.0 at 3.14 and above — but 3.10 to 3.13 are still preferred by
// the setup, because spacy-pkuseg ships no wheel for cp314 and compiling it
// needs a C++ toolchain.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describeWav, referenceProblem, usefulError } from "./voices.js";

/**
 * Just enough of a WAV to read its header.
 *
 * The chunk table sits at the front, so 64 KB covers any sane file — and the
 * whole point is not to read a 350 MB one into memory to discover it is too big.
 */
function readHead(file, bytes = 65536) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, "clone_server.py");
const DEFAULT_PYTHON = path.join(ROOT, ".venv-clone", "Scripts", "python.exe");

let child = null;
let state = "stopped"; // stopped | starting | ready | unavailable
let info = null;
let port = 4750;

export function cloneStatus() {
  return { state, ...(info ?? {}) };
}

/**
 * Start the cloned-voice process.
 *
 * Resolves false when it isn't available for any reason — no venv, no reference
 * clip, no CUDA — because a missing cloned voice must never stop Greg talking.
 */
export function initClone(config) {
  const settings = config.clonedVoice ?? {};
  if (!settings.enabled) {
    state = "unavailable";
    info = { reason: "disabled in config" };
    return Promise.resolve(false);
  }

  const python = settings.python ?? DEFAULT_PYTHON;
  const reference = path.resolve(ROOT, settings.reference ?? "voices/greg-reference.wav");

  // Check both before spawning: the failure messages Python would give for these
  // are buried in a traceback, and this is the common way to get it wrong.
  if (!fs.existsSync(python)) {
    state = "unavailable";
    // Name the command. "Run the clone setup first" was reported by somebody on
    // a second machine as not telling them what to run — and they were right:
    // the clone environment is off by default even under -All, so the person
    // seeing this has by definition never run it and has nothing to recognise.
    // An instruction the reader cannot act on is the same defect as no message.
    info = {
      reason:
        `the cloned voice is not installed — no Python at ${path.relative(ROOT, python)}. ` +
        `Run: setup-greg.ps1 -Clone  (about 6 GB; any Python from 3.10 to 3.13)`,
    };
    return Promise.resolve(false);
  }
  if (!fs.existsSync(reference)) {
    state = "unavailable";
    // Same rule as above: say what to do, not only what is wrong. Nothing ships
    // a reference clip — that would be publishing somebody's voice — so a fresh
    // install reaches this legitimately and the reader has nothing to go on.
    info = {
      reason:
        `no reference clip at ${path.relative(ROOT, reference)}. Put about ten seconds of ` +
        `speech there as a WAV, or point clonedVoice.reference at one — see docs/voices.md`,
    };
    return Promise.resolve(false);
  }

  // Check the clip BEFORE spawning anything. Chatterbox re-reads the whole
  // reference on every generation, so an untrimmed recording runs the machine
  // out of memory during the warm-up — the process dies on a signal and Node
  // reports `exited (null)`, which names neither the file nor the cause.
  // Reading a WAV header is a few bytes; the alternative is a 4 GB model load
  // that ends in an OOM kill.
  const bytes = fs.statSync(reference).size;
  const problem = referenceProblem(describeWav(readHead(reference), { fileSize: bytes }), { bytes });
  if (problem) {
    state = "unavailable";
    info = { reason: `${path.basename(reference)}: ${problem}` };
    return Promise.resolve(false);
  }

  // Never spawn a second one alongside the first. Reassigning `child` would drop
  // the old process's handle while it kept running — and this sidecar holds about
  // 4.2 GB of VRAM, so a stranded copy is expensive and invisible until you go
  // looking at nvidia-smi. No-op on the startup path, where there is no child yet.
  stopClone();

  port = settings.port ?? 4750;
  state = "starting";

  return new Promise((resolve) => {
    try {
      child = spawn(python, [SCRIPT], {
        cwd: ROOT,
        env: {
          ...process.env,
          GREG_CLONE_REFERENCE: reference,
          GREG_CLONE_PORT: String(port),
          GREG_CLONE_DEVICE: settings.device ?? "cuda",
          ...(settings.exaggeration != null ? { GREG_CLONE_EXAGGERATION: String(settings.exaggeration) } : {}),
          ...(settings.cfgWeight != null ? { GREG_CLONE_CFG_WEIGHT: String(settings.cfgWeight) } : {}),
          ...(settings.temperature != null ? { GREG_CLONE_TEMPERATURE: String(settings.temperature) } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      state = "unavailable";
      info = { reason: err.message };
      return resolve(false);
    }

    // Loading the model measured ~42 s cold, plus a warm-up generation before it
    // reports READY, plus a first-run download of the weights from HuggingFace.
    const timer = setTimeout(() => {
      if (state !== "ready") {
        state = "unavailable";
        info = { reason: "the cloned voice took too long to start" };
        resolve(false);
      }
    }, 300000);

    let stderrTail = "";

    child.stdout.on("data", (chunk) => {
      const line = chunk.toString();

      const failed = /ERROR (.+)/.exec(line);
      if (failed) {
        clearTimeout(timer);
        state = "unavailable";
        info = { reason: failed[1].trim() };
        return resolve(false);
      }

      const match = /READY reference=(\S+) rate=(\d+)/.exec(line);
      if (match) {
        clearTimeout(timer);
        state = "ready";
        // The dials travel with the status because the speech cache keys on them:
        // change exaggeration in config.json and every cached clip must miss, or
        // Greg keeps speaking in the old character from disk.
        info = {
          reference: match[1],
          sampleRate: Number(match[2]),
          exaggeration: settings.exaggeration ?? 0.5,
          cfgWeight: settings.cfgWeight ?? 0.5,
          temperature: settings.temperature ?? 0.8,
        };
        console.log(`[voice] cloned voice ready (${match[1]})`);
        resolve(true);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      // Model download progress and torch's deprecation noise both land here.
      if (/Traceback|ModuleNotFound|CUDA out of memory/i.test(text)) {
        console.error(`[voice] ${text.trim().slice(0, 300)}`);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      state = "unavailable";
      info = { reason: err.code === "ENOENT" ? "clone Python not found" : err.message };
      resolve(false);
    });

    child.on("exit", (code) => {
      if (state !== "ready") {
        clearTimeout(timer);
        state = "unavailable";
        // usefulError picks the line that says what happened, rather than the
        // last 200 characters — which for a CUDA failure is torch's generic
        // debugging advice and names nothing.
        info = { reason: `cloned voice exited (${code})`, detail: usefulError(stderrTail) };
        resolve(false);
      } else {
        state = "stopped";
        console.warn("[voice] cloned voice stopped — falling back to Piper");
      }
      child = null;
    });
  });
}

/** Synthesize text in the cloned voice. Returns a WAV buffer. */
export async function speakCloned(text) {
  if (state !== "ready") throw new Error("the cloned voice isn't running");

  // Generous next to Piper's 30 s: this runs at roughly realtime, so a long
  // sentence legitimately takes several seconds.
  const res = await fetch(`http://127.0.0.1:${port}/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(90000),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `synthesis failed (${res.status})`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Stop the sidecar — the whole TREE of it, not the process Node happens to hold.
 *
 * `child.kill()` was not enough and the difference was expensive. The venv's
 * python.exe spawns a SECOND python.exe which is the one that actually loads the
 * model, opens the port and holds about 4 GB of the card:
 *
 *     node -> python.exe (Node's handle)  ->  python.exe (the real worker)
 *
 * Killing the handle left the grandchild running. Found with six of them alive
 * at once on the machine this was written on, holding 20.3 of 24.5 GB between
 * them — every voice switch had stranded another, and Greg's own bookkeeping had
 * drifted onto a wrapper whose worker was gone while a different orphan still
 * owned port 4750.
 *
 * This is the same lesson stop-greg.bat learned: force-killing the parent skips
 * the cleanup and orphans the sidecar. It kills by tree there too.
 */
export function stopClone() {
  if (!child) return;

  const pid = child.pid;
  child.kill();
  child = null;
  state = "stopped";
  if (!pid) return;

  if (process.platform === "win32") {
    // /T for the tree, /F because a process mid-CUDA-load does not stop politely.
    // Fire and forget: a failure here means the process was already gone, and a
    // shutdown path must not throw.
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", detached: false }).unref();
    } catch {
      // Nothing to do — the handle kill above is all that is left to try.
    }
    return;
  }

  // POSIX: negative pid signals the whole process group. spawn() would need
  // detached:true for that to be its own group, so fall back to the plain kill
  // if it is not.
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone, or not a group leader. The child.kill() above stands.
  }
}
