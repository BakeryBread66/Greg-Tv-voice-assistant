// Transport controls that always work.
//
// Windows media keys go to whichever application owns playback, so this drives
// Spotify without knowing anything about Spotify — no account, no credentials,
// no network. It's the floor: if the Web API isn't configured, or the token has
// expired, or the internet is out, "pause" still pauses.
//
// What it can't do is start a *particular* song, because a keyboard can't. That
// needs lib/spotify.js.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, "media-key.ps1");

export const KEYS = ["playpause", "next", "previous", "stop", "volumeup", "volumedown", "mute"];

/** Press one media key. Resolves once Windows has been told. */
export function pressMediaKey(key) {
  if (!KEYS.includes(key)) return Promise.reject(new Error(`no such media key: ${key}`));

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(
        "powershell",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-Key", key],
        { windowsHide: true }
      );
    } catch (err) {
      return reject(new Error(`couldn't send the media key: ${err.message}`));
    }

    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("the media key timed out"));
    }, 8000);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(err.code === "ENOENT" ? "PowerShell not found" : err.message));
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim().split("\n").pop()?.slice(0, 160) || `media key failed (${code})`));
      resolve({ pressed: key });
    });
  });
}

/**
 * Nudge the volume by repeated presses.
 *
 * Each press is one Windows volume step, which is 2% — so this is coarse by
 * nature. Spotify's own volume endpoint is exact, and lib/spotify.js prefers it
 * when it's available; this is the version that works without an account.
 */
export async function nudgeVolume(direction, steps = 5) {
  const key = direction === "down" ? "volumedown" : "volumeup";
  for (let i = 0; i < Math.min(Math.max(steps, 1), 25); i++) {
    await pressMediaKey(key);
  }
  return { pressed: key, steps };
}
