// "Let me look that up." - what Greg says while slow work runs.
//
// The rules in lib/filler.js, proven with a clock the test drives: said at once
// for the tools that are slow every time, said late only when other work turns
// out slow, at most once a turn, never on top of something he already said, and
// never where nothing is spoken. Then the whole turn through think(), with
// Ollama stubbed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createFiller, SLOW_TOOLS, LATE_FILLER, FILLER_AFTER_MS, FILLER_PHRASES } from "../lib/filler.js";
import { DEFAULT_PHRASES } from "../lib/tts-cache.js";
import { initBrain, think } from "../lib/brain.js";

function fakeClock() {
  const pending = new Map();
  let next = 1;
  return {
    setTimer(fn, ms) {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      pending.delete(id);
    },
    run() {
      const due = [...pending.values()];
      pending.clear();
      for (const { fn } of due) fn();
    },
    get waiting() {
      return pending.size;
    },
    get lastMs() {
      return [...pending.values()].at(-1)?.ms;
    },
  };
}

function filler() {
  const clock = fakeClock();
  const said = [];
  const f = createFiller({ say: (text) => said.push(text), setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  return { f, clock, said };
}

test("a search is announced the moment it starts", () => {
  const { f, clock, said } = filler();
  f.toolsStarting(["search_web"]);
  assert.deepEqual(said, ["Let me look that up."]);
  assert.equal(clock.waiting, 0, "nothing left counting down");
  assert.equal(f.said, "Let me look that up.");
});

test("each slow tool says what he is actually doing", () => {
  for (const [tool, phrase] of Object.entries(SLOW_TOOLS)) {
    const { f, said } = filler();
    f.toolsStarting([tool]);
    assert.deepEqual(said, [phrase], tool);
  }
});

test("a quick tool says nothing when the answer comes quickly", () => {
  // "What time is it" must not be answered "One moment. It's noon."
  const { f, clock, said } = filler();
  f.toolsStarting(["get_current_time"]);
  assert.equal(clock.lastMs, FILLER_AFTER_MS);
  f.answering();
  clock.run();
  assert.deepEqual(said, []);
});

test("any other work that turns out slow gets the late filler", () => {
  const { f, clock, said } = filler();
  f.toolsStarting(["get_weather"]);
  clock.run(); // FILLER_AFTER_MS pass with no answer started
  assert.deepEqual(said, [LATE_FILLER]);
});

test("once a turn, however many rounds of tools it takes", () => {
  const { f, clock, said } = filler();
  f.toolsStarting(["search_web"]);
  f.toolsStarting(["read_page"]);
  f.toolsStarting(["get_weather"]);
  clock.run();
  assert.deepEqual(said, ["Let me look that up."]);
});

test("the slow one in a mixed batch is what he announces", () => {
  const { f, said } = filler();
  f.toolsStarting(["get_current_time", "look_at_screen"]);
  assert.deepEqual(said, ["Let me have a look."]);
});

test("never on top of something he has already said this round", () => {
  const { f, clock, said } = filler();
  f.toolsStarting(["search_web"], true);
  clock.run();
  assert.deepEqual(said, []);
});

test("nothing where nothing is spoken - /api/chat", () => {
  const clock = fakeClock();
  const f = createFiller({ say: null, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  f.toolsStarting(["search_web"]);
  f.toolsStarting(["get_weather"]);
  assert.equal(clock.waiting, 0, "no timer left behind either");
  assert.equal(f.said, null);
});

test("a turn that has ended says nothing afterwards", () => {
  const { f, clock, said } = filler();
  f.toolsStarting(["get_weather"]);
  f.done();
  clock.run();
  f.toolsStarting(["search_web"]);
  assert.deepEqual(said, []);
});

test("bad input is not a tool list", () => {
  for (const names of [undefined, null, [], [null], [""]]) {
    const { f, clock, said } = filler();
    f.toolsStarting(names);
    assert.deepEqual(said, [], JSON.stringify(names));
    assert.equal(clock.waiting, 1, "unknown work still gets the late check");
  }
});

test("every filler is pre-warmed in the speech cache", () => {
  for (const phrase of FILLER_PHRASES) assert.ok(DEFAULT_PHRASES.includes(phrase), phrase);
  assert.equal(new Set(DEFAULT_PHRASES).size, DEFAULT_PHRASES.length, "no phrase is warmed twice");
});

// ---------------------------------------------------------------------------
// The whole turn
// ---------------------------------------------------------------------------

const CONFIG = {
  provider: "ollama",
  ollama: { model: "stub-model", url: "http://127.0.0.1:11434" },
  location: { auto: false, city: "Testville", latitude: 35.9, longitude: -79.0 },
  // Off, so look_at_screen answers at once with an error on every platform
  // rather than taking a real screenshot of whatever machine runs the tests.
  vision: { enabled: false },
};

async function withOllama(tool, run) {
  const real = globalThis.fetch;
  let chats = 0;
  globalThis.fetch = async (url) => {
    const where = String(url);
    if (where.endsWith("/api/show")) return { ok: true, json: async () => ({ capabilities: ["tools", "completion"] }) };
    if (where.endsWith("/api/chat")) {
      chats++;
      const message = chats === 1
        ? { role: "assistant", content: "", tool_calls: [{ function: { name: tool, arguments: {} } }] }
        : { role: "assistant", content: "Here is what I found." };
      // A real Response, because a turn someone is listening to STREAMS: the
      // provider reads newline-delimited JSON off the body, not .json().
      return new Response(JSON.stringify({ message, done: true }) + "\n", { status: 200 });
    }
    throw new Error(`unexpected fetch to ${where}`);
  };
  try {
    await initBrain(CONFIG);
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

test("a slow tool: the filler is said first, marked as a preface, and kept in the transcript", async () => {
  const heard = [];
  const history = [];
  const result = await withOllama("look_at_screen", () =>
    think("what's on my screen", history, CONFIG, (text, meta = {}) => heard.push({ text, preface: Boolean(meta.preface) }))
  );
  assert.deepEqual(heard[0], { text: "Let me have a look.", preface: true });
  assert.deepEqual(heard.at(-1), { text: "Here is what I found.", preface: false });
  assert.match(result.reply, /^Let me have a look\. Here is what I found\.$/);
  // The model's own history never sees it: it did not say it.
  assert.ok(!history.some((m) => String(m.content).includes("Let me have a look")));
});

test("a quick tool: no filler at all", async () => {
  const heard = [];
  // Not "what time is it", which no longer reaches a model (test/quick.test.js).
  const result = await withOllama("get_current_time", () => think("is it lunchtime yet", [], CONFIG, (text) => heard.push(text)));
  assert.deepEqual(heard, ["Here is what I found."]);
  assert.equal(result.reply, "Here is what I found.");
});

test("/api/chat, where nothing is spoken, gets no filler in its reply", async () => {
  const result = await withOllama("look_at_screen", () => think("what's on my screen", [], CONFIG));
  assert.equal(result.reply, "Here is what I found.");
});
