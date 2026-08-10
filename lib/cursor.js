// Where the mouse is when it isn't in the browser.
//
// Greg's head follows the cursor, but a web page only sees the pointer inside its
// own window — so he froze at whatever angle he held as it crossed the edge.
// cursor-watch.ps1 reads the real desktop position; this owns that process.
//
// Started on demand and stopped when nobody is asking, because it is a spinning
// loop and Greg is meant to sit quietly in the background for hours at a time.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, "cursor-watch.ps1");

// How long the watcher keeps running after the last request for a position.
// Long enough to cover a glance at another window, short enough that walking
// away from the machine doesn't leave a loop spinning all afternoon.
const IDLE_MS = 15000;

let child = null;
let latest = null;
let lastAsked = 0;
let idleTimer = null;
let unavailable = null;

function stop() {
  if (child) {
    child.kill();
    child = null;
  }
  clearTimeout(idleTimer);
  idleTimer = null;
  latest = null;
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
    return;
  }

  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    // Only the newest line matters; anything older is a position already passed.
    for (let i = lines.length - 1; i >= 0; i--) {
      const match = /^(-?\d+),(-?\d+)/.exec(lines[i].trim());
      if (match) {
        latest = { x: Number(match[1]), y: Number(match[2]), at: Date.now() };
        break;
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    if (/Exception|Error|not recognized/i.test(text)) {
      console.warn(`[cursor] ${text.trim().slice(0, 200)}`);
    }
  });

  child.on("error", (err) => {
    unavailable = err.code === "ENOENT" ? "PowerShell not found" : err.message;
    child = null;
  });

  child.on("exit", () => {
    child = null;
  });
}

/**
 * The current desktop cursor position.
 *
 * Asking is what keeps the watcher alive — the face polls this only while its own
 * pointer is outside the window, so an idle Greg spawns nothing at all.
 */
export function getCursor() {
  lastAsked = Date.now();
  if (unavailable) return { error: unavailable };

  start();

  // No guard on the callback. Every request clears this timer, so the only way it
  // fires is that nothing has asked for IDLE_MS — the condition is already proven
  // by the timer having run at all.
  //
  // It originally re-checked `Date.now() - lastAsked >= IDLE_MS`, which fires at
  // exactly the boundary and can evaluate one millisecond short. Nothing
  // rescheduled when it did, so the watcher span forever. Verified: kill() works
  // fine, the guard was the whole bug.
  clearTimeout(idleTimer);
  idleTimer = setTimeout(stop, IDLE_MS);

  // Null on the first request or two while PowerShell loads. The face treats that
  // as "keep holding the last angle", which is exactly the old behaviour, so the
  // fallback is the thing it is replacing.
  return latest ? { x: latest.x, y: latest.y } : { pending: true };
}

export function stopCursorWatch() {
  stop();
}
