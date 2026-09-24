// A noisy copy of every clip (a room: steady hum plus random noise, at about
// 12 dB below the speech), and ten clips of the room alone — which Whisper
// should transcribe as nothing. Seeded, so both engines hear identical audio.
import fs from "node:fs";
import path from "node:path";

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "clips");
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;

function read(file) {
  const b = fs.readFileSync(file);
  const dataAt = b.indexOf("data") + 8;
  return new Int16Array(b.buffer.slice(b.byteOffset + dataAt, b.byteOffset + b.length));
}
function write(file, samples) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + samples.length * 2, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36);
  h.writeUInt32LE(samples.length * 2, 40);
  fs.writeFileSync(file, Buffer.concat([h, Buffer.from(samples.buffer)]));
}
function room(n, level) {
  const out = new Float32Array(n);
  let brown = 0;
  for (let i = 0; i < n; i++) {
    brown = 0.98 * brown + 0.02 * rand();
    out[i] = level * (0.6 * rand() + 3 * brown + 0.3 * Math.sin((2 * Math.PI * 60 * i) / 16000));
  }
  return out;
}

const clean = fs.readdirSync(DIR).filter((f) => f.endsWith(".wav") && !f.startsWith("noisy") && !f.startsWith("silence"));
for (const f of clean) {
  const s = read(path.join(DIR, f));
  let power = 0;
  for (const v of s) power += (v / 32768) ** 2;
  const rms = Math.sqrt(power / s.length) || 0.01;
  const noise = room(s.length, rms / 4); // ~12 dB under the speech
  const out = new Int16Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(s[i] + noise[i] * 32768)));
  write(path.join(DIR, `noisy-${f}`), out);
}
for (let i = 0; i < 10; i++) {
  const n = room(16000 * 3, 0.01 + i * 0.004);
  write(path.join(DIR, `silence__${i}.wav`), Int16Array.from(n, (v) => Math.round(v * 32768)));
}
console.log(`${clean.length} noisy copies, 10 room-only clips`);
