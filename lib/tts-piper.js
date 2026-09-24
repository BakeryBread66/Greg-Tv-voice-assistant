// Local text-to-speech: Piper, by one of two engines.
//
//   sherpa-onnx   in this process, no Python. Preferred when installed: the same
//                 Piper voice, measured as fast (276 ms a sentence against 298)
//                 and as clearly heard back by Whisper. See lib/engines.js.
//   piper-tts     the Python sidecar, piper_server.py — the fallback, and still
//                 what downloads a voice that isn't on disk yet.
//
// Optional either way. With neither, Greg falls back to Windows' own voice and
// then the cloud voice (lib/tts.js), and says so.

import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sidecarPython } from "./platform.js";
import { enginePaths, espeakData, voiceThreads } from "./engines.js";
import { sherpaVoice } from "./piper-convert.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, "piper_server.py");

let child = null;
let state = "stopped"; // stopped | starting | ready | unavailable
let info = null;
let port = 4749;
let sherpaTts = null; // the in-process engine, when it is the one in use
let sherpaSpeaker = 0;

export function piperStatus() {
  return { state, ...(info ?? {}) };
}

/**
 * Start local speech: sherpa-onnx if it is installed, the Python sidecar if not.
 * Resolves to false (rather than throwing) when neither is available, so startup
 * continues on another voice.
 *
 * `localVoice.engine` is "auto" (the default), "sherpa" or "python".
 */
export async function initPiper(config) {
  const settings = config.localVoice ?? {};
  if (settings.enabled === false) {
    state = "unavailable";
    info = { reason: "disabled in config" };
    return false;
  }
  const wanted = settings.engine ?? "auto";
  if (wanted !== "python") {
    const why = await startSherpa(settings);
    if (why === true) return true;
    if (wanted === "sherpa") {
      state = "unavailable";
      info = { reason: why };
      return false;
    }
  }
  return startPython(config, settings);
}

/**
 * The voice in this process, through sherpa-onnx. Returns true, or the reason it
 * can't — which is said once and not an error: it means the Python engine next.
 */
async function startSherpa(settings) {
  const espeak = espeakData();
  if (!espeak) return "sherpa-onnx's pronunciation data isn't installed";
  const name = settings.voice ?? "en_US-ryan-high";
  const onnx = path.join(ROOT, "voices", `${name}.onnx`);
  if (!fs.existsSync(onnx) || !fs.existsSync(`${onnx}.json`)) return `the ${name} voice isn't downloaded yet`;

  let sherpa;
  try {
    sherpa = createRequire(import.meta.url)("sherpa-onnx-node");
  } catch (err) {
    return `sherpa-onnx didn't load (${err.message})`;
  }

  state = "starting";
  try {
    const voice = sherpaVoice(onnx, enginePaths().sherpaVoices);
    // config.json says "speed"; Piper wants length_scale, its reciprocal —
    // the same translation the Python sidecar has always made.
    const speed = Number(settings.speed) > 0 ? Number(settings.speed) : 1;
    sherpaTts = await sherpa.OfflineTts.createAsync({
      model: {
        vits: {
          model: voice.model,
          tokens: voice.tokens,
          dataDir: espeak,
          noiseScale: settings.noiseScale ?? voice.noiseScale,
          noiseScaleW: settings.noiseWScale ?? voice.noiseScaleW,
          lengthScale: 1 / speed,
        },
        numThreads: voiceThreads(),
        provider: "cpu",
        debug: false,
      },
      maxNumSentences: 1,
    });
    sherpaSpeaker = Number(settings.speaker) || 0;
  } catch (err) {
    sherpaTts = null;
    state = "stopped";
    return `sherpa-onnx couldn't load the voice (${err.message})`;
  }

  state = "ready";
  info = { voice: name, sampleRate: sherpaTts.sampleRate, engine: "sherpa-onnx" };
  console.log(`[voice] local speech ready (${name}, sherpa-onnx, ${voiceThreads()} threads)`);
  return true;
}

/** The Python sidecar, piper_server.py — the engine this module always had. */
function startPython(config, settings) {
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
        info = { voice: match[1], sampleRate: Number(match[2]), engine: "piper-tts" };
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

/**
 * 16-bit WAV from sherpa-onnx's float samples, peak-normalised the way the
 * Python Piper does (normalize_audio): scaled so the loudest sample is full
 * scale. Without it sherpa's voice came out about 5 dB quieter than the one it
 * replaces — peaks of 0.56 against 1.0 on the same 24 sentences.
 */
export function toWav(samples, sampleRate) {
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  const gain = 1 / Math.max(0.01, peak);
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i] * gain)) * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Synthesize text locally. Returns a WAV buffer. */
export async function speakLocally(text) {
  if (state !== "ready") throw new Error("local speech isn't running");

  if (sherpaTts) {
    const audio = await sherpaTts.generateAsync({ text, sid: sherpaSpeaker, speed: 1.0 });
    return toWav(audio.samples, audio.sampleRate);
  }

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
  if (sherpaTts) {
    // In this process: nothing to kill, only to let go of.
    sherpaTts = null;
    state = "stopped";
    return;
  }
  if (child) {
    child.kill();
    child = null;
    state = "stopped";
  }
}
