// Long-term memory — the things Greg should still know tomorrow.
//
// Plain JSON in the project folder so you can read, edit, or delete it yourself.
// Deliberately separate from conversation history: the ⟲ button clears what
// you were just talking about, not what Greg knows about you.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILE = path.join(ROOT, "memory.json");
const MAX_FACTS = 60;

let store = null;

function load() {
  if (store) return store;
  try {
    store = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (!Array.isArray(store.facts)) store.facts = [];
  } catch {
    store = { facts: [] };
  }
  return store;
}

function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    console.error("[memory] could not save:", err.message);
  }
}

const normalize = (text) => text.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

/** Store something durable about the user. Returns what was actually kept. */
export function remember(text) {
  const fact = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!fact) throw new Error("nothing to remember");
  if (fact.length > 300) throw new Error("that's too long to remember as a single fact");

  const data = load();
  const key = normalize(fact);

  // Replace a near-duplicate rather than accumulating variations of one fact.
  const existing = data.facts.findIndex((f) => {
    const other = normalize(f.text);
    return other === key || other.includes(key) || key.includes(other);
  });

  if (existing !== -1) {
    data.facts[existing] = { text: fact, savedAt: new Date().toISOString() };
  } else {
    data.facts.push({ text: fact, savedAt: new Date().toISOString() });
    if (data.facts.length > MAX_FACTS) data.facts.shift(); // oldest out first
  }

  save();
  return fact;
}

/** Drop anything matching a phrase. Returns the facts that were removed. */
export function forget(query) {
  const needle = normalize(query ?? "");
  const data = load();

  if (needle === "everything" || needle === "all" || needle === "") {
    const removed = data.facts.map((f) => f.text);
    data.facts = [];
    save();
    return removed;
  }

  const words = needle.split(" ").filter((w) => w.length > 2);
  const kept = [];
  const removed = [];

  for (const fact of data.facts) {
    const text = normalize(fact.text);
    const hit = text.includes(needle) || words.some((w) => text.includes(w));
    (hit ? removed : kept).push(fact);
  }

  data.facts = kept;
  save();
  return removed.map((f) => f.text);
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
