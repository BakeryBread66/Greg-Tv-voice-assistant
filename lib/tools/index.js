// Every tool Greg has, and the one place they are dispatched from.
//
// Each file in this folder exports an array of `{ name, description,
// parameters, run }` — the schema the model is shown and the handler that runs
// it, TOGETHER. They used to be four hundred lines apart in lib/brain.js: a
// 23-entry array near the top and a 23-case switch near the bottom, with
// nothing to stop the two drifting as tools were added. Three were added in one
// session.
//
// Adding a tool is now: write it in the right file, and — if it CHANGES
// SOMETHING IN THE WORLD — add it to the honesty sentence in the system prompt.
// That second step is not optional and this project has forgotten it four
// times; see CLAUDE.md, which reads that list as a checklist rather than an
// anecdote.

import { weather } from "./weather.js";
import { news } from "./news.js";
import { screen } from "./screen.js";
import { music } from "./music.js";
import { market } from "./market.js";
import { personality } from "./personality.js";
import { power } from "./power.js";
import { channels } from "./channels.js";
import { time } from "./time.js";
import { web } from "./web.js";
import { memory } from "./memory.js";
import { reminders } from "./reminders.js";
import { engineering } from "./engineering.js";
import { files } from "./files.js";

// The ORDER matters and is preserved exactly as it was declared in brain.js.
// It is the order the model is shown the tools in, and while it should not
// change behaviour, "should not" is not a measurement — so the refactor holds
// it constant rather than betting on it.
const ALL = [
  ...weather,
  ...news,
  ...screen,
  ...music,
  ...personality,
  ...power,
  ...channels,
  ...time,
  ...web,
  ...memory,
  ...reminders,
  ...market,
  ...engineering,
  ...files,
];

const ORDER = [
  "get_weather", "get_local_news", "look_at_screen", "take_screenshot",
  "play_music", "play_podcast", "whats_playing", "get_market", "control_playback",
  "set_personality", "get_personality", "set_persona", "set_vision", "set_gaming_mode",
  "set_channel", "get_current_time", "search_web", "read_page", "open_website",
  "recall_conversation", "remember_about_user", "forget_about_user", "explain_last_answer",
  "set_reminder", "list_reminders", "cancel_reminder", "get_engineering",
  "read_file",
];

const byName = new Map(ALL.map((tool) => [tool.name, tool]));

// Fail loudly at startup rather than quietly serving a short list. A tool that
// silently vanishes from the schema is a capability Greg stops having with no
// error anywhere — the same class of failure as the vision model that reports
// sight it does not have.
for (const name of ORDER) {
  if (!byName.has(name)) throw new Error(`tool "${name}" is in the order but no file defines it`);
}
for (const tool of ALL) {
  if (!ORDER.includes(tool.name)) throw new Error(`tool "${tool.name}" is defined but missing from ORDER`);
  if (typeof tool.run !== "function") throw new Error(`tool "${tool.name}" has no handler`);
}

/** The schemas, in declaration order — this is what the model is shown. */
export const TOOLS = ORDER.map((name) => {
  const { name: n, description, parameters } = byName.get(name);
  return { name: n, description, parameters };
});

/**
 * Run one tool.
 *
 * `ctx` carries the things a handler needs from the brain and cannot import for
 * itself: the config, the live provider (only the screen tool uses it) and
 * resolvePlace, which turns "Tokyo" into coordinates.
 */
export async function runTool(name, input, ctx) {
  const tool = byName.get(name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  return tool.run(input ?? {}, ctx);
}
