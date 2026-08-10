// Files Greg can look at.
//
// This is the first thing in the project that touches the user's own machine,
// and it is deliberately the smallest version that is useful: he can FIND a
// file, READ what is in it, and TRANSCRIBE one that is audio or video. He
// cannot write, move, rename, delete or run anything, and there is no code path
// here that could — the module exports nothing that opens a file for writing.
//
// That is not timidity, it is the honesty rule applied one level down. Greg
// mishears words for a living: "delete the invoice" and "delete the invoices"
// are one phoneme apart, and this project has already recorded him claiming to
// have cancelled a timer that was still armed. Reading the wrong file wastes a
// turn. Deleting the wrong file does not.
//
// Three separate gates, and a path has to clear all of them:
//
//   1. it resolves to somewhere INSIDE an allowed root
//   2. it is not on the deny list, which wins over the allow list
//   3. it is not one of the shapes a secret takes
//
// Written as pure functions with the filesystem passed in where it matters, so
// the gates can be proven without a disk full of decoy secrets.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { transcribe, sttStatus } from "./stt.js";

// Where he may look, when config.json says nothing. Deliberately the folders a
// person puts their own documents in, and deliberately NOT the home directory
// itself — that would sweep in AppData, .ssh, browser profiles, and every
// dotfile a developer has ever been handed by an installer.
const DEFAULT_ROOTS = ["Documents", "Downloads", "Desktop", "Pictures", "Videos", "Music"];

/**
 * The folders he is allowed to look in, absolute and resolved.
 *
 * A root that does not exist is dropped rather than being an error: not every
 * machine has a Videos folder, and refusing to start over that would be silly.
 */
export function allowedRoots(config = {}) {
  const configured = config.files?.roots;
  const home = os.homedir();
  // An EMPTY array means nowhere; only ABSENCE means the defaults. The first
  // version treated the two the same, so somebody switching the feature off by
  // emptying the list would silently have been given the whole default set
  // instead — a failure in the direction of more access, which is the only
  // direction that matters here. Absence and emptiness are different facts, the
  // same lesson `Number(null)` being 0 taught this project twice already.
  const list = Array.isArray(configured) ? configured : DEFAULT_ROOTS.map((name) => path.join(home, name));

  const roots = [];
  for (const entry of list) {
    try {
      const resolved = fs.realpathSync(path.resolve(String(entry)));
      if (fs.statSync(resolved).isDirectory()) roots.push(resolved);
    } catch {
      // Missing or unreadable — simply not a place he can look.
    }
  }
  return roots;
}

/**
 * Names and fragments that are refused wherever they appear.
 *
 * The deny list WINS over the allow list, and that ordering is the point. Point
 * a root at the home directory — which somebody will — and without this he
 * would happily read `.env`, an SSH key, a browser cookie jar, or Greg's own
 * `spotify-tokens.json` and `conversations.jsonl`, out loud, in a room.
 *
 * Matched against the whole path, lowercased, so a secret is refused no matter
 * how deeply it is buried.
 */
const DENY_FRAGMENTS = [
  `${path.sep}appdata${path.sep}`, `${path.sep}.ssh${path.sep}`, `${path.sep}.git${path.sep}`,
  `${path.sep}node_modules${path.sep}`, `${path.sep}.venv`, `${path.sep}windows${path.sep}`,
  `${path.sep}program files`, `${path.sep}.aws${path.sep}`, `${path.sep}.config${path.sep}`,
];

const DENY_NAMES = [
  /^\.env(\..*)?$/i,
  /^id_(rsa|ed25519|ecdsa)/i,
  /\.(pem|key|pfx|p12|keystore|jks)$/i,
  /(password|passwd|secret|credential|token|apikey|api_key)/i,
  /^cookies(\.sqlite)?$/i,
  /^conversations\.jsonl$/i,
  /^spotify-tokens\.json$/i,
  /^memory\.json$/i,
];

/**
 * True if this path is one of the shapes a secret takes.
 *
 * `root` matters more than it looks. The fragments describe places he must not
 * WANDER INTO from an allowed root — not places a root may not live. Checked
 * against the absolute path, a temp folder under `AppData\Local\Temp` is
 * entirely unreadable, and so is anybody whose Documents have been redirected
 * somewhere unusual: the guard silently swallows a folder they configured on
 * purpose, with no error to explain it. Passing the root makes the question
 * "where did he go from here", which is the one being asked.
 *
 * The NAME checks always apply, wherever the file is.
 */
export function isSecret(target, root = null) {
  const full = String(target ?? "").toLowerCase();
  const name = path.basename(full);
  const within = root
    ? path.sep + path.relative(String(root), String(target)).toLowerCase()
    : full;
  if (DENY_FRAGMENTS.some((fragment) => within.includes(fragment))) return true;
  // A leading dot is a configuration file more often than a document, and the
  // interesting exceptions (.txt, .md) do not start with one.
  if (name.startsWith(".") && name !== ".") return true;
  return DENY_NAMES.some((pattern) => pattern.test(name));
}

