// Speech-to-text: a local Whisper process, by one of two engines.
//
//   whisper.cpp   whisper-server.exe, no Python. Preferred when installed: on 768
//                 test clips it was as accurate as faster-whisper and took half
//                 the time (29 ms a clip on the GPU, 348 ms on the CPU).
//   faster-whisper   the Python sidecar, whisper_server.py — the fallback.
//
// Entirely optional. With neither, Greg falls back to the browser's own speech
// recognition and everything still works.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sidecarPython } from "./platform.js";
import { whisperEngine, whisperArgs } from "./engines.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, "whisper_server.py");

let child = null;
let state = "stopped"; // stopped | starting | ready | unavailable
let info = null;
let port = 4748;
let engine = null; // "whisper.cpp" | "faster-whisper"

export function sttStatus() {
  return { state, ...(info ?? {}) };
}

/**
 * Start local hearing: whisper.cpp if it is installed, the Python sidecar if not.
 * Resolves to false (rather than throwing) when neither is available, so startup
 * continues on the browser's recognition.
 *
 * `speech.engine` is "auto" (the default), "whisper.cpp" or "python".
 */
export async function initStt(config) {
  const settings = config.speech ?? {};
  if (settings.mode === "browser") {
    state = "unavailable";
    info = { reason: "disabled in config" };
    return false;
  }

  port = settings.port ?? 4748;
  const wanted = settings.engine ?? "auto";
  if (wanted !== "python") {
    const cpp = whisperEngine(settings.model ?? "base.en");
    if (cpp) return startWhisperCpp(cpp, settings);
    if (wanted === "whisper.cpp") {
      state = "unavailable";
      info = { reason: "whisper.cpp isn't installed" };
      return false;
    }
  }
  return startPython(settings);
}

/** whisper-server, started and waited for until it answers. */
function startWhisperCpp(cpp, settings) {
  state = "starting";
  engine = "whisper.cpp";
  const args = whisperArgs(cpp, { port });
  if (settings.device === "cpu") args.push("-ng");

  return new Promise((resolve) => {
    let gpu = null;
    let stderrTail = "";
    let settled = false;
    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      if (ok) {
        state = "ready";
        const device = gpu ? "cuda" : "cpu";
        info = { device, model: settings.model ?? "base.en", engine: "whisper.cpp", ...(gpu ? { gpu } : {}) };
        console.log(`[ears] local speech recognition ready (${info.model} on ${gpu ?? "the CPU"}, whisper.cpp)`);
      } else {
        state = "unavailable";
        info = { reason: detail, detail: stderrTail.trim().slice(-200) };
      }
      resolve(ok);
    };

    try {
      child = spawn(cpp.server, args, { cwd: cpp.dir, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    } catch (err) {
      return finish(false, err.message);
    }

    // whisper.cpp logs everything to stderr, including which GPU it found.
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-2000);
      const device = /Device 0: ([^,\r\n]+)/.exec(text);
      if (device) gpu = device[1].trim();
    });
    child.on("error", (err) => finish(false, err.code === "ENOENT" ? "whisper-server not found" : err.message));
    child.on("exit", (code) => {
      if (state !== "ready") finish(false, `whisper-server exited (${code})`);
      else {
        state = "stopped";
        console.warn("[ears] local speech recognition stopped");
      }
      child = null;
    });

    // Ready when it answers HTTP. Loading base.en takes about a second.
    const started = Date.now();
    const poll = setInterval(async () => {
      if (Date.now() - started > 60000) return finish(false, "whisper.cpp took too long to start");
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) finish(true);
      } catch {
        /* not listening yet */
      }
    }, 250);
  });
}

/** The Python sidecar, whisper_server.py — the engine this module always had. */
function startPython(settings) {
  engine = "faster-whisper";
  state = "starting";

  return new Promise((resolve) => {
    const python = settings.python ?? sidecarPython();
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
        info = { device: match[1], model: match[2], engine: "faster-whisper" };
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

  if (engine === "whisper.cpp") {
    const started = Date.now();
    const form = new FormData();
    form.append("file", new Blob([audio], { type: "audio/wav" }), "speech.wav");
    form.append("response_format", "json");
    form.append("temperature", "0.0");
    const res = await fetch(`http://127.0.0.1:${port}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(timeoutMs) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error ?? `transcription failed (${res.status})`);
    // The same shape as the Python sidecar's answer, so nothing downstream changes.
    return { text: String(data.text ?? "").trim(), ms: Date.now() - started, device: info?.device ?? "cpu" };
  }

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
