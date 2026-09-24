// Setting Greg up from his own window: find out what this PC has, download
// what it lacks with a progress bar, and check every byte.
//
// It replaces a console full of pip and winget for the parts Greg can fetch
// himself: his hearing (whisper.cpp and its models), his voice's pronunciation
// data and default voice, and his brain (through Ollama's own pull). Python is
// not involved at all. Ollama itself, if missing, is installed with winget — the
// one step that is a separate program's installer.
//
// Every file is pinned to an exact size and SHA-256, taken from the project's
// own published digest where there is one (GitHub releases, Hugging Face's LFS
// hashes) and checked against it before it is used. A mismatch is a failed
// step, never a used file.
//
// Everything that touches the network, the disk or another program is passed
// in, so the tests run it against a local server.

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { enginePaths, whisperEngine, espeakData, VAD_MODEL } from "./engines.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GITHUB = "https://github.com";
const HF = "https://huggingface.co";

/** What Greg downloads, where from, and exactly what it must be. */
export const FILES = {
  whisperCuda: {
    label: "Hearing, on your graphics card (whisper.cpp)",
    url: `${GITHUB}/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-cublas-12.4.0-bin-x64.zip`,
    bytes: 670611449,
    sha256: "443110ddaad70d4290ab2e77179e31cf712035bbc4fad56bb4519a90c917b39c",
  },
  whisperCpu: {
    label: "Hearing (whisper.cpp)",
    url: `${GITHUB}/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip`,
    bytes: 8194445,
    sha256: "49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a",
  },
  whisperModel: {
    label: "Hearing model (base.en)",
    url: `${HF}/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin`,
    bytes: 147964211,
    sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
  },
  vadModel: {
    label: "Silence filter (Silero VAD)",
    url: `${HF}/ggml-org/whisper-vad/resolve/main/${VAD_MODEL}`,
    bytes: 885098,
    sha256: "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf",
  },
  espeak: {
    label: "Pronunciation data for his voice",
    url: `${GITHUB}/k2-fsa/sherpa-onnx/releases/download/tts-models/espeak-ng-data.zip`,
    bytes: 9037020,
    sha256: "bc4525eafe31b4e3f5e43aea495f3169e97dd2544f1bbfe95514ce8a61baee39",
  },
  voice: {
    label: "His voice (Piper, en_US-ryan-high)",
    url: `${HF}/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/ryan/high/en_US-ryan-high.onnx`,
    bytes: 120786792,
    sha256: "b3990d7606e183ec8dbfba70a4607074f162de1a0c412e0180d1ff60bb154eca",
  },
  voiceConfig: {
    label: "His voice's settings",
    url: `${HF}/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/ryan/high/en_US-ryan-high.onnx.json`,
    bytes: 4166,
    sha256: "c6d3b98f08315cb4bebf0d49d50fc4ff491b503c64b940cd3d5ca28543b48011",
  },
};

// Roughly what Ollama downloads for each model, for the sizes on screen only —
// Ollama checks its own downloads.
const MODEL_BYTES = { "gemma4:e4b": 9.6e9, "qwen2.5vl:7b": 6.0e9 };

// CUDA 12.x needs at least this driver on Windows. Older, and the CPU build.
const CUDA12_MIN_DRIVER = 527.41;