/**
 * Is `target` genuinely inside one of `roots`?
 *
 * The separator on the end is what makes this correct rather than nearly
 * correct: without it, a root of `.../Documents` also admits
 * `.../Documents-private`, which is a different folder that happens to share a
 * prefix. Comparison is case-insensitive because Windows paths are.
 */
export function rootFor(target, roots = []) {
  if (!target) return null;
  const full = path.resolve(String(target)).toLowerCase();
  return (
    roots.find((root) => {
      const base = path.resolve(String(root)).toLowerCase();
      return full === base || full.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
    }) ?? null
  );
}

export function insideRoots(target, roots = []) {
  return rootFor(target, roots) !== null;
}

/**
 * Turn something the model said into a real path it is allowed to touch, or a
 * reason why not.
 *
 * `realpathSync` FIRST, then the root check — that order is the whole guard. A
 * symlink or a junction inside Documents pointing at `C:\Windows\System32` is a
 * path that passes a string comparison and reads somewhere else entirely, and
 * Windows hands those out for OneDrive and for Program Files.
 */
export function resolveReadable(target, config = {}) {
  const raw = String(target ?? "").trim();
  if (!raw) return { error: "no file was named" };

  let full;
  try {
    full = fs.realpathSync(path.resolve(raw));
  } catch {
    return { error: `there is no file called "${path.basename(raw)}" that I can see` };
  }

  const roots = allowedRoots(config);
  const root = rootFor(full, roots);
  if (!root) {
    return {
      error: "that file is outside the folders I am allowed to look in",
      // Named, so "why can't he see it" is answerable without reading the code.
      allowed: roots.map((entry) => path.basename(entry)),
    };
  }
  if (isSecret(full, root)) {
    return { error: "that one looks like a private file — keys, tokens and settings files are off limits" };
  }
  return { path: full };
}

// What kind of thing a file is, by extension. Deliberately a small list: an
// extension not in here is one he says he cannot read, rather than one he opens
// and reports as gibberish.
const KINDS = {
  text: [".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".log", ".xml", ".yml", ".yaml", ".html", ".htm", ".rtf"],
  code: [".js", ".ts", ".py", ".java", ".c", ".h", ".cpp", ".cs", ".go", ".rs", ".rb", ".php", ".sh", ".ps1", ".sql", ".css"],
  audio: [".mp3", ".wav", ".m4a", ".flac", ".ogg", ".opus", ".aac", ".wma"],
  video: [".mp4", ".mkv", ".mov", ".avi", ".webm", ".m4v"],
  image: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"],
  document: [".pdf", ".docx", ".doc", ".pptx", ".xlsx", ".odt"],
};

export function kindOf(target) {
  const ext = path.extname(String(target ?? "")).toLowerCase();
  for (const [kind, list] of Object.entries(KINDS)) if (list.includes(ext)) return kind;
  return "other";
}

/** Whether reading it means transcribing it. */
export const isSpeech = (target) => ["audio", "video"].includes(kindOf(target));

/**
 * How much of a file he will read, and how big a recording he will take on.
 *
 * The text cap is small because everything read here is going into a prompt
 * that already carries ~4,560 tokens of fixed overhead before a word of
 * conversation. The media cap is generous by comparison because the audio never
 * touches the model — it goes to Whisper and comes back as text.
 */
export const MAX_TEXT_BYTES = 200_000;
export const MAX_MEDIA_BYTES = 250_000_000;

/** A size a person would say out loud. */
export function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Score a filename against what the user asked for.
 *
 * Every word has to appear somewhere in the name — an OR would return the whole
 * disk for "the tax spreadsheet" — and matches earlier in the name score higher,
 * because that is where people put the thing the file is about.
 */
export function scoreName(name, words) {
  const hay = String(name ?? "").toLowerCase();
  let score = 0;
  for (const word of words) {
    const at = hay.indexOf(word);
    if (at === -1) return 0;
    score += word.length * 2 + Math.max(0, 20 - at);
  }
  return score;
}

/** The words worth matching on, out of what the user said. */
export function searchWords(query) {
  return String(query ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !["the", "my", "file", "that", "for", "and", "with", "from"].includes(word));
}

/**
 * Walk the allowed roots looking for a name that matches.
 *
 * Breadth-first with a hard cap on how many directories are opened, because
 * "find my notes" must not turn into a full scan of a drive while somebody
 * stands there waiting. A cap that is hit is REPORTED rather than hidden: an
 * incomplete search that presents itself as a complete one is the empty-results
 * failure this project keeps rediscovering.
 */
export async function findFiles(query, config = {}, { limit = 8, kind = null, maxDirs = 4000 } = {}) {
  const words = searchWords(query);
  if (!words.length) return { error: "I need something to search for — a word from the file's name." };

  const roots = allowedRoots(config);
  if (!roots.length) {
    return { error: "there are no folders I am allowed to look in — see the files section of config.json" };
  }

  // Each directory carries the root it came from, so `isSecret` can ask where
  // he WANDERED rather than where the root happens to live on disk.
  const queue = roots.map((root) => ({ dir: root, root }));
  const hits = [];
  let opened = 0;

  while (queue.length && opened < maxDirs) {
    const { dir, root } = queue.shift();
    opened++;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable folder: skip it rather than fail the search
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (isSecret(full, root)) continue;
      if (entry.isDirectory()) {
        queue.push({ dir: full, root });
        continue;
      }
      if (!entry.isFile()) continue;
      if (kind && kindOf(full) !== kind) continue;

      const score = scoreName(entry.name, words);
      if (score > 0) hits.push({ full, name: entry.name, score });
    }
  }

  const ranked = [];
  for (const hit of hits.sort((a, b) => b.score - a.score).slice(0, limit)) {
    let stat = null;
    try {
      stat = await fsp.stat(hit.full);
    } catch {
      continue;
    }
    ranked.push({
      file: hit.name,
      kind: kindOf(hit.full),
      size: humanSize(stat.size),
      modified: stat.mtime.toISOString().slice(0, 10),
      folder: path.basename(path.dirname(hit.full)),
      path: hit.full,
    });
  }

  return {
    matches: ranked,
    searched: opened,
    // Said plainly, because a model handed an empty list fills the silence.
    ...(ranked.length
      ? {}
      : { note: "Nothing in those folders has a name like that. Say you could not find it rather than guessing at what it might be." }),
    ...(opened >= maxDirs ? { partial: "The search stopped early — there were too many folders to look through, so this may not be everything." } : {}),
  };
}

