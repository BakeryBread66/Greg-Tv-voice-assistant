// The handshake between clone_server.py and lib/tts-clone.js.
//
// The sidecar announces itself on one line of stdout and Node matches it with a
// regex. Nothing else connects the two, they are written in different languages,
// and neither imports the other — so a field renamed on one side is invisible on
// the other until somebody runs it.
//
// The cost of that drift is badly out of proportion to the mistake. A READY line
// Node cannot match is not an error: initClone simply never resolves, waits out
// its five-minute timer and reports "the cloned voice took too long to start" —
// which names neither the field nor the file, and reads like a slow machine. The
// clone then silently falls through to Piper, which is the failure this project
// cares most about, because Greg still talks and nothing looks wrong.
//
// So this reads both files as text and checks they still agree. It cannot start
// a sidecar: that is 2.8 GB of somebody's graphics card and forty seconds, and
// this suite has twice been wrecked by a test that did real work.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PYTHON = fs.readFileSync(path.join(ROOT, "clone_server.py"), "utf8");
const NODE = fs.readFileSync(path.join(ROOT, "lib", "tts-clone.js"), "utf8");

/** The regex Node actually matches READY with, lifted from the source. */
function readyPattern() {
  const found = /\/(READY [^/]+)\/\.exec/.exec(NODE);
  assert.ok(found, "lib/tts-clone.js no longer matches a READY line with a regex literal");
  return new RegExp(found[1]);
}

/**
 * The line clone_server.py prints, rebuilt from its own source.
 *
 * The print is an f-string split over two lines, so the fields are read as
 * `name={PLACEHOLDER}` pairs in order rather than by parsing Python. Sample
 * values are per-field because the regex is not uniform — `rate` is matched as
 * digits, and filling it with a word would fail for the wrong reason.
 */
function readyLine() {
  // Anchored on READY itself. Matching the first `print(` in the file finds the
  // missing-reference ERROR line instead, which has no fields and fails here
  // rather than where the mistake is.
  const block = /f"READY[\s\S]{0,400}?flush=True/.exec(PYTHON);
  assert.ok(block, "clone_server.py no longer prints READY as an f-string");

  const samples = { reference: "greg-reference", rate: "24000", precision: "fp16", port: "4750" };
  const fields = [...block[0].matchAll(/(\w+)=\{[^}]+\}/g)].map(([, name]) => name);
  assert.ok(fields.length, "no fields found in the READY line");

  return "READY " + fields.map((name) => `${name}=${samples[name] ?? "sample"}`).join(" ");
}

test("Node's regex matches the READY line the sidecar actually prints", () => {
  const line = readyLine();
  const match = readyPattern().exec(line);
  assert.ok(match, `lib/tts-clone.js cannot match: ${line}`);
});

test("the READY line carries precision, which the speech cache keys on", () => {
  // fp16 and fp32 are the same voice and not the same audio, so a clip cached
  // under one must miss under the other. The sidecar resolves "auto" — Node
  // cannot know which it got without being told.
  assert.match(readyLine(), /precision=/);
  assert.match(readyPattern().source, /precision=/);
  assert.match(
    fs.readFileSync(path.join(ROOT, "lib", "tts.js"), "utf8"),
    /clone:.*\$\{clone\.precision\}/,
    "the clone's cache key no longer includes precision",
  );
});

test("only the t3 backbone is cast to half", () => {
  // Casting s3gen too saves another ~400 MiB and was rejected by ear: 1.6 dB
  // louder, and "rushed and barely coherent". Every metric measured passed it,
  // so nothing here can catch a regression except the absence of the cast.
  //
  // Both patterns match CODE and not prose. The first version of this test
  // looked for the bare word "autocast" and duly failed on the comment above
  // the cast explaining why autocast was rejected — a guard that reads the
  // reasoning as a violation of itself.
  assert.doesNotMatch(
    PYTHON,
    /^\s*MODEL\.s3gen\s*=\s*MODEL\.s3gen\.half\(\)/m,
    "s3gen must stay in fp32 — see CLAUDE.md, this was rejected by listening",
  );
  assert.doesNotMatch(
    PYTHON,
    /^\s*with torch\.autocast/m,
    "autocast over generate() is the rejected variant — see CLAUDE.md",
  );
  assert.match(PYTHON, /^\s*MODEL\.t3\s*=\s*MODEL\.t3\.half\(\)/m);
});

test("the reference is prepared once, not per sentence", () => {
  // generate() rebuilds the conditionals from the clip when handed
  // audio_prompt_path — in fp32, which undoes the cast on the first reply.
  assert.doesNotMatch(
    PYTHON,
    /generate\([^)]*audio_prompt_path/s,
    "passing audio_prompt_path per call rebuilds the conditionals in fp32",
  );
  assert.match(PYTHON, /prepare_conditionals\(/);
});
