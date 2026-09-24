// Setting Greg up: reading the machine, planning the steps, and downloading
// with every byte checked. Against a local HTTP server and a scratch folder —
// no real download, no real Ollama, no real tar.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { parseGpu, whisperBuildFor, eyesFit, planSteps, setupNeeded, download, pullModel, runSetup, survey, unzipCommand, FILES } from "../lib/setup.js";
import { enginePaths, VAD_MODEL } from "../lib/engines.js";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "greg-setup-"));
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// What the fake server serves: path -> body.
const served = new Map();
let server;
let base;
before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/api/pull") {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(JSON.stringify({ status: "pulling manifest" }) + "\n");
      res.write(JSON.stringify({ status: "downloading", total: 100, completed: 40 }) + "\n");
      res.write(JSON.stringify({ status: "downloading", total: 100, completed: 100 }) + "\n");
      return res.end(JSON.stringify({ status: "success" }) + "\n");
    }
    const body = served.get(req.url);
    if (!body) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Length": body.length });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(DIR, { recursive: true, force: true });
});

function serve(name, body) {
  const buf = Buffer.from(body);
  served.set(`/${name}`, buf);
  return { url: `${base}/${name}`, bytes: buf.length, sha256: sha(buf), label: name };
}

// ---------------------------------------------------------------------------

test("the graphics card is read from nvidia-smi, and absent is null", () => {
  assert.deepEqual(parseGpu("NVIDIA GeForce RTX 4090, 24564, 610.88\n"), { name: "NVIDIA GeForce RTX 4090", vramMB: 24564, driver: "610.88" });
  assert.equal(parseGpu(""), null);
  assert.equal(parseGpu(null), null);
  assert.equal(parseGpu("garbage"), null);
});

test("the hearing build follows the card and its driver, and only on Windows", () => {
  assert.equal(whisperBuildFor({ driver: "610.88" }, "win32"), "cuda");
  assert.equal(whisperBuildFor({ driver: "472.12" }, "win32"), "cpu", "a driver too old for CUDA 12");
  assert.equal(whisperBuildFor(null, "win32"), "cpu");
  assert.equal(whisperBuildFor({ driver: "610.88" }, "linux"), null);
});

test("the eyes are offered only where they fit beside the brain", () => {
  assert.equal(eyesFit({ vramMB: 24564 }), true);
  assert.equal(eyesFit({ vramMB: 12288 }), false);
  assert.equal(eyesFit(null), false);
});

const machine = (over = {}) => ({
  platform: "win32",
  gpu: { name: "GPU", vramMB: 24564, driver: "610" },
  whisperBuild: "cuda",
  eyesFit: true,
  ollama: { running: true, installed: true, models: [] },
  brainModel: "gemma4:e4b",
  eyesModel: "qwen2.5vl:7b",
  have: { whisper: null, whisperModel: false, vad: false, espeak: false, voice: "en_US-ryan-high", voiceFiles: false },
  ...over,
});

test("a bare machine needs every step, with the right build and sizes", () => {
  const steps = planSteps(machine());
  assert.deepEqual(steps.map((s) => s.id), ["brain", "whisper", "whisperModel", "vad", "espeak", "voice"]);
  assert.ok(steps.every((s) => !s.done));
  assert.equal(steps.find((s) => s.id === "whisper").file, "whisperCuda");
  assert.equal(steps.find((s) => s.id === "whisper").bytes, FILES.whisperCuda.bytes);
  assert.equal(setupNeeded(machine()), true);
});

test("Ollama is installed first when it's missing; the eyes only when asked", () => {
  const steps = planSteps(machine({ ollama: { running: false, installed: false, models: [] } }), { eyes: true });
  assert.equal(steps[0].id, "ollama");
  assert.ok(steps.some((s) => s.id === "eyes"));
  assert.ok(!planSteps(machine()).some((s) => s.id === "eyes"));
});

test("a machine with everything needs nothing, and says so", () => {
  const full = machine({
    ollama: { running: true, installed: true, models: ["gemma4:e4b"] },
    have: { whisper: "cuda", whisperModel: true, vad: true, espeak: true, voice: "en_US-ryan-high", voiceFiles: true },
  });
  assert.ok(planSteps(full).every((s) => s.done));
  assert.equal(setupNeeded(full), false);
});

test("off Windows, only the brain is Greg's to fetch; the engines are setup-greg.sh's", () => {
  const steps = planSteps(machine({ platform: "linux", whisperBuild: null }));
  assert.ok(!steps.some((s) => ["whisper", "whisperModel", "vad", "espeak"].includes(s.id)));
});

test("zips are opened with Windows' own tar by its full path, never whichever tar PATH finds first", () => {
  // Git's GNU tar came first on the real machine's PATH and cannot read a zip.
  const [cmd, args] = unzipCommand("C:\\d\\w.zip", "C:\\d\\out", { platform: "win32", systemRoot: "C:\\Windows", exists: () => true });
  assert.equal(cmd, path.join("C:\\Windows", "System32", "tar.exe"));
  assert.deepEqual(args, ["-xf", "C:\\d\\w.zip", "-C", "C:\\d\\out"]);
  // No system tar (Windows 10 before 1803): PowerShell's Expand-Archive, quoted.
  const [ps, psArgs] = unzipCommand("C:\\it's\\w.zip", "C:\\out", { platform: "win32", systemRoot: "C:\\Windows", exists: () => false });
  assert.equal(ps, "powershell.exe");
  assert.match(psArgs.at(-1), /Expand-Archive -LiteralPath 'C:\\it''s\\w\.zip' -DestinationPath 'C:\\out' -Force/);
  assert.equal(unzipCommand("a.zip", "out", { platform: "linux" })[0], "tar");
});

