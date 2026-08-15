// The three ways Greg can be unable to look at your screen, kept apart.
//
// This project's oldest and most expensive lesson is a model that reports a
// capability it does not have — gemma4 describing a screen it never received,
// fluently and wrongly. The swatch test in lib/vision.js exists to stop that,
// and `proven` (a fact about the model) is deliberately never collapsed into
// `enabled` (a preference), so a switch cannot become a way around the proof.
//
// Mini Greg adds a third way, and it is the reason this file exists: on a small
// card the eyes are switched off in config.json, because a 5.9 GB vision model
// cannot load beside a 2.8 GB cloned voice on 8 GB. That state must not be
// reported as a model that FAILED — it sat no test. Telling somebody their
// hardware cannot do a thing it can is the same confident wrongness pointed the
// other way.
//
// Nothing here loads a model. The failing provider is a stub returning "Black",
// which is what gemma4 genuinely answers to every colour swatch.

import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyVision, setVisionEnabled, visionStatus } from "../lib/vision.js";
import { buildSystemPrompt } from "../lib/brain.js";

// Module state is shared, so these run in order: the untested case has to be
// asserted before anything calls verifyVision and marks the state checked.
test("before any test has run, the refusal says exactly that", () => {
  assert.equal(visionStatus().checked, false);
  const result = setVisionEnabled(true);
  assert.equal(result.ok, false);
  assert.match(result.error, /has not run/);
  assert.doesNotMatch(result.error, /failed/);
});

test("switched off in config is reported as a decision, not a failure", async () => {
  await verifyVision(null, { vision: { enabled: false } });

  const status = visionStatus();
  assert.equal(status.proven, false);
  assert.equal(status.enabled, false);
  assert.equal(status.ok, false);

  const result = setVisionEnabled(true);
  assert.equal(result.ok, false);
  // The whole point. This used to read "the model failed its eyesight test at
  // startup — switched off in config.json", which leads with a false clause
  // about a test that never happened.
  assert.doesNotMatch(result.error, /failed its eyesight test/);
  assert.match(result.error, /switched off in config\.json/);
  // And it has to be actionable: the reader cannot fix this by asking again.
  assert.match(result.error, /vision\.enabled/);
});

test("a model that really fails the swatch test is still told so", async () => {
  // gemma4's actual answer to a solid red swatch.
  await verifyVision({ describeImage: async () => "Black" }, { vision: {} });

  assert.equal(visionStatus().proven, false);
  const result = setVisionEnabled(true);
  assert.equal(result.ok, false);
  assert.match(result.error, /failed its eyesight test/);
  // A real failure must NOT be softened into "switched off", or the swatch test
  // stops meaning anything.
  assert.doesNotMatch(result.error, /switched off in config/);
});

test("with the eyes off, Greg is told plainly that he cannot see", async () => {
  await verifyVision(null, { vision: { enabled: false } });

  const prompt = buildSystemPrompt({ name: "Greg" }, "Chapel Hill, North Carolina");
  assert.match(prompt, /CANNOT see the user's screen/);
  // He must not offer to turn them back on: that branch is for eyes that were
  // proven and then switched off at runtime, where the offer can be honoured.
  // Under config-disabled it needs a restart, so offering would be a promise
  // Greg cannot keep.
  assert.doesNotMatch(prompt, /offer to turn them back on/);
});
