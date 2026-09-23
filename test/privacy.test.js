// Three privacy promises, each of which was broken before this file existed.
//
//   1. "Forget X" forgets X. forget("the car") used to delete every fact on
//      file: they are all written "The user ...", and the matcher took any
//      word of three letters or more, by substring.
//   2. "Clear my history" clears the history. No tool could. The model routed
//      it to forget_about_user, which removes facts, and said the log was
//      gone — three times, with the log intact after every one.
//   3. The brain stays on this PC unless you ask otherwise. "auto" used to
//      prefer Claude whenever a key was present, and when Claude IS the brain
//      the window now says so for as long as it is true.
//
// Nothing here touches the user's real memory.json or conversations.jsonl, and
// nothing talks to a model: every file is a temp file and Ollama is a stubbed
// fetch. A test that does real work is not thorough, it is slow.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { pickForgettable, significantWords, isNearDuplicate, useMemoryFile, remember, forget, listFacts } from "../lib/memory.js";
import { wantsHistoryCleared, initConversationLog, logTurn, conversationStats } from "../lib/conversation-log.js";
import { historyClearClaimedNotDone, buildSystemPrompt, initBrain, think } from "../lib/brain.js";
import { runTool } from "../lib/tools/index.js";
import { ollamaWhere } from "../lib/providers/ollama.js";
import { createAnthropicProvider } from "../lib/providers/anthropic.js";
import { brainPlace, showBrainPlace } from "../public/brain-place.js";
import { deviceLines, tagline } from "../public/boot.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "greg-privacy-"));
// Before anything can call remember() or forget(): the real file is never the target.
useMemoryFile(path.join(tmp, "memory.json"));

const fact = (text) => ({ text, savedAt: "2026-01-01T00:00:00.000Z" });
const FACTS = [
  fact("The user's car is a green Volvo estate"),
  fact("The user's sister is called Maya"),
  fact("The user works at the library on weekends"),
  fact("The user is scared of heights"),
];
const texts = (list) => list.map((f) => f.text);

// ---------------------------------------------------------------------------
// 1. Forgetting one fact
// ---------------------------------------------------------------------------

test("forgetting the car forgets the car, and nothing else", () => {
  // The regression exactly as it happened: "the" is in every fact.
  const { removed, kept } = pickForgettable(FACTS, "the car");
  assert.deepEqual(texts(removed), ["The user's car is a green Volvo estate"]);
  assert.equal(kept.length, 3);
});

test("a word is matched as a word, not inside another one", () => {
  // "car" is inside "scared".
  assert.deepEqual(texts(pickForgettable(FACTS, "car").removed), ["The user's car is a green Volvo estate"]);
});

test("the words every fact shares pick out no fact at all", () => {
  for (const vague of ["the user", "that", "it", "about the user", "that thing I told you", "my"]) {
    const verdict = pickForgettable(FACTS, vague);
    assert.equal(verdict.removed.length, 0, `"${vague}" must not delete anything`);
    assert.ok(verdict.problem, `"${vague}" should say why nothing was forgotten`);
  }
});

test("a blank request is not a request to forget everything", () => {
  // It used to be: an empty argument cleared the store.
  for (const bad of [undefined, null, "", "   "]) {
    const verdict = pickForgettable(FACTS, bad);
    assert.equal(verdict.removed.length, 0, `${JSON.stringify(bad)} must not delete anything`);
    assert.ok(verdict.problem);
  }
});

test("everything means everything, in the words people use", () => {
  for (const all of ["everything", "Everything.", "all of it", "everything you know about me"]) {
    assert.equal(pickForgettable(FACTS, all).removed.length, FACTS.length, all);
  }
});

test("every significant word must be there, and plurals and possessives still meet", () => {
  assert.deepEqual(texts(pickForgettable(FACTS, "my sister Maya").removed), ["The user's sister is called Maya"]);
  assert.deepEqual(texts(pickForgettable(FACTS, "sisters").removed), ["The user's sister is called Maya"]);
  // A paraphrase keeps rather than guesses; one right word of two is not enough.
  assert.equal(pickForgettable(FACTS, "my vehicle").removed.length, 0);
  assert.equal(pickForgettable(FACTS, "green Honda").removed.length, 0);
});

test("significant words drop the filler and keep the subject", () => {
  assert.deepEqual(significantWords("forget that the user's car is blue"), ["car", "blue"]);
  assert.deepEqual(significantWords(""), []);
  assert.deepEqual(significantWords(null), []);
});

