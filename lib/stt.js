// Speech-to-text: manages the local Whisper process and forwards audio to it.
//
// Entirely optional. If Python or faster-whisper isn't there, Greg falls back to
// the browser's own speech recognition and everything still works.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, "whisper_server.py");

let child = null;
let state = "stopped"; // stopped | starting | ready | unavailable
let info = null;
let port = 4748;

export function sttStatus() {
  return { state, ...(info ?? {}) };
}

/**
 * Start the Whisper process. Resolves to false (rather than throwing) when it
 * isn't available, so startup continues normally.
 */
export function initStt(config) {
  const settings = config.speech ?? {};
  if (settings.mode === "browser") {
    state = "unavailable";
    info = { reason: "disabled in config" };
    return Promise.resolve(false);
  }

  port = settings.port ?? 4748;
  state = "starting";

  return new Promise((resolve) => {
    const python = settings.python ?? "py";
    const args = python === "py" ? ["-3", SCRIPT] : [SCRIPT];

    try {
      child = spawn(python, args, {
        cwd: ROOT,
        env: {
          ...process.env,
          GREG_WHISPER_MODEL: settings.model ?? "base.en",
          GREG_WHISPER_DEVICE: settings.device ?? "auto",
          GREG_WHISPER_PORT: String(port),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      state = "unavailable";
      info = { reason: err.message };
      return resolve(false);
    }

    // Loading the model (and downloading it the first time) can take a while.
    const timer = setTimeout(() => {
      if (state !== "ready") {
        state = "unavailable";
        info = { reason: "Whisper took too long to start" };
        resolve(false);
      }
    }, 180000);

    let stderrTail = "";

    child.stdout.on("data", (chunk) => {
      const line = chunk.toString();
      const match = /READY device=(\S+) model=(\S+)/.exec(line);
      if (match) {
        clearTimeout(timer);
        state = "ready";
        info = { device: match[1], model: match[2] };
        console.log(`[ears] local speech recognition ready (${match[2]} on ${match[1]})`);
        resolve(true);
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-600);
      // Hugging Face prints download progress here; only surface real problems.
      if (/Error|Traceback|ModuleNotFound/i.test(text)) console.error(`[ears] ${text.trim().slice(0, 300)}`);
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
        info = { reason: `Whisper exited (${code})`, detail: stderrTail.trim().slice(-200) };
        resolve(false);
      } else {
        state = "stopped";
        console.warn("[ears] local speech recognition stopped");
      }
      child = null;
    });
  });
}

/**
 * Send audio (a WAV buffer) and get back what was said.
 *
 * `timeoutMs` is a parameter because the two callers want wildly different
 * things from it. An utterance from the microphone is a second or two of speech
 * and 60 s is already generous; a recording off disk can be an hour long, and
 * cutting that off at a minute would report a failure for work that was going
 * perfectly well. The default is unchanged, so the live listening path behaves
 * exactly as it did.
 */
export async function transcribe(audio, { timeoutMs = 60000 } = {}) {
  if (state !== "ready") throw new Error("local speech recognition isn't running");

  const res = await fetch(`http://127.0.0.1:${port}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "Content-Length": String(audio.length) },
    body: audio,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `transcription failed (${res.status})`);
  return data;
}

export function stopStt() {
  if (child) {
    child.kill();
    child = null;
    state = "stopped";
  }
}
