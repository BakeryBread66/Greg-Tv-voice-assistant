// Writing one value into .env, for the settings that have to live there.
//
// .env holds secrets — the Claude key, the Spotify client id — and is
// gitignored, which is exactly why a key typed into Settings goes here rather
// than into config.json, a file people paste into bug reports.
//
// Every other line is kept as it was, comments included: this file was written
// by hand before Greg ever wrote to it. The write goes through a temp file and a
// rename, like config.json's, so a crash mid-write cannot leave half a key.
//
// Takes a path, so the tests never touch the real .env.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const ENV_FILE = path.join(ROOT, ".env");

const NAME = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Refused before anything is written. A value with a line break in it would
 * write a SECOND line, and a second line in .env is a second setting nobody
 * typed — "sk-ant-x\nANTHROPIC_BASE_URL=http://elsewhere" would send every
 * conversation somewhere else. Quotes and a leading # would be read back as
 * something other than what was saved.
 */
function problemWith(name, value) {
  if (!NAME.test(String(name))) return `"${name}" is not a name .env can hold.`;
  const text = String(value ?? "");
  if (!text) return "Nothing to save.";
  if (/[\r\n\0]/.test(text)) return "That has a line break in it, so it can't be saved.";
  if (/["'`#\s]/.test(text)) return "That has spaces, quotes or a # in it, so it can't be a key.";
  if (text.length > 400) return "That is far too long to be a key.";
  return null;
}

function linesOf(file) {
  try {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    // A file ending in a newline splits into a last line that is empty; left
    // there, a new value would be added after a blank line it never had.
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines;
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

function write(file, lines) {
  // No trailing empty lines piling up with each save.
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, lines.length ? `${lines.join("\n")}\n` : "", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
}

const isLineFor = (name) => (line) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line);

/** Set NAME=value in the file and in this process. Returns { ok } or { error }. */
export function setEnvValue(name, value, { file = ENV_FILE, env = process.env } = {}) {
  const problem = problemWith(name, value);
  if (problem) return { error: problem };
  try {
    const lines = linesOf(file);
    const matches = isLineFor(name);
    const at = lines.findIndex(matches);
    const line = `${name}=${value}`;
    // The first one is replaced in place, so it stays where the user put it;
    // any later duplicates go, or the file would say two things.
    const kept = lines.filter((l, i) => i === at || !matches(l));
    if (at === -1) kept.push(line);
    else kept[kept.findIndex(matches)] = line;
    write(file, kept);
    env[name] = String(value);
    return { ok: true };
  } catch (err) {
    return { error: `Couldn't save to .env: ${err.message}` };
  }
}

/** Remove NAME from the file and from this process. */
export function removeEnvValue(name, { file = ENV_FILE, env = process.env } = {}) {
  if (!NAME.test(String(name))) return { error: `"${name}" is not a name .env can hold.` };
  try {
    const lines = linesOf(file);
    const kept = lines.filter((line) => !isLineFor(name)(line));
    if (kept.length !== lines.length) write(file, kept);
    delete env[name];
    return { ok: true };
  } catch (err) {
    return { error: `Couldn't change .env: ${err.message}` };
  }
}
