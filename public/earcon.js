// The two sounds the set makes before it says something.
//
// Its own module for the reason public/vocoder.js is: the graph needs a browser
// but the numbers do not, so an OfflineAudioContext can render these and check
// what is actually in them. Left inside voice.js they would be unprovable —
// that file cannot be imported outside a page at all.
//
//   ident  a timer, a reminder, a place read off the globe
//   alert  a severe weather warning, about to be read out
//
// Both go through speakerChain(), which is most of why they sound like a
// television. The first version of this was two rising sine notes straight into
// the speakers, which is a phone notification — a television makes neither of
// those noises.

/**
 * The set's own loudspeaker, as a filter chain.
 *
 * A small driver in a wooden box rolls off hard at both ends and honks in the
 * upper-middle where speech lives. Three biquads is enough to be unmistakable:
 * nothing below ~380 Hz (no chest, no thump), nothing above ~4.2 kHz (no
 * sparkle, no hi-fi), and a lift around 2 kHz for the boxy resonance.
 *
 * Both earcons' tones sit inside that passband on purpose — 784 to 1046 Hz for
 * the ident, 853 and 960 for the alert. A chime the speaker cannot reproduce is
 * a chime nobody hears.
 */
export function speakerChain(ctx, destination) {
  const highpass = ctx.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 380;

  const honk = ctx.createBiquadFilter();
  honk.type = "peaking";
  honk.frequency.value = 2000;
  honk.Q.value = 1.2;
  honk.gain.value = 6;

  const lowpass = ctx.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 4200;

  highpass.connect(honk).connect(lowpass);
  lowpass.connect(destination);
  // Torn down when the sound is over: a reminder every hour for a week is a lot
  // of filters to leave attached to a graph that never restarts.
  return { input: highpass, release: () => highpass.disconnect() };
}

/** One tone, with an envelope. Both earcons are made of these. */
function tone(ctx, destination, { freq, at, hold, decay, peak, type = "sine", detune = 0 }) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.detune.value = detune;
  // A 4 ms attack rather than an instant one: a square-edged start is a click,
  // and through the peaking filter above it rings.
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.004);
  gain.gain.setValueAtTime(peak, at + hold);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + hold + decay);
  osc.connect(gain).connect(destination);
  osc.start(at);
  osc.stop(at + hold + decay + 0.02);
}

// What each earcon is made of, as data — so the test can assert against the
// same numbers the sound is built from, and a third earcon is a table entry.
export const EARCONS = {
  // The station ident: a two-note figure, C6 down to G5.
  //
  // DESCENDING, which is the fix rather than a detail. Rising two-tones read as
  // a question or a notification — something wants your attention. Falling ones
  // read as an announcement being made, which is what this is, and it is the
  // shape every broadcast ident has.
  //
  // Two oscillators per note, four cents apart, so they beat slowly against each
  // other the way two struck chime bars do. One oscillator alone is a test tone.
  ident: {
    totalMs: 720,
    notes: [
      { freq: 1046.5, at: 0, hold: 0.03, decay: 0.42, peak: 0.2, type: "triangle" },
      { freq: 1046.5, at: 0, hold: 0.03, decay: 0.42, peak: 0.1, type: "triangle", detune: 4 },
      { freq: 784, at: 0.2, hold: 0.03, decay: 0.42, peak: 0.2, type: "triangle" },
      { freq: 784, at: 0.2, hold: 0.03, decay: 0.42, peak: 0.1, type: "triangle", detune: 4 },
    ],
  },
  // 853 Hz and 960 Hz TOGETHER: the attention signal that precedes exactly this
  // announcement on American television, and has since the Emergency Broadcast
  // System. Simultaneous rather than in sequence — the dissonant beating between
  // the two is the whole character of it, and playing them one after the other
  // produces a completely different noise.
  //
  // The real thing runs 8 to 25 seconds. This is 0.85, because it is a doorbell
  // for a sentence and not a national activation. The extra silence afterwards
  // is the beat a station leaves before speaking.
  alert: {
    totalMs: 1120,
    notes: [
      { freq: 853, at: 0, hold: 0.85, decay: 0.06, peak: 0.16 },
      { freq: 960, at: 0, hold: 0.85, decay: 0.06, peak: 0.16 },
    ],
  },
};

// ---------------------------------------------------------------------------
// The set warming up
//
// The boot sequence has been silent since it was built, which was unavoidable
// then — there was nowhere for audio to live and no volume control to turn it
// down with. Both exist now.
//
// These deliberately do NOT go through speakerChain(). That filter is the
// television's loudspeaker, and none of these sounds come out of it: the
// degauss thunk is the shadow mask and the cabinet, the whine is the line
// output transformer, and the beep is a PC speaker in a different box
// altogether. Putting them through it would filter away the exact frequencies
// that identify them — the thunk is entirely below the 380 Hz highpass.
// ---------------------------------------------------------------------------

