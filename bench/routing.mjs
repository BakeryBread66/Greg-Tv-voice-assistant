// Does adding tools cost routing accuracy, and where does it start?
//
//   node bench/routing.mjs           the sweep, then the control
//   node bench/routing.mjs 5         5 runs per prompt instead of 3
//   node bench/routing.mjs 3 --skip-control    (don't)
//
// NOT part of `npm test`, on purpose. It needs Ollama and takes minutes, and
// this project has twice had its suite wrecked by a test that did real work —
// once restarting a Piper sidecar, once loading a 4 GB clone model. Run it
// deliberately when the budget question comes up, the way grab-window.ps1 is a
// tool rather than a test.
//
// WHY IT EXISTS. The ratchet in test/tools.test.js is a ratchet, not a measured
// cliff: it locked in a passing state at 3,277 proxy-tokens with 23 tools. It
// cannot answer the question that actually matters — at what point does the
// model stop picking the right tool? Every feature proposal was being costed
// against a number nobody had checked.
//
// THE CONTROL THAT MAKES THE SWEEP MEAN ANYTHING. Descriptions are held fixed:
// real tools are untouched and padding is only ever ADDED, so the only variable
// is count. The only other routing data in this project measured *phrasing*
// (8/10 at 265 tokens, 6/10 at 113, 9/10 at 152), so wording is known to move
// the result by 30 points. Varying both would measure both and settle neither.
//
// AND THE SWEEP CAME BACK 126/126, WHICH IS WHY THE CONTROL RUNS BY DEFAULT.
// A perfect score is either a real result or an instrument that cannot register
// a miss, and a test that has never failed is not evidence of anything. The
// control re-runs the battery against padding built to genuinely compete. If it
// also scores 100%, the harness is broken and the sweep is void. You should not
// be able to get a number out of this file without also getting proof the
// number means something.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createOllamaProvider } from "../lib/providers/ollama.js";
import { TOOLS } from "../lib/tools/index.js";
import { buildSystemPrompt } from "../lib/brain.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const provider = createOllamaProvider(config);

const PLACE = "Chapel Hill, North Carolina";
const RUNS = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 3);
const SKIP_CONTROL = process.argv.includes("--skip-control");

// ---------------------------------------------------------------------------
// The battery. Every prompt has ONE defensible answer.
//
// The first three are the documented alias traps. "What is the NASDAQ at" and
// "what's playing" both used to CHANGE CHANNEL instead of answering, and
// get_engineering was given its own tool specifically so "how hot is my GPU"
// would not. They are the likeliest to break under pressure, which is exactly
// why they are at the top.
// ---------------------------------------------------------------------------
const BATTERY = [
  ["what is the nasdaq at",                 "get_market"],
  ["what's playing right now",              "whats_playing"],
  ["how hot is my gpu",                     "get_engineering"],
  ["what's the weather like",               "get_weather"],
  ["what time is it",                       "get_current_time"],
  ["remind me to call mum at six",          "set_reminder"],
  ["what reminders do i have",              "list_reminders"],
  ["put the weather channel on",            "set_channel"],
  ["what's on my screen",                   "look_at_screen"],
  ["take a screenshot of my desktop",       "take_screenshot"],
  ["search the web for who won the euros",  "search_web"],
  ["what did we talk about yesterday",      "recall_conversation"],
  ["remember that i'm allergic to peanuts", "remember_about_user"],
  ["skip this song",                        "control_playback"],
];

