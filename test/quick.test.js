// The everyday questions, recognised in code: the time and the date answered
// with no model, and the weather fetched before the model is asked.
//
// Nothing here touches the network or a model: fetch is stubbed throughout.

import { test } from "node:test";
import assert from "node:assert/strict";

import { quickIntent, spokenTime, spokenDate } from "../lib/quick.js";
import { initBrain, think } from "../lib/brain.js";
import { clearWeatherCache } from "../lib/weather.js";
import { clearAirCache } from "../lib/airquality.js";

// ---------------------------------------------------------------------------
// Recognising them
// ---------------------------------------------------------------------------

test("the time, however it was asked in his log", () => {
  for (const said of [
    "what time is it", "What time is it?", "what's the time", "what time is it now",
    "Hey Greg, what time is it", "what time is it greg", "tell me the time", "whats the time",
    "can you tell me the time please", "time",
  ]) {
    assert.equal(quickIntent(said), "time", said);
  }
});

test("the date", () => {
  for (const said of ["What day is it", "what's the date", "what's today's date", "what day is it today"]) {
    assert.equal(quickIntent(said), "date", said);
  }
});

test("the weather at home", () => {
  for (const said of [
    "what's the weather", "what is the weather", "Whats the weather", "how's the weather",
    "tell me the weather", "what's the weather like", "what's the weather like today",
    "what's the forecast", "hey greg what's the weather",
  ]) {
    assert.equal(quickIntent(said), "weather", said);
  }
});

test("anything with an argument in it still goes to the model", () => {
  for (const said of [
    "what time is it in Tokyo",
    // "here" is the globe's selection, which only the model is told about.
    "what's the weather here",
    "what time is it there",
    "what's the weather in London",
    "will it rain tomorrow",
    "do I need a jacket",
    "what time does the store close",
    "what's the weather going to be like tomorrow",
    "set a timer for the time it takes",
    "is it lunchtime yet",
    "",
  ]) {
    assert.equal(quickIntent(said), null, said);
  }
  assert.equal(quickIntent(null), null);
  assert.equal(quickIntent(undefined), null);
});

// ---------------------------------------------------------------------------
// Saying the time
// ---------------------------------------------------------------------------

const at = (hour, minute) => new Date(2026, 7, 6, hour, minute);

test("the clock is said the way a person says it", () => {
  assert.equal(spokenTime(at(14, 9)), "It's two oh nine in the afternoon.");
  assert.equal(spokenTime(at(2, 13)), "It's two thirteen in the morning.");
  assert.equal(spokenTime(at(22, 28)), "It's ten twenty-eight at night.");
  assert.equal(spokenTime(at(18, 45)), "It's six forty-five in the evening.");
  assert.equal(spokenTime(at(9, 0)), "It's nine o'clock in the morning.");
  assert.equal(spokenTime(at(0, 30)), "It's twelve thirty in the morning.");
  assert.equal(spokenTime(at(12, 30)), "It's twelve thirty in the afternoon.");
  assert.equal(spokenTime(at(11, 59)), "It's eleven fifty-nine in the morning.");
});

test("noon and midnight are said as words, not as twelve o'clock", () => {
  assert.equal(spokenTime(at(12, 0)), "It's twelve noon.");
  assert.equal(spokenTime(at(0, 0)), "It's midnight.");
});

test("every minute of the day comes out as words, with no digits for a voice to misread", () => {
  for (let minutes = 0; minutes < 24 * 60; minutes++) {
    const said = spokenTime(at(Math.floor(minutes / 60), minutes % 60));
    assert.doesNotMatch(said, /\d|undefined|\s{2}/, said);
  }
});

test("the date is said with an ordinal", () => {
  assert.equal(spokenDate(new Date(2026, 7, 6)), "It's Thursday, August sixth.");
  assert.equal(spokenDate(new Date(2026, 8, 23)), "It's Wednesday, September twenty-third.");
  assert.equal(spokenDate(new Date(2026, 11, 31)), "It's Thursday, December thirty-first.");
});

// ---------------------------------------------------------------------------
// Through think(), with Ollama and the weather services stubbed
// ---------------------------------------------------------------------------

const CONFIG = {
  provider: "ollama",
  ollama: { model: "stub-model", url: "http://127.0.0.1:11434" },
  location: { auto: false, city: "Testville", region: "NC", latitude: 35.9132, longitude: -79.0558 },
  units: { temperature: "fahrenheit", windSpeed: "mph" },
};