/**
 * The degauss thunk, at the moment the tube strikes.
 *
 * A CRT switching on demagnetises its shadow mask, and what you hear is a low
 * mechanical thump with a brief shimmer over it. The pitch falls as the coil's
 * field collapses, which is why this is a sweep rather than a note.
 */
export function playStrike(ctx, destination) {
  const at = ctx.currentTime + 0.01;

  const thump = ctx.createOscillator();
  const thumpGain = ctx.createGain();
  thump.type = "sine";
  thump.frequency.setValueAtTime(64, at);
  thump.frequency.exponentialRampToValueAtTime(34, at + 0.28);
  thumpGain.gain.setValueAtTime(0.0001, at);
  thumpGain.gain.exponentialRampToValueAtTime(0.38, at + 0.012);
  thumpGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.34);
  thump.connect(thumpGain).connect(destination);
  thump.start(at);
  thump.stop(at + 0.36);

  // The shimmer: a short burst of noise through a narrow band, which is the
  // mask ringing rather than anything tonal.
  const frames = Math.floor(ctx.sampleRate * 0.2);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 900;
  band.Q.value = 1.4;
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.09, at);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
  noise.connect(band).connect(noiseGain).connect(destination);
  noise.start(at);
}

// The line frequency of an analogue television, and the reason a room with a
// CRT in it is never quite silent. Many adults cannot hear it at all, which is
// exactly why it is kept this quiet: it costs nothing for anyone who can't, and
// is instantly recognisable to anyone who can.
export const FLYBACK_HZ = 15625;

/**
 * The whine, while the set is on. Returns a handle that stops it.
 *
 * Ramped up and down rather than switched. Starting a 15 kHz oscillator at full
 * gain produces a click, and a click is the one thing a continuous background
 * tone must not have at either end.
 */
export function tubeWhine(ctx, destination, { level = 0.014 } = {}) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = FLYBACK_HZ;
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(level, ctx.currentTime + 0.35);
  osc.connect(gain).connect(destination);
  osc.start();

  return {
    stop(fade = 0.5) {
      const now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      // The level is taken from the closure, NOT read back off `gain.gain.value`.
      //
      // Reading it is the idiom everyone writes, and it measured a peak of
      // 0.999 on a tone asked to run at 0.014: `.value` reports the intrinsic
      // value, which is still the default 1 when the only thing that has
      // happened to the param is a scheduled ramp that has not run yet. That is
      // reachable in a real session — clicking to skip the warm-up inside the
      // 350 ms fade-in is exactly when it would happen — and a 15 kHz tone
      // jumping to full scale is a genuinely unpleasant way to find out.
      gain.gain.setValueAtTime(level, now);
      gain.gain.linearRampToValueAtTime(0.0001, now + fade);
      osc.stop(now + fade + 0.05);
    },
  };
}

/**
 * How many times a POST beeps: one for a clean machine, two for a degraded one.
 *
 * A real BIOS says whether it found everything with the number of beeps, and
 * the boot screen already refuses to claim more than it has — the amber `[ -- ]`
 * rows and the copyright line that stops saying "all processing local" the
 * moment anything is in the cloud. **The sound has to tell the same truth as
 * the picture**, or it becomes the one part of the warm-up that flatters.
 */
export function postBeeps(devices = []) {
  return devices.some((d) => !d.ok) ? 2 : 1;
}

/** The POST beep, when the device list has finished. */
export function playPost(ctx, destination, { devices = [] } = {}) {
  const count = postBeeps(devices);
  // Square through a lowpass: a PC speaker is a tiny cone driven by a square
  // wave, and the harshness is most of what makes it recognisable.
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 3600;
  filter.connect(destination);

  for (let i = 0; i < count; i++) {
    const at = ctx.currentTime + 0.01 + i * 0.21;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = 1000;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.11, at + 0.004);
    gain.gain.setValueAtTime(0.11, at + 0.1);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.13);
    osc.connect(gain).connect(filter);
    osc.start(at);
    osc.stop(at + 0.15);
  }
}

/**
 * Play one, and resolve when it is over.
 *
 * `destination` is the volume bus, so the knob on the cabinet turns the chime
 * down exactly as it turns his voice down. That is the point of routing them
 * together: an announcement tone that stayed at full blast after you turned him
 * down would be the control lying.
 *
 * The two earcons are deliberately not the same sound and not the same LENGTH.
 * An alarm you have learned to ignore is worse than no alarm, which is the
 * argument lib/alertwatch.js makes for interrupting on 44 warnings out of 189 —
 * and it only holds if the interruption sounds like one.
 */
export function playEarcon(ctx, destination, kind = "ident", { schedule = setTimeout } = {}) {
  const earcon = EARCONS[kind] ?? EARCONS.ident;
  const speaker = speakerChain(ctx, destination);
  const now = ctx.currentTime + 0.02;

  for (const note of earcon.notes) {
    tone(ctx, speaker.input, { ...note, at: now + note.at });
  }

  return new Promise((resolve) => {
    schedule(() => {
      speaker.release();
      resolve();
    }, earcon.totalMs);
  });
}