// Padding for the SWEEP: plausible tools a voice assistant might grow, in
// domains the battery never asks about.
//
// The calibration matters and is the easiest thing to get wrong. Obvious junk
// is trivially ignored and would UNDER-state the effect; anything overlapping a
// battery answer competes legitimately and would OVER-state it. So: nothing
// here touches weather, time, media, reminders, channels, screen, search,
// memory or hardware. Sized near the real tools' ~128 proxy-token average.
const NEUTRAL = [
  ["convert_units", "Convert a quantity from one unit to another. Handles length, mass, volume, temperature and area.",
    { value: ["number", "The quantity to convert."], from: ["string", "The unit to convert from, e.g. miles."], to: ["string", "The unit to convert to, e.g. kilometres."] }],
  ["convert_currency", "Convert an amount between two currencies at today's rate.",
    { amount: ["number", "How much to convert."], from: ["string", "Three-letter code to convert from."], to: ["string", "Three-letter code to convert to."] }],
  ["translate_text", "Translate a phrase into another language and say it back.",
    { text: ["string", "The words to translate."], language: ["string", "The language to translate into."] }],
  ["define_word", "Look up what a word means, and how it is pronounced.",
    { word: ["string", "The word to define."], sense: ["string", "Optional: which sense."] }],
  ["calculate", "Work out an arithmetic expression and give the result.",
    { expression: ["string", "The sum to work out, e.g. 18 percent of 64."] }],
  ["get_sports_scores", "The latest score or result for a team or competition.",
    { team: ["string", "The team or competition."], when: ["string", "Optional: today, yesterday, or a date."] }],
  ["track_parcel", "Where a parcel has got to, from its tracking number.",
    { tracking: ["string", "The tracking number."], carrier: ["string", "Optional: the delivery company."] }],
  ["find_recipe", "Find something to cook from ingredients or a dish name.",
    { dish: ["string", "The dish, or ingredients to use up."], servings: ["number", "Optional: how many people."] }],
  ["plant_care", "How to look after a houseplant — watering, light and feeding.",
    { plant: ["string", "The plant's common or botanical name."] }],
  ["get_bus_times", "The next departures from a bus stop or station.",
    { stop: ["string", "The stop or station name."], route: ["string", "Optional: a route number."] }],
  ["spell_word", "Spell a word out letter by letter.",
    { word: ["string", "The word to spell."] }],
  ["roll_dice", "Roll dice, or pick a random number in a range.",
    { sides: ["number", "How many sides each die has."], count: ["number", "Optional: how many dice."] }],
  ["get_holidays", "Public holidays coming up in a country.",
    { country: ["string", "The country to look up."], year: ["number", "Optional: which year."] }],
  ["describe_colour", "What a colour looks like, and what mixes to make it.",
    { colour: ["string", "The colour name or hex value."] }],
];

// Padding for the CONTROL: each one deliberately shadows a real tool the
// battery asks for. This is what genuine competition looks like — not junk, and
// not a different domain.
const CONFUSABLE = [
  ["get_stock_price", "Look up the current price or level of a stock, index or market.",
    { symbol: ["string", "The ticker or index to look up."] }],
  ["get_current_track", "What song or media is playing on this machine right now.",
    { source: ["string", "Optional: which player to ask."] }],
  ["get_hardware_temps", "Temperatures and load for the GPU, CPU and memory on this PC.",
    { component: ["string", "Optional: gpu, cpu or memory."] }],
  ["get_forecast", "The current conditions and forecast for a place.",
    { place: ["string", "Optional: the place to look up."] }],
  ["get_clock", "The time right now, and the date.",
    { timezone: ["string", "Optional: which timezone."] }],
  ["schedule_alarm", "Set an alarm or a reminder for a time later today or on a date.",
    { at: ["string", "When it should go off."], label: ["string", "What it is for."] }],
  ["capture_display", "Look at what is shown on the user's monitor and describe it.",
    { display: ["string", "Optional: which monitor."] }],
];

const padTool = ([name, description, props]) => ({
  name,
  description,
  parameters: {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(props).map(([k, [type, d]]) => [k, { type, description: d }])
    ),
    required: [Object.keys(props)[0]],
  },
});

const cost = (tools) => Math.round(JSON.stringify(tools).length / 4);

async function ask(prompt, tools) {
  const started = Date.now();
  const { toolCalls } = await provider.complete({
    system: buildSystemPrompt(config, PLACE, prompt),
    messages: [{ role: "user", content: prompt }],
    tools,
  });
  return { called: toolCalls.map((c) => c.name), ms: Date.now() - started };
}

/**
 * Counted correct if the right tool was called AT ALL. Calling the right one
 * plus a spurious extra is a milder failure than calling the wrong one, and
 * collapsing the two would hide which is happening — so misses are printed with
 * what was actually called.
 */
