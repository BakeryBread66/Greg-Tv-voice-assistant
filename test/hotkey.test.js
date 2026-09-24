// The push-to-talk key: its spelling, what may be claimed from Windows, how a
// keydown is read, and what the server stores and reports.
//
// The Windows half — RegisterHotKey in launcher/Greg.cs — cannot run here. It
// was checked on Windows with a harness around the real TalkKey class: parsing,
// claiming, a second claim refused, one synthetic press delivered once.

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normaliseHotkey, hotkeyProblem, hotkeyFromEvent, isHotkey, KEY_NAMES } from "../public/hotkey.js";
import { initSettings, applySettings, settingsState, hotkeyState, setHotkeyStatus } from "../lib/settings.js";

test("combinations come back in one spelling, whatever order or case they were written in", () => {
  assert.equal(normaliseHotkey("Ctrl+Alt+G"), "Ctrl+Alt+G");
  assert.equal(normaliseHotkey("alt + ctrl + g"), "Ctrl+Alt+G");
  assert.equal(normaliseHotkey("CONTROL+ALT+G"), "Ctrl+Alt+G");
  assert.equal(normaliseHotkey("f9"), "F9");
  assert.equal(normaliseHotkey("Shift+Win+pagedown"), "Shift+Win+PageDown");
  assert.equal(normaliseHotkey("meta+space"), "Win+Space");
});

test("a key that would stop you typing it is never claimed", () => {
  // Claimed from Windows, "G" would swallow every G typed in every program.
  for (const text of ["G", "g", "Shift+G", "5", "Space", "Home", "Shift+Space"]) {
    assert.equal(normaliseHotkey(text), "", text);
    assert.ok(hotkeyProblem(text), `${text} should be explained`);
  }
  // Nobody types these into anything.
  for (const text of ["F9", "F24", "Pause", "ScrollLock", "Insert", "Shift+F2"]) {
    assert.equal(normaliseHotkey(text), text, text);
  }
});

test("nonsense is refused, and nothing at all means no key", () => {
  for (const text of ["Ctrl+Alt", "Ctrl+G+H", "F25", "Ctrl+Banana", "++", "Ctrl+"]) {
    assert.equal(normaliseHotkey(text), "", text);
  }
  for (const empty of ["", "   ", null, undefined]) {
    assert.equal(normaliseHotkey(empty), "");
    assert.equal(hotkeyProblem(empty), null, "no key is not a problem");
  }
});

test("every key name the page allows is one Greg.exe can claim", () => {
  // Greg.cs parses letters, digits and F-keys by range and the rest by name. A
  // name added to hotkey.js and not to Greg.cs would be saved, shown as working
  // in the window, and refused by Greg.exe as a key it does not know.
  const source = fs.readFileSync(new URL("../launcher/Greg.cs", import.meta.url), "utf8");
  for (const name of KEY_NAMES) {
    if (/^[A-Z0-9]$/.test(name) || /^F\d+$/.test(name)) continue;
    assert.ok(source.includes(`part == "${name}"`), `launcher/Greg.cs does not parse "${name}"`);
  }
  for (const mod of ["Ctrl", "Alt", "Shift", "Win"]) assert.ok(source.includes(`part == "${mod}"`), mod);
});

const press = (code, mods = {}) => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

test("a keydown is read by the physical key, so Shift and the layout cannot change it", () => {
  assert.equal(hotkeyFromEvent(press("KeyG", { ctrlKey: true, altKey: true })), "Ctrl+Alt+G");
  assert.equal(hotkeyFromEvent(press("Digit5", { ctrlKey: true, shiftKey: true })), "Ctrl+Shift+5");
  assert.equal(hotkeyFromEvent(press("F9")), "F9");
  assert.equal(hotkeyFromEvent(press("Pause")), "Pause");
  // Only a modifier so far: still reaching for the key.
  assert.equal(hotkeyFromEvent(press("ControlLeft", { ctrlKey: true })), "");
  assert.equal(hotkeyFromEvent(press("Numpad5")), "");
  assert.equal(hotkeyFromEvent(null), "");
});

test("only the exact combination is the talk key", () => {
  assert.equal(isHotkey(press("KeyG", { ctrlKey: true, altKey: true }), "Ctrl+Alt+G"), true);
  assert.equal(isHotkey(press("KeyG", { ctrlKey: true }), "Ctrl+Alt+G"), false);
  assert.equal(isHotkey(press("KeyG", { ctrlKey: true, altKey: true, shiftKey: true }), "Ctrl+Alt+G"), false);
  assert.equal(isHotkey(press("F9"), "f9"), true);
  // No key set, or one that could never be claimed: nothing matches.
  assert.equal(isHotkey(press("KeyG"), ""), false);
  assert.equal(isHotkey(press("KeyG"), "G"), false);
});

// ---------------------------------------------------------------------------
// Stored and reported by the server
// ---------------------------------------------------------------------------

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "greg-hotkey-test-"));
let config;

beforeEach(() => {
  config = { name: "Greg", wakeWords: ["hey greg"], location: { auto: false, city: "X", latitude: 1, longitude: 1 } };
  initSettings(config, { file: path.join(DIR, "config.json"), voices: DIR, switcher: async () => ({ switched: false }) });
  setHotkeyStatus({ key: "" });
});

after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test("a good key is saved in its one spelling; a bad one is refused and explained", async () => {
  const good = await applySettings({ pushToTalk: { key: "alt+ctrl+g" } });
  assert.deepEqual(good.problems, []);
  assert.equal(config.pushToTalk.key, "Ctrl+Alt+G");
  assert.equal(hotkeyState().key, "Ctrl+Alt+G");

  const bad = await applySettings({ pushToTalk: { key: "G" } });
  assert.equal(bad.problems.length, 1);
  assert.match(bad.problems[0], /can't be the talk key/);
  assert.equal(config.pushToTalk.key, "Ctrl+Alt+G", "the old key is kept");

  await applySettings({ pushToTalk: { key: "" } });
  assert.equal(settingsState().pushToTalk.key, "");
});

test("what Greg.exe reported is shown only for the key it was about", async () => {
  await applySettings({ pushToTalk: { key: "F9" } });
  assert.equal(settingsState().pushToTalk.global, null, "nothing reported: started some other way");

  setHotkeyStatus({ key: "F9", claimed: true });
  assert.equal(settingsState().pushToTalk.global.claimed, true);

  // A new key: the report about F9 says nothing about it.
  await applySettings({ pushToTalk: { key: "Pause" } });
  assert.equal(settingsState().pushToTalk.global, null);

  setHotkeyStatus({ key: "Pause", claimed: false, problem: "another program is already using Pause." });
  const global = settingsState().pushToTalk.global;
  assert.equal(global.claimed, false);
  assert.match(global.problem, /another program/);
});

test("a report cannot claim success it did not state, or carry an essay", () => {
  const status = setHotkeyStatus({ key: "ctrl+alt+g", claimed: "yes", problem: "x".repeat(5000) });
  assert.equal(status.key, "Ctrl+Alt+G");
  assert.equal(status.claimed, false);
  assert.equal(status.problem.length, 300);
});