test("every pinned download is https, from the projects' own homes, with a SHA-256", () => {
  for (const [name, f] of Object.entries(FILES)) {
    assert.match(f.url, /^https:\/\/(github\.com\/(ggml-org\/whisper\.cpp|k2-fsa\/sherpa-onnx)|huggingface\.co\/(ggerganov|ggml-org|rhasspy))\//, name);
    assert.match(f.sha256, /^[0-9a-f]{64}$/, name);
    assert.ok(f.bytes > 0, name);
  }
});

// ---------------------------------------------------------------------------

test("a download that matches is installed, with progress along the way", async () => {
  const spec = serve("good.bin", "x".repeat(50000));
  const seen = [];
  const dest = path.join(DIR, "a", "good.bin");
  await download(spec, dest, { onProgress: (r, t) => seen.push([r, t]) });
  assert.equal(fs.readFileSync(dest, "utf8").length, 50000);
  assert.ok(seen.length >= 1 && seen.at(-1)[0] === 50000 && seen.at(-1)[1] === 50000);
  assert.ok(!fs.existsSync(`${dest}.part`));
});

test("a download that doesn't match its fingerprint is thrown away, never installed", async () => {
  const spec = { ...serve("tampered.bin", "evil bytes"), sha256: sha(Buffer.from("good bytes")) };
  const dest = path.join(DIR, "b", "tampered.bin");
  await assert.rejects(download(spec, dest), /didn't match/);
  assert.ok(!fs.existsSync(dest));
  assert.ok(!fs.existsSync(`${dest}.part`));
});

test("a download larger than published is stopped, not filled up", async () => {
  const spec = { ...serve("huge.bin", "y".repeat(100000)), bytes: 1000 };
  const dest = path.join(DIR, "c", "huge.bin");
  await assert.rejects(download(spec, dest), /larger than it should be/);
  assert.ok(!fs.existsSync(dest) && !fs.existsSync(`${dest}.part`));
});

test("a missing file is an error, not an empty file", async () => {
  await assert.rejects(download({ url: `${base}/nope`, bytes: 1, sha256: "0".repeat(64) }, path.join(DIR, "d", "x")), /404/);
});

test("Ollama's pull is followed to success, with its progress", async () => {
  const seen = [];
  assert.equal(await pullModel("gemma4:e4b", { ollamaUrl: base, onProgress: (c, t) => seen.push(c / t) }), true);
  assert.deepEqual(seen, [0.4, 1]);
});

// ---------------------------------------------------------------------------

test("a whole run installs everything where Greg looks for it, and a failure costs only its own step", async () => {
  const root = path.join(DIR, "greg");
  fs.mkdirSync(root, { recursive: true });
  const files = {
    whisperCpu: serve("whisper.zip", "ZIP"),
    whisperModel: serve("model.bin", "MODEL"),
    vadModel: serve("vad.bin", "VAD"),
    espeak: { ...serve("espeak.zip", "ESPEAK"), sha256: "0".repeat(64) }, // this one will fail
    voice: serve("voice.onnx", "ONNX"),
    voiceConfig: serve("voice.json", "{}"),
  };
  // tar, stood in for: "unzipping" the whisper zip makes a Release folder with
  // the server, a library, and a demo that must NOT be copied.
  const runner = async (cmd, args) => {
    assert.match(cmd, /tar(\.exe)?$/i);
    const into = args[args.indexOf("-C") + 1];
    fs.mkdirSync(path.join(into, "Release"), { recursive: true });
    for (const f of ["whisper-server.exe", "ggml.dll", "wchess.exe"]) fs.writeFileSync(path.join(into, "Release", f), f);
  };
  const steps = planSteps(machine({ whisperBuild: "cpu", ollama: { running: true, installed: true, models: ["gemma4:e4b"] } }));
  const reports = [];
  const results = await runSetup(steps, { root, files, runner, report: (id, u) => reports.push([id, u.state]) });

  assert.deepEqual(results, { whisper: "done", whisperModel: "done", vad: "done", espeak: "failed", voice: "done" });
  const p = enginePaths(root);
  assert.deepEqual(fs.readdirSync(p.whisperDir).sort(), ["build.json", "ggml.dll", "whisper-server.exe"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.whisperDir, "build.json"))).build, "cpu");
  assert.ok(fs.existsSync(path.join(p.modelsDir, "ggml-base.en.bin")));
  assert.ok(fs.existsSync(path.join(p.modelsDir, VAD_MODEL)));
  assert.ok(fs.existsSync(path.join(root, "voices", "en_US-ryan-high.onnx")));
  assert.ok(!fs.existsSync(path.join(p.engines, ".downloads")), "the staging folder is cleaned up");
  assert.ok(reports.some(([id, s]) => id === "espeak" && s === "failed"));
  assert.ok(!reports.some(([id]) => id === "brain"), "a step already done isn't run");

  // Surveyed afterwards, the installed parts are seen as installed.
  const after = await survey({}, { root, platform: "win32", runner: async () => "GPU, 24564, 610\n", fetchImpl: async () => ({ json: async () => ({ models: [{ name: "gemma4:e4b" }] }) }) });
  assert.equal(after.have.whisper, "cpu");
  assert.equal(after.have.espeak, false);
  assert.equal(after.have.voiceFiles, true);
});