function run(command, args, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** From nvidia-smi's CSV: the first GPU's name, memory and driver, or null. */
export function parseGpu(csv) {
  const line = String(csv ?? "").trim().split(/\r?\n/)[0];
  if (!line) return null;
  const [name, memory, driver] = line.split(",").map((s) => s.trim());
  const vramMB = Number(memory);
  if (!name || !Number.isFinite(vramMB)) return null;
  return { name, vramMB, driver: driver ?? "" };
}

/** Which whisper.cpp build this machine should get. */
export function whisperBuildFor(gpu, platform = process.platform) {
  if (platform !== "win32") return null; // the prebuilt engines are Windows ones
  if (!gpu) return "cpu";
  return Number.parseFloat(gpu.driver) >= CUDA12_MIN_DRIVER ? "cuda" : "cpu";
}

/**
 * Is it worth offering the eyes? They need about 8.6 GB of the card on top of
 * the brain's 5.1 (driver-level, measured — see docs/mini.md). Offered from 14
 * GB, where both fit; below that, loading them evicts the brain.
 */
export const eyesFit = (gpu) => Boolean(gpu && gpu.vramMB >= 14000);

/** Everything the setup screen needs to know about this PC. */
export async function survey(config = {}, { root = ROOT, platform = process.platform, runner = run, fetchImpl = fetch } = {}) {
  let gpu = null;
  try {
    gpu = parseGpu(await runner("nvidia-smi", ["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"]));
  } catch {
    gpu = null; // no NVIDIA card, or no driver
  }

  const ollamaUrl = config.ollama?.url ?? "http://localhost:11434";
  let ollama = { running: false, models: [] };
  try {
    const res = await fetchImpl(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    ollama = { running: true, models: (data.models ?? []).map((m) => m.name) };
  } catch {
    ollama.installed = await ollamaInstalled({ runner, platform });
  }
  if (ollama.running) ollama.installed = true;

  const p = enginePaths(root);
  const voiceName = config.localVoice?.voice ?? "en_US-ryan-high";
  const cpp = whisperEngine(config.speech?.model ?? "base.en", { root });
  return {
    platform,
    gpu,
    whisperBuild: whisperBuildFor(gpu, platform),
    eyesFit: eyesFit(gpu),
    ollama,
    brainModel: config.ollama?.model ?? "gemma4:e4b",
    eyesModel: config.vision?.model ?? "qwen2.5vl:7b",
    have: {
      whisper: cpp ? cpp.build : fs.existsSync(path.join(p.whisperDir, platform === "win32" ? "whisper-server.exe" : "whisper-server")) ? "partial" : null,
      whisperModel: fs.existsSync(path.join(p.modelsDir, "ggml-base.en.bin")),
      vad: fs.existsSync(path.join(p.modelsDir, VAD_MODEL)),
      espeak: Boolean(espeakData({ root })),
      voice: voiceName,
      voiceFiles: fs.existsSync(path.join(root, "voices", `${voiceName}.onnx`)) && fs.existsSync(path.join(root, "voices", `${voiceName}.onnx.json`)),
    },
  };
}

async function ollamaInstalled({ runner, platform }) {
  const local = platform === "win32" ? path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Ollama", "ollama.exe") : null;
  if (local && fs.existsSync(local)) return true;
  try {
    await runner("ollama", ["--version"], 4000);
    return true;
  } catch {
    return false;
  }
}

const hasModel = (models, wanted) => models.some((m) => m === wanted || m === `${wanted}:latest`);

/**
 * The steps this PC needs, in order, with their sizes. A step already done is
 * listed as done, so the screen shows the whole picture rather than a list that
 * shrinks as it works.
 *
 * The voice files are needed only for the default voice: a different one set
 * in config.json is the user's choice, fetched by the Python Piper as before.
 */
export function planSteps(s, { eyes = false } = {}) {
  const steps = [];
  const add = (id, label, bytes, done, extra = {}) => steps.push({ id, label, bytes, done: Boolean(done), ...extra });

  if (!s.ollama.installed) add("ollama", "Ollama, which runs his brain", 0, false, { note: "installed with winget, Windows' own package manager" });
  add("brain", `His brain (${s.brainModel})`, MODEL_BYTES[s.brainModel] ?? 0, hasModel(s.ollama.models, s.brainModel));
  if (eyes) add("eyes", `His eyes (${s.eyesModel})`, MODEL_BYTES[s.eyesModel] ?? 0, hasModel(s.ollama.models, s.eyesModel));

  if (s.whisperBuild) {
    const file = s.whisperBuild === "cuda" ? FILES.whisperCuda : FILES.whisperCpu;
    add("whisper", file.label, file.bytes, s.have.whisper === s.whisperBuild || s.have.whisper === "cuda", { file: s.whisperBuild === "cuda" ? "whisperCuda" : "whisperCpu" });
    add("whisperModel", FILES.whisperModel.label, FILES.whisperModel.bytes, s.have.whisperModel, { file: "whisperModel" });
    add("vad", FILES.vadModel.label, FILES.vadModel.bytes, s.have.vad, { file: "vadModel" });
    add("espeak", FILES.espeak.label, FILES.espeak.bytes, s.have.espeak, { file: "espeak" });
  }
  if (s.have.voice === "en_US-ryan-high") {
    add("voice", FILES.voice.label, FILES.voice.bytes + FILES.voiceConfig.bytes, s.have.voiceFiles, { file: "voice" });
  }
  return steps;
}

/** Is anything essential missing — enough to open the setup screen by itself? */
export function setupNeeded(s) {
  return planSteps(s).some((step) => !step.done);
}

// ---------------------------------------------------------------------------
// Doing it
// ---------------------------------------------------------------------------

/**
 * Download one pinned file to `dest`, hashing as it arrives. Written to a .part
 * file and renamed only once size and SHA-256 both match, so a failed or
 * tampered download never sits where Greg would use it.
 */
export async function download(spec, dest, { fetchImpl = fetch, onProgress = () => {}, signal } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const res = await fetchImpl(spec.url, { signal, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`the download answered ${res.status}`);

  const hash = crypto.createHash("sha256");
  const out = fs.createWriteStream(part);
  let received = 0;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      received += chunk.length;
      if (received > spec.bytes) throw new Error("the download is larger than it should be");
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      onProgress(received, spec.bytes);
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw err;
  }

  const digest = hash.digest("hex");
  if (received !== spec.bytes || digest !== spec.sha256) {
    fs.rmSync(part, { force: true });
    throw new Error(`the download didn't match what was published (got ${received} bytes, expected ${spec.bytes}); nothing was installed`);
  }
  fs.renameSync(part, dest);
  return dest;
}

/**
 * Unpack a zip with the tar that ships with Windows 10 and 11 — by its full
 * path. Plain "tar" found Git's GNU tar first on this machine's PATH, which
 * cannot read a zip at all, and anybody with Git installed has the same PATH.
 * Windows older than 1803 has no tar; PowerShell's Expand-Archive does it there.
 */
export function unzipCommand(file, into, { platform = process.platform, systemRoot = process.env.SystemRoot, exists = fs.existsSync } = {}) {
  if (platform !== "win32") return ["tar", ["-xf", file, "-C", into]];
  const tar = path.join(systemRoot || "C:\\Windows", "System32", "tar.exe");
  if (exists(tar)) return [tar, ["-xf", file, "-C", into]];
  const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
  return ["powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath ${quote(file)} -DestinationPath ${quote(into)} -Force`]];
}

function unzip(file, into, { runner = run } = {}) {
  fs.mkdirSync(into, { recursive: true });
  const [command, args] = unzipCommand(file, into);
  return runner(command, args, 120000);
}

/** Pull a model through Ollama's own API, reporting its progress. */
export async function pullModel(name, { ollamaUrl = "http://localhost:11434", fetchImpl = fetch, onProgress = () => {}, signal } = {}) {
  const res = await fetchImpl(`${ollamaUrl}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: name, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Ollama answered ${res.status}`);
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let at;
    while ((at = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.error) throw new Error(event.error);
      if (event.total) onProgress(event.completed ?? 0, event.total);
      if (event.status === "success") return true;
    }
  }
  throw new Error("Ollama stopped before the model was complete");
}

/**
 * Run the steps that aren't done, in order. `report(stepId, update)` is called
 * with { state: "working"|"done"|"failed", received?, total?, error? }. A failed
 * step stops nothing after it that doesn't depend on it: hearing and the voice
 * are independent of the brain, and one failing must not cost the other.
 */
export async function runSetup(steps, { root = ROOT, config = {}, report = () => {}, fetchImpl = fetch, runner = run, signal, files = FILES } = {}) {
  const p = enginePaths(root);
  const staging = path.join(p.engines, ".downloads");
  const ollamaUrl = config.ollama?.url ?? "http://localhost:11434";
  const progress = (id) => (received, total) => report(id, { state: "working", received, total });
  const results = {};

  for (const step of steps) {
    if (step.done) continue;
    report(step.id, { state: "working" });
    try {
      switch (step.id) {
        case "ollama":
          await runner("winget", ["install", "--id", "Ollama.Ollama", "--exact", "--silent", "--accept-package-agreements", "--accept-source-agreements"], 15 * 60000);
          break;
        case "brain":
        case "eyes":
          await pullModel(step.id === "brain" ? config.ollama?.model ?? "gemma4:e4b" : config.vision?.model ?? "qwen2.5vl:7b", {
            ollamaUrl, fetchImpl, onProgress: progress(step.id), signal,
          });
          break;
        case "whisper": {
          const zip = await download(files[step.file], path.join(staging, "whisper.zip"), { fetchImpl, onProgress: progress(step.id), signal });
          const unpacked = path.join(staging, "whisper");
          fs.rmSync(unpacked, { recursive: true, force: true });
          await unzip(zip, unpacked, { runner });
          // Only the server and the libraries it loads — not the zip's demos.
          const release = fs.existsSync(path.join(unpacked, "Release")) ? path.join(unpacked, "Release") : unpacked;
          fs.rmSync(p.whisperDir, { recursive: true, force: true });
          fs.mkdirSync(p.whisperDir, { recursive: true });
          for (const name of fs.readdirSync(release)) {
            if (name === "whisper-server.exe" || name.toLowerCase().endsWith(".dll")) fs.copyFileSync(path.join(release, name), path.join(p.whisperDir, name));
          }
          fs.writeFileSync(path.join(p.whisperDir, "build.json"), JSON.stringify({ build: step.file === "whisperCuda" ? "cuda" : "cpu", version: "v1.9.2" }));
          fs.rmSync(unpacked, { recursive: true, force: true });
          fs.rmSync(zip, { force: true });
          break;
        }
        case "whisperModel":
          await download(files.whisperModel, path.join(p.modelsDir, "ggml-base.en.bin"), { fetchImpl, onProgress: progress(step.id), signal });
          break;
        case "vad":
          await download(files.vadModel, path.join(p.modelsDir, VAD_MODEL), { fetchImpl, onProgress: progress(step.id), signal });
          break;
        case "espeak": {
          const zip = await download(files.espeak, path.join(staging, "espeak-ng-data.zip"), { fetchImpl, onProgress: progress(step.id), signal });
          const unpacked = path.join(staging, "espeak");
          fs.rmSync(unpacked, { recursive: true, force: true });
          await unzip(zip, unpacked, { runner });
          // Whether the zip has a top folder or not, the data is the folder
          // holding "phontab": found, not assumed.
          const found = [unpacked, ...fs.readdirSync(unpacked).map((n) => path.join(unpacked, n))].find((d) => fs.existsSync(path.join(d, "phontab")));
          if (!found) throw new Error("the pronunciation data wasn't in the download");
          fs.rmSync(p.espeakData, { recursive: true, force: true });
          fs.renameSync(found, p.espeakData);
          fs.rmSync(unpacked, { recursive: true, force: true });
          fs.rmSync(zip, { force: true });
          break;
        }
        case "voice": {
          const voices = path.join(root, "voices");
          let base = 0;
          await download(files.voiceConfig, path.join(voices, "en_US-ryan-high.onnx.json"), { fetchImpl, signal, onProgress: (r) => (base = r) });
          await download(files.voice, path.join(voices, "en_US-ryan-high.onnx"), {
            fetchImpl, signal, onProgress: (r) => progress(step.id)(base + r, step.bytes),
          });
          break;
        }
        default:
          throw new Error(`nothing knows how to do "${step.id}"`);
      }
      results[step.id] = "done";
      report(step.id, { state: "done" });
    } catch (err) {
      results[step.id] = "failed";
      report(step.id, { state: "failed", error: err.message });
      if (signal?.aborted) break;
    }
  }
  fs.rmSync(staging, { recursive: true, force: true });
  return results;
}

/** Free space where Greg lives, for the screen to warn before a 10 GB download. */
export function freeBytes(dir = ROOT) {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

export const cpuCount = () => os.availableParallelism?.() ?? os.cpus().length;
