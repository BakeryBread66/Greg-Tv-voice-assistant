// What is playing on this machine, according to Windows rather than Spotify.
//
// `whats_playing` in lib/spotify.js needs the Web API and a live token, which
// covers exactly one app and stops working the moment the refresh token dies.
// Windows keeps its own record for every app that registers transport controls —
// Spotify, a YouTube tab, VLC, a game — and hands over the album art with it.
// media-session.ps1 reads that; this owns the process.
//
// Started on demand and stopped when nobody is asking, like lib/cursor.js: it is
// a polling loop, and Greg is meant to sit quietly for hours at a time.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, "media-session.ps1");

// How long the watcher keeps running after the last request. Longer than the
// cursor's, because the now-playing channel polls slowly and a track can run for
// minutes without anyone asking anything.
const IDLE_MS = 60000;

let child = null;
let latest = null;
let art = null;          // Buffer of the current track's artwork, or null
let artVersion = 0;      // bumped whenever `art` changes, so the browser can cache
let idleTimer = null;
let unavailable = null;
let waiters = [];

function settle() {
  const pending = waiters;
  waiters = [];
  for (const resolve of pending) resolve(latest);
}

function stop() {
  if (child) {
    child.kill();
    child = null;
  }
  clearTimeout(idleTimer);
  idleTimer = null;
  latest = null;
  art = null;
  // Deliberately NOT resetting artVersion: a browser holding version 3 must not
  // be handed a different picture under the same number after a restart.
  settle();
}

function handleLine(line) {
  let data;
  try {
    data = JSON.parse(line);
  } catch {
    return;
  }

  // Art arrives only when the track changes, so an absent field means "keep what
  // you have" while an empty string means "this track genuinely has none".
  if (typeof data.art === "string") {
    art = data.art ? Buffer.from(data.art, "base64") : null;
    artVersion++;
  }
  delete data.art;

  latest = { ...data, artVersion, source: friendlyApp(data.app) };
  settle();
}

function start() {
  if (child || unavailable) return;

  try {
    child = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
  } catch (err) {
    unavailable = err.message;
    settle();
    return;
  }

  // A line carrying album art is around 260 KB, so this genuinely has to buffer
  // across chunks rather than assuming one chunk is one line.
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line) handleLine(line);
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (!text) return;
    // The script says so itself when the art path is missing. That is a
    // degradation, not a failure, and worth exactly one line in the console.
    console.warn(`[nowplaying] ${text.slice(0, 200)}`);
  });

  child.on("error", (err) => {
    unavailable = err.code === "ENOENT" ? "PowerShell not found" : err.message;
    child = null;
    settle();
  });

  child.on("exit", () => {
    child = null;
  });
}

/** Turn an Application User Model ID into something worth saying out loud. */
function friendlyApp(appId) {
  const id = String(appId ?? "");
  if (!id) return "";
  if (/spotify/i.test(id)) return "Spotify";
  if (/chrome/i.test(id)) return "Chrome";
  if (/msedge/i.test(id)) return "Edge";
  if (/firefox/i.test(id) || id === "308046B0AF4A39CB") return "Firefox";
  if (/vlc/i.test(id)) return "VLC";
  if (/foobar/i.test(id)) return "foobar2000";
  if (/itunes|apple/i.test(id)) return "Apple Music";
  if (/zune|groove|media\.?player/i.test(id)) return "Windows Media Player";
  // A packaged app's id is "Publisher.Name_hash!App" — the middle is the only
  // legible part, and a bare hash read aloud would be unbearable.
  const packaged = /^[^.]+\.([^_]+)_/.exec(id);
  if (packaged) return packaged[1];
  return id.replace(/\.exe$/i, "");
}

/**
 * The current reading, starting the watcher if it isn't running.
 *
 * Asking is what keeps it alive. `waitMs` is for callers that need an answer now
 * rather than eventually — a voice question can't be told "ask again in three
 * seconds" while PowerShell starts up.
 */
export async function getNowPlaying({ waitMs = 0 } = {}) {
  if (unavailable) return { playing: false, error: unavailable };

  start();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(stop, IDLE_MS);

  if (latest || !waitMs) return latest ?? { playing: false, pending: true };

  // First reading after a cold start: PowerShell takes ~300 ms and the art
  // helper compiles once on top of that.
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== onReading);
      resolve(latest ?? { playing: false, pending: true });
    }, waitMs);

    const onReading = (reading) => {
      clearTimeout(timer);
      resolve(reading ?? { playing: false, pending: true });
    };
    waiters.push(onReading);
  });
}

/** The current track's artwork, as a PNG buffer, or null. */
export function getArt() {
  return art ? { image: art, version: artVersion } : null;
}

/** A sentence Greg can say. Kept here so the tool and the face agree. */
export function describeNowPlaying(reading) {
  if (!reading || !reading.playing) return "Nothing is playing.";

  const { title, artist, album, source, status, kind } = reading;
  const what = [title, artist && `by ${artist}`].filter(Boolean).join(" ");
  if (!what) return `Something is playing${source ? ` in ${source}` : ""}, but it has no title attached.`;

  const lead = status === "Paused" ? "Paused" : "Playing";
  const on = source ? ` on ${source}` : "";
  // A podcast episode carries the show in `artist` and has no album, so naming
  // an album here would be inventing one.
  const record = kind === "Music" && album && album !== title ? `, from ${album}` : "";
  return `${lead}: ${what}${record}${on}.`;
}

export function stopNowPlaying() {
  stop();
}
