// A disk cache for synthesized speech.
//
// Piper answers in milliseconds and never needed one. The cloned voice runs at
// roughly 1.3x realtime — a sentence costs seconds — so anything Greg says twice
// is worth keeping.
//
// Content-addressed: the key is a hash of the text he is about to speak, together
// with the voice that would speak it. That means it needs no list of "known"
// phrases to work; a repeat hits whether it came from the model, a reminder, or
// the globe announcing a country. The pre-warm list below is a head start, not
// the mechanism.
//
// Keyed on the text AFTER speakable() has cleaned it, so "**cold**" and "cold"
// share one entry rather than two.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FILLER_PHRASES } from "./filler.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let dir = path.join(ROOT, "cache", "tts");
let enabled = true;
let maxEntries = 500;
let hits = 0;
let misses = 0;

const EXTENSIONS = { "audio/wav": "wav", "audio/mpeg": "mp3" };
const TYPES = { wav: "audio/wav", mp3: "audio/mpeg" };

export function initCache(config) {
  const settings = config.speechCache ?? {};
  enabled = settings.enabled !== false;
  maxEntries = Number(settings.maxEntries) > 0 ? Number(settings.maxEntries) : 500;
  if (settings.folder) dir = path.resolve(ROOT, settings.folder);

  if (!enabled) return { enabled: false };

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    enabled = false;
    return { enabled: false, reason: err.message };
  }
  return { enabled: true, entries: countEntries(), folder: path.relative(ROOT, dir) };
}

function countEntries() {
  try {
    return fs.readdirSync(dir).filter((f) => /\.(wav|mp3)$/.test(f)).length;
  } catch {
    return 0;
  }
}

/**
 * The cache key.
 *
 * `voiceId` must capture everything that changes how the audio sounds — backend,
 * reference clip, and the dials. Leave a setting out and changing it in
 * config.json would silently keep serving the old voice, which is the kind of
 * bug that wastes an afternoon.
 */
export function cacheKey(voiceId, cleanText) {
  // The separator is a NUL, so no voice id and text can run together into the
  // key of a different pair. Written as the escape rather than the character:
  // a literal NUL byte made git treat this whole file as binary, so every diff
  // of it read "Binary files differ". Same string, so every key is unchanged.
  return crypto.createHash("sha256").update(`${voiceId}\0${cleanText}`).digest("hex").slice(0, 32);
}

export function readCache(key) {
  if (!enabled) return null;
  for (const ext of ["wav", "mp3"]) {
    const file = path.join(dir, `${key}.${ext}`);
    try {
      const audio = fs.readFileSync(file);
      // Bump mtime so pruning treats this as recently used rather than old.
      const now = new Date();
      fs.utimes(file, now, now, () => {});
      hits += 1;
      return { audio, contentType: TYPES[ext] };
    } catch {
      // Try the other extension, then fall through to a miss.
    }
  }
  misses += 1;
  return null;
}

export function writeCache(key, audio, contentType) {
  if (!enabled || !audio?.length) return;
  const ext = EXTENSIONS[contentType];
  if (!ext) return; // Unknown format: better uncached than unplayable.

  try {
    // Write then rename, so a crash mid-write can't leave a truncated WAV that
    // would be served as a cache hit forever after.
    const temp = path.join(dir, `.${key}.${process.pid}.tmp`);
    fs.writeFileSync(temp, audio);
    fs.renameSync(temp, path.join(dir, `${key}.${ext}`));
  } catch {
    // A cache that cannot write is a slow cache, not a broken Greg.
  }
  prune();
}

function prune() {
  try {
    const files = fs.readdirSync(dir).filter((f) => /\.(wav|mp3)$/.test(f));
    if (files.length <= maxEntries) return;
    const byAge = files
      .map((f) => {
        const full = path.join(dir, f);
        try {
          return { full, used: fs.statSync(full).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.used - b.used);
    for (const { full } of byAge.slice(0, files.length - maxEntries)) {
      try {
        fs.unlinkSync(full);
      } catch {
        // Someone else may have removed it; nothing to do.
      }
    }
  } catch {
    // Pruning is housekeeping — never let it break synthesis.
  }
}

/**
 * Phrases worth generating before they are first needed.
 *
 * Be honest about what this buys: Greg's replies come from a language model, so
 * it does not repeat itself word for word as often as you would hope. These are
 * the short ones observed to recur, plus the fixed strings the server itself
 * speaks. The runtime cache above is what actually carries the load.
 */
export const DEFAULT_PHRASES = [...new Set([
  "Yes.", "No.", "Okay.", "Done.", "Got it.", "Sure.",
  "I don't know.", "I'm not sure.", "Let me check.", "One moment.",
  "Timer set.", "Timer cancelled.", "Nothing is playing.",
  "I couldn't reach the internet.", "I can't see your screen.",
  "Sorry, I didn't catch that.", "I'm listening.",
  // What he says while he works - "Let me look that up." Taken from
  // lib/filler.js rather than copied, so a new filler can never be the one
  // phrase that is not warm. A filler the cloned voice has to synthesise first
  // arrives seconds late, which is no filler at all.
  ...FILLER_PHRASES,
])];

/**
 * Generate the pre-warm list in the background.
 *
 * Deliberately sequential and deliberately not awaited by startup: the sidecar
 * serializes synthesis anyway, so racing it would only delay Greg's first real
 * answer — the one thing this whole feature exists to speed up.
 */
export async function warmCache({ phrases, voiceId, synthesize, onDone }) {
  if (!enabled) return;
  const list = (phrases ?? []).filter((p) => typeof p === "string" && p.trim());
  let made = 0;

  for (const phrase of list) {
    try {
      const { clean, key } = describe(voiceId, phrase);
      if (!clean || readCacheQuiet(key)) continue;
      const { audio, contentType } = await synthesize(phrase);
      writeCache(key, audio, contentType);
      made += 1;
    } catch {
      // One bad phrase must not stop the rest.
    }
  }
  onDone?.({ made, total: list.length });
}

// readCache() counts hits and misses for the stats line; the warm loop must not
// pollute those, so it gets a quiet variant.
function readCacheQuiet(key) {
  for (const ext of ["wav", "mp3"]) {
    if (fs.existsSync(path.join(dir, `${key}.${ext}`))) return true;
  }
  return false;
}

// Set by lib/tts.js so the warm loop keys phrases exactly as synthesis will.
let cleaner = (text) => text;
export function setCleaner(fn) {
  if (typeof fn === "function") cleaner = fn;
}
function describe(voiceId, text) {
  const clean = cleaner(text);
  return { clean, key: cacheKey(voiceId, clean) };
}

export function cacheStats() {
  return { enabled, entries: countEntries(), hits, misses, folder: path.relative(ROOT, dir) };
}
