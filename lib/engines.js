// Where the Python-free speech engines live, and whether they are there.
//
//   engines/whisper/          whisper.cpp: whisper-server.exe and its DLLs,
//                             plus build.json saying which build ("cuda"/"cpu")
//   engines/models/           ggml-<model>.bin, and the Silero VAD model
//   engines/espeak-ng-data/   pronunciation data for Piper voices under sherpa-onnx
//   cache/sherpa-voices/      Piper voices converted for sherpa-onnx (see piper-convert.js)
//
// All of it is downloaded, never committed (engines/ is gitignored). Measured
// against the Python engines before replacing them — see notes/sound-and-voice.md:
// whisper.cpp heard the same 768 clips as accurately (3.81% word errors against
// 3.62% clean, 4.18% against 4.65% noisy) in half the time, and sherpa-onnx spoke
// the same 24 sentences as fast (276 ms against 298) and as clearly.
//
// Takes a root, so tests point it at a scratch folder.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const VAD_MODEL = "ggml-silero-v5.1.2.bin";

export function enginePaths(root = ROOT) {
  const engines = path.join(root, "engines");
  return {
    engines,
    whisperDir: path.join(engines, "whisper"),
    modelsDir: path.join(engines, "models"),
    espeakData: path.join(engines, "espeak-ng-data"),
    sherpaVoices: path.join(root, "cache", "sherpa-voices"),
  };
}

const exe = (name, platform = process.platform) => (platform === "win32" ? `${name}.exe` : name);

/**
 * The installed whisper.cpp, or null. Needs the server, the model asked for,
 * and the VAD model — the silence filter is not optional: without its 400 ms of
 * padding, whisper.cpp clipped the first word of one clip in ten.
 */
export function whisperEngine(model = "base.en", { root = ROOT, platform = process.platform } = {}) {
  const p = enginePaths(root);
  // The platform is a parameter, like survey()'s: asked about Windows while
  // running on Linux (as CI does), it must look for whisper-server.exe.
  const server = path.join(p.whisperDir, exe("whisper-server", platform));
  const modelFile = path.join(p.modelsDir, `ggml-${model}.bin`);
  const vad = path.join(p.modelsDir, VAD_MODEL);
  if (![server, modelFile, vad].every((f) => fs.existsSync(f))) return null;
  let build = "cpu";
  try {
    build = JSON.parse(fs.readFileSync(path.join(p.whisperDir, "build.json"), "utf8")).build === "cuda" ? "cuda" : "cpu";
  } catch {
    build = fs.existsSync(path.join(p.whisperDir, "ggml-cuda.dll")) ? "cuda" : "cpu";
  }
  return { server, model: modelFile, vad, build, dir: p.whisperDir };
}

/** The pronunciation data sherpa-onnx needs for Piper voices, or null. */
export function espeakData({ root = ROOT } = {}) {
  const dir = enginePaths(root).espeakData;
  return fs.existsSync(path.join(dir, "phontab")) ? dir : null;
}

/**
 * Threads for the voice. ONNX Runtime's own default is the number of PHYSICAL
 * cores, which is what the Python Piper was getting; half the logical count is
 * that on any machine with hyper-threading. Capped at 16, where the measured
 * gain stopped (16 and 12 threads both matched the Python voice; 8 did not).
 */
export function voiceThreads(logical = os.availableParallelism?.() ?? os.cpus().length) {
  return Math.max(1, Math.min(16, Math.floor(logical / 2) || 1));
}

/**
 * The arguments whisper-server gets. Matched to what faster-whisper did in
 * whisper_server.py: English, greedy, and its VAD settings exactly — 400 ms of
 * padding, 2 s minimum silence, no minimum speech length. whisper.cpp's own
 * default padding (30 ms) cut the first word off ("play some Steely Dan" came
 * back "some steely Dan"); with these, the two engines scored the same.
 */
export function whisperArgs(engine, { port = 4748, threads = 8 } = {}) {
  return [
    "-m", engine.model,
    "--host", "127.0.0.1",
    "--port", String(port),
    "-l", "en",
    "-nt",
    "-t", String(threads),
    "--vad",
    "-vm", engine.vad,
    "-vp", "400",
    "-vsd", "2000",
    "-vspd", "0",
  ];
}
