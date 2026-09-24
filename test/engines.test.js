// The Python-free speech engines: finding them, how whisper.cpp is started, the
// conversion of a Piper voice for sherpa-onnx, and the loudness of what it says.
//
// No engine runs here. The measurements that chose these engines, and the
// settings pinned below, are in notes/sound-and-voice.md.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { enginePaths, whisperEngine, espeakData, whisperArgs, voiceThreads, VAD_MODEL } from "../lib/engines.js";
import { sherpaMetadata, metadataBytes, tokensText, sherpaVoice } from "../lib/piper-convert.js";
import { toWav } from "../lib/tts-piper.js";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "greg-engines-"));
after(() => fs.rmSync(DIR, { recursive: true, force: true }));

function install(root, { build = "cuda", model = "base.en", vad = true, espeak = true } = {}) {
  const p = enginePaths(root);
  fs.mkdirSync(p.whisperDir, { recursive: true });
  fs.mkdirSync(p.modelsDir, { recursive: true });
  fs.writeFileSync(path.join(p.whisperDir, process.platform === "win32" ? "whisper-server.exe" : "whisper-server"), "");
  fs.writeFileSync(path.join(p.whisperDir, "build.json"), JSON.stringify({ build }));
  fs.writeFileSync(path.join(p.modelsDir, `ggml-${model}.bin`), "");
  if (vad) fs.writeFileSync(path.join(p.modelsDir, VAD_MODEL), "");
  if (espeak) {
    fs.mkdirSync(p.espeakData, { recursive: true });
    fs.writeFileSync(path.join(p.espeakData, "phontab"), "");
  }
  return p;
}

test("whisper.cpp counts as installed only with its server, its model and its VAD model", () => {
  const root = path.join(DIR, "full");
  install(root);
  const found = whisperEngine("base.en", { root });
  assert.equal(found.build, "cuda");
  assert.match(found.model, /ggml-base\.en\.bin$/);

  assert.equal(whisperEngine("small.en", { root }), null, "a model that isn't downloaded");
  const noVad = path.join(DIR, "no-vad");
  install(noVad, { vad: false });
  // Without the VAD model the silence filter can't run, and without its padding
  // whisper.cpp cut the first word off one clip in ten. Not installed.
  assert.equal(whisperEngine("base.en", { root: noVad }), null);
  assert.equal(whisperEngine("base.en", { root: path.join(DIR, "nothing") }), null);
});

test("the platform asked about decides the server's name, not the one running the test", () => {
  // CI on Linux asked survey() about Windows, and whisperEngine looked for the
  // Linux name — a Windows install read as "partial". Caught on Linux only.
  const root = path.join(DIR, "platforms");
  const p = enginePaths(root);
  fs.mkdirSync(p.whisperDir, { recursive: true });
  fs.mkdirSync(p.modelsDir, { recursive: true });
  fs.writeFileSync(path.join(p.whisperDir, "whisper-server.exe"), "");
  fs.writeFileSync(path.join(p.modelsDir, "ggml-base.en.bin"), "");
  fs.writeFileSync(path.join(p.modelsDir, VAD_MODEL), "");
  assert.ok(whisperEngine("base.en", { root, platform: "win32" }));
  assert.equal(whisperEngine("base.en", { root, platform: "linux" }), null);
});

test("the CPU build is told apart from the GPU one", () => {
  const root = path.join(DIR, "cpu");
  install(root, { build: "cpu" });
  assert.equal(whisperEngine("base.en", { root }).build, "cpu");
});

test("sherpa's pronunciation data is found only where it really is", () => {
  const root = path.join(DIR, "espeak");
  install(root);
  assert.match(espeakData({ root }), /espeak-ng-data$/);
  assert.equal(espeakData({ root: path.join(DIR, "nothing") }), null);
});

test("whisper.cpp is started with the settings that matched faster-whisper", () => {
  const args = whisperArgs({ model: "M", vad: "V" }, { port: 4748, threads: 8 });
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(value("-m"), "M");
  assert.equal(value("--host"), "127.0.0.1", "never listening beyond this PC");
  assert.equal(value("--port"), "4748");
  assert.equal(value("-l"), "en");
  assert.ok(args.includes("--vad"));
  assert.equal(value("-vm"), "V");
  // faster-whisper's own VAD defaults. whisper.cpp's 30 ms padding clipped words.
  assert.equal(value("-vp"), "400");
  assert.equal(value("-vsd"), "2000");
  assert.equal(value("-vspd"), "0");
});

test("the voice gets ONNX Runtime's own default: physical cores, capped at 16", () => {
  assert.equal(voiceThreads(32), 16);
  assert.equal(voiceThreads(64), 16);
  assert.equal(voiceThreads(8), 4);
  assert.equal(voiceThreads(1), 1);
  assert.equal(voiceThreads(2), 1);
});

