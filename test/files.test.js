// The gates between Greg and the user's disk.
//
// This is the highest-stakes code in the project. Everything else that goes
// wrong here wastes a turn; this reads somebody's files out loud in a room, and
// the input naming the file comes from a language model listening to a
// microphone that mishears words for a living.
//
// So the three gates are tested as gates: a path has to be INSIDE an allowed
// root, NOT on the deny list, and NOT shaped like a secret. Each is checked
// separately, and then together against a real temporary directory — because a
// prefix comparison that looks right and a `realpath` that runs in the wrong
// order are the two ways this fails, and only one of them is visible by reading.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  allowedRoots, insideRoots, isSecret, kindOf, isSpeech, scoreName,
  searchWords, humanSize, resolveReadable, readTextFile, findFiles,
} from "../lib/files.js";

// A little world to search: an allowed root with a document in it, a secret
// beside it, and somewhere off limits next door.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "greg-files-test-"));
const ROOT = path.join(DIR, "Documents");
const OUTSIDE = path.join(DIR, "Private");
// Shares a prefix with the root and is NOT inside it. This is the whole reason
// insideRoots appends a separator before comparing.
const LOOKALIKE = path.join(DIR, "Documents-private");

let config;

before(() => {
  fs.mkdirSync(path.join(ROOT, "notes"), { recursive: true });
  fs.mkdirSync(OUTSIDE, { recursive: true });
  fs.mkdirSync(LOOKALIKE, { recursive: true });

  fs.writeFileSync(path.join(ROOT, "lease agreement.txt"), "No pets are permitted in the property.", "utf8");
  fs.writeFileSync(path.join(ROOT, "notes", "shopping list.md"), "milk\neggs", "utf8");
  fs.writeFileSync(path.join(ROOT, ".env"), "SECRET=hunter2", "utf8");
  fs.writeFileSync(path.join(ROOT, "id_rsa"), "PRIVATE KEY", "utf8");
  fs.writeFileSync(path.join(ROOT, "spotify-tokens.json"), "{}", "utf8");
  fs.writeFileSync(path.join(OUTSIDE, "diary.txt"), "nobody should read this", "utf8");
  fs.writeFileSync(path.join(LOOKALIKE, "taxes.txt"), "nor this", "utf8");

  config = { files: { roots: [ROOT] } };
});

after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test("a root admits what is inside it and nothing that merely looks similar", () => {
  const roots = allowedRoots(config);
  assert.equal(roots.length, 1);

  assert.ok(insideRoots(path.join(ROOT, "lease agreement.txt"), roots));
  assert.ok(insideRoots(path.join(ROOT, "notes", "shopping list.md"), roots), "nested files count");
  assert.ok(insideRoots(ROOT, roots), "the root itself");

  assert.equal(insideRoots(path.join(OUTSIDE, "diary.txt"), roots), false);

  // The separator is what makes this correct rather than nearly correct.
  // "…/Documents-private" starts with "…/Documents" as a plain string, and it
  // is a different folder belonging to somebody who chose that name on purpose.
  assert.equal(insideRoots(path.join(LOOKALIKE, "taxes.txt"), roots), false, "a shared prefix is not containment");

  assert.equal(insideRoots("", roots), false);
  assert.equal(insideRoots(path.join(ROOT, "x.txt"), []), false, "no roots means nothing is readable");
});

test("the shapes a secret takes are refused, and ordinary documents are not", () => {
  for (const secret of [
    "C:\\Users\\me\\Documents\\.env",
    "/home/me/Documents/.env.local",
    "/home/me/Documents/id_rsa",
    "/home/me/Documents/server.pem",
    "/home/me/Documents/my-api_key.txt",
    "/home/me/Documents/passwords.csv",
    "/home/me/Greg/conversations.jsonl",
    "/home/me/Greg/spotify-tokens.json",
    "/home/me/Greg/memory.json",
    `/home/me${path.sep}.ssh${path.sep}known_hosts`,
    `/home/me${path.sep}AppData${path.sep}Roaming${path.sep}thing.txt`,
    `/proj${path.sep}node_modules${path.sep}pkg${path.sep}readme.md`,
  ]) {
    assert.equal(isSecret(secret), true, `${secret} must be refused`);
  }

  // False positives matter too: a deny list that eats ordinary documents makes
  // the whole feature useless, and "useless" is how a safety measure gets
  // switched off.
  for (const fine of [
    "/home/me/Documents/lease agreement.txt",
    "/home/me/Documents/tax return 2025.pdf",
    "/home/me/Documents/notes/shopping list.md",
    "/home/me/Videos/holiday.mp4",
    "/home/me/Documents/Environment Agency letter.txt",
  ]) {
    assert.equal(isSecret(fine), false, `${fine} is an ordinary file`);
  }
});

test("resolving a path runs realpath BEFORE the root check", () => {
  const ok = resolveReadable(path.join(ROOT, "lease agreement.txt"), config);
  assert.equal(ok.error, undefined);
  assert.ok(ok.path.endsWith("lease agreement.txt"));

  // Traversal out of the root. The string starts inside it and the file does
  // not — which is exactly what a symlink or a Windows junction does, and why
  // the resolve has to happen first. Getting that order backwards passes a
  // string comparison and reads somewhere else entirely.
  const escape = resolveReadable(path.join(ROOT, "notes", "..", "..", "Private", "diary.txt"), config);
  assert.match(escape.error, /outside the folders/);
  assert.ok(Array.isArray(escape.allowed), "and it says which folders it can see");

  assert.match(resolveReadable(path.join(OUTSIDE, "diary.txt"), config).error, /outside the folders/);
  assert.match(resolveReadable(path.join(ROOT, ".env"), config).error, /private file/);
  assert.match(resolveReadable(path.join(ROOT, "id_rsa"), config).error, /private file/);
  assert.match(resolveReadable(path.join(ROOT, "nothing here.txt"), config).error, /no file called/);
  assert.match(resolveReadable("", config).error, /no file was named/);
});

