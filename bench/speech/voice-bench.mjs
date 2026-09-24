// Voice benchmark: the same 24 sentences through one engine, timed, then heard
// back by one fixed judge — the Python Whisper on the GPU — to score how
// clearly each came out. Every engine is judged by the same ears.
//
//   node voice-bench.mjs greg                          Greg's own lib/tts-piper.js (sherpa-onnx when installed)
//   node voice-bench.mjs python http://127.0.0.1:4761  piper_server.py, started by hand on that port
//
// The judge must be running first:
//   set GREG_WHISPER_PORT=4758 && py -3 whisper_server.py
//
// Piper voices sample a little noise on purpose, so the judged score moves by a
// point or so between runs of the SAME engine. Compare averages of several runs.
import fs from "node:fs";
import path from "node:path";

import { SENTENCES } from "./sentences.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const [kind = "greg", where, label = kind] = process.argv.slice(2);
const JUDGE = process.env.JUDGE ?? "http://127.0.0.1:4758";

let speak;
if (kind === "python") {
  speak = async (text) => {
    const res = await fetch(`${where}/speak`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    return Buffer.from(await res.arrayBuffer());
  };
} else {
  const voice = await import(new URL("../../lib/tts-piper.js", import.meta.url));
  const ok = await voice.initPiper({ localVoice: { voice: "en_US-ryan-high", port: 4769 } });
  if (!ok) throw new Error(`Greg's voice didn't start: ${JSON.stringify(voice.piperStatus())}`);
  console.error(`engine: ${voice.piperStatus().engine}`);
  speak = voice.speakLocally;
}

const judge = async (wav) =>
  (await (await fetch(`${JUDGE}/transcribe`, { method: "POST", body: wav, headers: { "Content-Type": "application/octet-stream" } })).json()).text ?? "";
const words = (t) => String(t).toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const seconds = (wav) => (wav.length - (wav.indexOf("data") + 8)) / (wav.readUInt32LE(24) * 2);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) * p)]; };

for (const s of SENTENCES.slice(0, 2)) await speak(s); // warm-up, uncounted

const rows = [];
fs.mkdirSync(path.join(HERE, `voice-${label}`), { recursive: true });
for (const [i, text] of SENTENCES.entries()) {
  const t0 = performance.now();
  const wav = await speak(text);
  const ms = performance.now() - t0;
  fs.writeFileSync(path.join(HERE, `voice-${label}`, `${String(i).padStart(2, "0")}.wav`), wav);
  const heard = await judge(wav);
  rows.push({ text, ms, seconds: seconds(wav), heard, errors: distance(words(text), words(heard)), words: words(text).length });
}
console.log(JSON.stringify({
  engine: label,
  msP50: Math.round(pct(rows.map((r) => r.ms), 0.5)),
  msP90: Math.round(pct(rows.map((r) => r.ms), 0.9)),
  realtime: +(rows.reduce((n, r) => n + r.seconds, 0) / (rows.reduce((n, r) => n + r.ms, 0) / 1000)).toFixed(1),
  judgedWer: +((100 * rows.reduce((n, r) => n + r.errors, 0)) / rows.reduce((n, r) => n + r.words, 0)).toFixed(2),
}));
process.exit(0);
