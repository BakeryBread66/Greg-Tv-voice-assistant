// Putting Greg's voice through the television.
//
// Not a vocoder in the strict sense — a real one needs a carrier and a filter
// bank, and what it does to speech is famous rather than pleasant. This is the
// thing people mean when they say vocoder: band-limit it like a small speaker,
// drive it a little, and ring-modulate it just enough to sound electrical.
//
// It runs in the browser on the audio as it plays, which is what makes it work
// on EVERY voice — the cloned one, Piper, Windows' own, the cloud, and the
// browser's own fallback. A treatment done in the synthesiser would have to be
// done four times and would miss the last one entirely.
//
//   input ──┬─────────── dry ─────────────┐
//           │                              ├── output
//           └── highpass ─ lowpass ─ drive ─ ring ── wet ┘
//
// The dry path is what keeps it intelligible. Full ring modulation is a great
// noise and a terrible way to hear the weather, so even at maximum some of the
// clean signal comes through.

/**
 * How the single "amount" dial maps onto the three things that actually move.
 *
 * Exported and pure so it can be checked without an AudioContext — the graph
 * below cannot be tested outside a browser, but the numbers driving it can.
 */
export function mixFor(amount) {
  const a = Math.max(0, Math.min(1, Number(amount) || 0));
  return {
    // Never reaches zero: at full wet the words stop being words.
    dry: 1 - a * 0.72,
    wet: a,
    // Ring depth climbs with the dial but starts high enough that a low setting
    // is still audibly an effect rather than a slightly muffled voice.
    depth: 0.35 + a * 0.5,
    // Low carrier: 38 Hz buzzes and stays intelligible. Above about 120 it
    // turns into a different, much less useful noise.
    carrier: 38,
  };
}

/** A gentle asymmetric drive. Sounds like a small amplifier working hard. */
function driveCurve(samples = 1024) {
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = Math.tanh(x * 2.2);
  }
  return curve;
}

/**
 * Build the effect and hand back its two ends.
 *
 * Returns null rather than throwing if the browser is missing anything — this
 * sits in the path Greg's voice travels down, and an effect failing to build
 * must cost the effect, not the speech.
 */
export function createVocoder(ctx) {
  try {
    const input = ctx.createGain();
    const output = ctx.createGain();

    const dry = ctx.createGain();
    const wet = ctx.createGain();

    const high = ctx.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = 240;

    const low = ctx.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = 3600;

    const shaper = ctx.createWaveShaper();
    shaper.curve = driveCurve();
    shaper.oversample = "2x";

    // Ring modulation: a gain whose value is driven by an oscillator rather than
    // set. Base value 0 so the gain swings through negative — multiplying by a
    // signal that crosses zero is what makes it ring rather than tremolo.
    const ring = ctx.createGain();
    ring.gain.value = 0;

    const carrier = ctx.createOscillator();
    carrier.type = "sine";
    const depth = ctx.createGain();
    carrier.connect(depth).connect(ring.gain);
    carrier.start();

    input.connect(dry).connect(output);
    input.connect(high).connect(low).connect(shaper).connect(ring).connect(wet).connect(output);

    const apply = (enabled, amount) => {
      const m = mixFor(amount);
      const now = ctx.currentTime;
      // Ramped rather than set: changing a gain instantly while audio is playing
      // is an audible click, and the settings dialog moves this slider live.
      const ease = (param, value) => {
        param.cancelScheduledValues(now);
        param.setTargetAtTime(value, now, 0.02);
      };
      ease(dry.gain, enabled ? m.dry : 1);
      ease(wet.gain, enabled ? m.wet : 0);
      ease(depth.gain, m.depth);
      carrier.frequency.setTargetAtTime(m.carrier, now, 0.02);
    };

    apply(false, 0);
    return { input, output, apply };
  } catch (err) {
    console.warn("[vocoder] not available:", err.message);
    return null;
  }
}
