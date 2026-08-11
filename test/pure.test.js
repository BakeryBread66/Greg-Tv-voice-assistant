// The functions that can be proven without a microphone, a model or a network.
//
// This file exists because the same batteries kept being written and thrown
// away. Across three sessions, `resolveChannel`, `skyFrom`, `adviceRule`,
// `parseClockTime`, `speakable` and the rest were each checked ad hoc, the
// result pasted into a commit message, and the test deleted — so the next
// session had no way to know any of it still held.
//
// Everything here is a pure function reachable from Node. Nothing in it starts
// a server, opens a socket or needs the GPU:
//
//     npm test
//
// If you add a pure function that decides something — especially one standing in
// for a prompt instruction, which this project does constantly — add it here.
// A code gate with no test is a prompt instruction with extra steps.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { resolveChannel, CHANNELS, setChannel, turnKnob } from "../lib/channels.js";
import { skyFrom } from "../lib/nws.js";
import { adviceRule, spokenPercent } from "../lib/stocks.js";
import { parseClockTime } from "../lib/reminders.js";
import { reminderWasClaimedNotSet, appendSentence } from "../lib/brain.js";
import { speakable } from "../lib/tts.js";
import { trendOf, auroraFor } from "../lib/spacewx.js";
import { distanceKm, bearing, compassOf } from "../lib/overhead.js";
import { wrapChars, ellipsizeChars } from "../public/channels/ceefax.js";
import { greetingFor } from "../lib/presence.js";
import { TRAITS } from "../lib/personality.js";
import { selfInShot, setWindowRect, getWindowRect } from "../lib/screen.js";
import { deviceLines, tagline } from "../public/boot.js";
import { mixFor } from "../public/vocoder.js";
import { pickToRead, yearsIn, looksLikeListicle, wantsOneAnswer } from "../lib/ranking.js";
import {
  pageDates, freshnessOf, freshnessWanted, shouldTrySecond,
  describeAge, spokenDate, STALE_DAYS, mentionsDate, staleSourceIn, stalenessCaveat,
} from "../lib/freshness.js";

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

test("resolveChannel: numbers, bare and after 'channel'", () => {
  assert.equal(resolveChannel("1")?.id, "testcard");
  assert.equal(resolveChannel("channel two")?.number, 2);
  assert.equal(resolveChannel("channel 4")?.number, 4);
  assert.equal(resolveChannel("switch to channel eight")?.number, 8);
  assert.equal(resolveChannel("ch 7")?.number, 7);
  // Ten and above: the word map used to stop at nine.
  assert.equal(resolveChannel("channel ten")?.number, 10);
  assert.equal(resolveChannel("ten")?.number, 10);
});

test("resolveChannel: a number inside a sentence is NOT a channel", () => {
  // This was a real latent bug. Numbers only count bare or after "channel",
  // otherwise "set a timer for nine minutes" lands on channel 9.
  assert.equal(resolveChannel("set a timer for nine minutes"), null);
  assert.equal(resolveChannel("set a timer for ten minutes"), null);
  assert.equal(resolveChannel("remind me in five minutes"), null);
  assert.equal(resolveChannel("wake me at seven"), null);
  assert.equal(resolveChannel("channel ninety"), null);
});

test("resolveChannel: names and the phrasings people actually use", () => {
  const cases = [
    ["go back to the test card", "testcard"], ["your face", "testcard"], ["the usual", "testcard"],
    ["put the album art up", "nowplaying"], ["show me the music", "nowplaying"],
    ["put teletext on", "ceefax"], ["the news channel", "ceefax"],
    ["put the weather on", "weather"], ["show me the forecast", "weather"],
    ["sky at night", "apod"], ["picture of the day", "apod"], ["put nasa on", "apod"],
    ["northern lights", "spacewx"], ["the k index", "spacewx"],
    ["weather radar", "radar"], ["show me the rain radar", "radar"],
    ["nasdaq", "stocks"], ["stock ticker", "stocks"],
    ["planes", "flights"], ["what is flying overhead", "flights"],
    ["my schedule", "agenda"], ["what's coming up", "agenda"],
  ];
  for (const [said, id] of cases) assert.equal(resolveChannel(said)?.id, id, said);
});

test("resolveChannel: longest alias wins, so 'space weather' beats 'space' and 'weather'", () => {
  assert.equal(resolveChannel("put space weather on")?.id, "spacewx");
  assert.equal(resolveChannel("switch to space")?.id, "apod");
  assert.equal(resolveChannel("the weather channel")?.id, "weather");
});

test("resolveChannel: nothing matches nothing", () => {
  for (const said of ["is it sunny outside", "tell me a joke", "what time is it", "", null, undefined]) {
    assert.equal(resolveChannel(said), null, JSON.stringify(said));
  }
});

test("the dial wraps both ways and back undoes forward", () => {
  const n = CHANNELS.length;
  setChannel(1);
  assert.equal(turnKnob(-1).channel, n, "back from the first goes to the last");
  setChannel(n);
  assert.equal(turnKnob(1).channel, 1, "forward from the last goes to the first");
  for (let s = 1; s <= n; s++) {
    setChannel(s);
    turnKnob(1);
    assert.equal(turnKnob(-1).channel, s, `back undoes forward from ${s}`);
  }
  setChannel(1);
});

// ---------------------------------------------------------------------------
// Weather symbols
// ---------------------------------------------------------------------------

const icon = (tail) => `https://api.weather.gov/icons/land/${tail}?size=medium`;

test("skyFrom: reads the icon's controlled vocabulary", () => {
  const cases = [
    ["day/skc", "Sunny", "clear"], ["night/skc", "Clear", "clear"], ["day/few", "Sunny", "clear"],
    ["day/sct", "Mostly Sunny", "partcloud"], ["night/sct", "Partly Cloudy", "partcloud"],
    ["night/bkn", "Mostly Cloudy", "cloud"], ["day/ovc", "Cloudy", "cloud"],
    ["day/tsra_hi,20", "Slight Chance Showers And Thunderstorms", "storm"],
    ["day/rain_showers,40", "Chance Rain Showers", "rain"],
    ["day/snow,80", "Snow", "snow"], ["day/fzra,30", "Freezing Rain", "snow"],
    ["day/fog", "Areas Of Fog", "fog"], ["day/wind", "Windy", "wind"],
    ["day/wind_bkn", "Mostly Cloudy and Windy", "cloud"], ["day/hot", "Sunny and Hot", "clear"],
  ];
  for (const [tail, short, want] of cases) assert.equal(skyFrom(icon(tail), short), want, tail);
});

test("skyFrom: only the FIRST segment, so a sunny day with late storms is sunny", () => {
  // land/day/sct/tsra_hi,20 is mostly sunny THEN a slight chance of storms.
  // Searching the whole path finds "tsra" and paints a thunderstorm over an
  // 11%-chance sunny day.
  assert.equal(skyFrom(icon("day/sct/tsra_hi,20"), "Mostly Sunny then Slight Chance Showers"), "partcloud");
  assert.equal(skyFrom(icon("night/tsra_hi,20/sct"), "Slight Chance Showers then Partly Cloudy"), "storm");
});

test("skyFrom: the prose fallback tests 'partly' before 'cloudy'", () => {
  // "partly cloudy" contains "cloudy", so the partial forms have to come first
  // or every broken sky reads as overcast.
  assert.equal(skyFrom(null, "Partly Cloudy"), "partcloud");
  assert.equal(skyFrom(null, "Mostly Cloudy"), "cloud");
  assert.equal(skyFrom(null, "Mostly Sunny then Chance Showers"), "partcloud");
  assert.equal(skyFrom(null, ""), "cloud");
});

// ---------------------------------------------------------------------------
// Money — the gate, and the spoken number
// ---------------------------------------------------------------------------

const config = { stocks: { symbols: ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "TSLA"] } };

test("adviceRule fires on a request for a recommendation", () => {
  const fires = [
    "should I buy Nvidia", "is now a good time to invest in tech stocks",
    "shall I sell my Apple shares", "do you recommend any stocks",
    "is Tesla worth buying", "should I put money into an index fund",
    "should I short the market", "is AMZN worth holding onto", "would you buy bitcoin",
  ];
  for (const q of fires) assert.notEqual(adviceRule(q, config), "", q);
});

test("adviceRule stays silent on everything else", () => {
  // Both an advice verb AND a financial subject are required, which is what
  // keeps "should I buy a new laptop" and "tell me about Tesla history" quiet.
  const quiet = [
    "what is the nasdaq at", "how are the markets doing", "should I buy a new laptop",
    "put the markets on", "what time is it", "should I bring an umbrella",
    "sell me on this idea", "what is Apple trading at", "is it a good time to go outside",
    "show me the stock ticker", "tell me about Tesla history", "who founded Nvidia", "play some music",
  ];
  for (const q of quiet) assert.equal(adviceRule(q, config), "", q);
});

test("spokenPercent hands the model words, not a decimal to convert", () => {
  // Handed 0.29 the model said "two point nine percent" — a tenfold error in a
  // figure somebody might act on. Digits after the point are read individually
  // so "point two nine" cannot be heard as "twenty-nine".
  assert.equal(spokenPercent(0.29), "up zero point two nine percent");
  assert.equal(spokenPercent(-0.96), "down zero point nine six percent");
  assert.equal(spokenPercent(1.3), "up one point three zero percent");
  assert.equal(spokenPercent(12.5), "down twelve point five zero percent".replace("down", "up"));
  assert.equal(spokenPercent(-12.5), "down twelve point five zero percent");
  assert.equal(spokenPercent(0), "flat at zero point zero zero percent");
});

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

test("parseClockTime understands the ways people say a time", () => {
  const now = new Date("2026-08-08T12:00:00");
  const at = (s) => parseClockTime(s, now);
  assert.ok(at("3pm"), "3pm");
  assert.ok(at("9:30am"), "9:30am");
  assert.ok(at("15:45"), "24-hour");
  assert.equal(at("not a time"), null);
  assert.equal(at(""), null);
});

test("parseClockTime rolls past times to tomorrow", () => {
  const now = new Date("2026-08-08T12:00:00");
  const morning = parseClockTime("9am", now);
  assert.ok(morning > now, "9am with noon on the clock means tomorrow morning");
});

