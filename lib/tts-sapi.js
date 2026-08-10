// Windows' own voice, as the last thing that still works offline.
//
// It sits between Piper and Edge in the chain, and that position is the whole
// reason it exists. Before it, a failure of the local voice fell straight to
// Microsoft's servers — so the one property this project puts at the top of its
// README ("nothing you say is sent anywhere") quietly stopped holding at the
// exact moment something had already gone wrong. Now a local voice failing
// degrades to another local voice, and the cloud is only reached if Windows
// itself has no speech at all.
//
// Measured on this machine: **230 ms for 4.65 s of audio, about 20x realtime** —
// twice Piper's speed — and 22050 Hz 16-bit mono WAV, byte-identical in shape to
// what Piper already returns, so nothing downstream needed a new format.
//
// No sidecar. It is spawned per utterance and exits, for the same reason the
// engineering channel shells out to nvidia-smi rather than keeping something
// alive: a long-running helper would have to be added to stop-greg.bat's sweep
// BY NAME, and a process that outlives a shutdown is a bug this project has
// already paid for more than once.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, "speak-sapi.ps1");

let settings = { enabled: true, voice: "", rate: 0 };
let available = null; // null until probed, then true/false
let reason = "not checked yet";

/**
 * Ask Windows whether it has any voices at all.
 *
 * Probed once at startup rather than assumed: Windows Server installs and some
 * stripped images genuinely have none, and finding that out mid-sentence is too
 * late to do anything useful about it.
 */
export async function initSapi(config = {}) {
  const wanted = config.systemVoice ?? {};
  settings = {
    enabled: wanted.enabled !== false,
    voice: typeof wanted.voice === "string" ? wanted.voice : "",
    rate: Number.isFinite(Number(wanted.rate)) ? Number(wanted.rate) : 0,
  };

  if (!settings.enabled) {
    available = false;
    reason = "switched off in config.json";
    return sapiStatus();
  }

  if (process.platform !== "win32") {
    available = false;
    reason = "not Windows";
    return sapiStatus();
  }

  try {
    const voices = await listVoices();
    available = voices.length > 0;
    reason = available ? `${voices.length} voice${voices.length === 1 ? "" : "s"}` : "Windows reports no installed voices";
    if (available && settings.voice && !voices.includes(settings.voice)) {
      console.warn(`[voice] system voice "${settings.voice}" is not installed — using the Windows default. Have: ${voices.join(", ")}`);
      settings.voice = "";
    }
  } catch (err) {
    available = false;
    reason = err.message;
  }
  return sapiStatus();
}

export function sapiStatus() {
  return {
    state: available ? "ready" : "unavailable",
    voice: settings.voice || "Windows default",
    rate: settings.rate,
    reason,
  };
}

function listVoices() {
  // Through the script, not an inline -Command: a script block full of braces
  // does not survive Node's argument quoting on Windows, and the first attempt
  // came back "MissingEndCurlyBrace" rather than a list of voices.
  return run(
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-List"],
    8000,
  ).then((out) => out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
}

/** Speak, and hand back the WAV bytes. */
export async function speakWithSystemVoice(text) {
  const stamp = `${process.pid}-${Date.now()}`;
  const textFile = path.join(os.tmpdir(), `greg-say-${stamp}.txt`);
  const wavFile = path.join(os.tmpdir(), `greg-say-${stamp}.wav`);

  try {
    // Via a file, so nothing the model wrote is ever interpolated into a command
    // line. An apostrophe in "the cafe's menu" would break naive quoting without
    // anyone trying to.
    fs.writeFileSync(textFile, text, "utf8");

    const args = [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT,
      "-TextFile", textFile, "-Out", wavFile, "-Rate", String(settings.rate),
    ];
    if (settings.voice) args.push("-Voice", settings.voice);

    await run(args, 20000);
    if (!fs.existsSync(wavFile)) throw new Error("no audio was written");
    return fs.readFileSync(wavFile);
  } finally {
    // Both, always. One of them is a transcript of what he was about to say.
    fs.rm(textFile, { force: true }, () => {});
    fs.rm(wavFile, { force: true }, () => {});
  }
}

function run(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("powershell", args, { windowsHide: true });
    } catch (err) {
      return reject(new Error(`couldn't start PowerShell: ${err.message}`));
    }

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("the system voice timed out"));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(err.code === "ENOENT" ? "PowerShell not found" : err.message));
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(stderr.trim().split("\n").pop()?.slice(0, 160) || `system voice failed (${code})`));
      }
      resolve(stdout);
    });
  });
}