const FORECAST = {
  timezone: "America/New_York",
  current: { temperature_2m: 71.4, apparent_temperature: 70.2, relative_humidity_2m: 55, weather_code: 1, wind_speed_10m: 6.2 },
  daily: {
    time: ["2026-09-23", "2026-09-24", "2026-09-25"],
    weather_code: [1, 2, 3],
    temperature_2m_max: [78, 80, 75],
    temperature_2m_min: [58, 60, 59],
    precipitation_probability_max: [5, 10, 40],
  },
};

/** Ollama and the weather services, answering from fixtures. Records each chat request. */
function stubEverything(replies) {
  const chats = [];
  const real = globalThis.fetch;
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  globalThis.fetch = async (url, init) => {
    const where = String(url);
    if (where.endsWith("/api/show")) return ok({ capabilities: ["tools", "completion"] });
    if (where.endsWith("/api/chat")) {
      chats.push(JSON.parse(init.body));
      return ok({ message: replies[chats.length - 1] ?? { role: "assistant", content: "Done." } });
    }
    if (where.includes("air-quality-api.open-meteo.com")) return ok({ current: { us_aqi: 42, pm2_5: 8.1, time: "2026-09-23T12:00" } });
    if (where.includes("api.open-meteo.com")) return ok(FORECAST);
    if (where.includes("api.weather.gov")) return ok({ features: [] });
    throw new Error(`unexpected fetch to ${where}`);
  };
  return { chats, restore: () => { globalThis.fetch = real; } };
}

test("asking the time asks no model at all, and the answer is the clock's", async () => {
  const stub = stubEverything([]);
  try {
    await initBrain(CONFIG);
    const history = [];
    const said = [];
    const before = spokenTime(new Date());
    const turn = await think("what time is it", history, CONFIG, (text) => said.push(text));
    const after = spokenTime(new Date());

    assert.equal(stub.chats.length, 0, "no /api/chat request was made");
    assert.ok([before, after].includes(turn.reply), turn.reply);
    assert.deepEqual(said, [turn.reply]);
    assert.deepEqual(turn.usedTools, ["get_current_time"]);
    assert.deepEqual(turn.timing.map(([name]) => name), ["get_current_time"]);
    // Kept, so a follow-up has it in front of the model.
    assert.deepEqual(history.map((m) => m.role), ["user", "assistant"]);
    assert.equal(history[1].content, turn.reply);
  } finally {
    stub.restore();
  }
});

test("the welcome-back greeting still comes first, as a preface", async () => {
  const stub = stubEverything([]);
  try {
    await initBrain(CONFIG);
    const said = [];
    const turn = await think("what day is it", [], CONFIG, (text, opts) => said.push([text, opts?.preface ?? false]), 4 * 3600);
    assert.equal(said.length, 2);
    assert.equal(said[0][1], true, "the greeting is a preface");
    assert.equal(said[1][0], spokenDate(new Date()));
    assert.ok(turn.reply.startsWith(said[0][0]), "the transcript has what was said out loud");
  } finally {
    stub.restore();
  }
});

test("the weather is in front of the model before its first round, so one round phrases it", async () => {
  clearWeatherCache();
  clearAirCache();
  const stub = stubEverything([{ role: "assistant", content: "It's seventy-one and mostly clear." }]);
  try {
    await initBrain(CONFIG);
    const history = [];
    const turn = await think("what's the weather", history, CONFIG);

    assert.equal(stub.chats.length, 1, "one model round, not two");
    const sent = stub.chats[0].messages;
    const call = sent.find((m) => m.role === "assistant" && m.tool_calls?.length);
    assert.equal(call.tool_calls[0].function.name, "get_weather");
    const result = sent.find((m) => m.role === "tool");
    assert.equal(result.tool_name, "get_weather");
    assert.match(result.content, /71/, "the forecast itself, not an error");

    assert.equal(turn.reply, "It's seventy-one and mostly clear.");
    assert.deepEqual(turn.usedTools, ["get_weather"]);
    assert.deepEqual(turn.timing.map(([name]) => name), ["get_weather", "model"]);
    // The fetched JSON stays out of history, as a model-made call's does.
    assert.deepEqual(history.map((m) => m.role), ["user", "assistant"]);
  } finally {
    stub.restore();
  }
});

test("a weather question the shortcut does not recognise still goes the model's way", async () => {
  clearWeatherCache();
  clearAirCache();
  const stub = stubEverything([
    { role: "assistant", content: "", tool_calls: [{ function: { name: "get_weather", arguments: {} } }] },
    { role: "assistant", content: "Bring a jacket." },
  ]);
  try {
    await initBrain(CONFIG);
    const turn = await think("do I need a jacket", [], CONFIG);
    assert.equal(stub.chats.length, 2);
    assert.deepEqual(turn.timing.map(([name]) => name), ["model", "get_weather", "model"]);
  } finally {
    stub.restore();
  }
});
