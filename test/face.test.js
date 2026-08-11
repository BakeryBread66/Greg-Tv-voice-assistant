// The reduced face — the last thing standing between a broken renderer and a
// dead page.
//
// It is worth more tests than its size suggests, because everything about its
// situation is hostile. It runs when something else has already failed, on a
// machine whose install may be incomplete, and it is reached from a top-level
// await in voice.js — so a throw here costs the user their microphone, their
// buttons and their listeners while the HTML carries on looking fine. The one
// thing it must never do is fail.
//
// It needs no browser: it takes a canvas and asks it for a 2D context, so a
// stub that records what it was told proves the drawing. Same argument
// LocalListener's tests make — the level logic is provable in Node even though
// the wiring is not.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createFace, isMissingModule } from "../public/face.js";

/** A canvas that remembers rather than paints. */
function stubCanvas({ width = 300, height = 300 } = {}) {
  const calls = [];
  const texts = [];
  const ctx = new Proxy({
    fillText: (t) => { texts.push(t); calls.push(["fillText", t]); },
    measureText: (t) => ({ width: String(t).length * 6 }),
    setTransform: (...a) => calls.push(["setTransform", ...a]),
    arc: (...a) => calls.push(["arc", ...a]),
    fillRect: (...a) => calls.push(["fillRect", ...a]),
    stroke: () => calls.push(["stroke"]),
    beginPath: () => calls.push(["beginPath"]),
  }, {
    get: (t, k) => (k in t ? t[k] : typeof k === "string" ? (t[k] = () => {}) : undefined),
    set: (t, k, v) => { t[k] = v; return true; },
  });

  return {
    calls, texts, ctx,
    width: 0, height: 0,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ width, height }),
  };
}

/** The globals face.js reaches for, installed for the length of one test. */
function withBrowser(fn, { dpr = 1 } = {}) {
  const had = { w: globalThis.window, d: globalThis.document, p: globalThis.performance };
  globalThis.window = { devicePixelRatio: dpr };
  globalThis.document = { getElementById: () => null };
  globalThis.performance ??= { now: () => 0 };
  try { return fn(globalThis.window); }
  finally {
    globalThis.window = had.w;
    globalThis.document = had.d;
    globalThis.performance = had.p;
  }
}

async function minimalFace(canvas, opts) {
  return withBrowser(async () => (await createFace(canvas, "minimal")).face, opts);
}

test("asking for the reduced face gets it, with the four required methods", async () => {
  const canvas = stubCanvas();
  const { face, renderer } = await withBrowser(() => createFace(canvas, "minimal"));

  assert.equal(renderer, "minimal");
  // The entire contract between a face and everything else. Anything beyond
  // these is called with `?.` by voice.js and may be absent.
  for (const m of ["setState", "setLevel", "setSpectrum", "start"]) {
    assert.equal(typeof face[m], "function", `a face must have ${m}()`);
  }
});

test("it draws every state voice.js can set, and never the word undefined", async () => {
  // The five states are fixed: setMode maps everything onto these.
  for (const state of ["idle", "listening", "thinking", "speaking", "error"]) {
    const canvas = stubCanvas();
    const face = await minimalFace(canvas);
    face.setState(state);
    face.setLevel(0.5);
    withBrowser(() => { face.measure(); face.draw(0.016); });

    assert.ok(canvas.texts.length, `${state} drew no text`);
    for (const t of canvas.texts) {
      assert.notEqual(String(t), "undefined", `${state} drew "undefined"`);
      assert.notEqual(String(t), "null", `${state} drew "null"`);
    }
    assert.ok(
      canvas.texts.includes("REDUCED FACE"),
      `${state} never said it is the reduced face — which is how somebody ends up reporting it as Greg looking wrong`,
    );
  }
});