test("a near-duplicate is a whole-word match, so tea is not teapots", () => {
  assert.equal(isNearDuplicate("The user likes tea", "The user likes teapots"), false);
  assert.equal(isNearDuplicate("The user likes tea", "The user likes tea with honey"), true);
  assert.equal(isNearDuplicate("", "anything"), false);
  assert.equal(isNearDuplicate(null, undefined), false);
});

test("remember and forget, end to end, on a file of the test's own", () => {
  for (const f of FACTS) remember(f.text);
  remember("The user likes tea");
  remember("The user likes teapots from Japan");
  assert.equal(listFacts().length, 6, "tea and teapots are two facts");

  assert.deepEqual(forget("the car").removed, ["The user's car is a green Volvo estate"]);
  assert.equal(listFacts().length, 5);
  assert.ok(forget("").problem);
  assert.equal(listFacts().length, 5, "a blank forget touched nothing");
  assert.ok(fs.existsSync(path.join(tmp, "memory.json")), "the test's own file was the one written");
});

test("forget_about_user reports a vague request as a failure, not as done", async () => {
  const result = await runTool("forget_about_user", { about: "that" }, {});
  assert.ok(result.error, "a vague forget must come back as an error, or it gets relayed as success");
  assert.deepEqual(result.forgotten, []);
});

test("a forget that matches nothing hands back what IS remembered, to retry with", async () => {
  const result = await runTool("forget_about_user", { about: "my vehicle" }, {});
  assert.deepEqual(result.forgotten, []);
  assert.ok(result.remembered.length > 0);
  assert.equal(result.error, undefined, "matching nothing is not a failure, it is nothing");
});

// ---------------------------------------------------------------------------
// 2. Clearing the conversation history
// ---------------------------------------------------------------------------

// The first two are the words from his own log, the ones he answered falsely.
const ASKED = [
  "clear history",
  "Clear your history of our conversations",
  "clear my conversation history",
  "delete our chat log",
  "wipe the conversation log please",
  "can you erase everything I said",
  "forget our conversations",
  "Hey Greg, delete all our conversations",
];

const NOT_ASKED = [
  "can you clear your memory", // facts, not the log
  "forget everything",
  "forget what I said about my car",
  "clear my browser history", // not his to clear, and not permission to clear his
  "clear the search history",
  "don't delete my history",
  "do not clear the log",
  "what did we talk about yesterday",
  "tell me about the history of Rome",
  "wipe the slate clean",
  undefined,
  null,
  "",
];

test("a request to clear the history is recognised in the words it comes in", () => {
  for (const said of ASKED) assert.equal(wantsHistoryCleared(said), true, said);
});

test("and nothing else is: facts, other histories, refusals, blanks", () => {
  for (const said of NOT_ASKED) assert.equal(wantsHistoryCleared(said), false, JSON.stringify(said));
});

test("asked to clear the history and not calling the tool is corrected out loud", () => {
  assert.match(historyClearClaimedNotDone("clear history", ["forget_about_user"]), /have not deleted/);
  assert.match(historyClearClaimedNotDone("clear history", []), /have not deleted/);
  assert.equal(historyClearClaimedNotDone("clear history", ["forget_about_user", "clear_conversation_history"]), null);
  assert.equal(historyClearClaimedNotDone("forget everything", ["forget_about_user"]), null);
  assert.equal(historyClearClaimedNotDone(undefined, []), null);
});

function freshLog() {
  const file = path.join(tmp, `conversations-${Math.random().toString(36).slice(2)}.jsonl`);
  initConversationLog({ conversationLog: { file } });
  logTurn({ user: "my car is blue", reply: "Noted." });
  logTurn({ user: "what time is it", reply: "Four o'clock." });
  return file;
}

test("clear_conversation_history empties the log when the user asked for it", async () => {
  const file = freshLog();
  const result = await runTool("clear_conversation_history", {}, { userText: "clear my conversation history" });
  assert.equal(result.cleared, true);
  assert.equal(fs.readFileSync(file, "utf8"), "");
});

test("and refuses, deleting nothing, when they did not ask", async () => {
  // A web page, a file, or the model's own misreading cannot grant it. Only
  // the user's words, this turn, can.
  for (const ctx of [{ userText: "what's the weather" }, { userText: "forget my car" }, {}, undefined]) {
    freshLog();
    const result = await runTool("clear_conversation_history", {}, ctx);
    assert.match(result.error ?? "", /^NOTHING WAS DELETED/, JSON.stringify(ctx));
    assert.equal(conversationStats().turns, 2, "the log is intact");
  }
});

