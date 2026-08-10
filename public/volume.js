// How loud Greg is — the decisions, with no DOM anywhere near them.
//
// Split out for the reason public/wake.js was: voice.js reaches for `document`
// on its eleventh line and does a top-level `await createFace(...)` on its
// thirty-second, so Node cannot import that file at all and nothing inside it
// can ever be proven. The three judgements here — where to clamp, how far a
// click on the knob moves it, and where the notch points — are exactly the kind
// of thing this project has been bitten by: an off-by-one at the end of the
// range is invisible until the knob will not quite reach zero.
//
// face-tv.js draws the knob from volumeAngle(); voice.js steps it with
// stepVolume(). Both read the same numbers, so the dial you turn and the dial
// you see cannot disagree — the mistake floatOffset() was extracted to fix.

/**
 * 0..1, and never NaN. A NaN reaching a GainNode silences him permanently, with
 * nothing on screen to explain why.
 *
 * Absence is tested for BEFORE conversion, and that ordering is the whole
 * function. `Number(null)` is 0, `Number("")` is 0, and 0 is a perfectly valid
 * volume — so a config.json written before this setting existed, or a field that
 * arrived empty, would convert cleanly to silent and look like a deliberate
 * mute. It is the same one-line mistake that once accepted a location pin with
 * no coordinates as (0, 0), in the Atlantic off the coast of Ghana.
 */
export function clampVolume(value, fallback = 1) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

/** How far one click on the knob moves it. Ten steps end to end. */
export const VOLUME_STEP = 0.1;

/**
 * Turn the volume knob. `step` is +1 louder, -1 quieter.
 *
 * Deliberately NOT wrapped, unlike the channel knob. A dial that goes from
 * silent to full because you clicked once past the end is a genuinely unpleasant
 * surprise at two in the morning, and a volume control has ends — that is what
 * distinguishes it from a selector.
 *
 * Snapped to the grid, so ten clicks down from 1 is exactly 0 rather than
 * 5.5e-17: a "muted" test against a float that is nearly zero is the knife-edge
 * threshold this project has been caught by twice.
 *
 * A click moves to the next grid point in that DIRECTION, rather than adding a
 * step and rounding. From 0.65 — which the settings slider can produce, since it
 * steps in fives — adding and rounding gives 0.75, which rounds up to 0.8: the
 * knob would jump two places for one click. Off-grid values are the only case
 * where the two differ, and they are exactly the case that reaches this.
 *
 * The epsilon is doing real work and is not a knife edge: 0.3 / 0.1 is
 * 2.9999999999999996 in floating point, so flooring it lands on 2 and a click
 * "up" from 0.3 returns 0.3. Nine orders of magnitude of margin against a grid
 * of 0.1 — the opposite of the 1.28-against-1.29 thresholds this project has
 * been bitten by.
 */
export function stepVolume(current, step, size = VOLUME_STEP) {
  const units = clampVolume(current) / size;
  const next = step >= 0 ? Math.floor(units + 1e-9) + 1 : Math.ceil(units - 1e-9) - 1;
  return clampVolume(Number((next * size).toFixed(4)));
}

/**
 * Where the notch points, in radians, for a volume of 0..1.
 *
 * `sweep` is the same arc the channel knob travels — passed in rather than
 * defined here so face-tv.js keeps one KNOB_SWEEP and the two dials are visibly
 * the same piece of hardware. Centred on 0 exactly as channelAngle() is: silent
 * at the left end of the travel, full at the right.
 */
export function volumeAngle(volume, sweep) {
  return (clampVolume(volume) - 0.5) * sweep;
}

/**
 * What the on-screen readout says.
 *
 * Zero is "MUTE" and not "0%", because they answer different questions: 0%
 * looks like a setting that could be a fault, MUTE looks like a decision. The
 * same distinction the stale strip draws between "no data" and "old data".
 */
export function volumeLabel(volume) {
  const v = clampVolume(volume);
  return v <= 0 ? "MUTE" : `${Math.round(v * 100)}%`;
}
