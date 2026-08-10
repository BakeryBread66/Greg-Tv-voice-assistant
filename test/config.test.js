// Loading config.json — the one path every new user walks down.
//
// A fresh clone has no config.json, and for six sessions server.js read it with
// a bare JSON.parse: the first thing anybody cloning this repo saw was an ENOENT
// stack trace. That is the failure this file guards, along with the one that
// would be worse — a torn or hand-edited config being silently replaced by the
// defaults, which loses every setting somebody had chosen.
//
// Nothing here touches your files. `file` and `example` both point at a scratch
// directory, which is the reason this function is in lib/config.js at all rather
// than inline in server.js: importing server.js to test it would run its
// top-level code and start a second Greg, sidecars and all.

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig, firstRunNotice, ConfigError, CONFIG_FILE, CONFIG_EXAMPLE } from "../lib/config.js";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "greg-config-test-"));
const FILE = path.join(DIR, "config.json");
const EXAMPLE = path.join(DIR, "config.example.json");

const EXAMPLE_TEXT = JSON.stringify({ name: "Greg", port: 4747, wakeWords: ["hey greg"] }, null, 2);

// Collected instead of printed, so the assertions can be about what the console
// was told rather than about whether it looked right in the scroll-back.
let said;
const log = (msg) => said.push({ level: "log", msg });
const warn = (msg) => said.push({ level: "warn", msg });
const load = (opts = {}) => loadConfig({ file: FILE, example: EXAMPLE, log, warn, ...opts });

beforeEach(() => {
  said = [];
  fs.rmSync(FILE, { force: true });
  fs.writeFileSync(EXAMPLE, EXAMPLE_TEXT, "utf8");
});

after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test("an existing config is read, and the example is left out of it", () => {
  fs.writeFileSync(FILE, JSON.stringify({ name: "Not Greg", port: 5000 }), "utf8");

  const config = load();

  assert.equal(config.name, "Not Greg");
  assert.equal(config.port, 5000);
  // No first-run noise on an ordinary start.
  assert.deepEqual(said, []);
});

test("a missing config is CREATED from the example, not just fallen back to", () => {
  const config = load();

  assert.equal(config.name, "Greg");
  assert.equal(fs.existsSync(FILE), true, "config.json should exist after a first run");
  assert.equal(fs.readFileSync(FILE, "utf8"), EXAMPLE_TEXT);

  // Creating a file in somebody's checkout without saying so is the kind of
  // silent side effect this project spends its time removing.
  assert.equal(said.length, 1);
  assert.equal(said[0].level, "log");
  assert.match(said[0].msg, /First run/);
  assert.match(said[0].msg, /config\.json/);
});

test("the created config is the one read on the NEXT start", () => {
  load();
  said = [];

  // Somebody edits it, as the first-run message tells them to.
  const written = JSON.parse(fs.readFileSync(FILE, "utf8"));
  written.location = { city: "Reykjavik" };
  fs.writeFileSync(FILE, JSON.stringify(written), "utf8");

  const config = load();
  assert.equal(config.location.city, "Reykjavik");
  assert.deepEqual(said, [], "a second start is not a first run");
});

test("a config that will not parse is refused, and is NOT overwritten", () => {
  // What a process killed mid-write leaves behind.
  const torn = '{ "name": "Greg", "port": 47';
  fs.writeFileSync(FILE, torn, "utf8");

  assert.throws(() => load(), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /not valid JSON/);
    // The message has to say the file was kept, or the obvious next move is to
    // delete it — which is the loss this branch exists to prevent.
    assert.match(err.message, /NOT been overwritten/);
    return true;
  });

  assert.equal(fs.readFileSync(FILE, "utf8"), torn, "the torn file must survive untouched");
});

test("no config and no example says so, rather than throwing ENOENT at the user", () => {
  fs.rmSync(EXAMPLE, { force: true });

  assert.throws(() => load(), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /config\.example\.json/);
    return true;
  });
});

test("an unwritable checkout still starts, and says settings will not stick", () => {
  // The write fails; the read of the example succeeded. Greg has to run.
  const config = loadConfig({
    file: path.join(DIR, "no-such-directory", "config.json"),
    example: EXAMPLE,
    log,
    warn,
  });

  assert.equal(config.name, "Greg", "he runs from the example in memory");
  assert.equal(said.length, 1);
  assert.equal(said[0].level, "warn");
  assert.match(said[0].msg, /will not survive a restart/);
});

test("the shipped example is valid JSON and names the shipped defaults", () => {
  // The file a fresh clone is about to be handed. If this is malformed, every
  // first run in the world fails at exactly the moment nobody has a config to
  // fall back to.
  const shipped = JSON.parse(fs.readFileSync(CONFIG_EXAMPLE, "utf8"));

  assert.equal(shipped.name, "Greg");
  assert.equal(typeof shipped.port, "number");
  assert.ok(Array.isArray(shipped.wakeWords) && shipped.wakeWords.length > 0,
    "zero wake words leaves no way to reach him but typing");
  // Personal data must not ship. The example's location is what a stranger gets.
  assert.equal(shipped.location.latitude, null);
  assert.equal(shipped.location.longitude, null);
  assert.equal(shipped.location.city, "");
});

test("config.json is not what the tests just wrote", () => {
  // Cheap guard against the mistake this project has made twice: a test that
  // does real work, against the user's real files.
  assert.notEqual(CONFIG_FILE, FILE);
  assert.notEqual(CONFIG_EXAMPLE, EXAMPLE);
});

// ---------------------------------------------------------------------------
// Warning about a long, silent first start
//
// The first run downloads speech models and prints nothing until each one
// finishes, so the console sits there looking hung. Reported twice by the same
// person: once as "it didn't work", then as "it did work, it just took a
// while". Both times the fault was that nothing said the wait was expected.
// ---------------------------------------------------------------------------

const withVoice = { localVoice: { enabled: true, voice: "en_US-ryan-high" }, speech: { mode: "auto" } };

test("it warns when the voice model is not on disk yet", () => {
  const notice = firstRunNotice(withVoice, { exists: () => false, wasCreated: false });
  assert.match(notice, /en_US-ryan-high/);
  assert.match(notice, /60-140 MB/);
  // The reassurance is the point: an idle-looking window is what gets reported.
  assert.match(notice, /looks idle/);
});

test("it says NOTHING once the model is already there", () => {
  // Printing this every start would train people to ignore it, which is worse
  // than never having said it - the same argument the alert watcher makes for
  // interrupting on 44 warnings out of 189.
  assert.equal(firstRunNotice(withVoice, { exists: () => true, wasCreated: false }), null);
});

test("a genuinely fresh install also warns about speech recognition", () => {
  const notice = firstRunNotice(withVoice, { exists: () => false, wasCreated: true });
  assert.match(notice, /speech recognition model/);
});

test("nothing is promised for parts that are switched off", () => {
  // Claiming a download that will never happen is the boot screen's "all
  // processing local" defect in a new place.
  const off = { localVoice: { enabled: false, voice: "en_US-ryan-high" }, speech: { mode: "off" } };
  assert.equal(firstRunNotice(off, { exists: () => false, wasCreated: true }), null);
});

test("a config with nothing in it does not throw", () => {
  assert.doesNotThrow(() => firstRunNotice({}, { exists: () => false, wasCreated: false }));
  assert.doesNotThrow(() => firstRunNotice(null, { exists: () => false, wasCreated: true }));
});