test("the prompt tells him the two deletions apart, and the honesty rule covers the new one", () => {
  const prompt = buildSystemPrompt({}, "Testville");
  assert.match(prompt, /-> call clear_conversation_history/);
  assert.match(prompt, /forget_about_user only removes remembered facts/);
  assert.match(prompt, /clearing the conversation history/);
});

// ---------------------------------------------------------------------------
// The whole turn, through think(), with Ollama stubbed
// ---------------------------------------------------------------------------

const BRAIN_CONFIG = {
  provider: "ollama",
  ollama: { model: "stub-model", url: "http://127.0.0.1:11434" },
  location: { auto: false, city: "Testville", latitude: 35.9, longitude: -79.05 },
};

/** Stand in for Ollama: one scripted reply per /api/chat call, in order. */
async function withOllama(replies, run) {
  const real = globalThis.fetch;
  let turn = 0;
  globalThis.fetch = async (url) => {
    const where = String(url);
    if (where.endsWith("/api/show")) return { ok: true, json: async () => ({ capabilities: ["tools", "completion"] }) };
    if (where.endsWith("/api/chat")) {
      const message = replies[Math.min(turn++, replies.length - 1)];
      return { ok: true, json: async () => ({ message: { role: "assistant", content: "", ...message } }) };
    }
    throw new Error(`unexpected fetch to ${where}`);
  };
  try {
    await initBrain(BRAIN_CONFIG);
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

const call = (name, args = {}) => ({ tool_calls: [{ function: { name, arguments: args } }] });

test("clearing by voice empties the log AND the conversation he is holding", async () => {
  const file = freshLog();
  const history = [
    { role: "user", content: "my car is blue" },
    { role: "assistant", content: "Noted." },
  ];
  const result = await withOllama(
    [call("clear_conversation_history"), { content: "Done. Our conversation history is cleared." }],
    () => think("Clear your history of our conversations", history, BRAIN_CONFIG)
  );

  assert.equal(result.historyCleared, true);
  assert.deepEqual(result.usedTools, ["clear_conversation_history"]);
  assert.equal(fs.readFileSync(file, "utf8"), "", "the log on disk is empty");
  assert.equal(history.length, 0, "and so is the conversation in memory, or he could still repeat it");
  assert.doesNotMatch(result.reply, /have not deleted/, "no correction when it really happened");
});

test("routed to forget_about_user instead, he says the log is still there", async () => {
  // Exactly what the log recorded, three times over.
  freshLog();
  const history = [];
  const result = await withOllama(
    [call("forget_about_user", { about: "everything" }), { content: "I have cleared your history." }],
    () => think("clear history", history, BRAIN_CONFIG)
  );

  assert.equal(result.historyCleared, false);
  assert.match(result.reply, /have not deleted our conversation history/);
  assert.equal(conversationStats().turns, 2, "the log was not touched");
  assert.ok(history.length > 0, "an ordinary turn is still kept in memory");
});

// ---------------------------------------------------------------------------
// 3. Where the brain runs, and the window saying so
// ---------------------------------------------------------------------------

async function withKey(run) {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-test-not-a-real-key";
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
}

test('"auto" never picks Claude, even with a key present and Ollama down', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
  };
  try {
    const brain = await withKey(() => initBrain({ provider: "auto", ollama: { model: "stub-model" } }));
    // The old order put Claude first. Basic mode is the honest fallback: it
    // runs here, and it says it is limited.
    assert.equal(brain.active, false);
    assert.notEqual(brain.kind, "anthropic");
  } finally {
    globalThis.fetch = real;
  }
});

test('"auto" with Ollama up is Ollama, key or no key', async () => {
  const brain = await withKey(() => withOllama([{ content: "hi" }], () => initBrain({ ...BRAIN_CONFIG, provider: "auto" })));
  assert.equal(brain.kind, "ollama");
  assert.equal(brain.onThisMachine, true);
});

test("naming Claude is how you get it, and then the brain says it is not on this PC", async () => {
  const brain = await withKey(() => initBrain({ provider: "anthropic" }));
  assert.equal(brain.kind, "anthropic");
  assert.equal(brain.onThisMachine, false);
  assert.equal(brain.service, "Anthropic");
  assert.match(brain.label, /Anthropic/, "the console banner line says where, too");
  assert.equal(createAnthropicProvider({}).where.onThisMachine, false);
});