test("an unknown state is ignored rather than blanking the face", async () => {
  // Same rule the subtitle modes follow: an unrecognised value must not take
  // the picture away. It keeps the last good state.
  const canvas = stubCanvas();
  const face = await minimalFace(canvas);
  face.setState("listening");
  face.setState("nonsense");
  withBrowser(() => { face.measure(); face.draw(0.016); });

  assert.ok(canvas.texts.includes("LISTENING"), "an unknown state threw away a good one");
});

test("absence and nonsense in the level are survived, not converted", async () => {
  // Number(null) is 0 and Number("") is 0 — six occurrences across five modules
  // in one session of this project's history. Here the danger is NaN: it
  // propagates into the radius and canvas silently stops drawing the arc.
  const canvas = stubCanvas();
  const face = await minimalFace(canvas);

  for (const bad of [null, undefined, "", NaN, "loud", {}, -5, 99]) {
    face.setLevel(bad);
    assert.ok(
      Number.isFinite(face.level) && face.level >= 0 && face.level <= 1,
      `setLevel(${JSON.stringify(bad)}) left level as ${face.level}`,
    );
  }

  // And the spectrum is accepted and ignored, in every shape voice.js sends.
  for (const s of [null, new Uint8Array(8)]) {
    assert.doesNotThrow(() => face.setSpectrum(s));
  }
});

test("a canvas laid out at zero is survived and picked up later", async () => {
  // A zero-sized canvas is what killed the television face on a real
  // multi-monitor machine: drawImage raises rather than quietly doing nothing.
  // This face must simply wait for a frame with a size.
  const canvas = stubCanvas({ width: 0, height: 0 });
  const face = await minimalFace(canvas);

  withBrowser(() => {
    assert.doesNotThrow(() => { face.measure(); face.draw(0.016); }, "zero size threw");
  });
  assert.equal(canvas.texts.length, 0, "it drew into a canvas with no size");

  // Now give it a size, as a settled layout would.
  canvas.getBoundingClientRect = () => ({ width: 300, height: 300 });
  withBrowser(() => { face.measure(); face.draw(0.016); });
  assert.ok(canvas.texts.includes("REDUCED FACE"), "it never recovered once laid out");
});

test("the backing store follows a device pixel ratio change", async () => {
  // The bug both helmets carried to the end. Moving the window to a monitor
  // with different scaling fires neither `resize` nor a ResizeObserver, so the
  // canvas keeps its old resolution and draws soft.
  const canvas = stubCanvas({ width: 300, height: 300 });
  const face = await minimalFace(canvas);

  withBrowser(() => face.measure(), { dpr: 1 });
  assert.equal(canvas.width, 300, "at ratio 1 the backing store should match the CSS size");

  withBrowser(() => face.measure(), { dpr: 2 });
  assert.equal(canvas.width, 600, "the backing store did not follow the ratio to 2");
});

test("a render loop survives a frame that throws", async () => {
  // Some causes are transient, and giving up on the first bad frame turns a
  // flicker into a permanently blank screen — which is the failure this face
  // exists to prevent.
  const canvas = stubCanvas();
  const face = await minimalFace(canvas);

  let frames = 0;
  const raf = (fn) => { if (frames++ < 3) fn(frames * 16); };

  withBrowser(() => {
    globalThis.requestAnimationFrame = raf;
    // Poison one frame the way a real canvas fault would.
    const good = face.draw.bind(face);
    let n = 0;
    face.draw = (dt) => { if (n++ === 0) throw new Error("bad frame"); return good(dt); };
    assert.doesNotThrow(() => face.start(), "a throwing frame escaped the loop");
  });

  assert.ok(frames > 1, "the loop stopped after the first bad frame");
  delete globalThis.requestAnimationFrame;
});

test("a fetch failure is still told apart from a bug", () => {
  // Unchanged by the helmets going, and the reason the badge can say "files
  // missing from this install" rather than quoting a stack.
  assert.equal(isMissingModule(new Error("Failed to fetch dynamically imported module: /face-tv.js")), true);
  assert.equal(isMissingModule(new Error("canvas.getContext is not a function")), false);
});
