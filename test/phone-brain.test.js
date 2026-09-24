// A question from the phone: no screen, no files — enforced in the tools the
// model is offered, in its prompt, and in what actually runs.
//
// Ollama is stubbed; every request body the brain sends is captured.

import { test } from "node:test";
import assert from "node:assert/strict";

import { initBrain, think, buildSystemPrompt, PHONE_BLOCKED } from "../lib/brain.js";
import { asksAboutScreen, SCREEN_FROM_PHONE } from "../lib/quick.js";

const CONFIG = {
  provider: "ollama",
  ollama: { model: "stub-model", url: "http://127.0.0.1:11434" },
  location: { auto: false, city: "Testville", region: "NC", latitude: 35.9, longitude: -79.05 },
  units: { temperature: "fahrenheit", windSpeed: "mph" },
  files: { roots: [] },
};

function stubOllama(replies) {
  const bodies = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const where = String(url);
    if (where.endsWith("/api/show")) return { ok: true, json: async () => ({ capabilities: ["tools", "completion"] }) };
    if (where.endsWith("/api/chat")) {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ message: replies[bodies.length - 1] ?? { role: "assistant", content: "Done." } }) };
    }
    throw new Error(`unexpected fetch to ${where}`);
  };
  return { bodies, restore: () => { globalThis.fetch = real; } };
}

const toolNames = (body) => (body.tools ?? []).map((t) => t.function?.name ?? t.name);

test("the phone is never offered the screen or file tools; the PC still is", async () => {
  const stub = stubOllama([{ role: "assistant", content: "Hello." }, { role: "assistant", content: "Hello." }]);
  try {
    await initBrain(CONFIG);
    await think("tell me a joke", [], CONFIG, null, 0, { remote: true });
    await think("tell me a joke", [], CONFIG, null, 0);
    const [phone, pc] = stub.bodies.map(toolNames);
    for (const name of PHONE_BLOCKED) assert.ok(!phone.includes(name), `${name} was offered to the phone`);
    assert.ok(pc.includes("read_file") && pc.includes("take_screenshot"), "the PC keeps them");
    // Everything else the phone should have.
    for (const name of ["set_reminder", "play_music", "get_weather", "search_web", "remember_about_user"]) {
      assert.ok(phone.includes(name), `the phone lost ${name}`);
    }
  } finally {
    stub.restore();
  }
});

test("the phone's prompt says it has no screen or files, and drops the screenshot rule", () => {
  const phone = buildSystemPrompt(CONFIG, "Testville, NC", "hi", { remote: true });
  const pc = buildSystemPrompt(CONFIG, "Testville, NC", "hi");
  assert.match(phone, /through their PHONE/);
  assert.match(phone, /cannot see or capture the PC's screen and cannot open or read files/);
  assert.ok(!phone.includes("call take_screenshot"), "no rule for a tool it does not have");
  assert.ok(!phone.includes("call look_at_screen"));
  assert.ok(pc.includes("call take_screenshot"), "the PC's prompt is unchanged");
  assert.ok(!pc.includes("through their PHONE"));
});

test("if a model calls a blocked tool from the phone anyway, it does not run", async () => {
  const stub = stubOllama([
    { role: "assistant", content: "", tool_calls: [{ function: { name: "read_file", arguments: { query: "passwords" } } }] },
    { role: "assistant", content: "I can't open files from your phone." },
  ]);
  try {
    await initBrain(CONFIG);
    const turn = await think("read my passwords file", [], CONFIG, null, 0, { remote: true });
    assert.deepEqual(turn.usedTools, [], "nothing counted as used");
    const second = stub.bodies[1].messages;
    const toolReply = second.find((m) => m.role === "tool");
    assert.match(toolReply.content, /NOT AVAILABLE FROM THE PHONE/);
    assert.equal(turn.reply, "I can't open files from your phone.");
  } finally {
    stub.restore();
  }
});

test("the time still works from the phone, with no model at all", async () => {
  const stub = stubOllama([]);
  try {
    await initBrain(CONFIG);
    const turn = await think("what time is it", [], CONFIG, null, 0, { remote: true });
    assert.deepEqual(turn.usedTools, ["get_current_time"]);
    assert.equal(stub.bodies.length, 0);
  } finally {
    stub.restore();
  }
});

test("a question about the PC's screen from the phone is answered in code, never by the model", async () => {
  const stub = stubOllama([]);
  try {
    await initBrain(CONFIG);
    for (const said of ["what is on my screen right now", "what's on my monitor", "take a screenshot", "what am I looking at"]) {
      const turn = await think(said, [], CONFIG, null, 0, { remote: true });
      assert.equal(turn.reply, SCREEN_FROM_PHONE, said);
      assert.deepEqual(turn.usedTools, []);
    }
    assert.equal(stub.bodies.length, 0, "no model was asked");
  } finally {
    stub.restore();
  }
});

test("the screen gate is narrow: Greg's own set, and the PC, are unaffected", () => {
  for (const said of ["put the weather on the screen", "change the channel", "what's the weather", "is the screen door open"]) {
    assert.equal(asksAboutScreen(said), false, said);
  }
  assert.equal(asksAboutScreen(null), false);
});