test("an Ollama brain is only 'on this PC' when it is", () => {
  assert.equal(ollamaWhere({}).onThisMachine, true);
  assert.equal(ollamaWhere({ ollama: { url: "http://127.0.0.1:11434", model: "gemma4:e4b" } }).onThisMachine, true);
  assert.equal(ollamaWhere({ ollama: { url: "http://localhost:11434/" } }).onThisMachine, true);

  const lan = ollamaWhere({ ollama: { url: "http://192.168.1.20:11434" } });
  assert.equal(lan.onThisMachine, false);
  assert.equal(lan.service, "192.168.1.20");

  // Ollama's own cloud models carry the word as their tag.
  assert.equal(ollamaWhere({ ollama: { model: "gpt-oss:120b-cloud" } }).onThisMachine, false);
  assert.equal(ollamaWhere({ ollama: { model: "some-model:cloud" } }).onThisMachine, false);
  // ...and only as the tag.
  assert.equal(ollamaWhere({ ollama: { model: "cloudy-llama:7b" } }).onThisMachine, true);
});

const CLAUDE = {
  hasBrain: true,
  brainKind: "anthropic",
  brainOnThisMachine: false,
  brainService: "Anthropic",
  brainLabel: "claude-opus-5 (Claude, on Anthropic's servers)",
  listening: "local",
  speaking: "local",
  canSeeScreen: false,
  location: { city: "Testville" },
};

test("the window says Claude whenever Claude is the brain", () => {
  const place = brainPlace(CLAUDE);
  assert.ok(place);
  assert.match(place.badge, /CLAUDE/);
  assert.match(place.detail, /Anthropic/);
  assert.match(place.tooltip, /sent there/);
});

test("including from a server too old to report where the brain is", () => {
  assert.ok(brainPlace({ hasBrain: true, brainKind: "anthropic" }), "hiding it is the wrong way to be wrong");
});

test("an Ollama brain off this PC gets the badge too, naming where", () => {
  const place = brainPlace({ hasBrain: true, brainKind: "ollama", brainOnThisMachine: false, brainService: "192.168.1.20" });
  assert.match(place.badge, /NOT THIS PC/);
  assert.match(place.detail, /192\.168\.1\.20/);
});

test("and says nothing for a brain on this PC, or for no brain at all", () => {
  assert.equal(brainPlace({ hasBrain: true, brainKind: "ollama", brainOnThisMachine: true }), null);
  assert.equal(brainPlace({ hasBrain: true, brainKind: "ollama" }), null);
  assert.equal(brainPlace({ hasBrain: false, brainKind: "anthropic" }), null);
  assert.equal(brainPlace({}), null);
  assert.equal(brainPlace(), null);
  assert.equal(brainPlace(null), null);
});

test("painting the badge shows it, fills it, and hides it again", () => {
  const node = () => ({ hidden: true, textContent: "", title: "", classList: { on: false, toggle(_, v) { this.on = v; } } });
  const els = { "cloud-brain": node(), "brain-where": node() };
  const doc = { getElementById: (id) => els[id] ?? null };

  showBrainPlace(CLAUDE, doc);
  assert.equal(els["cloud-brain"].hidden, false);
  assert.match(els["cloud-brain"].textContent, /CLAUDE/);
  assert.match(els["brain-where"].textContent, /Anthropic/);
  assert.equal(els["brain-where"].classList.on, true);

  showBrainPlace({ hasBrain: true, brainKind: "ollama", brainOnThisMachine: true }, doc);
  assert.equal(els["cloud-brain"].hidden, true);
  assert.equal(els["brain-where"].textContent, "");

  // A page without the elements must not throw.
  assert.doesNotThrow(() => showBrainPlace(CLAUDE, { getElementById: () => null }));
});

test("the boot screen no longer calls a Claude session local", () => {
  assert.equal(tagline(CLAUDE), "Some processing remote");
  const brain = deviceLines(CLAUDE).find((row) => row.label === "Brain");
  assert.equal(brain.ok, false);
  // Short, because the full label ran through the status column when rendered.
  assert.equal(brain.value, "Claude (cloud)");
  // And a local brain is still [ OK ].
  const local = { ...CLAUDE, brainKind: "ollama", brainOnThisMachine: true, brainLabel: "gemma4:e4b (on this PC)" };
  assert.equal(tagline(local), "All processing local");
  assert.equal(deviceLines(local).find((row) => row.label === "Brain").ok, true);
});