async function score(battery, tools, runs) {
  let hits = 0, total = 0, ms = 0;
  const misses = [];
  const perPrompt = new Map();

  for (const [prompt, expected] of battery) {
    const got = [];
    for (let run = 0; run < runs; run++) {
      try {
        const { called, ms: took } = await ask(prompt, tools);
        got.push(called.join("+") || "(none)");
        if (called.includes(expected)) hits++;
        else misses.push({ prompt, expected, got: called.join("+") || "(none)" });
        total++; ms += took;
      } catch (err) {
        got.push(`ERR`);
        misses.push({ prompt, expected, got: `error: ${err.message.slice(0, 40)}` });
        total++;
      }
      process.stdout.write(".");
    }
    perPrompt.set(prompt, { hits: got.filter((g) => g.split("+").includes(expected)).length, got: [...new Set(got)] });
  }
  return { hits, total, misses, perPrompt, avgMs: Math.round(ms / total) };
}

// ---------------------------------------------------------------------------

if (!(await provider.ready())) {
  console.error("Ollama is not answering. Start it and try again — this bench needs a real model.");
  process.exit(1);
}

const CONDITIONS = [
  { label: `${TOOLS.length} (today)`, tools: TOOLS },
  { label: `${TOOLS.length + 7} (+7)`, tools: [...TOOLS, ...NEUTRAL.slice(0, 7).map(padTool)] },
  { label: `${TOOLS.length + 14} (+14)`, tools: [...TOOLS, ...NEUTRAL.map(padTool)] },
];

console.log(`model ${config.ollama?.model} · ${BATTERY.length} prompts × ${RUNS} runs × ${CONDITIONS.length} conditions`);
console.log(`${BATTERY.length * RUNS * CONDITIONS.length} calls, plus the control\n`);

for (const c of CONDITIONS) {
  process.stdout.write(`${c.label.padEnd(12)} ${String(cost(c.tools)).padStart(5)} tk  `);
  c.result = await score(BATTERY, c.tools, RUNS);
  const { hits, total, avgMs } = c.result;
  console.log(`  ${hits}/${total} (${((hits / total) * 100).toFixed(0)}%)  avg ${avgMs} ms`);
}

console.log("\n--- per prompt ---");
console.log(`${"".padEnd(40)}${CONDITIONS.map((c) => c.label.padEnd(12)).join("")}`);
for (const [prompt] of BATTERY) {
  const cells = CONDITIONS.map((c) => `${c.result.perPrompt.get(prompt).hits}/${RUNS}`.padEnd(12)).join("");
  console.log(`${prompt.slice(0, 38).padEnd(40)}${cells}`);
}

const allMisses = CONDITIONS.flatMap((c) => c.result.misses.map((m) => ({ ...m, at: c.label })));
console.log("\n--- misses ---");
if (!allMisses.length) console.log("  none at any tool count");
for (const m of allMisses) console.log(`  ${m.at.padEnd(12)} "${m.prompt}" wanted ${m.expected}, got ${m.got}`);

if (SKIP_CONTROL) {
  console.log("\nControl skipped. The numbers above are unvalidated — see the header.");
  process.exit(0);
}

// ---- The control ----------------------------------------------------------
const controlBattery = BATTERY.slice(0, 7);
const controlTools = [...TOOLS, ...CONFUSABLE.map(padTool)];
console.log(`\n--- control: ${TOOLS.length} real + ${CONFUSABLE.length} deliberately confusable, ${cost(controlTools)} tk ---`);
process.stdout.write("  ");
const control = await score(controlBattery, controlTools, RUNS);
console.log(`  ${control.hits}/${control.total} (${((control.hits / control.total) * 100).toFixed(0)}%)`);

for (const [prompt, expected] of controlBattery) {
  const p = control.perPrompt.get(prompt);
  console.log(`  ${p.hits}/${RUNS}  ${prompt.slice(0, 32).padEnd(34)} wanted ${expected.padEnd(19)} got ${p.got.join(" | ")}`);
}

const clean = control.hits === control.total;
console.log(clean
  ? "\n  100% AGAIN — the harness cannot register a miss, so the sweep above is VOID.\n  Fix the harness before believing any of it."
  : "\n  The control dropped, so the harness can see a miss and the sweep is real.");
process.exit(clean ? 1 : 0);
