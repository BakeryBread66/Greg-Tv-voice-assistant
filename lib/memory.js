// Long-term memory — the things Greg should still know tomorrow.
//
// Plain JSON in the project folder so you can read, edit, or delete it yourself.
// Deliberately separate from conversation history: the ⟲ button clears what
// you were just talking about, not what Greg knows about you.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAX_FACTS = 60;

let file = path.join(ROOT, "memory.json");
let store = null;

/**
 * Point memory at a different file. Only the tests call it.
 *
 * It used to be one hard-coded path, which made remember() and forget()
 * untestable without writing to the user's real memory.json — the exact trap
 * DECISIONS.md names: anything that reads the user's own folders must take a
 * path. Resets the in-memory copy so the next read comes from the new file.
 */
export function useMemoryFile(target) {
  file = path.resolve(String(target));
  store = null;
}

function load() {
  if (store) return store;
  try {
    store = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(store.facts)) store.facts = [];
  } catch {
    store = { facts: [] };
  }
  return store;
}

function save() {
  try {
    fs.writeFileSync(file, JSON.stringify(store, null, 2));
  } catch (err) {
    console.error("[memory] could not save:", err.message);
  }
}

const normalize = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

/**
 * Is one fact the other with more detail — "likes tea" and "likes tea with
 * honey" — so the newer one should replace it rather than sit beside it?
 *
 * Compared as WHOLE WORDS. It used to be a character substring, so "the user
 * likes tea" was a near-duplicate of "the user likes teapots" and was quietly
 * overwritten by it: a fact lost because another one happened to share its
 * first letters.
 */
export function isNearDuplicate(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return false;
  return x === y || ` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `);
}

// Words that say nothing about WHICH fact is meant.
//
// Every fact is written "The user ..." — remember_about_user's own schema asks
// for exactly that — so "the" and "user" are in all of them. forget() used to
// delete any fact containing ANY word of three letters or more from the
// request, by substring, which made forget("the car") delete every fact on
// file, and "car" alone delete "The user is scared of heights". The two bugs
// compounded: the filler word matched everything, and the real word matched
// inside other words.
const FILLER = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with", "from", "by", "as", "about",
  "user", "users", "i", "im", "ive", "me", "my", "mine", "myself", "you", "your", "yours", "we", "our", "us",
  "he", "she", "him", "his", "her", "hers", "they", "them", "their", "theirs", "it", "its",
  "this", "that", "these", "those", "what", "which", "who", "whom", "whose",
  "is", "are", "was", "were", "be", "been", "being", "am", "has", "have", "had", "do", "does", "did",
  "fact", "facts", "thing", "things", "stuff", "something", "anything", "detail", "details", "info", "information",
  "please", "just", "also", "now", "ever", "again", "anymore", "any", "some", "all", "every", "everything",
  "forget", "remember", "remembered", "know", "known", "knew", "said", "say", "told", "tell", "called", "named",
]);

// Asking for all of it, in the words people actually use. A fixed list rather
// than "no significant words left", because "forget that" and "forget it" have
// no significant words either and mean ONE thing, not everything.
const EVERYTHING = new Set([
  "everything", "all", "all of it", "all of them", "it all", "all facts", "all the facts", "every fact",
  "everything about me", "everything you know", "everything you know about me", "all you know about me",
]);

// Plural and possessive both flatten to the same stem: normalize() has already
// turned "sister's" into "sisters", so "sister" has to meet it halfway.
const stem = (word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word);
const wordsOf = (text) => normalize(text).split(" ").filter(Boolean);

/** The words in a request that actually pick out a fact. */
export function significantWords(query) {
  return [...new Set(wordsOf(query).filter((w) => w.length > 1 && !FILLER.has(w)).map(stem))];
}

/**
 * Decide which facts a "forget" request removes. Pure, so it can be proven
 * without touching memory.json.
 *
 * A fact goes only if EVERY significant word of the request appears in it as a
 * whole word. That errs toward keeping — "forget my vehicle" removes nothing
 * rather than guessing — which is the right direction for a delete: a fact kept
 * by mistake costs one more "forget", a fact deleted by mistake is gone.
 *
 * @returns {{ removed: object[], kept: object[], problem?: string, everything?: boolean }}
 */
export function pickForgettable(facts, query) {
  const all = Array.isArray(facts) ? facts : [];
  const needle = normalize(query);

  // Empty used to mean "everything" — so a model calling the tool with a blank
  // argument wiped the store. Absence is not a request.
  if (!needle) {
    return { removed: [], kept: all, problem: "No fact was named, so nothing was forgotten. Ask which fact they mean." };
  }
  if (EVERYTHING.has(needle)) return { removed: all, kept: [], everything: true };

  const wanted = significantWords(needle);
  if (!wanted.length) {
    return {
      removed: [],
      kept: all,
      problem: `"${String(query).trim()}" does not say which fact, so nothing was forgotten. Ask which one they mean, or pass words from the fact itself.`,
    };
  }

  const removed = [];
  const kept = [];
  for (const fact of all) {
    const words = new Set(wordsOf(fact.text).map(stem));
    (wanted.every((w) => words.has(w)) ? removed : kept).push(fact);
  }
  return { removed, kept };
}

/** Store something durable about the user. Returns what was actually kept. */
export function remember(text) {
  const fact = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!fact) throw new Error("nothing to remember");
  if (fact.length > 300) throw new Error("that's too long to remember as a single fact");

  const data = load();

  // Replace a near-duplicate rather than accumulating variations of one fact.
  const existing = data.facts.findIndex((f) => isNearDuplicate(f.text, fact));

  if (existing !== -1) {
    data.facts[existing] = { text: fact, savedAt: new Date().toISOString() };
  } else {
    data.facts.push({ text: fact, savedAt: new Date().toISOString() });
    if (data.facts.length > MAX_FACTS) data.facts.shift(); // oldest out first
  }

  save();
  return fact;
}

/**
 * Drop the facts a request names. See pickForgettable for what counts.
 *
 * @returns {{ removed: string[], problem?: string }} — `problem` set means
 *          nothing was touched, and says why in words the model can relay.
 */
export function forget(query) {
  const data = load();
  const verdict = pickForgettable(data.facts, query);
  if (verdict.problem) return { removed: [], problem: verdict.problem };
  if (verdict.removed.length) {
    data.facts = verdict.kept;
    save();
  }
  return { removed: verdict.removed.map((f) => f.text) };
}

export function listFacts() {
  return load().facts.map((f) => f.text);
}

/** Rendered into the system prompt so Greg simply knows these things. */
export function formatForPrompt() {
  const facts = listFacts();
  if (!facts.length) return "";
  return `\n\nWhat you already know about the user (from previous conversations):\n${facts.map((f) => `- ${f}`).join("\n")}\nTreat these as established fact. Don't announce that you remembered them; just use them.`;
}