test("reminderWasClaimedNotSet catches a promise with no tool call", () => {
  // Keyed off the REQUEST, not the reply: "did the user ask" is a fixed
  // testable string, "did he claim it worked" means parsing free text.
  assert.ok(reminderWasClaimedNotSet("remind me to take the bins out at 7am", []));
  assert.ok(reminderWasClaimedNotSet("set a timer for ten minutes", []));
  assert.ok(!reminderWasClaimedNotSet("remind me to take the bins out at 7am", ["set_reminder"]));
});

test("reminderWasClaimedNotSet ignores things that are not requests to schedule", () => {
  // "every morning I drink coffee" must not fire, or Greg volunteers that he
  // failed to do something nobody asked for. And recall is a memory question.
  assert.ok(!reminderWasClaimedNotSet("every morning I drink coffee", []));
  assert.ok(!reminderWasClaimedNotSet("remind me what you told me about the car", ["recall_conversation"]));
  assert.ok(!reminderWasClaimedNotSet("what time is it", []));
});

// ---------------------------------------------------------------------------
// Speech
// ---------------------------------------------------------------------------

test("speakable strips what text-to-speech would read literally", () => {
  assert.ok(!speakable("**cold** today").includes("*"), "asterisks");
  assert.ok(!/https?:/.test(speakable("see https://example.com/x")), "urls");
  assert.ok(!/#/.test(speakable("# Heading")), "hashes");
});

test("speakable spells initialisms espeak gets wrong, and leaves the rest", () => {
  // Measured with voice.phonemize(): espeak already says BBC and NASA correctly,
  // and turns UNCW into "unk-wuh".
  assert.match(speakable("UNCW"), /U N C W/, "UNCW is spelled out");
  assert.match(speakable("CPUs"), /C P U s/, "a plural s needs its own space");
  assert.ok(!/N A S A/.test(speakable("NASA")), "NASA is said as a word");
  assert.ok(!/T V/.test(speakable("TV")), "two-letter forms are left alone");
});

// ---------------------------------------------------------------------------
// Space weather
// ---------------------------------------------------------------------------

test("trendOf needs a real margin, not the feed's jitter", () => {
  const flat = new Array(60).fill(1);
  assert.equal(trendOf(flat), "steady");
  const jitter = Array.from({ length: 60 }, (_, i) => 1 + (i % 2) * 0.1);
  assert.equal(trendOf(jitter), "steady", "alternating noise is not a trend");
  const rising = Array.from({ length: 60 }, (_, i) => i / 30);
  assert.equal(trendOf(rising), "rising");
  assert.equal(trendOf(rising.slice().reverse()), "falling");
  assert.equal(trendOf([1, 2]), "steady", "too little history to say");
});

test("auroraFor is honest about latitude", () => {
  // From 36 north the answer is almost always no, even in a big storm — a
  // channel that implies otherwise sends somebody into a field for nothing.
  assert.equal(auroraFor(5, 35.9).visible, false);
  assert.equal(auroraFor(8, 35.9).visible, false);
  assert.equal(auroraFor(5, 65).visible, true);
  assert.equal(auroraFor(0, null).visible, null, "no latitude means no verdict");
});

// ---------------------------------------------------------------------------
// Where things are in the sky
// ---------------------------------------------------------------------------

test("distanceKm and bearing agree with known geography", () => {
  const chapelHill = { lat: 35.9132, lon: -79.0558 };
  const raleigh = { lat: 35.7796, lon: -78.6382 };
  const km = distanceKm(chapelHill, raleigh);
  assert.ok(km > 35 && km < 50, `Chapel Hill to Raleigh is about 40km, got ${km.toFixed(1)}`);
  const b = bearing(chapelHill, raleigh);
  assert.ok(b > 90 && b < 135, `Raleigh is south-east of Chapel Hill, got ${b.toFixed(0)}`);
});

test("distance is symmetric and zero to itself", () => {
  const a = { lat: 51.5, lon: -0.12 };
  const b = { lat: 40.7, lon: -74.0 };
  assert.equal(Math.round(distanceKm(a, b)), Math.round(distanceKm(b, a)));
  assert.equal(Math.round(distanceKm(a, a)), 0);
});

test("compassOf names the right sixteenth, and wraps", () => {
  assert.equal(compassOf(0), "N");
  assert.equal(compassOf(90), "E");
  assert.equal(compassOf(180), "S");
  assert.equal(compassOf(270), "W");
  assert.equal(compassOf(360), "N", "360 wraps to north rather than falling off the end");
  assert.equal(compassOf(45), "NE");
});

// ---------------------------------------------------------------------------
// Teletext's fixed grid
// ---------------------------------------------------------------------------

test("wrapChars wraps by character, not by pixel", () => {
  assert.deepEqual(wrapChars("one two three", 7), ["one two", "three"]);
  assert.deepEqual(wrapChars("", 10), []);
  for (const line of wrapChars("a b c d e f g h i j k", 5)) assert.ok(line.length <= 5, line);
});

test("wrapChars cuts a single word too long for the line", () => {
  // A URL or a hyphenated place name must not run off the edge of the picture.
  const out = wrapChars("supercalifragilistic", 8);
  assert.ok(out.every((l) => l.length <= 8), JSON.stringify(out));
});

test("ellipsizeChars keeps within the column count", () => {
  assert.equal(ellipsizeChars("short", 10), "short");
  assert.ok(ellipsizeChars("a much longer headline than fits", 10).length <= 10);
  assert.equal(ellipsizeChars("anything", 0), "");
});

// ---------------------------------------------------------------------------
// Being away
// ---------------------------------------------------------------------------

test("greetingFor says nothing for a short absence", () => {
  // Returns null, not "" — asserted as written rather than as assumed, because
  // the caller does `if (greeting)` and both would pass there. A test that
  // guesses the shape of a return is testing the guess.
  assert.equal(greetingFor(0), null);
  assert.equal(greetingFor(60), null);
  assert.equal(greetingFor(19 * 60), null, "under twenty minutes is not an absence");
  assert.equal(greetingFor("nonsense"), null, "a bad number is not an absence either");
});

test("greetingFor greets after a real absence", () => {
  assert.ok(greetingFor(3 * 3600));
  assert.ok(greetingFor(30 * 3600));
});

// ---------------------------------------------------------------------------
// Freshness — "is this last year's version of the story?"
//
// The failure these guard is the one that is faithful to its source and still
// wrong: Greg reads July 2025's ranking and reports it as this year's. Nothing
// is fabricated, so nothing looks off.
//
// The markup below is trimmed from the real pages the fix was measured against:
// two 2026 stories and one from July 2025, all returned by the SAME query, plus
// a Wikipedia article whose datePublished is 2007 and dateModified is last
// month. That last one is why staleness is judged on the later of the two.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-08T12:00:00Z");

test("pageDates reads the signals real articles actually carry", () => {
  // ld+json datePublished — hit 4/4 on the measured result set.
  assert.equal(
    pageDates('<script type="application/ld+json">{"datePublished":"2025-07-18T15:41:39-04:00"}</script>', NOW).published,
    "2025-07-18",
  );
  // article:published_time, both attribute orders.
  assert.equal(
    pageDates('<meta property="article:published_time" content="2026-08-05T09:01:35Z">', NOW).published,
    "2026-08-05",
  );
  assert.equal(
    pageDates('<meta content="2026-08-05T09:01:35Z" property="article:published_time">', NOW).published,
    "2026-08-05",
  );
  // <time datetime> — the weakest signal, so it is last.
  assert.equal(pageDates('<time datetime="2026-07-01T10:00:00Z">July</time>', NOW).published, "2026-07-01");
});

test("no date is null, not a guess", () => {
  // A wrong date attached to a right fact is the fabricated-citation failure.
  assert.equal(pageDates("<html><body>no dates here at all</body></html>", NOW).published, null);
  assert.equal(pageDates("", NOW).published, null);
  assert.equal(pageDates(undefined, NOW).published, null);
});

test("a date that cannot be real is rejected rather than reported", () => {
  assert.equal(pageDates('<script>{"datePublished":"2031-01-01"}</script>', NOW).published, null, "the future");
  assert.equal(pageDates('<script>{"datePublished":"1970-01-01"}</script>', NOW).published, null, "before the web");
  assert.equal(pageDates('<script>{"datePublished":"not a date"}</script>', NOW).published, null);
});

test("a maintained page is judged on when it was last edited, not when it was created", () => {
  // Wikipedia's Biscuitville article, verbatim shape: created 2007, edited last
  // month. Read as published-only it came back "about 19 years ago", which
  // would have had Greg calling a current page two decades out of date.
  const wiki = '<script type="application/ld+json">{"datePublished":"2007-02-12T06:39:15Z","dateModified":"2026-06-18T13:25:08Z"}</script>';
  const f = freshnessOf(wiki, NOW);

  assert.equal(f.published, "2007-02-12");
  assert.equal(f.updated, "2026-06-18");
  assert.equal(f.stale, false, "a page edited seven weeks ago is not stale");
  assert.match(f.label, /Published 12 February 2007, last updated 18 June 2026/);
});

test("a news story that got a typo fixed keeps its publication date", () => {
  // Modified a few hours later — not a maintained page, so no "last updated".
  const news = '<script>{"datePublished":"2026-08-05T09:01:35Z","dateModified":"2026-08-05T20:13:18Z"}</script>';
  const f = freshnessOf(news, NOW);

  assert.equal(f.label, "Published 5 August 2026");
  assert.equal(f.stale, false);
});

test("last year's story is marked NOT current, in words the model can copy", () => {
  const old = '<script>{"datePublished":"2025-07-18T15:41:39-04:00"}</script>';
  const f = freshnessOf(old, NOW);

  assert.equal(f.stale, true);
  assert.ok(f.ageDays > 365, `ageDays was ${f.ageDays}`);
  assert.match(f.note, /NOT current/);
  assert.match(f.note, /18 July 2025/, "the date itself has to be in the sentence");
});

test("an undated page says so loudly rather than saying nothing", () => {
  // An absent date meant two things — none published, and nobody looked — and a
  // model handed silence fills it. Same shape as the empty-alert-list bug.
  const f = freshnessOf("<html>nothing dated</html>", NOW);

  assert.equal(f.published, null);
  assert.equal(f.stale, false, "unknown is not stale — it is unknown");
  assert.equal(f.label, null);
  assert.match(f.note, /no publication date/);
  assert.match(f.note, /Do not describe it as current/);
});

test("describeAge hands over words, not a day count to divide", () => {
  // Same lesson as spokenPercent: give it something to copy, not something to
  // convert. "0.29" was verbalised as "two point nine percent" one run in three.
  assert.equal(describeAge("2026-08-08", NOW), "today");
  assert.equal(describeAge("2026-08-07", NOW), "yesterday");
  assert.equal(describeAge("2026-08-01", NOW), "7 days ago");
  assert.equal(describeAge("2026-07-01", NOW), "about 5 weeks ago");
  assert.equal(describeAge("2026-02-08", NOW), "about 6 months ago");
  assert.equal(describeAge("2025-07-18", NOW), "about a year ago");
  assert.equal(describeAge("2021-08-08", NOW), "about 5 years ago");
});

test("spokenDate spells the month, because 2025-07-18 gets read out digit by digit", () => {
  assert.equal(spokenDate("2025-07-18"), "18 July 2025");
  assert.equal(spokenDate("2026-01-01"), "1 January 2026");
});

test("freshnessWanted fires on questions that asked for current information", () => {
  for (const q of [
    "latest news on the strike", "what is the current price of gold", "who won the game today",
    "recent reviews of the pixel", "best laptop right now", "any update on the election",
    "what happened in 2026", "is it still raining",
  ]) {
    assert.equal(freshnessWanted(q), true, `"${q}" asked for something current`);
  }
});

test("freshnessWanted stays silent on evergreen questions", () => {
  // No trigger, no extra fetch, nothing for the model to get wrong — the same
  // shape as the deixis gate and adviceRule.
  for (const q of [
    "what is the tallest mountain in north carolina", "how do I boil an egg",
    "who wrote moby dick", "what is the capital of peru",
    "cabinet reshuffle history",      // must not match "new" inside a word
    "nowhere man lyrics meaning",     // must not match "now" inside a word
    "how long is a marathon",
  ]) {
    assert.equal(freshnessWanted(q), false, `"${q}" is not a question about now`);
  }
});

test("the second-chance fetch needs all three conditions", () => {
  const old = STALE_DAYS + 100;

  assert.equal(shouldTrySecond("latest news on the strike", old), true);

  assert.equal(shouldTrySecond("who wrote moby dick", old), false, "the question did not ask for current");
  assert.equal(shouldTrySecond("latest news on the strike", 3), false, "the top result is fresh");
  assert.equal(shouldTrySecond("latest news on the strike", null), false, "no date is not evidence of age");
  assert.equal(shouldTrySecond("latest news on the strike", undefined), false);
  assert.equal(shouldTrySecond("latest news on the strike", STALE_DAYS), false, "exactly at the line is not past it");
});

test("staleSourceIn finds the stale page in either tool shape", () => {
  const page = { stale: true, published: "2025-07-18", age: "about a year ago", source: "charlotteobserver.com" };

  // read_page returns the page itself; search_web wraps it in topResult.
  assert.equal(staleSourceIn(page)?.published, "2025-07-18");
  assert.equal(staleSourceIn({ topResult: page })?.published, "2025-07-18");

  assert.equal(staleSourceIn({ ...page, stale: false }), null, "a fresh page is not a stale source");
  assert.equal(staleSourceIn({ stale: true, published: null }), null, "stale with no date is not usable");
  assert.equal(staleSourceIn(null), null);
  assert.equal(staleSourceIn("a string"), null);
  assert.equal(staleSourceIn({ results: [] }), null, "a search with no page read");
});

test("mentionsDate recognises the way he actually writes years", () => {
  const iso = "2025-07-18";

  // Digits, which is the obvious case and the only one the first scorer caught.
  assert.equal(mentionsDate("published in 2025", iso), true);
  // Words, which is what he really writes, being a voice assistant. A scorer
  // looking only for digits reported 0/3 on transcripts that all named the date.
  assert.equal(mentionsDate("published on July eighteenth, two thousand twenty-five", iso), true);
  assert.equal(mentionsDate("from twenty twenty five", iso), true);
  // A month name alone is enough — he often says "back in July".
  assert.equal(mentionsDate("that was back in July", iso), true);
  assert.equal(mentionsDate("it was published last year", iso), true);

  // A vague gesture at age is NOT a date, and must not suppress the caveat:
  // "about a year old" leaves the user without a point in time, which is the
  // one thing the caveat exists to supply.
  assert.equal(mentionsDate("the article is about a year old", iso), false);

  assert.equal(mentionsDate("Biscuitville was named the best.", iso), false);
  assert.equal(mentionsDate("", iso), false);
});

test("the freshness caveat is added only when he left the date out", () => {
  const stale = { published: "2025-07-18", age: "about a year ago", source: "charlotteobserver.com" };

  const bare = stalenessCaveat("Biscuitville was named the best.", stale);
  assert.match(bare, /18 July 2025/);
  assert.match(bare, /something newer/);

  // He said it himself — adding it again would have him say the date twice.
  assert.equal(stalenessCaveat("According to a July 2025 article, Biscuitville.", stale), "");
  assert.equal(stalenessCaveat("That was published in two thousand twenty-five.", stale), "");

  // Nothing stale was read, so there is nothing to caveat.
  assert.equal(stalenessCaveat("Biscuitville was named the best.", null), "");
  assert.equal(stalenessCaveat("anything", { published: null }), "");
});

test("a sentence added in code ends the one before it", () => {
  // Found live: the model answered a stale-page question with the bare word
  // "Biscuitville" and the freshness caveat was appended with a space, giving
  // "Biscuitville That was published 18 July 2025". lib/sentences.js splits the
  // reply into one clip per sentence for synthesis, so that is a single run-on
  // with no pause in it.
  assert.equal(appendSentence("Biscuitville", "That was July."), "Biscuitville. That was July.");
  assert.equal(appendSentence("It was Biscuitville.", "That was July."), "It was Biscuitville. That was July.");
  assert.equal(appendSentence("Really?", "That was July."), "Really? That was July.");
  assert.equal(appendSentence("Wow!", "That was July."), "Wow! That was July.");
  assert.equal(appendSentence('He said "no"', "That was July."), 'He said "no" That was July.');

  // Nothing to add, or nothing to add it to.
  assert.equal(appendSentence("Biscuitville", ""), "Biscuitville");
  assert.equal(appendSentence("  spaced  ", ""), "spaced");
  assert.equal(appendSentence("", "That was July."), "That was July.");
});

// ---------------------------------------------------------------------------
// The boot screen — a POST that must not invent hardware
//
// The device list is the one part of the startup sequence that makes claims.
// A screen showing [ OK ] beside a subsystem that did not load would be this
// project's oldest failure — fabricating something plausible — wearing set
// decoration. Everything here comes from /api/config.
// ---------------------------------------------------------------------------

const FULL = {
  name: "Greg", hasBrain: true, brainLabel: "Ollama gemma4:e4b",
  listening: "local", earsLabel: "small.en on cuda",
  speaking: "local", voiceLabel: "greg (cloned)",
  canSeeScreen: true, visionLabel: "qwen2.5vl:7b",
  location: { city: "Chapel Hill", region: "NC" },
};

test("the boot screen reports what actually loaded", () => {
  const rows = deviceLines(FULL);
  assert.deepEqual(rows.map((r) => r.label), ["Brain", "Ears", "Voice", "Eyes", "Home"]);
  assert.ok(rows.every((r) => r.ok), "everything present should read OK");
  assert.equal(rows[0].value, "Ollama gemma4:e4b");
  assert.equal(rows[4].value, "Chapel Hill, NC");
});

test("nothing that failed to load is marked OK", () => {
  const rows = deviceLines({ hasBrain: false, listening: "browser", speaking: "cloud", canSeeScreen: false, location: {} });
  assert.ok(rows.every((r) => !r.ok), "a degraded machine must show no OK at all");
  assert.equal(rows[0].value, "not found");
  assert.equal(rows[1].value, "browser speech");
  assert.equal(rows[2].value, "cloud voice");
  // Eyes are the one device that can be installed and still unusable: a vision
  // model that fails the startup swatch test has its tool withdrawn, and the
  // boot screen must not imply otherwise.
  assert.equal(rows[3].value, "not fitted");
  assert.equal(rows[4].value, "unknown");
});

test("an empty config claims nothing", () => {
  // The page can wake before /api/config answers.
  assert.ok(deviceLines({}).every((r) => !r.ok));
  assert.ok(deviceLines().every((r) => !r.ok));
});

test("the copyright line does not boast about being local when it isn't", () => {
  // Caught by rendering the degraded case and reading it: the screen said "All
  // processing local" with the ears on browser speech and the voice in the
  // cloud — false in exactly the state where the claim matters.
  assert.equal(tagline(FULL), "All processing local");
  assert.equal(tagline({ ...FULL, speaking: "cloud" }), "Some processing remote");
  assert.equal(tagline({ ...FULL, listening: "browser" }), "Some processing remote");
  assert.equal(tagline({ ...FULL, hasBrain: false }), "Some processing remote");
  assert.equal(tagline({}), "Some processing remote");
});

// ---------------------------------------------------------------------------
// Engineering — channel 11, and the aliases it must NOT claim
// ---------------------------------------------------------------------------

test("the engineering channel answers to the ways people ask to see it", () => {
  for (const said of [
    "engineering", "put engineering on", "switch to the engineering channel",
    "show me the system stats", "system status", "diagnostics", "hardware", "vitals",
    "channel eleven", "11",
  ]) {
    assert.equal(resolveChannel(said)?.id, "engineering", said);
  }
});

test("asking about the hardware is a QUESTION, not a channel change", () => {
  // Aliases are matched as substrings, so a bare "gpu", "vram" or "temps" here
  // would turn every one of these into a channel switch. That is the exact
  // failure "what's playing" hit against channel 2 and "what is the NASDAQ at"
  // hit against channel 8 — both fixed by leaving the question its own tool.
  // get_engineering answers these; set_channel must not.
  for (const said of [
    "how hot is my gpu", "how much vram is free", "what models are loaded",
    "is the gpu busy", "what's my cpu usage", "how much memory am I using",
    "what temperature is the graphics card",
  ]) {
    assert.equal(resolveChannel(said), null, said);
  }
});

// ---------------------------------------------------------------------------
// Which search result to read
//
// The fixtures below are a REAL DuckDuckGo result set, captured for the query
// this failure was first measured on. Two round-ups rank above the one article
// that actually answers, and three of the six name an old year in their URL.
// ---------------------------------------------------------------------------

const RESULTS = [
  { title: "10 best restaurants for fast food breakfast",
    url: "https://10best.usatoday.com/awards/best-fast-food-breakfast/", source: "10best.usatoday.com" },
  { title: "Top fast food restaurants for breakfast, burgers, and more",
    url: "https://10best.usatoday.com/food-drink/best-fast-food-restaurants-2026/", source: "10best.usatoday.com" },
  { title: "Here are the top fast food restaurants for breakfast, burgers, and more",
    url: "https://www.usatoday.com/story/money/food/2024/07/20/top-fast-food-restaurants/7445", source: "usatoday.com" },
  { title: "Where to get the best fast-food breakfast near Wilmington, NC",
    url: "https://www.starnewsonline.com/story/lifestyle/food/2026/08/05/where-to-get-the-best/", source: "starnewsonline.com" },
  { title: "Best Fast Food Breakfast Restaurant For 2025 Revealed",
    url: "https://www.iheart.com/content/2025-07-29-best-fast-food-breakfast-revealed/", source: "iheart.com" },
  { title: "10Best readers cite the best fast food restaurants of 2023 - USA TODAY",
    url: "https://www.usatoday.com/story/travel/10best/awards/2023/07/28/best-fast-food-2023", source: "usatoday.com" },
];

test("yearsIn finds the year in a url or a headline, and not in an article id", () => {
  assert.deepEqual(yearsIn("https://www.usatoday.com/story/money/food/2024/07/20/x"), [2024]);
  assert.deepEqual(yearsIn("Best Fast Food Breakfast Restaurant For 2025 Revealed"), [2025]);
  // Digit soup in a CMS id must not read as a year — "article310925290" would
  // otherwise be mined for anything starting 20.
  assert.deepEqual(yearsIn("https://www.charlotteobserver.com/x/article310925290.html"), []);
  assert.deepEqual(yearsIn("no years here"), []);
});

test("looksLikeListicle knows a round-up from an article", () => {
  assert.equal(looksLikeListicle("10 best restaurants for fast food breakfast"), true);
  assert.equal(looksLikeListicle("Here are the top fast food restaurants"), true);
  assert.equal(looksLikeListicle("Top fast food restaurants for breakfast, burgers, and more"), true);
  assert.equal(looksLikeListicle("The 20 greatest albums, ranked"), true);

  assert.equal(looksLikeListicle("Where to get the best fast-food breakfast near Wilmington, NC"), false);
  assert.equal(looksLikeListicle("Biscuitville ranks No. 1 in the US"), false);
});

test("a round-up is skipped when the question has one right answer", () => {
  // The measured failure, as a standing test: results[0] is a round-up, and
  // reading it faithfully is how "Hardee's" got reported.
  const pick = pickToRead(RESULTS, "which chain was named best fast food breakfast", new Date("2026-08-08"));
  assert.equal(pick.result.source, "starnewsonline.com");
  assert.match(pick.why, /round-up/);
});

test("a round-up is the RIGHT answer when the question wants options", () => {
  // Penalising round-ups unconditionally would wreck every "give me some
  // options" search, so the penalty is gated on the question being singular.
  assert.equal(wantsOneAnswer("what are the best fast food breakfast chains"), false);
  assert.equal(wantsOneAnswer("which chain was named best"), true);
  assert.equal(wantsOneAnswer("who won the final"), true);

  const pick = pickToRead(RESULTS, "what are the best fast food breakfast chains", new Date("2026-08-08"));
  assert.ok(looksLikeListicle(pick.result.title), `picked ${pick.result.title}`);
});

test("asking about a specific year reads that year, not this one", () => {
  // Waiving the staleness penalty was not enough: the 2023 page still lost to
  // the 2026 one, because everything current kept a freshness bonus. Wanting a
  // particular vintage has to be a reward, not the absence of a punishment.
  const pick = pickToRead(RESULTS, "which chain won best fast food breakfast in 2023", new Date("2026-08-08"));
  assert.match(pick.result.url, /2023/);
});

test("with nothing to choose between, the search engine's order stands", () => {
  const plain = [
    { title: "NC chain again ranks No. 1 in US", url: "https://www.newsobserver.com/x/article310925290.html", source: "newsobserver.com" },
    { title: "Best breakfast? This NC-based chain ranks No. 1", url: "https://www.charlotteobserver.com/x/article316578813.html", source: "charlotteobserver.com" },
  ];
  const pick = pickToRead(plain, "which NC chain was named best for breakfast", new Date("2026-08-08"));
  assert.equal(pick.index, 0, "no signals means no reordering");
  assert.equal(pick.why, null, "and nothing to explain");
});

test("pickToRead copes with results that have no url", () => {
  assert.equal(pickToRead([], "anything"), null);
  assert.equal(pickToRead([{ title: "no link" }], "anything"), null);
  assert.equal(pickToRead(undefined, "anything"), null);
});

test("wantsOneAnswer copes with adjectives between the pronoun and the noun", () => {
  // Measured failing: "which fast food chain did USA TODAY name the best" is
  // about as singular as a question gets, and matched nothing because two words
  // of adjective stood between "which" and "chain". The listicle penalty then
  // never applied on the very query the feature exists for.
  for (const q of [
    "which fast food chain did USA TODAY name the best for breakfast",
    "which chain was named best",
    "who won the final",
    "which NC restaurant is number one",
    "what car did they name car of the year",
  ]) {
    assert.equal(wantsOneAnswer(q), true, q);
  }

  // And the plural still asks for options — `chain\b` cannot match "chains".
  for (const q of [
    "what are the best fast food breakfast chains",
    "best laptops 2026",
    "tell me about north carolina restaurants",
    "how do I make biscuits",
  ]) {
    assert.equal(wantsOneAnswer(q), false, q);
  }
});

// ---------------------------------------------------------------------------
// Recognising himself on the screen
//
// On a multi-monitor desktop the second display can sit at NEGATIVE x, so the
// virtual origin is not (0, 0) and "is Greg in shot" has to be measured rather
// than assumed. That is not hypothetical: asked what windows were open, the
// vision model listed four and said no others were visible — Greg was on the
// other screen entirely, and capture defaults to the primary one.
//
// The numbers below are a fixture, not a description of anybody's desk: an
// ultrawide primary, and a window the size of Greg's own.
// ---------------------------------------------------------------------------

const PRIMARY = { x: 0, y: 0, w: 3440, h: 1440 };

test("he is in shot when his window is inside the captured display", () => {
  const middle = selfInShot({ x: 1500, y: 300, w: 560, h: 780 }, PRIMARY);
  assert.equal(middle.onScreen, true);
  assert.equal(middle.where, "in the middle");

  assert.equal(selfInShot({ x: 100, y: 200, w: 560, h: 780 }, PRIMARY).where, "on the left");
  assert.equal(selfInShot({ x: 2800, y: 200, w: 560, h: 780 }, PRIMARY).where, "on the right");
});

test("he is NOT in shot when he is on another monitor", () => {
  // The measured case: the second display is at negative X, and "primary" is
  // what gets captured. Claiming to recognise himself here would be inventing.
  const other = selfInShot({ x: -3200, y: 100, w: 560, h: 780 }, PRIMARY);
  assert.equal(other.onScreen, false);
  assert.equal(other.known, true, "we know where he is — he is elsewhere");
  assert.match(other.why, /different monitor/);
});

test("a minimised window is not on screen even at sane coordinates", () => {
  // Windows parks minimised windows at -32000, and a window can also be open,
  // positioned and simply hidden behind another.
  assert.equal(selfInShot({ x: -32000, y: -32000, w: 560, h: 780 }, PRIMARY).onScreen, false);
  assert.equal(selfInShot({ x: 500, y: 200, w: 560, h: 780, hidden: true }, PRIMARY).onScreen, false);
});

test("not knowing where he is stays a separate answer from not being there", () => {
  // The page may never have reported — before it is woken, or with no window
  // open at all. "I don't know" and "no" must not collapse, or he would deny
  // being on screen while sitting in the middle of it.
  assert.equal(selfInShot(null, PRIMARY).known, false);
  assert.equal(selfInShot({ x: 0, y: 0, w: 10, h: 10 }, null).known, false);
});

test("a window touching the edge of the display still counts", () => {
  assert.equal(selfInShot({ x: -100, y: 0, w: 560, h: 780 }, PRIMARY).onScreen, true, "half off the left edge");
  assert.equal(selfInShot({ x: 3400, y: 0, w: 560, h: 780 }, PRIMARY).onScreen, true, "half off the right edge");
  assert.equal(selfInShot({ x: 3440, y: 0, w: 560, h: 780 }, PRIMARY).onScreen, false, "exactly past the edge");
});

test("a nonsense window report is refused rather than stored", () => {
  assert.equal(setWindowRect({ x: 1, y: 2, w: 3, h: 4 }), true);
  assert.deepEqual(
    { x: getWindowRect().x, w: getWindowRect().w },
    { x: 1, w: 3 },
  );
  assert.equal(setWindowRect({ x: "nonsense", y: 2, w: 3, h: 4 }), false);
  assert.equal(setWindowRect({ x: 1, y: 2, w: 0, h: 4 }), false, "a zero-sized window is not a position");
  assert.equal(setWindowRect(null), false);
  assert.equal(getWindowRect().x, 1, "a bad report must not clobber the last good one");
});

// ---------------------------------------------------------------------------
// Personas — who he is, as data
//
// The dials decide how he says things; a persona decides who is saying them.
// It exists because the identity line was hard-coded: setting `name` renamed
// the wake word, the window and the badge while the system prompt still said
// "You are Greg", which is the first thing anyone cloning the repo would hit.
// ---------------------------------------------------------------------------

test("the shipped personas all load and are complete", async () => {
  const { listPersonas } = await import("../lib/personas.js");
  const all = listPersonas();
  assert.ok(all.length >= 4, `expected the shipped set, got ${all.length}`);

  for (const p of all) {
    assert.ok(p.name, `${p.id} needs a name`);
    assert.ok(p.is.length > 10, `${p.id} needs a sentence saying what it is`);
    assert.ok(p.is.length <= 240, `${p.id}'s identity is too long for a prompt line`);
    // Every dial it names must be a real one, or it silently does nothing.
    for (const key of Object.keys(p.traits)) {
      assert.ok(TRAITS[key], `${p.id} sets "${key}", which is not a trait`);
      assert.ok(p.traits[key] >= 0 && p.traits[key] <= 100, `${p.id}.${key} out of range`);
    }
  }
});

test("greg.json reproduces the shipped defaults exactly", async () => {
  // The default persona must be a no-op, or installing this feature would
  // quietly change how he already behaves.
  const { resolvePersona } = await import("../lib/personas.js");
  const greg = resolvePersona("greg");
  assert.deepEqual(greg.traits, { humour: 55, edge: 15, directness: 60, warmth: 55, brevity: 70, formality: 30 });
  assert.match(greg.is, /Jarvis/);
});

test("a persona is found however it was asked for", async () => {
  const { resolvePersona } = await import("../lib/personas.js");
  assert.equal(resolvePersona("butler")?.name, "Bramley");
  assert.equal(resolvePersona("put the butler on")?.name, "Bramley");
  assert.equal(resolvePersona("be Sam")?.name, "Sam");
  // Hyphens and spaces fold together: the file is flight-computer.json and
  // nobody says "flight hyphen computer". This was caught by running it.
  assert.equal(resolvePersona("flight computer")?.name, "Ship");
  assert.equal(resolvePersona("flight-computer")?.name, "Ship");

  assert.equal(resolvePersona("nonsense"), null);
  assert.equal(resolvePersona(""), null);
  assert.equal(resolvePersona(null), null);
});

test("a persona patch is something applySettings can take", async () => {
  const { resolvePersona, personaPatch } = await import("../lib/personas.js");
  const patch = personaPatch(resolvePersona("butler"));

  assert.equal(patch.name, "Bramley");
  assert.ok(patch.identity.length > 10);
  assert.equal(patch.personality.formality, 85);
  assert.equal(patch.personality.mirror, false);
});

test("the identity reaches the system prompt, so renaming actually renames", async () => {
  // The bug this whole feature starts from: `name` changed everything except
  // what he believed he was.
  const { buildSystemPrompt } = await import("../lib/brain.js");
  const line = buildSystemPrompt({ name: "Ada", identity: "a lighthouse keeper" }, {}).split("\n")[0];
  assert.match(line, /You are Ada — a lighthouse keeper/);

  // And with nothing configured it is word for word what it always was.
  const fallback = buildSystemPrompt({}, {}).split("\n")[0];
  assert.match(fallback, /^You are Greg — a voice-controlled AI assistant living on the user's Windows PC, in the spirit of Jarvis from Iron Man\.$/);
});

// ---------------------------------------------------------------------------
// The vocoder's one dial
//
// The audio graph itself needs a browser, but the numbers driving it do not —
// and the numbers are where it would go wrong: full wet is a great noise and a
// useless way to hear the weather.
// ---------------------------------------------------------------------------

test("the dry path never disappears, however far the dial goes", () => {
  // This is the whole reason the mapping is a function rather than a straight
  // wet/dry crossfade. At 100% a plain crossfade is pure ring modulation, which
  // is unintelligible — you would not be able to hear the time.
  for (const amount of [0, 0.25, 0.5, 0.75, 1]) {
    assert.ok(mixFor(amount).dry > 0.25, `at ${amount} the dry path was ${mixFor(amount).dry}`);
  }
  assert.equal(mixFor(0).dry, 1, "off means untouched");
  assert.equal(mixFor(0).wet, 0);
});

test("turning it up increases the effect and decreases the clean signal", () => {
  const low = mixFor(0.2);
  const high = mixFor(0.9);
  assert.ok(high.wet > low.wet);
  assert.ok(high.dry < low.dry);
  assert.ok(high.depth > low.depth);
});

test("the carrier stays where speech survives it", () => {
  // Above roughly 120 Hz ring modulation stops sounding like a machine talking
  // and starts sounding like a different noise entirely.
  assert.ok(mixFor(1).carrier > 20 && mixFor(1).carrier < 120);
});

test("nonsense on the dial is treated as off, not as NaN", () => {
  // It arrives from a range input and from config.json, so neither can be
  // trusted. A NaN would silence him: every gain in the chain would go quiet
  // with nothing on screen to say why.
  for (const bad of [undefined, null, "loud", NaN, {}]) {
    const m = mixFor(bad);
    assert.ok(Number.isFinite(m.dry) && Number.isFinite(m.wet), `${String(bad)} produced NaN`);
    assert.equal(m.wet, 0);
  }
  assert.equal(mixFor(5).wet, 1, "clamped, not trusted");
  assert.equal(mixFor(-3).wet, 0);
});

// ---------------------------------------------------------------------------
// The cloned voice path
//
// A cloned voice cannot always be switched on when asked: it may be disabled in
// config, or parked by gaming mode to free 4.2 GB. In every one of those cases
// the CHOICE is still saved, so a restart picks it up — "needs a restart" is a
// delay rather than a dead end — and he says plainly that nothing changed yet.
// ---------------------------------------------------------------------------

const CLONE_VOICE = { kind: "clone", id: "greg-reference", label: "greg", file: "voices/greg-reference.wav" };

test("a clone that is switched off in config says so and asks for a restart", async () => {
  const { cloneAction } = await import("../lib/voices.js");
  for (const config of [{}, { clonedVoice: { enabled: false } }]) {
    const d = cloneAction(config, CLONE_VOICE, true);
    assert.equal(d.stop, true);
    assert.equal(d.result.saved, true, "the choice is kept so a restart applies it");
    assert.equal(d.result.needsRestart, true);
    assert.match(d.result.note, /switched off/);
    assert.match(d.result.note, /sound exactly as you did/, "it must not imply anything changed");
  }
});

test("gaming mode is not undone as a side effect of picking a character", async () => {
  // It exists to free 11 GB. Loading a 4.2 GB voice because someone chose a
  // persona would take that back without anyone asking for it.
  const { cloneAction } = await import("../lib/voices.js");
  const d = cloneAction({ clonedVoice: { enabled: true } }, CLONE_VOICE, false);

  assert.equal(d.stop, true);
  assert.equal(d.result.saved, true);
  assert.match(d.result.note, /gaming mode/);
});

test("with the clone enabled and wanted, it proceeds", async () => {
  const { cloneAction } = await import("../lib/voices.js");
  assert.equal(cloneAction({ clonedVoice: { enabled: true } }, CLONE_VOICE, true).stop, false);
});

test("the clone reference is read from clonedVoice, the key that is actually consumed", async () => {
  // It was `config.clone` for a day — a key nothing writes and nothing reads —
  // so a swap set a field into space and the sidecar reported "disabled in
  // config". Guessed rather than checked against the file that consumes it.
  const { currentVoice } = await import("../lib/voices.js");

  // `wantedClone` is the field that reads config. `cloneReference` is what is
  // actually LOADED and is null here because no sidecar runs in a test — that
  // separation is the fix for a different bug, where config naming a voice was
  // taken as proof it was working, so a clone that had failed could never be
  // retried from the dialog.
  assert.equal(
    currentVoice({ clonedVoice: { reference: "voices/x.wav" } }).wantedClone,
    "voices/x.wav",
  );
  assert.equal(currentVoice({ clone: { reference: "voices/wrong.wav" } }).wantedClone, null);
  assert.equal(currentVoice({ clonedVoice: { reference: "voices/x.wav" } }).cloneReference, null);
});

// ---------------------------------------------------------------------------
// Foreign news — reading the local edition, not English coverage of it
//
// Measured: asked about Seoul, Greg searched the US English edition and returned
// World Youth Day 2027 and a religious-freedom press release. The Korean
// edition's own front page the same minute led with party primaries, medical
// school quotas and a missile-stock story. A reader in Korea confirmed the first
// set meant nothing there. Translation alone would have translated the wrong
// stories.
// ---------------------------------------------------------------------------

test("a country maps to its own Google News edition", async () => {
  const { editionFor } = await import("../lib/editions.js");

  const kr = editionFor("KR");
  assert.equal(kr.hl, "ko");
  assert.equal(kr.gl, "KR");
  assert.equal(kr.ceid, "KR:ko", "ceid is the pair Google actually keys on");
  assert.equal(kr.translate, true);
  assert.equal(kr.known, true);

  assert.equal(editionFor("kr").gl, "KR", "a lowercase code is still a country");
});

test("English-speaking countries get their own edition and no translation", async () => {
  const { editionFor } = await import("../lib/editions.js");
  for (const code of ["US", "GB", "AU", "IE", "NZ"]) {
    const e = editionFor(code);
    assert.equal(e.translate, false, `${code} should not be translated`);
    assert.equal(e.language, "English");
  }
  assert.equal(editionFor("GB").hl, "en-GB", "and it is the local one, not the US one");
});

test("an unknown country falls back without claiming to be local", async () => {
  const { editionFor } = await import("../lib/editions.js");
  for (const code of ["ZZ", "", null, undefined]) {
    const e = editionFor(code);
    assert.equal(e.known, false, "known:false is what stops it claiming a local front page");
    assert.equal(e.translate, false, "and nothing must claim to have been translated");
    assert.equal(e.gl, "US");
  }
});

test("a translation that changes the number of headlines is rejected", async () => {
  // The whole contract. The caller pairs translations back on by index, so a
  // model that merges two headlines would attach the wrong English to the wrong
  // story — worse than not translating, because it looks right.
  const { parseNumbered } = await import("../lib/translate.js");

  assert.deepEqual(parseNumbered("1. One\n2. Two\n3. Three", 3), ["One", "Two", "Three"]);
  assert.equal(parseNumbered("1. One\n2. Two", 3), null, "too few");
  assert.equal(parseNumbered("1. One\n2. Two\n3. Three\n4. Four", 3), null, "too many");
  assert.equal(parseNumbered("", 3), null);
});

test("the parser drops a preamble and copes with the numbering models actually use", async () => {
  const { parseNumbered } = await import("../lib/translate.js");

  // Small models add this constantly, and it must not become a headline.
  assert.deepEqual(parseNumbered("Here are the translations:\n1. One\n2. Two", 2), ["One", "Two"]);
  assert.deepEqual(parseNumbered("1) One\n2) Two", 2), ["One", "Two"]);
  assert.deepEqual(parseNumbered("1 - One\n2 - Two", 2), ["One", "Two"]);
  assert.deepEqual(parseNumbered("\n\n1. One\n\n2. Two\n\n", 2), ["One", "Two"]);
});

// ---------------------------------------------------------------------------
// The volume knob
//
// Ten clicks from full to silent, and the notch on the cabinet has to point at
// the same value the gain node is set to. Both ends are where this kind of
// control goes wrong: a dial that cannot quite reach zero, or one that wraps
// from silent to full because you clicked once past the stop.
// ---------------------------------------------------------------------------

test("volume clamps to 0..1 and never returns NaN", async () => {
  const { clampVolume } = await import("../public/volume.js");

  assert.equal(clampVolume(0.5), 0.5);
  assert.equal(clampVolume(2), 1, "above the top of the range");
  assert.equal(clampVolume(-3), 0, "below the bottom");

  // A NaN reaching a GainNode silences him permanently with nothing on screen
  // to explain it — the same failure class as a NaN in minLevel making the
  // microphone threshold unsatisfiable.
  for (const bad of [NaN, undefined, null, "", "loud", {}]) {
    assert.equal(clampVolume(bad), 1, `${String(bad)} falls back rather than silencing him`);
  }
  assert.equal(clampVolume("nonsense", 0.4), 0.4, "the fallback is the caller's to choose");

  // Zero is a real setting, not an absent one. `Number(null)` being a perfectly
  // finite 0 is how a pin with no coordinates once passed as Null Island.
  assert.equal(clampVolume(0), 0, "muted on purpose survives the clamp");
});

test("the knob reaches both stops exactly, and does not wrap", async () => {
  const { stepVolume, VOLUME_STEP } = await import("../public/volume.js");

  assert.equal(stepVolume(0.5, 1), 0.6);
  assert.equal(stepVolume(0.5, -1), 0.4);

  // Ten clicks down from full lands on exactly zero. Accumulated floating point
  // would leave 5.5e-17 here, and "is he muted" tested against that is the
  // knife-edge threshold this project has been caught by twice.
  let v = 1;
  for (let i = 0; i < 10; i++) v = stepVolume(v, -1);
  assert.equal(v, 0, "ten clicks down is silent, exactly");
  assert.equal(stepVolume(v, -1), 0, "and it stops there rather than wrapping to full");

  for (let i = 0; i < 10; i++) v = stepVolume(v, 1);
  assert.equal(v, 1, "and ten back up is full, exactly");
  assert.equal(stepVolume(v, 1), 1, "with no wrap at that end either");

  // Somewhere between two clicks — from the slider, which steps in 5s — snaps to
  // the grid rather than carrying the offset along for the rest of the range.
  assert.equal(stepVolume(0.65, -1), 0.6);
  assert.equal(stepVolume(0.65, 1), 0.7);
  assert.equal(VOLUME_STEP, 0.1, "ten segments on the readout means ten clicks");
});

test("the notch points where the volume actually is", async () => {
  const { volumeAngle } = await import("../public/volume.js");

  // The same arc the channel knob travels, centred on zero — silent at the left
  // stop, full at the right. Getting the sign backwards draws a knob that turns
  // down as you turn it up, and it is not obvious from the code which way round
  // it is: check it against a picture, not by reasoning.
  const sweep = 2.3;
  assert.equal(volumeAngle(0, sweep), -1.15, "silent is the left-hand stop");
  assert.equal(volumeAngle(1, sweep), 1.15, "full is the right-hand stop");
  assert.equal(volumeAngle(0.5, sweep), 0, "half is straight up");
  assert.ok(volumeAngle(0.7, sweep) > volumeAngle(0.3, sweep), "louder is further clockwise");
});

test("silence reads as a decision, not as a fault", async () => {
  const { volumeLabel } = await import("../public/volume.js");

  // 0% looks like a setting that could be a fault; MUTE looks like something
  // somebody chose. The same distinction the stale strip draws between no data
  // and old data.
  assert.equal(volumeLabel(0), "MUTE");
  assert.equal(volumeLabel(1), "100%");
  assert.equal(volumeLabel(0.7), "70%");
  assert.equal(volumeLabel(0.05), "5%", "quiet is still not muted");
});

test("the two earcons are different sounds, not the same one twice", async () => {
  const { EARCONS } = await import("../public/earcon.js");

  // Rendered through an OfflineAudioContext in a browser, these measure:
  //
  //   ident  1046 Hz alone at 40-140 ms, 784 Hz alone at 260-360 ms — it
  //          genuinely descends, one note then the other
  //   alert  853 and 960 Hz both present throughout, sustained for 0.85 s
  //
  // The browser is where that was proven; what is guarded here is the shape
  // those numbers come from, because a table is easy to edit into something
  // that no longer means what the comment beside it says.
  const ident = EARCONS.ident.notes;
  const alert = EARCONS.alert.notes;

  // The alert's two tones must be SIMULTANEOUS. Played in sequence they are a
  // completely different noise — the dissonant beating between them is the
  // entire character of the attention signal.
  assert.equal(new Set(alert.map((n) => n.at)).size, 1, "both tones start together");
  assert.deepEqual(alert.map((n) => n.freq).sort(), [853, 960], "the EBS attention pair");

  // The ident must DESCEND. A rising two-tone reads as a notification asking
  // for attention; a falling one reads as an announcement being made, which is
  // what it precedes.
  const order = [...new Set(ident.map((n) => n.at))].sort((a, b) => a - b);
  const freqAt = (at) => Math.max(...ident.filter((n) => n.at === at).map((n) => n.freq));
  assert.equal(order.length, 2, "two notes");
  assert.ok(freqAt(order[0]) > freqAt(order[1]), "the second note is lower than the first");

  // Everything has to fit through the speaker the set actually has: nothing
  // below 380 Hz or above 4200 survives speakerChain(), and a chime the speaker
  // cannot reproduce is a chime nobody hears.
  for (const note of [...ident, ...alert]) {
    assert.ok(note.freq > 380 && note.freq < 4200, `${note.freq} Hz is inside the speaker's band`);
  }

  // An alarm you have learned to ignore is worse than no alarm: the two must
  // not be the same length either.
  assert.ok(EARCONS.alert.totalMs > EARCONS.ident.totalMs * 1.4, "the warning is plainly longer");
});

// ---------------------------------------------------------------------------
// Page 888 — subtitles, and the mute they exist to answer
// ---------------------------------------------------------------------------

test("muting him turns the subtitles on, and 'off' is a choice rather than an accident", async () => {
  const { subtitlesFor } = await import("../public/subtitles.js");

  // The default, and the whole point: silence must not mean the answer never
  // arrived. He talks into a muted speaker, the conversation log records it,
  // and he follows up as though he told you something.
  assert.equal(subtitlesFor("auto", 0), true, "muted means subtitles");
  assert.equal(subtitlesFor("auto", 0.5), false, "audible means none");
  assert.equal(subtitlesFor(undefined, 0), true, "an absent setting still protects a muted set");

  assert.equal(subtitlesFor("always", 0.8), true);
  assert.equal(subtitlesFor("off", 0), false, "off is honoured even at zero volume");

  // A typo in config.json must not silently take the words away from somebody
  // who cannot hear him — there would be no error and no text, which is the
  // exact failure this feature removes.
  assert.equal(subtitlesFor("no thanks", 0), true, "an unrecognised mode falls back to auto");
});

test("the subtitle walks through a clip that holds several sentences", async () => {
  const { sentenceAt } = await import("../public/subtitles.js");

  // Sentences 2..N of a reply are now synthesized as ONE call so Piper picks
  // its own pauses. That removed the seam the subtitles used to sit on: one
  // clip would otherwise mean one subtitle for the whole remainder, clipped at
  // four lines — and on a muted set that is the only copy of the answer.
  const three = ["Aaaa.", "Bbbb.", "Cccc."]; // equal length, so thirds

  assert.equal(sentenceAt(three, 0), "Aaaa.");
  assert.equal(sentenceAt(three, 0.5), "Bbbb.");
  assert.equal(sentenceAt(three, 0.9), "Cccc.");
  assert.equal(sentenceAt(three, 1), "Cccc.", "the end of the clip is the last sentence, not past it");

  // Weighted by length: a long first sentence holds the subtitle longer, which
  // is the whole approximation — a TTS voice reads at a roughly constant rate.
  const uneven = ["A".repeat(90), "B".repeat(10)];
  assert.equal(sentenceAt(uneven, 0.5)[0], "A", "halfway through is still inside the long one");
  assert.equal(sentenceAt(uneven, 0.95)[0], "B");

  // Absence before conversion. Number(null) and Number("") are both 0, which is
  // a valid progress — so an unguarded version pins the subtitle to sentence one
  // for the whole clip and nothing looks wrong. Eighth place this could bite.
  for (const bad of [null, undefined, "", NaN, "half", {}]) {
    assert.equal(sentenceAt(three, bad), "Aaaa.", `progress ${JSON.stringify(bad)} falls back to the start`);
  }
  assert.equal(sentenceAt(three, -1), "Aaaa.", "clamped, not wrapped");
  assert.equal(sentenceAt(three, 5), "Cccc.");

  // Nothing to show is null rather than a crash or an empty string: the caller
  // passes it straight to face.setSpeech.
  assert.equal(sentenceAt([], 0.5), null);
  assert.equal(sentenceAt(null, 0.5), null);
  assert.equal(sentenceAt(["  ", ""], 0.5), null, "blank sentences are not sentences");
  assert.equal(sentenceAt(["Only one."], 0.7), "Only one.");
});

test("a subtitle wraps to the grid and says when it has been cut", async () => {
  const { subtitleLines } = await import("../public/subtitles.js");

  assert.deepEqual(subtitleLines("It is sixty eight degrees", 40), ["It is sixty eight degrees"]);
  assert.deepEqual(subtitleLines("", 40), []);
  assert.deepEqual(subtitleLines("   ", 40), [], "whitespace is not a sentence");

  const two = subtitleLines("It is sixty eight degrees and mostly cloudy this afternoon", 30);
  assert.equal(two.length, 2);
  for (const line of two) assert.ok(line.length <= 30, `"${line}" fits the grid`);

  // A word longer than the whole line is cut rather than allowed to run off the
  // edge of the picture.
  const long = subtitleLines("supercalifragilisticexpialidocious", 10, 1);
  assert.equal(long.length, 1);
  assert.ok(long[0].length <= 10);

  // Overflow has to LOOK like overflow. Without the ellipsis a clipped sentence
  // reads as Greg stopping mid-thought, which is a worse lie than the silence
  // subtitles exist to fix.
  const clipped = subtitleLines("one two three four five six seven eight nine ten eleven twelve", 20, 2);
  assert.equal(clipped.length, 2);
  assert.ok(clipped[1].endsWith("…"), "the cut is marked");
  for (const line of clipped) assert.ok(line.length <= 20);

  // And a sentence that exactly fits must NOT be marked as cut.
  const exact = subtitleLines("one two three", 13, 2);
  assert.deepEqual(exact, ["one two three"], "nothing lost, nothing marked");
});

// ---------------------------------------------------------------------------
// The set warming up, with sound
// ---------------------------------------------------------------------------

test("the POST beep tells the same truth as the POST screen", async () => {
  const { postBeeps } = await import("../public/earcon.js");
  const { deviceLines } = await import("../public/boot.js");

  const good = {
    hasBrain: true, brainLabel: "gemma4:e4b",
    listening: "local", speaking: "local", canSeeScreen: true,
    location: { city: "Chapel Hill", region: "North Carolina" },
  };
  assert.deepEqual(deviceLines(good).map((d) => d.ok), [true, true, true, true, true]);
  assert.equal(postBeeps(deviceLines(good)), 1, "a clean machine beeps once");

  // The picture already refuses to flatter: amber [ -- ] rows, and a copyright
  // line that stops claiming "all processing local" the moment anything is in
  // the cloud. The sound has to agree, or it becomes the one part of the
  // warm-up that lies.
  for (const degraded of [
    { ...good, speaking: "cloud" },
    { ...good, listening: "browser" },
    { ...good, canSeeScreen: false },
    { ...good, hasBrain: false },
    { ...good, location: {} },
  ]) {
    assert.equal(postBeeps(deviceLines(degraded)), 2, "anything missing beeps twice");
  }
  assert.equal(postBeeps([]), 1, "nothing known is not the same as something broken");
});

test("each warm-up beat is announced exactly once, and skipping ends the whine", async () => {
  const { BootSequence } = await import("../public/boot.js");

  const beats = [];
  const seq = new BootSequence({}, { onBeat: (name) => beats.push(name) });
  for (let t = 0; t < 6; t += 1 / 60) seq.update(1 / 60);

  assert.deepEqual(beats, ["strike", "open", "post", "end"], "in order, once each");

  // Skipping has to reach "end" too. A 15 kHz tone left running after somebody
  // clicked past the warm-up is an invisible fault: some people in the room can
  // hear it and others cannot, which is the worst way for it to be wrong.
  const cut = [];
  const skipped = new BootSequence({}, { onBeat: (name) => cut.push(name) });
  skipped.update(1 / 60);
  skipped.skip();
  assert.equal(cut.at(-1), "end", "a click during the warm-up still stops the sound");

  // A listener that throws must not take the picture down with it — this runs
  // inside the render loop, on the path that ends with the microphone opening.
  const angry = new BootSequence({}, { onBeat: () => { throw new Error("no speakers"); } });
  assert.doesNotThrow(() => angry.update(1 / 60));
});

// ---------------------------------------------------------------------------
// Sun and moon — the one channel that needs no network
//
// Astronomy is unusually satisfying to test because it has checkable right
// answers: an equinox really is twelve hours everywhere, the sun really does
// not rise over Tromsø in December, and a quarter moon really is half lit.
// ---------------------------------------------------------------------------

test("an equinox is twelve hours of daylight, anywhere", async () => {
  const { sunTimes, dayLength } = await import("../lib/sunmoon.js");

  // 20 March 2026 is the March equinox. Day length is within a few minutes of
  // 12 hours everywhere on earth — the residue is refraction and the sun's disc
  // having a width, which is exactly what the -0.833 degree altitude encodes.
  for (const [name, lat, lon] of [["equator", 0, 0], ["Chapel Hill", 35.9132, -79.0558], ["Reykjavik", 64.15, -21.94]]) {
    const { rise, set } = sunTimes(new Date("2026-03-20T12:00:00Z"), lat, lon);
    const { minutes } = dayLength(rise, set);
    assert.ok(Math.abs(minutes - 720) < 20, `${name}: ${minutes} minutes, expected about 720`);
  }
});

test("summer days are longer than winter days, and noon sits between", async () => {
  const { sunTimes, dayLength } = await import("../lib/sunmoon.js");
  const [lat, lon] = [35.9132, -79.0558];

  const summer = sunTimes(new Date("2026-06-21T12:00:00Z"), lat, lon);
  const winter = sunTimes(new Date("2026-12-21T12:00:00Z"), lat, lon);

  assert.ok(dayLength(summer.rise, summer.set).minutes > dayLength(winter.rise, winter.set).minutes + 200,
    "midsummer is hours longer than midwinter");

  // Ordering, which is the cheapest way to catch a sign error in the hour angle
  // — and a sign error there produces times that look perfectly plausible.
  for (const day of [summer, winter]) {
    assert.ok(day.rise < day.noon, "sunrise before solar noon");
    assert.ok(day.noon < day.set, "solar noon before sunset");
  }
});

test("polar day and polar night are stated, not returned as NaN", async () => {
  const { sunTimes } = await import("../lib/sunmoon.js");
  const [lat, lon] = [69.65, 18.96]; // Tromsø, well inside the Arctic circle

  const december = sunTimes(new Date("2026-12-21T12:00:00Z"), lat, lon);
  assert.equal(december.rise, null);
  assert.match(december.reason, /does not rise/);

  const june = sunTimes(new Date("2026-06-21T12:00:00Z"), lat, lon);
  assert.equal(june.set, null);
  assert.match(june.reason, /does not set/);

  // A NaN reaching the renderer prints "Invalid Date" and reads as a broken
  // feed. Both of these are facts about the place, not failures.
  assert.ok(december.noon instanceof Date && !Number.isNaN(december.noon.getTime()));
});

test("the moon's cycle comes back round, and a quarter is half lit", async () => {
  const { moonPhase, phaseName, SYNODIC_MONTH } = await import("../lib/sunmoon.js");

  // 6 January 2000, 18:14 UTC was a new moon; the maths counts from it.
  const newMoon = new Date(Date.UTC(2000, 0, 6, 18, 14));
  assert.ok(moonPhase(newMoon).illumination < 0.01, "new moon is dark");
  assert.equal(moonPhase(newMoon).name, "New Moon");

  const full = new Date(newMoon.getTime() + (SYNODIC_MONTH / 2) * 86400000);
  assert.ok(moonPhase(full).illumination > 0.99, "half a cycle later it is full");
  assert.equal(moonPhase(full).name, "Full Moon");

  // The name says quarter and the disc is half lit. Both are correct and they
  // disagree, which is exactly why the readout carries the number as well.
  const quarter = new Date(newMoon.getTime() + (SYNODIC_MONTH / 4) * 86400000);
  assert.equal(moonPhase(quarter).name, "First Quarter");
  assert.ok(Math.abs(moonPhase(quarter).illumination - 0.5) < 0.02, "a quarter moon is half lit");

  assert.equal(moonPhase(newMoon).waxing, true);
  assert.equal(moonPhase(new Date(newMoon.getTime() + 20 * 86400000)).waxing, false);

  // A full cycle later it is a new moon again, which catches a modulo that
  // drifts — and dates before the reference must not go negative.
  const nextNew = new Date(newMoon.getTime() + SYNODIC_MONTH * 86400000);
  assert.equal(moonPhase(nextNew).name, "New Moon");
  assert.ok(moonPhase(new Date("1985-06-01T00:00:00Z")).illumination >= 0, "dates before the reference still work");
  assert.equal(phaseName(1.25), "First Quarter", "the cycle wraps");
});

test("no coordinates means he says so rather than computing nonsense", async () => {
  const { sunAndMoon } = await import("../lib/sunmoon.js");

  for (const place of [{}, { city: "somewhere" }, { latitude: null, longitude: null }, { latitude: "x", longitude: 1 }]) {
    assert.match(sunAndMoon(place).error, /do not know where you are/);
  }

  const real = sunAndMoon({ city: "Chapel Hill", latitude: 35.9132, longitude: -79.0558 }, new Date("2026-08-10T16:00:00Z"));
  assert.equal(real.error, undefined);
  assert.ok(real.sunrise && real.sunset && real.dayLength, "a real place gets real times");
  assert.equal(typeof real.moon.illumination, "number");
});

// ---------------------------------------------------------------------------
// Air quality — and pollen being a fact about the PLACE
// ---------------------------------------------------------------------------

test("an AQI number is turned into the answer somebody actually wanted", async () => {
  const { aqiBand, airToSentence } = await import("../lib/airquality.js");

  // 51 means nothing on its own. The band is the answer to the question.
  assert.equal(aqiBand(51).name, "Moderate");
  assert.equal(aqiBand(50).name, "Good", "the boundary belongs to the lower band");
  assert.equal(aqiBand(0).name, "Good");
  assert.equal(aqiBand(101).name, "Unhealthy for Sensitive Groups");
  assert.equal(aqiBand(500).name, "Hazardous", "off the end of the scale still lands somewhere");

  for (const bad of [null, undefined, "", "smoggy", NaN]) {
    assert.equal(aqiBand(bad), null, `${String(bad)} is not a reading`);
  }

  assert.match(airToSentence({ place: "Chapel Hill", aqi: 51, band: "Moderate", advice: "Fine for most people." }), /Moderate, 51/);
  assert.match(airToSentence({ place: "Chapel Hill", aqi: null }), /could not get an air quality reading/);
  assert.match(airToSentence({ error: "nowhere to check" }), /nowhere to check/);
});

test("no pollen data and no pollen are different facts", async () => {
  const { pollenFrom, pollenLevel } = await import("../lib/airquality.js");

  // Measured on the user's own coordinates before this was written: every
  // pollen field comes back null in North Carolina, because Open-Meteo serves
  // pollen from a European model. Reading that as "no pollen today" would have
  // the channel report a clean spring morning for a place it knows nothing
  // about — the empty-alert-list failure in a new costume.
  assert.equal(pollenFrom({ us_aqi: 51, grass_pollen: null, birch_pollen: null }), null, "all null means not covered");
  assert.equal(pollenFrom({}), null);

  const covered = pollenFrom({ grass_pollen: 42, birch_pollen: 0, ragweed_pollen: 3 });
  assert.equal(covered.length, 3, "a zero IS a reading and must be kept");
  assert.equal(covered[0].name, "grass", "worst first");
  assert.equal(covered[0].level, "moderate");
  assert.equal(covered.at(-1).level, "none", "zero grains reads as none, not as missing");

  assert.equal(pollenLevel(0), "none");
  assert.equal(pollenLevel(19), "low");
  assert.equal(pollenLevel(60), "high");
  assert.equal(pollenLevel(500), "very high");
});


test("the two new channels answer to 'show me', not to over-broad words", async () => {
  const { resolveChannel } = await import("../lib/channels.js");

  // Asking for the picture works.
  assert.equal(resolveChannel("put on sun and moon")?.id, "sunmoon");
  assert.equal(resolveChannel("sun & moon")?.id, "sunmoon");
  assert.equal(resolveChannel("show me the moon phase")?.id, "sunmoon");
  assert.equal(resolveChannel("channel twelve")?.id, "sunmoon");
  assert.equal(resolveChannel("air quality")?.id, "air");
  assert.equal(resolveChannel("put the pollution up")?.id, "air");
  assert.equal(resolveChannel("channel 13")?.id, "air");

  // An alias must not be a word that turns up inside unrelated sentences. This
  // is NOT the claim that a question can never match a channel — the Weather
  // channel answers to "weather", deliberately, because get_weather exists for
  // the asking. It is the narrower claim that "air" and "pollen" were too broad
  // to be aliases at all, which is what the first version of this had.
  // (Scoped to the two channels added here. "put some music on" DOES resolve to
  // Now Playing, via that channel's own "music" alias — pre-existing, the same
  // accepted trade as Weather answering to "weather", and not something to fix
  // under cover of adding a channel.)
  for (const unrelated of [
    "book me a flight to the airport", "the air out there is lovely",
    "what time is it", "set a timer for nine minutes",
    "when is sunset", "is it a full moon tonight",
  ]) {
    assert.equal(resolveChannel(unrelated), null, `"${unrelated}" is not a channel`);
  }
});

// ---------------------------------------------------------------------------
// Telling a missing file from a broken one
//
// The television face is loaded with a dynamic import, and when that fails
// createFace falls back to the reduced face rather than throwing — a broken
// face must cost you the face, not the assistant. But the two reasons it can fail
// need different fixes: a module that could not be FETCHED means files are
// missing from the install, and a module that loaded and THREW is a bug here.
//
// Reported by somebody installing from a copied folder: the TV head never
// appeared and the only clue was "Failed to fetch dynamically imported module",
// which names no file and suggests no cause.
// ---------------------------------------------------------------------------

test("a module that could not be fetched is told apart from one that threw", async () => {
  const { isMissingModule } = await import("../public/face.js");

  // The real strings, as each browser words them.
  for (const message of [
    "Failed to fetch dynamically imported module: http://localhost:4747/face-tv.js",   // Chrome
    "error loading dynamically imported module",                                        // Firefox
    "Failed to load module script: Expected a JavaScript module script",                // MIME refusal
  ]) {
    assert.equal(isMissingModule(new Error(message)), true, message);
  }

  // A genuine bug inside the module must NOT be reported as a missing file, or
  // the advice sends somebody to reinstall over a fault a reinstall cannot fix.
  for (const message of [
    "canvas.getContext is not a function",
    "Cannot read properties of undefined (reading 'width')",
    "RENDERERS is not defined",
  ]) {
    assert.equal(isMissingModule(new Error(message)), false, message);
  }

  assert.equal(isMissingModule(undefined), false, "no error at all is not a missing module");
});

test("the advice names the right number of channel renderer files", () => {
  // face.js tells the user public/channels/ must hold N files. That number is
  // written into a string a human reads, so nothing stops it going stale the
  // day somebody adds a channel — the same defect as the startup banner that
  // listed four of six personality dials. This is the ratchet.
  const source = fs.readFileSync(new URL("../public/face.js", import.meta.url), "utf8");
  const claimed = Number(source.match(/public\/channels\/ (?:holds|must contain all) (\d+) files/)?.[1]);
  assert.ok(Number.isFinite(claimed), "face.js should state how many files public/channels/ holds");

  const actual = fs.readdirSync(new URL("../public/channels", import.meta.url)).filter((f) => f.endsWith(".js")).length;
  assert.equal(claimed, actual, `face.js claims ${claimed} files in public/channels/, there are ${actual}`);
});

// ---------------------------------------------------------------------------
// Telling somebody how to set Spotify up
//
// It needs a Spotify app, a redirect URI, a client id in .env and one visit to
// an authorise link — none of it discoverable from inside Greg. Somebody who
// asks him to play a song and is told he cannot has nowhere to go.
//
// Three states, kept apart because each needs something different. Collapsing
// them would send somebody who already has a client id off to create a second
// Spotify app.
// ---------------------------------------------------------------------------

test("each stage of Spotify setup gets its own instruction", async () => {
  const { spotifyGuidance } = await import("../public/spotify-help.js");
  const origin = "http://127.0.0.1:4747";

  const off = spotifyGuidance({ enabled: false }, origin);
  assert.equal(off.state, "off");

  const fresh = spotifyGuidance({ enabled: true, configured: false, connected: false }, origin);
  assert.equal(fresh.state, "unconfigured");
  assert.match(fresh.steps.join(" "), /developer\.spotify\.com/);
  // The literal 127.0.0.1 is not a style choice — Spotify rejects "localhost".
  assert.match(fresh.steps.join(" "), /127\.0\.0\.1/);
  assert.match(fresh.steps.join(" "), /localhost/, "it should say WHY, or somebody will 'fix' it");
  // A step that needs a restart must say so, or the dialog implies it took effect.
  assert.match(fresh.steps.join(" "), /[Rr]estart/);
  assert.equal(fresh.action, null, "nothing to click until there is a client id");

  const ready = spotifyGuidance({ enabled: true, configured: true, connected: false }, origin);
  assert.equal(ready.state, "unauthorised");
  assert.ok(ready.action, "this is the one live step, so it gets a button");
  assert.match(ready.action.url, /\/api\/spotify\/login$/);
  assert.doesNotMatch(ready.steps.join(" "), /developer\.spotify\.com/, "they already made the app");

  const done = spotifyGuidance({ enabled: true, configured: true, connected: true }, origin);
  assert.equal(done.state, "connected");
  assert.equal(done.action, null);
  // The two things that still stop it working even when connected.
  assert.match(done.steps.join(" "), /Premium/);
  assert.match(done.steps.join(" "), /open/i);
});

test("the setup advice survives an empty or missing status", () => {
  // /api/settings is fetched over HTTP; the shape cannot be assumed.
  const load = async () => (await import("../public/spotify-help.js")).spotifyGuidance;
  return load().then((spotifyGuidance) => {
    for (const bad of [undefined, {}, null]) {
      const guide = spotifyGuidance(bad ?? {}, "");
      assert.ok(guide.headline?.length > 10, String(bad));
      assert.doesNotMatch(guide.steps.join(" "), /undefined|null/, "no holes in the instructions");
    }
  });
});

// ---------------------------------------------------------------------------
// Eyes closed at startup, without becoming eyes that can never open
//
// `vision.enabled: false` already existed and records proven:false — which makes
// setVisionEnabled refuse forever with "the model failed its eyesight test". The
// test never ran, so that is a lie, and it is the proven/enabled conflation this
// project keeps apart arriving through the config file.
//
// `openAtStartup: false` is the third state: nothing established either way, the
// 5.9 GB model never loaded, and the real test run the first time somebody asks
// to see something.
// ---------------------------------------------------------------------------

test("eyes can start closed without the model ever loading", async () => {
  const { verifyVision, visionStatus } = await import("../lib/vision.js");

  let described = 0;
  const provider = { describeImage: async () => { described++; return "red"; } };

  const status = await verifyVision(provider, { vision: { openAtStartup: false } });

  assert.equal(described, 0, "the whole point: no swatch test, so no 5.9 GB model load");
  assert.equal(status.enabled, false, "closed");
  assert.equal(status.ok, false);
  assert.equal(status.checked, false, "NOT checked — as against checked and failed");
  assert.equal(status.proven, false);
  assert.match(status.reason, /start closed/i);
  assert.doesNotMatch(status.reason, /fail/i, "nothing failed; do not say it did");
});

test("and opening them later runs the test that was deferred", async () => {
  const { verifyVision, proveVision, setVisionEnabled, visionStatus } = await import("../lib/vision.js");

  let described = 0;
  const provider = {
    describeImage: async ({ imageBase64 }) => {
      described++;
      // Answer each swatch correctly, in the order SWATCHES declares them.
      return described === 1 ? "red" : "blue";
    },
  };

  await verifyVision(provider, { vision: { openAtStartup: false } });
  assert.equal(setVisionEnabled(true).ok, false, "cannot open eyes that were never tested");

  // What setVision does before flipping the switch.
  await proveVision({ vision: {} });
  assert.equal(described, 2, "both swatches, exactly once each");
  assert.equal(visionStatus().proven, true, "a model that passes is now proven");
  assert.equal(setVisionEnabled(true).ok, true, "and can be turned on");
});

test("a model that fails the deferred test is refused, not quietly enabled", async () => {
  // The one thing this must never become: a way to arm the screen tool without
  // passing the swatch test. gemma4 reports vision it does not have and answers
  // "Black" to every colour.
  const { verifyVision, proveVision, setVisionEnabled } = await import("../lib/vision.js");

  const blind = { describeImage: async () => "Black" };
  await verifyVision(blind, { vision: { openAtStartup: false } });
  await proveVision({ vision: {} });

  const result = setVisionEnabled(true);
  assert.equal(result.ok, false, "deferring the test must not become skipping it");
  assert.match(result.error, /eyesight test/i);
});