test("a junction out of the root is refused as well", { skip: process.platform !== "win32" }, () => {
  const link = path.join(ROOT, "shortcut");
  try {
    fs.symlinkSync(OUTSIDE, link, "junction");
  } catch {
    return; // needs a privilege this machine does not have; the traversal case above still covers the ordering
  }
  const escaped = resolveReadable(path.join(link, "diary.txt"), config);
  assert.match(escaped.error, /outside the folders/, "a junction is not a way around the root");
  fs.rmSync(link, { recursive: true, force: true });
});

test("searching matches every word, and prefers the name it is actually about", () => {
  assert.deepEqual(searchWords("the lease file"), ["lease"], "filler words are dropped");
  assert.deepEqual(searchWords("my tax return 2025"), ["tax", "return", "2025"]);
  assert.deepEqual(searchWords("!!!"), []);

  // AND, not OR. An OR would return most of the disk for anything.
  assert.equal(scoreName("lease agreement.txt", ["lease", "agreement"]) > 0, true);
  assert.equal(scoreName("lease agreement.txt", ["lease", "mortgage"]), 0, "one missing word is no match");

  // Earlier in the name scores higher — that is where people put the subject.
  assert.ok(
    scoreName("lease.txt", ["lease"]) > scoreName("scan of the old lease.txt", ["lease"]),
    "a file named for the thing beats one that mentions it",
  );
});

test("kinds decide whether reading means transcribing", () => {
  assert.equal(kindOf("a.txt"), "text");
  assert.equal(kindOf("a.PY"), "code", "extensions are case-insensitive");
  assert.equal(kindOf("a.mp3"), "audio");
  assert.equal(kindOf("a.mp4"), "video");
  assert.equal(kindOf("a.pdf"), "document");
  assert.equal(kindOf("a.png"), "image");
  assert.equal(kindOf("a.zzz"), "other", "an unknown type is 'other', not 'text' — it must not be opened hopefully");

  assert.equal(isSpeech("interview.m4a"), true);
  assert.equal(isSpeech("interview.mov"), true);
  assert.equal(isSpeech("interview.txt"), false);
});

test("a search finds real files, skips the secrets, and says so when it finds nothing", async () => {
  const found = await findFiles("lease", config);
  assert.equal(found.matches[0].file, "lease agreement.txt");
  assert.equal(found.matches[0].kind, "text");

  const nested = await findFiles("shopping", config);
  assert.equal(nested.matches[0].file, "shopping list.md", "it walks into subfolders");

  // The secrets are in an allowed root and must still never be offered.
  for (const query of ["env", "rsa", "spotify", "tokens"]) {
    const hits = await findFiles(query, config);
    for (const match of hits.matches ?? []) {
      assert.equal(isSecret(match.path), false, `search offered ${match.file}`);
    }
  }

  // A model handed an empty list fills the silence — this project has been
  // caught by that with alerts, with search and with the conversation log.
  const nothing = await findFiles("aardvark", config);
  assert.deepEqual(nothing.matches, []);
  assert.match(nothing.note, /rather than guessing/);

  assert.match((await findFiles("!!!", config)).error, /something to search for/);
});

test("reading a file returns its text, capped, and says when it was cut", async () => {
  const read = await readTextFile(path.join(ROOT, "lease agreement.txt"));
  assert.match(read.text, /No pets/);
  assert.equal(read.truncated, false);
  assert.equal(read.file, "lease agreement.txt", "the bare name, because paths must not be read aloud");
});

test("no roots configured means nothing is readable, and it says why", async () => {
  const empty = { files: { roots: [path.join(DIR, "does-not-exist")] } };
  assert.deepEqual(allowedRoots(empty), [], "a missing folder is dropped rather than throwing");
  const result = await findFiles("anything", empty);
  assert.match(result.error, /no folders I am allowed to look in/);
});

test("sizes are said the way a person would say them", () => {
  assert.equal(humanSize(0), "0 bytes");
  assert.equal(humanSize(900), "900 bytes");
  assert.equal(humanSize(2048), "2 KB");
  assert.equal(humanSize(5 * 1024 * 1024), "5.0 MB");
  assert.equal(humanSize(3 * 1024 * 1024 * 1024), "3.0 GB");
});

test("an empty roots list means nowhere, not everywhere", async () => {
  // The direction of this failure is the whole point. Somebody emptying the
  // list is switching the feature OFF; falling back to the defaults there would
  // hand him the entire Documents folder at the moment they asked for none of
  // it. Absence and emptiness are different facts.
  assert.deepEqual(allowedRoots({ files: { roots: [] } }), [], "empty means nowhere");
  assert.match((await findFiles("anything", { files: { roots: [] } })).error, /no folders I am allowed/);

  // Absence still means the sensible defaults, so a config that says nothing
  // about files behaves the way the README describes.
  assert.ok(Array.isArray(allowedRoots({})), "no files block at all is the default set");
  assert.equal(resolveReadable(path.join(ROOT, "lease agreement.txt"), { files: { roots: [] } }).error !== undefined, true);
});
