// A durable record of what was actually said.
//
// Greg's other memory is `lib/memory.js`, which keeps a handful of curated facts
// he was explicitly told to remember. This is the opposite: everything, verbatim,
// in the order it happened. The two answer different questions —
// "what do you know about me" against "what did we talk about yesterday" — and
// before this existed only the first one survived a restart.
//
// JSON Lines rather than one JSON document, because appending a line is atomic
// enough to survive Greg being killed mid-write, which he frequently is. A
// half-written last line costs one turn; a half-written JSON array costs the lot.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let file = path.join(ROOT, "conversations.jsonl");
let enabled = true;
let keepDays = 90;
let sessionId = null;

export function initConversationLog(config) {
  const settings = config.conversationLog ?? {};
  enabled = settings.enabled !== false;
  keepDays = Number(settings.keepDays) > 0 ? Number(settings.keepDays) : 90;
  if (settings.file) file = path.resolve(ROOT, settings.file);
  if (!enabled) return { enabled: false };

  // A session id lets a later reader tell "three separate conversations" from
  // "one long one", which timestamps alone can't.
  sessionId = new Date().toISOString().replace(/[:.]/g, "-");

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    prune();
  } catch (err) {
    enabled = false;
    return { enabled: false, reason: err.message };
  }
  return { enabled: true, file: path.relative(ROOT, file), turns: countTurns() };
}

function countTurns() {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * Record one exchange.
 *
 * Never throws and never awaits anything the reply is waiting on — a logging
 * problem must not cost the user an answer, and this runs on the path that
 * measures its own latency.
 */
export function logTurn({ user, reply, usedTools = [], ms = null, firstMs = null, answerMs = null, timing = null }) {
  if (!enabled || !String(user ?? "").trim()) return;
  const line = JSON.stringify({
    at: new Date().toISOString(),
    session: sessionId,
    user: String(user).trim(),
    reply: String(reply ?? "").trim(),
    tools: usedTools,
    ms,
    // When he started speaking, and where the time went - ["model", ms] and
    // [tool, ms] in order. Numbers only, never content. It is what turned "the
    // first question is slow" from a feeling into a pattern, and what will say
    // which part of a slow turn was slow.
    ...(firstMs !== null ? { firstMs } : {}),
    // Only when it differs: he said something first ("Let me look that up."),
    // and this is when the answer itself began.
    ...(answerMs !== null && answerMs !== firstMs ? { answerMs } : {}),
    ...(Array.isArray(timing) && timing.length ? { steps: timing } : {}),
  });
  try {
    fs.appendFileSync(file, line + "\n");
  } catch {
    // Disk full, file locked, whatever — losing a log line is not worth a word.
  }
}

/** Drop anything older than keepDays. Cheap, and only at startup. */
function prune() {
  if (!fs.existsSync(file)) return;
  const cutoff = Date.now() - keepDays * 86400000;
  const kept = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .filter((line) => {
      try {
        return new Date(JSON.parse(line).at).getTime() >= cutoff;
      } catch {
        return false; // an unparseable line is a torn write; drop it
      }
    });
  fs.writeFileSync(file, kept.length ? kept.join("\n") + "\n" : "");
}

function readAll() {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Search past conversations.
 *
 * Deliberately plain word matching rather than embeddings. Greg already ships a
 * `nomic-embed-text` model and it would be easy to reach for, but that means a
 * third model resident on a card already holding four, to search a file that
 * will have a few thousand lines in it. Grep is the right size of tool here.
 *
 * @param {string} query    words to look for; empty means "most recent"
 * @param {object} opts
 * @param {number} [opts.limit]      how many turns to return
 * @param {number} [opts.sinceDays]  only look this far back
 */
export function searchConversations(query, { limit = 6, sinceDays = null } = {}) {
  let turns = readAll();
  if (sinceDays) {
    const cutoff = Date.now() - sinceDays * 86400000;
    turns = turns.filter((t) => new Date(t.at).getTime() >= cutoff);
  }

  const words = String(query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);

  // Newest first. slice(-limit) alone keeps chronological order, so "what were we
  // just talking about" handed the model the OLDEST of the last six — and a model
  // reading a list leads with what it reads first.
  if (!words.length) return turns.slice(-limit).reverse().map(forOutput);

  const scored = turns
    .map((turn) => {
      const hay = `${turn.user} ${turn.reply}`.toLowerCase();
      const score = words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
      return { turn, score };
    })
    .filter((x) => x.score > 0)
    // Best match first, and among equals the most recent — "what did I say about
    // the car" almost always means the last time, not the first.
    .sort((a, b) => b.score - a.score || new Date(b.turn.at) - new Date(a.turn.at));

  return scored.slice(0, limit).map((x) => forOutput(x.turn));
}

// Dates go to the model as something it can say out loud. An ISO timestamp read
// aloud is the same class of problem as a Windows path.
function forOutput(turn) {
  const when = new Date(turn.at);
  return {
    when: when.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
    daysAgo: Math.max(0, Math.round((Date.now() - when.getTime()) / 86400000)),
    youSaid: turn.user,
    gregSaid: turn.reply,
  };
}

export function conversationStats() {
  const turns = readAll();
  return {
    enabled,
    file: path.relative(ROOT, file),
    turns: turns.length,
    oldest: turns[0]?.at ?? null,
    sessions: new Set(turns.map((t) => t.session)).size,
  };
}

// Did the person ask, in their own words, for this log to be wiped?
//
// This is the permission the clear_conversation_history tool needs, and it is
// read from what the USER said rather than from anything the model decided.
// The log used to be clearable only through DELETE /api/conversations, on the
// reasoning that deleting it is not something the model should do on its own
// initiative — and that reasoning still holds. What it missed is that "clear my
// history" was then answered by forget_about_user, which removes remembered
// facts and not one line of the log, and he said the history was gone. Three
// times, with the log intact every time. A tool gated on the request keeps the
// original rule and closes that gap: nothing the model reads — a web page, a
// file, its own misunderstanding — can grant it.
//
// Other people's histories are excluded by name. "Clear my browser history" is
// a request Greg cannot carry out, and it must not be read as permission to
// delete this one.
const CLEAR_VERB = String.raw`clear|delete|erase|wipe|purge|scrub|remove|get rid of|forget`;
const LOG_NOUN =
  String.raw`(?:conversation|chat)s?(?: history| log| logs| record| records)?|history|chat logs?|transcripts?|(?:the|your|our|my) logs?|everything (?:i|we)(?: have|'ve)? (?:said|told you|talked about)`;
const ASKS_TO_CLEAR = new RegExp(String.raw`\b(?:${CLEAR_VERB})\b[^.?!]{0,40}?\b(?:${LOG_NOUN})\b`, "i");
const NOT_OURS =
  /\b(?:browser|browsing|search|web|internet|chrome|edge|firefox|youtube|spotify|listening|watch|viewing|call|download|purchase|order|clipboard|medical|credit)\s+history\b/i;
const NEGATED = new RegExp(String.raw`\b(?:don'?t|do not|never|won'?t|not|stop)\b[^.?!]{0,15}\b(?:${CLEAR_VERB})\b`, "i");

export function wantsHistoryCleared(userText) {
  const text = String(userText ?? "").trim();
  if (!text) return false;
  if (NOT_OURS.test(text) || NEGATED.test(text)) return false;
  return ASKS_TO_CLEAR.test(text);
}

/** Wipe it. Exposed because a verbatim record of everything said needs an off switch. */
export function clearConversations() {
  try {
    fs.writeFileSync(file, "");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
