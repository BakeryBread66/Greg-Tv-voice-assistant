// The tool registry: what the model is shown, and that every schema has a
// handler behind it.
//
// The schemas and the handlers used to be four hundred lines apart in
// brain.js — a 23-entry array and a 23-case switch — and nothing checked that
// they matched. Three tools were added in a single session. lib/tools/index.js
// now throws at import if they disagree, and these prove it stays that way.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TOOLS, runTool } from "../lib/tools/index.js";

// The exact set, in the exact order the model is shown them. Written out rather
// than derived, so a tool cannot appear or vanish without this file changing
// too — which is the point of a guard.
const EXPECTED = [
  "get_weather", "get_local_news", "look_at_screen", "take_screenshot",
  "play_music", "play_podcast", "whats_playing", "get_market", "control_playback",
  "set_personality", "get_personality", "set_persona", "set_vision", "set_gaming_mode",
  "set_channel", "get_current_time", "search_web", "read_page", "open_website",
  "recall_conversation", "remember_about_user", "forget_about_user", "explain_last_answer",
  "set_reminder", "list_reminders", "cancel_reminder", "get_engineering",
  "read_file",
];

test("the tool list is exactly what we think it is, in order", () => {
  assert.deepEqual(TOOLS.map((t) => t.name), EXPECTED);
});

test("every tool has a description and a parameter schema", () => {
  for (const tool of TOOLS) {
    assert.ok(tool.description?.length > 20, `${tool.name} needs a real description`);
    assert.equal(tool.parameters?.type, "object", `${tool.name} parameters`);
    assert.ok(Array.isArray(tool.parameters.required), `${tool.name} required[]`);
    for (const req of tool.parameters.required) {
      assert.ok(tool.parameters.properties?.[req], `${tool.name} requires "${req}" but does not define it`);
    }
  }
});

test("an unknown tool is an error, not a silent no-op", () => {
  assert.rejects(() => runTool("no_such_tool", {}, {}), /unknown tool/);
});

test("the schemas stay affordable", () => {
  // They are sent on EVERY turn, so this is a RATCHET rather than a target: it
  // should fail when somebody writes a schema at documentation length, which
  // this project has caught twice — set_channel alone reached ~265 tokens
  // before being trimmed to ~152.
  //
  // The unit is chars/4 over the JSON, which is a crude proxy: it counts
  // braces and quotes a real tokenizer would treat differently, so it reads
  // high. Measured at 3277 with 23 tools; the ceiling leaves room for a couple
  // more before anyone has to think about it again. Raise it deliberately, and
  // only after looking at what grew.
  const tokens = Math.round(JSON.stringify(TOOLS).length / 4);
  assert.ok(tokens < 3600, `tool schemas are ~${tokens} proxy-tokens per turn, up from 3277 — check what grew`);
});

// Which tools change something in the world, and the words that cover each one
// in the honesty rule. The rule is prose — "Setting a timer" rather than
// "set_reminder" — so the link has to be written down somewhere, and here is
// the only place it can fail loudly.
// `open_` was added when open_website was, and the gap it closed is the exact
// one this guard has always been documented as having: it reads the naming
// convention, so a state-changing tool named unconventionally slips straight
// past the default-deny and is never checked at all. open_website did — the
// suite went green on a tool that changes the world, and only the token budget
// failing gave it away. Any new verb that writes state belongs in this pattern
// in the same change that introduces it.
const WRITES = /^(set_|play_|cancel_|remember_|forget_|take_|control_|open_)/;
const COVERED = {
  set_reminder: "setting a timer",
  cancel_reminder: "cancelling one",
  remember_about_user: "saving or forgetting a fact",
  forget_about_user: "saving or forgetting a fact",
  take_screenshot: "taking a screenshot",
  play_music: "playing or pausing music",
  play_podcast: "podcast",
  control_playback: "playing or pausing",
  set_personality: "personality settings",
  set_persona: "becoming a different character",
  set_vision: "turning your eyes on or off",
  set_gaming_mode: "gaming mode",
  set_channel: "what is on your screen",
  open_website: "opening a website",
};

test("every tool that changes something is named in the honesty rule", async () => {
  // The rule is what stops Greg announcing an action he never took — "I've
  // filed that away; you are now addressed as boss", with set_personality never
  // called and the setting untouched. It has caught four features and been
  // forgotten three times, because keeping it current depended on somebody
  // reading a note. This checks instead.
  //
  // Default-deny is the whole design: a NEW state-changing tool has no entry in
  // COVERED, so it fails here until someone adds it to the rule.
  const { buildSystemPrompt } = await import("../lib/brain.js");
  const rule = buildSystemPrompt({}, {}).split("\n").find((line) => line.includes("actions, not answers")) ?? "";
  assert.ok(rule, "the honesty rule has been reworded or removed — find it before trusting this test");

  for (const { name } of TOOLS.filter((t) => WRITES.test(t.name))) {
    const phrase = COVERED[name];
    assert.ok(phrase, `${name} changes something: name it in the honesty rule in lib/brain.js, then add it to COVERED here`);
    assert.ok(rule.toLowerCase().includes(phrase), `the honesty rule no longer covers ${name} — it lost the words "${phrase}"`);
  }
});