/**
 * Read a text file, capped.
 *
 * The content comes back tagged as quoted material. A file on this machine is
 * as untrusted as a web page for this purpose — `lib/readpage.js` already says
 * so about the internet, and a document somebody emailed you is no different
 * just because it now lives in Downloads.
 */
/**
 * Transcribe a recording, through the Whisper that is already loaded.
 *
 * No new sidecar and no change to `whisper_server.py`: it takes bytes over HTTP
 * and hands them to faster-whisper, which decodes the container itself. The
 * model is resident because the microphone needs it anyway, so this costs
 * nothing to have.
 *
 * **Whisper being unavailable is SAID, not worked around.** On a machine that
 * fell back to browser speech recognition there is no local Whisper at all, and
 * the browser's is a live microphone service that cannot be handed a file. An
 * error that names the reason is worth more than a silent failure, and this is
 * the same rule the voice fallbacks obey: a missing piece costs the feature, not
 * the truth about it.
 */
export async function transcribeFile(full, { minutesPerTimeout = 6 } = {}) {
  const ears = sttStatus();
  if (ears.state !== "ready") {
    return {
      error: "I can't transcribe recordings — the offline speech model isn't running on this machine.",
      retryable: false,
    };
  }

  const stat = await fsp.stat(full);
  if (stat.size > MAX_MEDIA_BYTES) {
    return {
      error: `that recording is ${humanSize(stat.size)}, which is more than I will take on in one go`,
      retryable: false,
    };
  }

  const audio = await fsp.readFile(full);
  // Scaled to the size of the file rather than fixed. A minute is plenty for an
  // utterance and absurd for a lecture; this gives roughly six minutes of grace
  // per 10 MB, which is far more than the GPU needs and still bounded.
  const timeoutMs = Math.max(120_000, Math.round((stat.size / 10_000_000) * minutesPerTimeout * 60_000));

  const started = Date.now();
  const result = await transcribe(audio, { timeoutMs });
  const text = String(result?.text ?? "").trim();

  console.log(`[files] transcribed ${path.basename(full)} (${humanSize(stat.size)}) in ${Date.now() - started} ms`);

  if (!text) {
    return {
      file: path.basename(full),
      transcript: "",
      note: "There is no speech in that recording, or none that could be made out. Say that rather than guessing at what it might contain.",
    };
  }

  return { file: path.basename(full), kind: kindOf(full), size: humanSize(stat.size), transcript: text };
}

export async function readTextFile(full) {
  const stat = await fsp.stat(full);
  const handle = await fsp.open(full, "r");
  try {
    const size = Math.min(stat.size, MAX_TEXT_BYTES);
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, 0);
    const text = buffer.toString("utf8");
    return {
      file: path.basename(full),
      kind: kindOf(full),
      size: humanSize(stat.size),
      truncated: stat.size > MAX_TEXT_BYTES,
      text,
    };
  } finally {
    await handle.close();
  }
}