// ---------------------------------------------------------------------------
// Converting a Piper voice for sherpa-onnx
// ---------------------------------------------------------------------------

const VOICE_JSON = {
  audio: { sample_rate: 22050 },
  espeak: { voice: "en-us" },
  language: { name_english: "English" },
  num_speakers: 1,
  inference: { noise_scale: 0.667, length_scale: 1, noise_w: 0.8 },
  phoneme_id_map: { _: [0], "^": [1], $: [2], " ": [3], a: [14] },
};

/** Read ModelProto field-14 entries back out of appended bytes. */
function readMetadata(bytes) {
  const out = [];
  let i = 0;
  const varint = () => {
    let v = 0, s = 0, b;
    do { b = bytes[i++]; v |= (b & 0x7f) << s; s += 7; } while (b & 0x80);
    return v;
  };
  while (i < bytes.length) {
    const key = varint();
    assert.equal(key, (14 << 3) | 2, "metadata_props, length-delimited");
    const end = varint() + i;
    const entry = {};
    while (i < end) {
      const k = varint() >> 3;
      const len = varint();
      entry[k === 1 ? "key" : "value"] = Buffer.from(bytes.subarray(i, i + len)).toString();
      i += len;
    }
    out.push([entry.key, entry.value]);
  }
  return out;
}

test("the metadata sherpa-onnx reads comes from the voice's own json", () => {
  assert.deepEqual(sherpaMetadata(VOICE_JSON), [
    ["model_type", "vits"],
    ["comment", "piper"],
    ["language", "English"],
    ["voice", "en-us"],
    ["has_espeak", "1"],
    ["n_speakers", "1"],
    ["sample_rate", "22050"],
  ]);
});

test("it is encoded as protobuf metadata_props that read back exactly", () => {
  const pairs = sherpaMetadata(VOICE_JSON);
  const bytes = metadataBytes(pairs);
  assert.deepEqual(readMetadata(bytes), pairs);
  // en_US-ryan-high's real metadata is these seven pairs in 131 bytes — the
  // size sherpa's own copy of that voice grew by, checked byte for byte.
  assert.equal(bytes.length, 131);
});

test("tokens.txt lists every phoneme with its id", () => {
  assert.equal(tokensText(VOICE_JSON), "_ 0\n^ 1\n$ 2\n  3\na 14\n");
});

test("the converted voice is the original plus metadata, beside it rather than over it", () => {
  const voices = path.join(DIR, "voices");
  fs.mkdirSync(voices, { recursive: true });
  const onnx = path.join(voices, "en_US-test-medium.onnx");
  const original = Buffer.from("ONNX-MODEL-BYTES");
  fs.writeFileSync(onnx, original);
  fs.writeFileSync(`${onnx}.json`, JSON.stringify(VOICE_JSON));
  const cache = path.join(DIR, "cache");

  const v = sherpaVoice(onnx, cache);
  const made = fs.readFileSync(v.model);
  assert.ok(made.subarray(0, original.length).equals(original));
  assert.deepEqual(readMetadata(made.subarray(original.length)), sherpaMetadata(VOICE_JSON));
  assert.ok(fs.readFileSync(onnx).equals(original), "the original is untouched");
  assert.equal(v.sampleRate, 22050);
  assert.equal(v.noiseScaleW, 0.8);

  // Reused while the original is unchanged; remade when it changes.
  const stamp = fs.statSync(v.model).mtimeMs;
  sherpaVoice(onnx, cache);
  assert.equal(fs.statSync(v.model).mtimeMs, stamp);
  fs.writeFileSync(onnx, Buffer.from("A-LONGER-NEW-MODEL"));
  const again = sherpaVoice(onnx, cache);
  assert.ok(fs.readFileSync(again.model).subarray(0, 18).equals(Buffer.from("A-LONGER-NEW-MODEL")));
});

// ---------------------------------------------------------------------------
// Loudness
// ---------------------------------------------------------------------------

test("sherpa's voice is peak-normalised like the Python Piper's, so it is not quieter", () => {
  const quiet = Float32Array.from({ length: 1000 }, (_, i) => 0.3 * Math.sin(i / 10));
  const wav = toWav(quiet, 22050);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(24), 22050);
  let peak = 0;
  for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
  assert.ok(peak >= 32700, `peak ${peak}`);
  // Near-silence is not blown up into noise: the gain is capped at 100x.
  const hiss = toWav(Float32Array.from({ length: 100 }, () => 0.0001), 22050);
  let loudest = 0;
  for (let i = 44; i < hiss.length; i += 2) loudest = Math.max(loudest, Math.abs(hiss.readInt16LE(i)));
  assert.ok(loudest < 400, `hiss became ${loudest}`);
});
