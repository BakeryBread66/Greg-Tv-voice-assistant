// Why the first weather question was slow, and the changes that answer it.
//
// Measured from his own conversation log before any of this: weather turns
// took a median 5.0 s against 2.2 s for asking the time - the same one tool call
// with no network in it - and the FIRST question of a session took 12 to 50 s.
// Three things were paid for serially on every weather answer: a fresh
// Open-Meteo request, a warning check when the watch had not looked yet (with a
// twelve-second timeout), and a fresh air-quality request.
//
// Nothing here touches the network or a model: fetch is stubbed, and every
// timing assertion is relative, so a slow machine cannot turn it red.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getWeather, clearWeatherCache, FORECAST_TTL_MS } from "../lib/weather.js";
import { getAirQuality, clearAirCache } from "../lib/airquality.js";
import { withinMs } from "../lib/deadline.js";
import { checkWarnings } from "../lib/tools/weather.js";
import { runTool } from "../lib/tools/index.js";
import { describeTiming, initBrain, think } from "../lib/brain.js";
import { initConversationLog, logTurn } from "../lib/conversation-log.js";

const CONFIG = {
  provider: "ollama",
  ollama: { model: "stub-model", url: "http://127.0.0.1:11434" },
  location: { auto: false, city: "Testville", region: "NC", latitude: 35.9132, longitude: -79.0558 },
  units: { temperature: "fahrenheit", windSpeed: "mph" },
};

const DAYS = ["2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29"];
const FORECAST = {
  timezone: "America/New_York",
  current: { temperature_2m: 71.4, apparent_temperature: 70.2, relative_humidity_2m: 55, weather_code: 1, wind_speed_10m: 6.2 },
  daily: {
    time: DAYS,
    weather_code: [1, 2, 3, 61, 0, 0, 1],
    temperature_2m_max: [78, 80, 75, 70, 72, 74, 76],
    temperature_2m_min: [58, 60, 59, 55, 54, 56, 57],
    precipitation_probability_max: [5, 10, 40, 80, 0, 0, 5],
  },
};
const AIR = { current: { us_aqi: 42, pm2_5: 8.1, time: "2026-09-23T12:00" } };

/**
 * Stand in for the three services. `delays` holds how long each takes, in ms,
 * and Infinity for one that never answers. Counts every request made.
 */
