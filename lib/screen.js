// Greg's eyes.
//
// Grabs a screenshot through a small PowerShell script and hands it back as
// base64 PNG. Windows can already do this with no dependencies, so nothing is
// installed for it.
//
// The image goes to the local model and nowhere else. That's the same rule the
// microphone follows, and it's the only reason letting an assistant look at your
// screen is a reasonable thing to do at all.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, "capture-screen.ps1");

/**
 * Take one screenshot and hand it back as base64, leaving nothing behind.
 * This is the path screen vision uses.
 * @returns {Promise<{ base64: string, size: string, bytes: number }>}
 */
export async function captureScreen({ maxWidth = 1280, display = "primary" } = {}) {
  const file = path.join(os.tmpdir(), `greg-screen-${process.pid}-${Date.now()}.png`);
  try {
    const { size, bounds } = await shoot(file, maxWidth, display);
    const png = fs.readFileSync(file);
    return { base64: png.toString("base64"), size, bounds, bytes: png.length };
  } finally {
    // Never leave a picture of someone's screen lying around in temp.
    fs.rm(file, { force: true }, () => {});
  }
}

/**
 * Take one screenshot and keep it.
 *
 * Deliberately separate from the above: this one is full resolution and stays on
 * disk, because it exists for the user rather than for a model. The vision path
 * downscales hard and deletes immediately, which is right for feeding a model
 * and wrong for something you asked to keep.
 *
 * @returns {Promise<{ path: string, file: string, folder: string, size: string, bytes: number }>}
 */
export async function saveScreenshot({ folder = "screenshots", display = "primary", maxWidth = 0 } = {}) {
  const directory = path.isAbsolute(folder) ? folder : path.join(ROOT, folder);
  fs.mkdirSync(directory, { recursive: true });

  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  // Sortable, and no characters Windows objects to.
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    ` ${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const file = `Screenshot ${stamp}.png`;
  const destination = path.join(directory, file);

  const { size } = await shoot(destination, maxWidth, display);
  return { path: destination, file, folder: directory, size, bytes: fs.statSync(destination).size };
}

// ---------------------------------------------------------------------------
// Was Greg himself in shot?
//
// He runs in a browser window, so the page knows exactly where it is —
// screenX/screenY are in the same virtual-desktop coordinates the capture
// reports its bounds in, which is what makes this a fact rather than a guess.
//
// It has to be a fact. Measured on this machine: asked what windows were open,
// the vision model listed four and said "no other applications are visible" —
// Greg was on a different monitor entirely, and "primary" is what gets captured.
// Telling him "look for a retro television, that's you" would have had him
// recognise himself in a screenshot he is not in, which is the fabricated-vision
// failure the startup swatch test exists to prevent, arriving by the back door.
// ---------------------------------------------------------------------------

let windowRect = null;

/** The browser reporting where its own window is. */
export function setWindowRect(rect) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const x = num(rect?.x);
  const y = num(rect?.y);
  const w = num(rect?.w);
  const h = num(rect?.h);
  if (x === null || y === null || !w || !h) return false;
  windowRect = { x, y, w, h, hidden: Boolean(rect.hidden), at: Date.now() };
  return true;
}

export function getWindowRect() {
  return windowRect;
}

/**
 * Was the window inside the captured region?
 *
 * Pure, and takes both rectangles rather than reading module state, so every
 * case below can be proven without a screen. Returns `known: false` when there
 * is nothing to go on — which is a different answer from "no", and the tool
 * wording keeps them apart.
 */
export function selfInShot(win, bounds) {
  if (!win || !bounds) return { known: false, onScreen: false, why: "no window position has been reported" };

  // Windows parks minimised windows at -32000. The page also reports its own
  // visibility, because a window can be open, positioned, and behind another.
  if (win.hidden || win.x < -30000 || win.y < -30000) {
    return { known: true, onScreen: false, why: "minimised or hidden" };
  }

  const overlaps =
    win.x < bounds.x + bounds.w && win.x + win.w > bounds.x &&
    win.y < bounds.y + bounds.h && win.y + win.h > bounds.y;

  if (!overlaps) return { known: true, onScreen: false, why: "on a different monitor" };

  // Where in the picture, in the words someone would actually use.
  const centre = win.x + win.w / 2 - bounds.x;
  const third = bounds.w / 3;
  const where = centre < third ? "on the left" : centre > third * 2 ? "on the right" : "in the middle";
  return { known: true, onScreen: true, where };
}

/** Run the capture script, writing a PNG to `file`. */
function shoot(file, maxWidth, display) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(
        "powershell",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-Out", file, "-MaxWidth", String(maxWidth), "-Display", display],
        { windowsHide: true }
      );
    } catch (err) {
      return reject(new Error(`couldn't start the screen capture: ${err.message}`));
    }

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("screen capture timed out"));
    }, 20000);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(err.code === "ENOENT" ? "PowerShell not found" : err.message));
    });

    child.on("exit", (code) => {
      clearTimeout(timer);

      if (code !== 0) {
        return reject(new Error(stderr.trim().split("\n").pop()?.slice(0, 200) || `screen capture failed (${code})`));
      }
      if (!fs.existsSync(file)) {
        return reject(new Error("the screenshot wasn't written"));
      }

      // Two lines now: the image size, then the region it came from. Parsed
      // defensively — an older script, or a machine where the bounds line goes
      // missing, must still capture rather than fail.
      const lines = stdout.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const size = lines.find((l) => /^\d+x\d+$/.test(l)) ?? "unknown";
      const raw = lines.find((l) => l.startsWith("bounds="))?.slice(7).split(",").map(Number);
      const bounds = raw?.length === 4 && raw.every(Number.isFinite)
        ? { x: raw[0], y: raw[1], w: raw[2], h: raw[3] }
        : null;

      resolve({ size, bounds });
    });
  });
}
