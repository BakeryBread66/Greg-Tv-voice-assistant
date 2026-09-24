// Ears benchmark: the same 778 clips through one transcription engine.
//
//   node ears-bench.mjs greg                             Greg's own lib/stt.js (whisper.cpp when installed)
//   node ears-bench.mjs python http://127.0.0.1:4758     whisper_server.py, started by hand on that port
//   node ears-bench.mjs cpp    http://127.0.0.1:4759     a whisper-server started by hand
//
// Make the clips first: py -3 make_corpus.py, powershell -File make_sapi.ps1 for the two Windows
// voices (see README.md), then node add_noise.mjs.
//
// Writes results-<label>.json and prints the summary. Clips are sent one at a
// time, as Greg sends them, after a few warm-up calls so model loading is not
// counted as a slow answer.
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const [kind, base, label = kind] = process.argv.slice(2);
const phrases = JSON.parse(fs.readFileSync(path.join(HERE, "phrases.json"), "utf8"));
const clips = fs.readdirSync(path.join(HERE, "clips")).filter((f) => f.endsWith(".wav")).sort();

let greg = null;
if (kind === "greg") {
  greg = await import(new URL("../../lib/stt.js", import.meta.url));
  if (!(await greg.initStt({ speech: { model: "base.en", port: 4768 } }))) throw new Error(`Greg's ears didn't start: ${JSON.stringify(greg.sttStatus())}`);
  console.error(`engine: ${greg.sttStatus().engine} on ${greg.sttStatus().gpu ?? greg.sttStatus().device}`);
}

async function transcribe(file) {
  const audio = fs.readFileSync(path.join(HERE, "clips", file));
  if (greg) return (await greg.transcribe(audio)).text ?? "";
  if (kind === "python") {
    const res = await fetch(`${base}/transcribe`, { method: "POST", body: audio, headers: { "Content-Type": "application/octet-stream" } });
    return (await res.json()).text ?? "";
  }
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/wav" }), file);
  form.append("response_format", "json");
  form.append("temperature", "0.0");
  const res = await fetch(`${base}/inference`, { method: "POST", body: form });
  const data = await res.json();
  return data.text ?? "";
}

// The same normalisation for both engines: case, punctuation, contractions,
// times and numbers written either way.
const NUMBERS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
function norm(text) {
  return String(text)
    .toLowerCase()
    .replace(/\b([ap])\.?\s?m\.?(?=\s|$|[,.!?])/g, "$1m")
    .replace(/(\d)(am|pm)\b/g, "$1 $2")
    .replace(/(\d):(\d\d)/g, "$1 $2")
    .replace(/[’`]/g, "'")
    .replace(/\bwhat's\b/g, "what is").replace(/\bit's\b/g, "it is").replace(/\bi'm\b/g, "i am")
    .replace(/\bdon't\b/g, "do not").replace(/\bcan't\b/g, "cannot").replace(/\bthat's\b/g, "that is")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/'/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w in NUMBERS ? String(NUMBERS[w]) : w))
    .join(" ");
}
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) * p)]; };

// Warm up on three clips, uncounted.
for (const f of clips.slice(0, 3)) await transcribe(f);

const results = [];
for (const file of clips) {
  const started = performance.now();
  let text = "";
  try {
    text = await transcribe(file);
  } catch (err) {
    text = `!!ERROR ${err.message}`;
  }
  const ms = performance.now() - started;
  const m = /__(\d+)\.wav$/.exec(file);
  const silence = file.startsWith("silence");
  const ref = silence ? "" : phrases[Number(m[1])];
  results.push({ file, ms, text: text.trim(), ref, noisy: file.startsWith("noisy"), silence });
}
fs.writeFileSync(path.join(HERE, `results-${label}.json`), JSON.stringify(results, null, 1));

function summary(rows) {
  let errors = 0, words = 0, exact = 0;
  for (const r of rows) {
    const ref = norm(r.ref).split(" ").filter(Boolean);
    const hyp = norm(r.text).split(" ").filter(Boolean);
    errors += distance(ref, hyp);
    words += ref.length;
    if (ref.join(" ") === hyp.join(" ")) exact++;
  }
  return { n: rows.length, wer: +(100 * errors / words).toFixed(2), exact: +(100 * exact / rows.length).toFixed(1), p50: Math.round(pct(rows.map((r) => r.ms), 0.5)), p90: Math.round(pct(rows.map((r) => r.ms), 0.9)) };
}
const clean = results.filter((r) => !r.noisy && !r.silence);
const noisy = results.filter((r) => r.noisy);
const silent = results.filter((r) => r.silence);
const out = {
  engine: label,
  clean: summary(clean),
  noisy: summary(noisy),
  silenceInvented: silent.filter((r) => norm(r.text)).map((r) => r.text),
  allMs: { p50: Math.round(pct(results.map((r) => r.ms), 0.5)), p90: Math.round(pct(results.map((r) => r.ms), 0.9)), max: Math.round(Math.max(...results.map((r) => r.ms))) },
};
console.log(JSON.stringify(out, null, 1));
greg?.stopStt();
process.exit(0);