test("set_channel's description is derived from the channel list", async () => {
  // It interpolates CHANNELS, so a channel added without touching brain.js
  // still reaches the model. If this breaks, new channels are invisible to it.
  const { CHANNELS } = await import("../lib/channels.js");
  const setChannel = TOOLS.find((t) => t.name === "set_channel");
  for (const channel of CHANNELS) {
    assert.ok(setChannel.description.includes(channel.name), `set_channel should mention ${channel.name}`);
  }
});

// ---------------------------------------------------------------------------
// A playback request that Spotify refuses
//
// The two pre-flight checks in play_music are worded as flat failures, because
// a soft error gets relayed to the user as success — the model reads a
// consolation as guidance rather than as the action not happening. The RUNTIME
// path returned the bare message instead, and that is exactly where the two
// commonest real failures land: a free account (403) and no running Spotify
// (404). The weakest wording was on the likeliest faults.
// ---------------------------------------------------------------------------

import { playbackFailure } from "../lib/tools/music.js";

test("a refused playback request is stated as a failure, not a suggestion", () => {
  const premium = playbackFailure("Spotify refused that — controlling playback needs a Premium account");
  // The prefix is what made the model report failure rather than success.
  assert.match(premium.error, /^NOTHING IS PLAYING\./);
  assert.match(premium.error, /no music was started/);
});

test("the two likely causes each carry a remedy the user can act on", () => {
  const premium = playbackFailure("controlling playback needs a Premium account");
  assert.match(premium.tell_the_user, /Premium/);
  // Saying what still works matters: pause and skip need no account at all.
  assert.match(premium.tell_the_user, /pause|skip/i);

  const device = playbackFailure("no active Spotify device — open Spotify and play something first");
  assert.match(device.tell_the_user, /open/i);
});

test("the remedy lives apart from the error, so it cannot be read as success", () => {
  const premium = playbackFailure("needs a Premium account");
  assert.ok(!/still work/i.test(premium.error), "consolation must not sit inside the failure");
});

test("an unrecognised failure still reads as a failure", () => {
  const odd = playbackFailure("something nobody has seen before");
  assert.match(odd.error, /^NOTHING IS PLAYING\./);
  assert.equal(odd.tell_the_user, undefined, "no invented remedy for an unknown cause");
});

test("a missing message does not produce a sentence with a hole in it", () => {
  for (const bad of [undefined, null, ""]) {
    const r = playbackFailure(bad);
    assert.match(r.error, /^NOTHING IS PLAYING\./);
    assert.doesNotMatch(r.error, /undefined|null|\.\s*,/);
  }
});

// ---------------------------------------------------------------------------
// Opening a website
//
// The model never handles a URL. It names a site and the URL is built in code,
// which makes the dangerous case unreachable rather than discouraged: URLs
// reach a model from search results and fetched pages, and opening one puts it
// in a browser carrying the user's real sessions. Reading a hostile link costs
// a bad answer; opening one costs rather more.
// ---------------------------------------------------------------------------

import { siteUrl, SITE_NAMES } from "../lib/websites.js";

test("a named site resolves to its own front page", () => {
  const yt = siteUrl("youtube");
  assert.equal(yt.url, "https://www.youtube.com");
  assert.equal(yt.searched, false);
});

test("search words go to that site's own search, encoded", () => {
  const yt = siteUrl("youtube", "how to poach an egg");
  assert.match(yt.url, /^https:\/\/www\.youtube\.com\/results\?search_query=/);
  assert.match(yt.url, /how%20to%20poach%20an%20egg|how\+to\+poach\+an\+egg/);
  assert.equal(yt.searched, true);
});

test("a site name is matched the way somebody would say it", () => {
  // Nobody says "you tube" the same way twice, and the model is no better.
  for (const said of ["YouTube", "youtube", "You Tube", "you-tube", "YOUTUBE"]) {
    assert.equal(siteUrl(said)?.url, "https://www.youtube.com", said);
  }
});

test("an unknown site is refused, never substituted", () => {
  // Quietly opening something else would put the substitution in a browser.
  for (const bad of ["evil.example.com", "https://evil.example.com", "", null, undefined, "faceboook"]) {
    assert.equal(siteUrl(bad), null, String(bad));
  }
});

test("a URL cannot be smuggled in through the search words", () => {
  // The words are encoded into a query string, so they cannot become a host.
  const out = siteUrl("google", "https://evil.example.com");
  assert.match(out.url, /^https:\/\/www\.google\.com\/search\?q=/);
  assert.doesNotMatch(out.url.replace(/^https:\/\/www\.google\.com\/search\?q=/, ""), /^https?:\/\//);
});

test("every listed site is reachable and https", () => {
  for (const name of SITE_NAMES) {
    const r = siteUrl(name);
    assert.ok(r, `${name} should resolve`);
    assert.match(r.url, /^https:\/\//, `${name} must be https`);
  }
});
