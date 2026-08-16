// Local text-to-speech: manages the Piper process and forwards text to it.
//
// Same shape as lib/stt.js, and optional in the same way. If Python or piper-tts
// isn't there, Greg falls back to the cloud voice in lib/tts-edge.js and
// everything still works — just not offline.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sidecarPython } from "./platform.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, "piper_server.py");

let child = null;
let state = "stopped"; // stopped | starting | ready | unavailable
let info = null;
let port = 4749;

export function piperStatus() {
  return { state, ...(info ?? {}) };
}

/**
 * Start the Piper process. Resolves to false (rather than throwing) when it
 * isn't available, so startup continues on the cloud voice.
 */
export function initPiper(config) {
  const settings = config.localVoice ?? {};
  if (settings.enabled === false) {
    state = "unavailable";
    info = { reason: "disabled in config" };
    return Promise.resolve(false);
  }

  port = settings.port ?? 4749;
  state = "starting";

  return new Promise((resolve) => {
    const python = settings.python ?? config.speech?.python ?? sidecarPython();
    const args = python === "py" ? ["-3", SCRIPT] : [SCRIPT];

    // config.json talks about "speed" because that's the intuitive direction;
    // Piper wants length_scale, which is its reciprocal — bigger means slower.
    const speed = Number(settings.speed) > 0 ? Number(settings.speed) : 1;

    try {
      child = spawn(python, args, {
        cwd: ROOT,
        env: {
          ...process.env,
          GREG_PIPER_VOICE: settings.voice ?? "en_US-ryan-high",
          GREG_PIPER_PORT: String(port),
          GREG_PIPER_LENGTH_SCALE: String(1 / speed),
          ...(settings.speaker != null ? { GREG_PIPER_SPEAKER: String(settings.speaker) } : {}),
          ...(settings.noiseScale != null ? { GREG_PIPER_NOISE_SCALE: String(settings.noiseScale) } : {}),
          ...(settings.noiseWScale != null ? { GREG_PIPER_NOISE_W_SCALE: String(settings.noiseWScale) } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      state = "unavailable";
      info = { reason: err.message };
      return resolve(false);
    }

    // First run downloads a 60-140 MB voice model, so this has to be generous.
    const timer = setTimeout(() => {
      if (state !== "ready") {
        state = "unavailable";
        info = { reason: "Piper took too long to start" };
        resolve(false);
      }
    }, 180000);

    let stderrTail = "";

    child.stdout.on("data", (chunk) => {
      const line = chunk.toString();

      // A silent minute of startup looks like a hang; say what's happening.
      // Sizes run from ~63 MB for a "-medium" voice to ~140 MB for a "-high" one.
      const downloading = /DOWNLOADING voice=(\S+)/.exec(line);
      if (downloading) console.log(`[voice] downloading the ${downloading[1]} voice — 60-140 MB, first run only`);

      const match = /READY voice=(\S+) rate=(\d+)/.exec(line);
      if (match) {
        clearTimeout(timer);
        state = "ready";
        info = { voice: match[1], sampleRate: Number(match[2]) };
        console.log(`[voice] local speech ready (${match[1]})`);
        resolve(true);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-600);
      // The downloader logs progress here; only surface real problems.
      if (/Error|Traceback|ModuleNotFound/i.test(text)) console.error(`[voice] ${text.trim().slice(0, 300)}`);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      state = "unavailable";
      info = { reason: err.code === "ENOENT" ? "Python not found" : err.message };
      resolve(false);
    });

    child.on("exit", (code) => {
      if (state !== "ready") {
        clearTimeout(timer);
        state = "unavailable";
        info = { reason: `Piper exited (${code})`, detail: stderrTail.trim().slice(-200) };
        resolve(false);
      } else {
        state = "stopped";
        console.warn("[voice] local speech stopped — falling back to the cloud voice");
      }
      child = null;
    });
  });
}

/** Synthesize text locally. Returns a WAV buffer. */
export async function speakLocally(text) {
  if (state !== "ready") throw new Error("local speech isn't running");

  const res = await fetch(`http://127.0.0.1:${port}/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `synthesis failed (${res.status})`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export function stopPiper() {
  if (child) {
    child.kill();
    child = null;
    state = "stopped";
  }
}
