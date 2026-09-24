// Greg-Setup.exe must never carry what Greg keeps about the person using him.
//
// installer/build.ps1 packs Greg's files from git's own list of them, and
// refuses anything installer/never-ship.txt names. installer/Setup.cs leans on
// that: an update and the uninstaller only remove files the payload had, so
// whatever can never be in the payload is safe from both. These tests hold the
// two ends together - the list names everything private, git ignores all of
// it, and git tracks none of it - because the build itself only runs on
// Windows, by hand, and a force-added config.json would otherwise ship.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const NEVER_SHIP = read("installer/never-ship.txt")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

// The same rule as Forbidden in build.ps1: an exact path, or a folder and all in it.
const forbidden = (file) => NEVER_SHIP.find((p) => file === p || (p.endsWith("/") && file.startsWith(p)));

function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}
const inRepo = git(["rev-parse", "--is-inside-work-tree"])?.trim() === "true";

test("never-ship.txt names everything Greg keeps about one person on one machine", () => {
  const private_ = [
    ".env", "spotify-tokens.json", "phones.json",
    "config.json", "conversations.jsonl", "memory.json", "reminders.json", "personality.json", "screenshots/",
    "voices/", "voice-audition/", "engines/", "cache/",
    "CLAUDE.md", "notes/",
  ];
  for (const p of private_) assert.ok(NEVER_SHIP.includes(p), `${p} is missing from installer/never-ship.txt`);
});

test("the rule catches a folder's contents and nothing that only starts the same way", () => {
  assert.equal(forbidden("voices/en_US-ryan-high.onnx"), "voices/");
  assert.equal(forbidden("config.json"), "config.json");
  assert.equal(forbidden("config.example.json"), undefined);
  assert.equal(forbidden("lib/config.json"), undefined, "only paths from Greg's folder are private");
  assert.equal(forbidden("cachet.js"), undefined);
});

test("everything never-ship.txt names is ignored by git", { skip: !inRepo && "not a git checkout" }, () => {
  for (const p of NEVER_SHIP) {
    // --no-index: ask whether .gitignore covers it, whether or not it is tracked.
    assert.notEqual(git(["check-ignore", "--no-index", "-q", p]), null, `${p} is not in .gitignore`);
  }
});

test("git tracks nothing never-ship.txt names, so no build can pack it", { skip: !inRepo && "not a git checkout" }, () => {
  const tracked = git(["ls-files", "-z"]).split("\0").filter(Boolean);
  assert.ok(tracked.length > 100, "git listed Greg's files");
  const leaks = tracked.filter(forbidden);
  assert.deepEqual(leaks, [], `tracked by git, and so packed into Greg-Setup.exe: ${leaks.join(", ")}`);
});

// Windows PowerShell 5.1 reads a .ps1 without a byte order mark as ANSI, and
// Greg.cs is read by tools that guess; see setup-greg.ps1. The installer's
// files are held to it here, where CI will notice.
for (const file of ["installer/Setup.cs", "installer/build.ps1", "installer/check.ps1", "launcher/Greg.cs", "launcher/build.ps1"]) {
  test(`${file} is ASCII only`, () => {
    const bytes = fs.readFileSync(path.join(ROOT, file));
    const at = bytes.findIndex((b) => b > 127);
    assert.equal(at, -1, `non-ASCII byte at offset ${at}`);
  });
}

// Windows' own compiler stops at C# 5, and CI's Linux runners cannot run it -
// so the three things a newer habit reaches for first are caught here instead.
test("Setup.cs and Greg.cs stay inside C# 5", () => {
  for (const file of ["installer/Setup.cs", "launcher/Greg.cs"]) {
    const code = read(file)
      .replace(/\/\/.*$/gm, "") // comments may say anything
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""'); // and so may strings
    assert.doesNotMatch(code, /\$"/, `${file}: string interpolation is C# 6`);
    assert.doesNotMatch(code, /\?\.[A-Za-z_]/, `${file}: ?. is C# 6`);
    assert.doesNotMatch(code, /\bnameof\s*\(/, `${file}: nameof is C# 6`);
  }
});
