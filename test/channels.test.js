// The channel renderers, driven at the two states nobody looks at.
//
// Every renderer opens the same way: no data yet, or the feed came back with an
// error. Those are the frames a person actually sees first — a channel is
// always in one of them for the moment after you turn the dial, and an add-on
// sits in the first one until its feed answers.
//
// They are also the frames that never get rendered during development, because
// by the time you switch to a channel to look at it the data has arrived. Three
// renderers shipped calling standby() with positional strings instead of the
// options object it takes:
//
//   standby(ctx, x, y, w, h, "AIR QUALITY", "reading the air")   <- wrong
//   standby(ctx, x, y, w, h, { message: "AIR QUALITY", ... })    <- right
//
// Destructuring { message, detail } from a string gives undefined for both, so
// fillText drew the literal word "undefined" and the detail line — which is
// where the error message lives — vanished silently. Live in air, sunmoon and
// every user-added channel.
//
// The renderers need no DOM: they take a 2D context as a parameter, so a stub
// that records what was drawn proves this in milliseconds. That is the same
// argument LocalListener's tests make — the level logic is provable in Node
// even though the wiring is not.

import { test } from "node:test";
import assert from "node:assert/strict";

import { RENDERERS } from "../public/channels/index.js";
import { draw as drawAddon } from "../public/channels/addon.js";

/**
 * A canvas that remembers its text instead of painting it.
 *
 * Every method is a no-op except measureText, which has to return something
 * plausible or ellipsize() loops, and fillText, which is the whole point.
 */
function stubContext() {
  const texts = [];
  const gradient = { addColorStop() {} };
  const ctx = {
    texts,
    fillStyle: "", strokeStyle: "", font: "10px sans-serif",
    textAlign: "left", textBaseline: "top",
    globalAlpha: 1, globalCompositeOperation: "source-over",
    lineWidth: 1, lineCap: "butt", lineJoin: "miter",
    fillText: (t) => texts.push(t),
    measureText: (t) => ({ width: String(t).length * 6 }),
    createLinearGradient: () => gradient,
    createConicGradient: () => gradient,
  };
  for (const name of [
    "save", "restore", "beginPath", "closePath", "fill", "stroke", "clip",
    "fillRect", "rect", "arc", "ellipse", "moveTo", "lineTo", "translate",
    "rotate", "setLineDash", "drawImage",
  ]) ctx[name] = () => {};
  return ctx;
}

/** The read-only surface a renderer gets from the face — see viewFor(). */
function stubView(feed) {
  return {
    feed: () => feed,
    time: new Date("2026-08-10T15:04:00Z"),
    pageSince: 0,
    photo: null,
    radarFrames: [],
  };
}

const SIZE = [0, 0, 400, 300];

test("no renderer draws undefined before its data arrives", () => {
  // The bug in one assertion. It is deliberately about the drawn TEXT rather
  // than about how standby is called: a renderer is free to draw its waiting
  // state however it likes, and what must never happen is the word "undefined"
  // reaching the glass.
  for (const [id, draw] of Object.entries(RENDERERS)) {
    const ctx = stubContext();
    draw(ctx, ...SIZE, stubView(null));

    assert.ok(ctx.texts.length, `${id} drew no text at all with no data`);
    for (const t of ctx.texts) {
      assert.notEqual(t, undefined, `${id} passed undefined to fillText with no data`);
      assert.notEqual(String(t), "undefined", `${id} drew the string "undefined" with no data`);
      assert.notEqual(String(t), "null", `${id} drew the string "null" with no data`);
    }
  }
});

test("a feed error reaches the screen rather than being swallowed", () => {
  // The detail line is where the error lives, and it is the half a positional
  // call dropped: a channel that had FAILED looked identical to one still
  // loading, because standby's `detail` defaulted to "".
  //
  // agenda is exempt and that is not an oversight. It is the one channel that
  // touches no network — it reads the same local reminder store list_reminders
  // reads — so it has no error branch to test. Worth knowing that it would
  // render a store failure as "NOTHING SCHEDULED", which is the wrong way round
  // for that particular claim, but that is a different defect from this one.
  const message = "the feed refused the request";

  for (const [id, draw] of Object.entries(RENDERERS)) {
    if (id === "agenda") continue;

    const ctx = stubContext();
    draw(ctx, ...SIZE, stubView({ error: message }));

    assert.ok(
      ctx.texts.join(" ").includes(message),
      `${id} never showed the error; it drew ${JSON.stringify(ctx.texts)}`,
    );
  }
});

test("the three renderers that got it wrong name themselves while they wait", () => {
  // Not a rule for every channel — most speak broadcast rather than naming
  // themselves ("TUNING IN", "NO SIGNAL", "SEARCHING"), and ceefax says "PAGE
  // NOT FOUND" because that is what teletext said. These three chose to print
  // their own name, and printing it is exactly what the positional call broke.
  for (const [id, expected] of [["air", "AIR QUALITY"], ["sunmoon", "SUN & MOON"]]) {
    const ctx = stubContext();
    RENDERERS[id](ctx, ...SIZE, stubView(null));
    assert.ok(
      ctx.texts.join(" ").includes(expected),
      `${id} drew ${JSON.stringify(ctx.texts)} instead of naming itself`,
    );
  }
});

test("an add-on channel names itself and its error while it waits", () => {
  // Not in RENDERERS: it takes the channel as a seventh argument, because one
  // renderer serves every user-added channel. It is also the one most likely
  // to sit in the loading state, since a feed somebody else wrote may never
  // answer at all.
  const channel = { id: "tides", name: "Tides", display: {} };

  const loading = stubContext();
  drawAddon(loading, ...SIZE, stubView(null), channel);
  assert.ok(
    loading.texts.join(" ").toUpperCase().includes("TIDES"),
    `an add-on waiting for its feed drew ${JSON.stringify(loading.texts)}`,
  );
  for (const t of loading.texts) {
    assert.notEqual(String(t), "undefined", "an add-on drew undefined while waiting");
  }

  const failed = stubContext();
  drawAddon(failed, ...SIZE, stubView({ error: "no such host" }), channel);
  assert.ok(
    failed.texts.join(" ").includes("no such host"),
    `an add-on that failed drew ${JSON.stringify(failed.texts)}`,
  );
});
