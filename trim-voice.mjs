// Cut a cloning reference out of a longer recording.
//
//   node trim-voice.mjs voices/whatever.wav
//   node trim-voice.mjs input.wav voices/dad.wav --seconds 15
//
// Greg's cloned voice re-reads its whole reference every time it speaks, so an
// untrimmed recording is not merely wasteful — half an hour of 48 kHz stereo is
// about 700 MB once decoded, on top of a 4 GB model, and the process is killed
// before it can say anything. The only clue is `exited (null)`.
//
// This exists because that has now happened to two people with the same file.
// Both had a long recording and no obvious way to get ten seconds out of it
// without installing an audio editor.
//
// It picks the most continuously-voiced stretch rather than the first N seconds,
// because the front of a recording is usually silence, a countdown or a breath —
// and a reference containing silence teaches the model to pause. Same reasoning
// as the note about noise-gated clips in docs/voices.md.

import fs from "node:fs";
import path from "node:path";

import { describeWav, IDEAL_REFERENCE_SECONDS } from "./lib/voices.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const positional = args.filter((a, i) => !a.startsWith("--") && !String(args[i - 1] ?? "").startsWith("--"));

const input = positional[0];
const seconds = Number(flag("seconds", 12));

if (!input) {
  console.log(`
Cut a cloning reference out of a longer recording.

  node trim-voice.mjs <input.wav> [output.wav] [--seconds ${IDEAL_REFERENCE_SECONDS[0]}-${IDEAL_REFERENCE_SECONDS[1]}]

Writes a mono WAV of the most continuously-voiced stretch it can find. With no
output path it writes <input>-trimmed.wav beside the original, and never
overwrites the file you gave it.
`);
  process.exit(1);
}

if (!fs.existsSync(input)) {
  console.error(`No such file: ${input}`);
  process.exit(1);
}
if (!Number.isFinite(seconds) || seconds < 3 || seconds > 60) {
  console.error(`--seconds must be between 3 and 60. Ten is as good as thirty.`);
  process.exit(1);
}

const output =
  positional[1] ??
  path.join(path.dirname(input), `${path.basename(input, path.extname(input))}-trimmed.wav`);

if (path.resolve(output) === path.resolve(input)) {
  console.error("Refusing to overwrite the input. Give a different output path.");
  process.exit(1);
}

const buffer = fs.readFileSync(input);
const wav = describeWav(buffer);
if (!wav) {
  console.error(`${path.basename(input)} is not a PCM WAV. Save it as 16-bit PCM WAV and try again.`);
  process.exit(1);
}
if (wav.bits !== 16) {
  console.error(`${path.basename(input)} is ${wav.bits}-bit. This only handles 16-bit PCM.`);
  process.exit(1);
}

// Find the data chunk again for the offset — describeWav reports the length but
// the caller needs to know where the samples start.
let at = 12;
let dataAt = 0;
let dataBytes = 0;
while (at + 8 <= buffer.length) {
  const id = buffer.toString("ascii", at, at + 4);
  const size = buffer.readUInt32LE(at + 4);
  if (id === "data") {
    dataAt = at + 8;
    dataBytes = Math.min(size, buffer.length - dataAt);
    break;
  }
  at += 8 + size + (size % 2);
}

const { channels, rate } = wav;
const frameBytes = channels * 2;
const frames = Math.floor(dataBytes / frameBytes);
const want = Math.floor(seconds * rate);

if (frames <= want) {
  console.log(`${path.basename(input)} is already ${wav.seconds.toFixed(1)}s — nothing to trim.`);
  process.exit(0);
}

// Score every candidate window by how loud it is and how little of it is
// silence. Silence in a reference is worse than a shorter clip: it teaches the
// model to pause.
const windowFrames = Math.max(1, Math.floor(rate * 0.02)); // 20 ms
const level = [];
for (let f = 0; f + windowFrames <= frames; f += windowFrames) {
  let sum = 0;
  for (let i = 0; i < windowFrames; i++) sum += Math.abs(buffer.readInt16LE(dataAt + (f + i) * frameBytes));
  level.push(sum / windowFrames);
}

const perWindow = Math.ceil(want / windowFrames);
let best = 0;
let bestScore = -Infinity;
for (let i = 0; i + perWindow <= level.length; i++) {
  let sum = 0;
  let quiet = 0;
  for (let j = i; j < i + perWindow; j++) {
    sum += level[j];
    if (level[j] < 200) quiet++;
  }
  const score = sum / perWindow - quiet * 40;
  if (score > bestScore) {
    bestScore = score;
    best = i;
  }
}

const startFrame = best * windowFrames;
const out = Buffer.alloc(want * 2);
for (let i = 0; i < want; i++) {
  const off = dataAt + (startFrame + i) * frameBytes;
  let v = 0;
  for (let c = 0; c < channels; c++) v += buffer.readInt16LE(off + c * 2);
  out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v / channels))), i * 2);
}

const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + out.length, 4);
header.write("WAVE", 8);
header.write("fmt ", 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(rate, 24);
header.writeUInt32LE(rate * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(out.length, 40);

fs.writeFileSync(output, Buffer.concat([header, out]));

const size = fs.statSync(output).size;
console.log(`${path.basename(input)}: ${wav.seconds.toFixed(1)}s, ${channels === 1 ? "mono" : "stereo"}, ${(buffer.length / 1e6).toFixed(1)} MB`);
console.log(`took ${seconds}s from ${(startFrame / rate).toFixed(1)}s in — the most continuously-voiced stretch`);
console.log(`wrote ${output}: mono, ${rate} Hz, ${(size / 1e6).toFixed(2)} MB`);
console.log(`\nPoint clonedVoice.reference at it, or pick it in Settings -> Personality -> Voice.`);