function stubServices({ forecast = 0, air = 0, nws = 0, failForecastOnce = false } = {}) {
  const calls = { forecast: 0, air: 0, nws: 0 };
  let failed = false;
  const answer = (ms, body, ok = true) =>
    new Promise((resolve) => {
      if (ms === Infinity) return; // never
      setTimeout(() => resolve({ ok, status: ok ? 200 : 503, json: async () => body }), ms);
    });
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const where = String(url);
    if (where.includes("air-quality-api.open-meteo.com")) { calls.air++; return answer(air, AIR); }
    if (where.includes("api.open-meteo.com")) {
      calls.forecast++;
      if (failForecastOnce && !failed) { failed = true; return answer(0, {}, false); }
      return answer(forecast, FORECAST);
    }
    if (where.includes("api.weather.gov")) { calls.nws++; return answer(nws, { features: [] }); }
    throw new Error(`unexpected fetch to ${where}`);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

function fresh() {
  clearWeatherCache();
  clearAirCache();
}

// ---------------------------------------------------------------------------
// The forecast cache
// ---------------------------------------------------------------------------

test("a second weather question inside ten minutes makes no second request", async () => {
  fresh();
  const s = stubServices();
  try {
    await getWeather(CONFIG, { days: 3 });
    await getWeather(CONFIG, { days: 1 });
    await getWeather(CONFIG, { days: 7 });
    assert.equal(s.calls.forecast, 1, "one request serves three questions and any number of days");
  } finally {
    s.restore();
  }
});

test("the days asked for are what come back, whatever was fetched", async () => {
  fresh();
  const s = stubServices();
  try {
    assert.equal((await getWeather(CONFIG, { days: 1 })).forecast.length, 1);
    assert.equal((await getWeather(CONFIG, { days: 3 })).forecast.length, 3);
    assert.equal((await getWeather(CONFIG, { days: 99 })).forecast.length, 7);
    // Absence is not zero: these get the default of three, not an empty forecast.
    for (const days of [undefined, null, "", "soon"]) {
      assert.equal((await getWeather(CONFIG, { days })).forecast.length, 3, JSON.stringify(days));
    }
  } finally {
    s.restore();
  }
});

test("a question asked while the startup prefetch is in flight shares it", async () => {
  fresh();
  const s = stubServices({ forecast: 50 });
  try {
    const [a, b] = await Promise.all([getWeather(CONFIG), getWeather(CONFIG)]);
    assert.equal(s.calls.forecast, 1);
    assert.equal(a.now.temperature, b.now.temperature);
  } finally {
    s.restore();
  }
});

test("a failed request is not cached, so the next question tries again", async () => {
  fresh();
  const s = stubServices({ failForecastOnce: true });
  try {
    await assert.rejects(() => getWeather(CONFIG), /503/);
    const ok = await getWeather(CONFIG);
    assert.equal(ok.now.temperature, "71°F");
    assert.equal(s.calls.forecast, 2);
  } finally {
    s.restore();
  }
});

test("after ten minutes it asks again", async () => {
  fresh();
  const s = stubServices();
  const realNow = Date.now;
  try {
    await getWeather(CONFIG);
    Date.now = () => realNow() + FORECAST_TTL_MS + 1000;
    await getWeather(CONFIG);
    assert.equal(s.calls.forecast, 2);
  } finally {
    Date.now = realNow;
    s.restore();
  }
});

test("different units are a different answer, not a cache hit", async () => {
  fresh();
  const s = stubServices();
  try {
    await getWeather(CONFIG);
    await getWeather({ ...CONFIG, units: { temperature: "celsius", windSpeed: "kmh" } });
    assert.equal(s.calls.forecast, 2);
  } finally {
    s.restore();
  }
});

test("the air is cached the same way", async () => {
  fresh();
  const s = stubServices();
  try {
    await getAirQuality(CONFIG);
    await getAirQuality(CONFIG);
    assert.equal(s.calls.air, 1);
  } finally {
    s.restore();
  }
});

// ---------------------------------------------------------------------------
// The tool: three services at once, and the extras bounded
// ---------------------------------------------------------------------------

test("the weather tool waits for the slowest service, not the sum of all three", async () => {
  fresh();
  // Each takes 300 ms. One after another that is 900; at once, about 300.
  const s = stubServices({ forecast: 300, air: 300, nws: 300 });
  try {
    const started = Date.now();
    const result = await runTool("get_weather", {}, { config: CONFIG, resolvePlace: async () => null });
    const took = Date.now() - started;
    assert.ok(took < 750, `took ${took} ms - the three requests are still running one after another`);
    assert.equal(result.airQuality.index, 42);
    assert.equal(result.warningsNote, "Checked just now: no weather warnings are in force here.");
    assert.equal(s.calls.nws, 1, "the watch had not looked, so the tool did");
  } finally {
    s.restore();
  }
});

test("a warning service that never answers costs a bounded wait, and is SAID", async () => {
  const s = stubServices({ nws: Infinity });
  try {
    const started = Date.now();
    const verdict = await checkWarnings(CONFIG, { waitMs: 60 });
    assert.ok(Date.now() - started < 1000);
    assert.equal(verdict.known, false, "not checked must not read as none");
    assert.notEqual(verdict.covered, false, "a timeout says nothing about coverage");
  } finally {
    s.restore();
  }
});

test("withinMs passes a quick answer through and times out a slow one", async () => {
  assert.equal(await withinMs(Promise.resolve(7), 50), 7);
  await assert.rejects(() => withinMs(new Promise(() => {}), 20, "the test"), (err) => err.timedOut === true && /the test/.test(err.message));
  await assert.rejects(() => withinMs(Promise.reject(new Error("boom")), 50), /boom/);
});

// ---------------------------------------------------------------------------
// Where the time went
// ---------------------------------------------------------------------------

test("the timing line names each step in order", () => {
  assert.equal(
    describeTiming([["model", 1900], ["get_weather", 420], ["model", 2150]]),
    "model 1.9s > get_weather 0.4s > model 2.1s"
  );
  assert.equal(describeTiming([]), "");
  assert.equal(describeTiming(null), "");
  assert.equal(describeTiming([["model", null]]), "model 0.0s");
});

test("think() reports each model round and each tool call", async () => {
  const real = globalThis.fetch;
  let chats = 0;
  globalThis.fetch = async (url) => {
    const where = String(url);
    if (where.endsWith("/api/show")) return { ok: true, json: async () => ({ capabilities: ["tools", "completion"] }) };
    if (where.endsWith("/api/chat")) {
      chats++;
      const message = chats === 1
        ? { role: "assistant", content: "", tool_calls: [{ function: { name: "get_current_time", arguments: {} } }] }
        : { role: "assistant", content: "It is noon." };
      return { ok: true, json: async () => ({ message }) };
    }
    throw new Error(`unexpected fetch to ${where}`);
  };
  try {
    await initBrain(CONFIG);
    // Not "what time is it": that one is answered without a model now (see
    // test/quick.test.js), and this test is about the model's rounds.
    const { timing } = await think("is it lunchtime yet", [], CONFIG);
    assert.deepEqual(timing.map(([name]) => name), ["model", "get_current_time", "model"]);
    assert.ok(timing.every(([, ms]) => Number.isFinite(ms) && ms >= 0));
  } finally {
    globalThis.fetch = real;
  }
});

test("the log keeps the timing - numbers only - and leaves it out when there is none", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "greg-speed-")), "conversations.jsonl");
  initConversationLog({ conversationLog: { file } });
  logTurn({ user: "what's the weather", reply: "Sunny.", usedTools: ["get_weather"], ms: 2500, firstMs: 1800, timing: [["model", 1200], ["get_weather", 300], ["model", 1000]] });
  logTurn({ user: "hello", reply: "Hi.", ms: 900 });
  const [first, second] = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(first.firstMs, 1800);
  assert.deepEqual(first.steps, [["model", 1200], ["get_weather", 300], ["model", 1000]]);
  assert.equal(second.steps, undefined);
  assert.equal(second.firstMs, undefined);
});
