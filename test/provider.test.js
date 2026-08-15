// The Ollama provider's request shape.
//
// One question here, and it is worth a file: does the warm-up send the same
// options a real turn sends?
//
// Ollama keys a loaded model on its context size. Warm at the default num_ctx,
// then ask a real question at 32768, and it silently unloads and reloads — so
// the warm-up costs nine seconds and buys nothing. **The dangerous part is that
// it looks like it worked**: /api/ps reports the model resident the whole time,
// and the only symptom is that the first question is still slow. Measured
// 10,854 ms mismatched against 1,449 ms matched, on the same machine minutes
// apart.
//
// The fix is that both build their options from one function, so they cannot
// drift. This asserts that they haven't — by capturing the actual request
// bodies rather than by reading the code.
//
// No Ollama needed: fetch is stubbed. A test that does real work is not
// thorough, it is slow, and this suite has twice been wrecked by one that did.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createOllamaProvider } from "../lib/providers/ollama.js";

const CONFIG = {
  ollama: { model: "test-model", contextTokens: 32768, temperature: 0.4, keepAlive: "30m" },
};

/**
 * Stand in for Ollama, and remember every body it was sent.
 *
 * /api/show has to answer first — the provider asks what the model can do
 * before it does anything, and reports "tools" and "thinking" so both optional
 * branches are actually exercised rather than skipped.
 */
function stubFetch(sent) {
  return async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    sent.push({ url: String(url), body });

    if (String(url).endsWith("/api/show")) {
      return { ok: true, json: async () => ({ capabilities: ["tools", "thinking", "completion"] }) };
    }
    return { ok: true, json: async () => ({ message: { role: "assistant", content: "ok" }, done_reason: "load" }) };
  };
}

async function capture(run) {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = stubFetch(sent);
  try { await run(createOllamaProvider(CONFIG)); }
  finally { globalThis.fetch = real; }
  return sent.filter((s) => s.url.endsWith("/api/chat")).map((s) => s.body);
}

test("the warm-up sends the same options a real turn sends", async () => {
  const [warmBody] = await capture((p) => p.warm());
  const [chatBody] = await capture((p) =>
    p.complete({ system: "s", messages: [{ role: "user", content: "hello" }], tools: [] })
  );

  // The assertion that matters. A mismatch here is not a cosmetic difference:
  // it makes Ollama reload the model on the first real question.
  assert.deepEqual(
    warmBody.options,
    chatBody.options,
    "warm() and complete() disagree about options — Ollama will reload the model and the warm-up buys nothing",
  );
  assert.equal(warmBody.options.num_ctx, 32768, "the configured context size must reach the warm-up");
});

test("the warm-up loads the model rather than asking it anything", async () => {
  const [body] = await capture((p) => p.warm());

  assert.deepEqual(body.messages, [], "a warm-up that sends a prompt is paying for inference it throws away");
  assert.equal(body.keep_alive, "30m", "without keep_alive the model unloads again before anyone speaks");
  assert.equal(body.stream, undefined, "nothing is reading a warm-up's stream");
});

test("thinking is set the same way for a warm-up as for a real turn", async () => {
  // Thinking is part of how the model is loaded, so a warm-up that differs here
  // is another way to get a reload. And "auto" has to reach Ollama as a
  // BOOLEAN — passing the string through is not an error it reports, it just
  // silently stops calling tools, which cost the eighth session a routing
  // measurement that scored 0/7 on prompts known to work.
  const [warmBody] = await capture((p) => p.warm());
  const [chatBody] = await capture((p) => p.complete({ system: "s", messages: [], tools: [] }));

  assert.equal(warmBody.think, true, `"auto" must reach Ollama as true, not the string`);
  assert.equal(warmBody.think, chatBody.think, "warm() and complete() disagree about thinking");
});

test("an unreachable Ollama fails the warm-up without throwing at the caller", async () => {
  // warmBrain() fires and forgets, so a rejection escaping here would be an
  // unhandled one. The provider is allowed to throw; brain.js catches. This
  // pins the contract that it throws rather than resolving falsely.
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  try {
    const provider = createOllamaProvider(CONFIG);
    await assert.rejects(() => provider.warm(), /500/, "a failed warm-up must be reported, not swallowed");
  } finally {
    globalThis.fetch = real;
  }
});

// ---------------------------------------------------------------------------
// Can this model call tools at all?
//
// Ollama declares it, and the provider already checked — but SILENTLY. A model
// without the capability simply had `tools` omitted from its request and nothing
// anywhere said so, which meant pointing ollama.model at a completion-only model
// gave a Greg that started up healthy, offered 28 tools he could never call, and
// answered everything from imagination.
//
// Measured on gemma3:1b, whose capabilities are `completion` and nothing else:
// 0 tool calls in six turns, a wrong time, a wrong day, and "seventy-three
// degrees with a chance of rain" against a real 89F and clear.
//
// Same shape as the vision swatch test: establish what the model can do, then
// withhold what it cannot.
// ---------------------------------------------------------------------------

function stubShow(capabilities, { ok = true } = {}) {
  return async (url) => {
    if (String(url).endsWith("/api/show")) {
      return { ok, status: ok ? 200 : 500, json: async () => ({ capabilities }) };
    }
    return { ok: true, json: async () => ({}) };
  };
}

async function askSupportsTools(capabilities, options) {
  const real = globalThis.fetch;
  globalThis.fetch = stubShow(capabilities, options);
  try {
    return await createOllamaProvider(CONFIG).supportsTools();
  } finally {
    globalThis.fetch = real;
  }
}

test("a model that declares tools can use them", async () => {
  assert.equal(await askSupportsTools(["completion", "tools", "thinking"]), true);
});

test("a completion-only model is caught", async () => {
  // gemma3:1b's actual capability list.
  assert.equal(await askSupportsTools(["completion"]), false);
});

test("a model that declares nothing at all is caught", async () => {
  assert.equal(await askSupportsTools([]), false);
  assert.equal(await askSupportsTools(undefined), false);
});

test("an unreachable Ollama does NOT strip tools", async () => {
  // A different failure, and ready() is what reports it. Answering "no tools"
  // on a network blip would silently take every tool away from a model that has
  // them — much worse than the thing this guard exists to prevent.
  assert.equal(await askSupportsTools(["tools"], { ok: false }), true);
});
