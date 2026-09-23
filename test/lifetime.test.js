// Greg.exe gives Greg no console, so closing his window is how he is stopped.
// These prove the decision in lib/lifetime.js without waiting fifteen seconds:
// the timer is a fake that runs when the test says so.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createWindowWatch, startedByLauncher, GRACE_MS } from "../lib/lifetime.js";

/** A clock the test drives: `run()` fires whatever is pending. */
function fakeClock() {
  const pending = new Map();
  let next = 1;
  return {
    setTimer(fn, ms) {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      pending.delete(id);
    },
    run() {
      const due = [...pending.values()];
      pending.clear();
      for (const { fn } of due) fn();
    },
    get waiting() {
      return pending.size;
    },
    get lastMs() {
      return [...pending.values()].at(-1)?.ms;
    },
  };
}

function watch() {
  const clock = fakeClock();
  let stops = 0;
  const w = createWindowWatch({ onAllClosed: () => stops++, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  return { w, clock, stops: () => stops };
}

test("closing the only window stops him, after the grace period", () => {
  const { w, clock, stops } = watch();
  w.opened();
  w.closed();
  assert.equal(clock.waiting, 1);
  assert.equal(clock.lastMs, GRACE_MS);
  assert.equal(stops(), 0, "not immediately: a reload looks exactly like this for a second");
  clock.run();
  assert.equal(stops(), 1);
});

test("a reload inside the grace period keeps him running", () => {
  const { w, clock, stops } = watch();
  w.opened();
  w.closed();
  w.opened(); // the reloaded page
  assert.equal(clock.waiting, 0, "the countdown is cancelled, not merely outlived");
  clock.run();
  assert.equal(stops(), 0);
  assert.equal(w.open, 1);
});

test("no window yet is not a closed window", () => {
  // A first run can take minutes before the window even opens.
  const { w, clock, stops } = watch();
  w.closed();
  assert.equal(clock.waiting, 0);
  clock.run();
  assert.equal(stops(), 0);
});

test("two windows: only the last one closing counts", () => {
  const { w, clock, stops } = watch();
  w.opened();
  w.opened();
  w.closed();
  assert.equal(clock.waiting, 0, "one is still open");
  w.closed();
  clock.run();
  assert.equal(stops(), 1);
});

test("it stops him once, however the closes arrive", () => {
  const { w, clock, stops } = watch();
  w.opened();
  w.closed();
  w.closed(); // a stray close for a stream that was never counted
  assert.equal(w.open, 0, "never below zero");
  assert.equal(clock.waiting, 1, "one countdown, not two");
  clock.run();
  w.opened();
  w.closed();
  clock.run();
  assert.equal(stops(), 1);
});

test("only Greg.exe asks for any of this", () => {
  assert.equal(startedByLauncher({ GREG_LAUNCHER: "1" }), true);
  for (const env of [{}, { GREG_LAUNCHER: "0" }, { GREG_LAUNCHER: "" }, { GREG_LAUNCHER: "true" }, null, undefined]) {
    assert.equal(startedByLauncher(env), false, JSON.stringify(env));
  }
});
