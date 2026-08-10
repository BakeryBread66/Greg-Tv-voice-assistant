// Greg's face: a floating CRT television showing SMPTE colour bars.
//
// The screen is where the expression lives — the way the LED array was in the
// helmet. Everything it does is something a real television does, which is what
// keeps it readable: you know what a rolling picture means, and you know what
// snow means, without being told.
//
//   idle       bars, steady, "PLEASE STAND BY"
//   listening  bars breathing with your voice, "LISTENING"
//   thinking   vertical hold slips and the picture rolls, "PLEASE WAIT"
//   speaking   the seven colour bars become an equaliser driven by his voice
//   error      snow, "NO SIGNAL"
//
// The programme channels are NOT in here. Each lives in public/channels/, one
// file per channel, and this file only decides which one to call and how much
// of the picture to give it.
//
// The wooden-cased body is drawn once to an offscreen canvas; only the picture,
// the glass and the float are redrawn each frame.

import { RENDERERS, STALE_LEAD } from "./channels/index.js";
import { draw as drawAddon } from "./channels/addon.js";
import { ellipsize, wrapText } from "./channels/shared.js";
import { BootSequence } from "./boot.js";
import { volumeAngle, volumeLabel } from "./volume.js";
import { subtitlesFor, subtitleLines } from "./subtitles.js";

const MODES = {
  idle:      { caption: "PLEASE STAND BY", roll: 0,    snow: 0.03, bob: 1.0, glow: 0.55 },
  listening: { caption: "LISTENING",       roll: 0,    snow: 0.05, bob: 1.4, glow: 0.9 },
  thinking:  { caption: "PLEASE WAIT",     roll: 1,    snow: 0.09, bob: 1.1, glow: 0.75 },
  speaking:  { caption: null,              roll: 0,    snow: 0.04, bob: 1.7, glow: 1.0 },
  error:     { caption: "NO SIGNAL",       roll: 0,    snow: 0.92, bob: 0.5, glow: 0.4 },
};

// SMPTE ECR 1-1978, 75% amplitude. The exact values matter: these are the
// colours a broadcast engineer would recognise, and approximating them is the
// difference between a test card and a rainbow.
const TOP_BARS = ["#c0c0c0", "#c0c000", "#00c0c0", "#00c000", "#c000c0", "#c00000", "#0000c0"];

// The same seven bars as hue/saturation/lightness, so music can push them around
// without losing the test card. Grey has no hue, so it carries a saturation of 0
// and gets given one only when the music is loud — which is what makes the whole
// card visibly "come alive" rather than six bars shifting around a dead one.
const TOP_BARS_HSL = [
  { h: 0, s: 0, l: 75 },     // grey
  { h: 60, s: 100, l: 38 },  // yellow
  { h: 180, s: 100, l: 38 }, // cyan
  { h: 120, s: 100, l: 38 }, // green
  { h: 300, s: 100, l: 38 }, // magenta
  { h: 0, s: 100, l: 38 },   // red
  { h: 240, s: 100, l: 38 }, // blue
];

// The castellation strip: the same hues reversed, separated by black.
const MID_BARS = ["#0000c0", "#131313", "#c000c0", "#131313", "#00c0c0", "#131313", "#c0c0c0"];

// The bottom row, in 28ths of the width. -I and +Q are the chroma reference
// patches; the three narrow bars are the PLUGE, used to set black level.
const BOTTOM_BARS = [
  { color: "#00214c", units: 5 }, // -I
  { color: "#ffffff", units: 5 }, // 100% white
  { color: "#32006a", units: 5 }, // +Q
  { color: "#131313", units: 5 }, // black
  { color: "#060606", units: 2 }, // PLUGE, below black
  { color: "#131313", units: 2 }, // PLUGE, black
  { color: "#202020", units: 2 }, // PLUGE, above black
  { color: "#131313", units: 2 }, // black
];

// Idle used to fire the same horizontal tear every few seconds, which reads as a
// loop rather than as a set that's alive. Four faults, chosen at random, and the
// repetition stops being visible.
const FAULTS = [
  "tear",   // a band of picture shoved sideways
  "slip",   // vertical hold loses its grip for a moment
  "burst",  // a spit of static
  "fringe", // colour separating from the picture
];

const lerp = (a, b, t) => a + (b - a) * t;

export class FaceTV {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");

    this.state = "idle";
    this.mode = MODES.idle;
    this.glow = MODES.idle.glow;
    this.roll = 0;
    this.snow = MODES.idle.snow;

    this.level = 0;
    this.rawLevel = 0;
    this.spectrum = null;
    this.bands = new Array(TOP_BARS.length).fill(0);
    // Music from the speakers: see setMusic(). Null until something is playing.
    this.music = null;
    this.beat = 0;      // spring position — positive is a nod downward
    this.beatVel = 0;   // spring velocity, kicked by each detected beat

    // Every number the nod depends on, in ONE place and mutable at runtime.
    //
    // They used to be constants buried across update() and draw(). Six rounds of
    // tuning went into them across one session, every judgement round-tripping
    // through the user, because the assistant doing the tuning can neither see
    // nor hear the result. Three separate sessions then wrote down the same
    // instruction: build the sliders first. public/nod-panel.js is those
    // sliders, and this object is what they move.
    //
    // The defaults are exactly the values that were there before, so a page
    // without the panel behaves identically.
    this.nodTuning = {
      stiffness: 400,     // spring constant — ring period, 400/34 gives 0.31 s
      damping: 34,        // 0.85 damping ratio: one reversal, settled in 0.23 s
      kick: 2.6,          // impulse per beat
      kickScale: 2.2,     // extra impulse from a loud hit
      depth: 1.7,         // spring position -> pixels, as a fraction of `u`
      tilt: 0.5,          // counter-rotation, so it reads as a nod not a lift
      onsetRatio: 2.0,    // flux over its running mean to count as an onset
      onsetFloor: 0.015,  // absolute floor, because flux nears zero when quiet
      gridEnter: 2.6,     // peak prominence needed to trust a tempo
      gridStay: 2.0,      // and to keep trusting it — hysteresis, not one edge
    };

    // The OUTPUT, in pixels, which is the number three rounds of tuning were
    // spent not measuring: the nod peaked at 1.6-3.1 px against an idle float of
    // 2.8-5.4 px that never stops, so nothing could have shown it however well
    // the beat was detected. Tracked here so the panel can display it and nobody
    // has to take the amplitude on trust again.
    this.nodPeakPx = 0;
    this.nodPeakDecayAt = 0;
    this.prevBass = 0;  // last frame's bass, for the rise the detector looks at
    this.fluxMean = 0;  // running mean of that rise
    // The beat grid: onset times, the tempo fitted to them, and when the next
    // beat is due. See fitGrid().
    this.onsets = [];
    this.period = 0;
    this.nextBeatAt = 0;
    this.gridConfidence = 0;
    this.sinceOnset = 1;
    this.sinceFit = 0;
    this.lastOnsetStrength = 0.5;
    this.onGrid = false;
    this.sinceBeat = 1; // refractory timer, so one kick fires once
    this.loudness = 0;  // smoothed overall level, drives the bar colour
    this.beatsSeen = 0;
    this.musicSeconds = 0;
    this.beatWarned = false;

    // ---- Channels ----------------------------------------------------------
    // What the set is SHOWING, as opposed to what it is doing. The state above
    // (idle/listening/thinking/speaking/error) is Greg's expression and stays
    // exactly as it was; the channel is the programme underneath it.
    //
    // The server owns the real value — see lib/channels.js. This is a copy
    // painted from whatever it last said, never a second source of truth.
    this.channel = 1;
    this.channelId = "testcard";
    // The current channel's own entry from /api/channel, and the renderers
    // fetched for add-ons. Cached by id so switching back and forth does not
    // re-import, and so a renderer that failed is not retried every frame.
    this.channelInfo = null;
    this.addonRenderers = new Map();
    // How many ticks the knob wears. Told to us by the server on the first
    // paint; the constant is only the value before that arrives, so a channel
    // added to lib/channels.js needs no edit here at all.
    this.channelCount = CHANNEL_COUNT;
    this.zoom = 1;      // the set leans in on any channel but the test card
    this.wipe = 0;      // static across the picture during a switch
    this.nowPlaying = null;
    this.art = null;        // an Image, once it has loaded
    this.artVersion = -1;   // which version `art` is, so it loads once per track

    // Whatever the current channel's feed last said. See setProgramme().
    this.programme = null;
    this.programmeId = null;
    this.lastProgrammeId = null;
    this.pageAt = 0;        // which teletext page is up
    this.pageSince = 0;
    this.photo = null;      // the astronomy picture, once it has loaded
    this.photoFor = null;   // which date `photo` is, so it loads once a day
    this.radarFrames = [];  // the radar loop, swapped in whole once loaded
    this.radarVersion = -1;

    this.time = 0;
    this.rollOffset = 0;
    this.flicker = 1;
    this.nextGlitchAt = 4 + Math.random() * 5;
    this.glitch = 0;
    this.fault = "tear";
    this.uptimeStart = null;

    // How loud he is, 0..1, and when the readout was last asked for. Same
    // arrangement as the channel: the server owns the value, this is a copy
    // painted from what it last said, and the left-hand knob points at it.
    //
    // 1 rather than 0 because that is what the graph does before anything has
    // been adopted — a knob that started at silent and pointed at the left stop
    // would be advertising a state he is not in.
    this.volume = 1;
    this.volumeShownAt = -Infinity;

    // Page 888: the sentence he is saying right now, and when to show it.
    //
    // The rule lives beside the volume rather than in voice.js because the
    // volume is already here — asking the page "are the subtitles on" would put
    // one fact in two places, which is the shape of half the bugs in this file.
    this.speechText = null;
    this.subtitleMode = "auto";

    // Where the pointer is, as -1..1 either side of centre, eased toward the
    // target so the head leans rather than snaps.
    this.look = { x: 0, y: 0 };
    this.lookTarget = { x: 0, y: 0 };

    // How still he is holding: 0 is the full idle float and head-turn, 1 is
    // dead still. Raised on any channel but the test card.
    //
    // A programme is something you READ — a forecast, a teletext page, a radar
    // loop, a column of figures — and the set leans in 1.55x to make that text
    // legible. Drifting and turning underneath it undoes the leaning in: the
    // words are bigger and moving. Channel 1 is his face, where the float is
    // most of what makes him look alive, so it keeps every bit of it.
    //
    // Eased rather than switched, because a set that snapped to centre on a
    // channel change would read as a fault rather than as settling.
    this.settle = 0;

    // Following the cursor beyond the window. See tickDesktopCursor() below.
    this.lastClient = null;
    this.lastMoveAt = 0;
    this.calibration = { x: { min: null, max: null }, y: { min: null, max: null } };
    this.trackTimer = null;
    this.cursorBusy = false;

    this.size = 0;
    this.dpr = 0;
    this.body = null; // offscreen television set
    this.noise = [];  // pre-rendered snow tiles

    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
    window.addEventListener("resize", () => this.resize());

    // Tracked across the whole window, not just the canvas — he should keep
    // watching you while you reach for the buttons underneath him.
    window.addEventListener("pointermove", (event) => {
      this.lastClient = { x: event.clientX, y: event.clientY };
      this.lastMoveAt = performance.now();
      this.lookAt(event.clientX, event.clientY);
    });

    // Past the edge of the browser the page stops seeing the mouse, so ask the
    // server, which asks Windows.
    //
    // Driven by "no pointermove lately" rather than by a pointerleave event. The
    // first version keyed off document pointerleave and did not work: one more
    // thing that has to fire correctly, and nothing to fall back on when it
    // doesn't. A clock always fires.
    this.trackTimer = setInterval(() => this.tickDesktopCursor(), 90);
  }

  // --- Following the mouse out of the window --------------------------------
  //
  // The hard part is not reading the desktop cursor, it is knowing where the
  // canvas sits on that desktop: browser chrome, window position and display
  // scaling all sit between the two, and this machine has two monitors of
  // different sizes. Calculating it means reasoning about a sign that, per
  // CLAUDE.md, produces "a perfectly convincing head that looks determinedly
  // away from your cursor" when you get it backwards — and it must be checked
  // against a picture, not by reasoning.
  //
  // So it is measured instead. While the pointer is inside, both coordinates are
  // known at once: the page has clientX, the server has the desktop position.
  // Pairing them gives the scale and offset directly. Nothing is assumed about
  // chrome, DPI or which monitor he is on, and a mapping derived from real pairs
  // cannot come out mirrored.

  noteCalibration(client, os) {
    for (const axis of ["x", "y"]) {
      const seen = this.calibration[axis];
      if (seen.min === null || client[axis] < seen.min.client) seen.min = { client: client[axis], os: os[axis] };
      if (seen.max === null || client[axis] > seen.max.client) seen.max = { client: client[axis], os: os[axis] };
    }
  }

  /** Turn a desktop position into page coordinates, or null if not yet calibrated. */
  desktopToClient(os) {
    const out = {};
    for (const axis of ["x", "y"]) {
      const { min, max } = this.calibration[axis];
      // Needs a real spread before the fit means anything — two samples a few
      // pixels apart would give a wild scale.
      if (!min || !max || max.client - min.client < 120) return null;
      const scale = (max.os - min.os) / (max.client - min.client);
      if (!Number.isFinite(scale) || scale === 0) return null;
      out[axis] = min.client + (os[axis] - min.os) / scale;
    }
    return out;
  }

  /**
   * One poll of the desktop cursor: calibrate from it, or steer by it.
   *
   * The same reading does both jobs, which is why they share a tick. While the
   * pointer is in the window the page already knows where it is, so the reading
   * is only used to learn the mapping. Once it leaves, that mapping is all there
   * is.
   */
  async tickDesktopCursor() {
    // A hidden tab shouldn't keep a PowerShell loop spinning on the other side.
    if (document.hidden || this.cursorBusy) return;

    const inside = performance.now() - this.lastMoveAt < 300;
    // Calibrated and the pointer is in the window: nothing to learn, nothing to
    // steer. Skip the request entirely so a still mouse costs nothing.
    if (inside && this.calibrated()) return;

    const sentAt = this.lastClient ? { ...this.lastClient } : null;
    this.cursorBusy = true;
    try {
      const os = await (await fetch("/api/cursor")).json();
      if (typeof os.x !== "number") return; // watcher still starting

      if (inside && sentAt && this.lastClient) {
        // Pair the two coordinate systems. Tolerance rather than the identity
        // check this had before: that required the pointer to be perfectly still
        // across the request, so a moving mouse recorded nothing and a still one
        // recorded the same point forever — the 120px spread never arrived and
        // the mapping was never usable. A few pixels of drift is irrelevant to a
        // fit measured over hundreds.
        const drift = Math.hypot(this.lastClient.x - sentAt.x, this.lastClient.y - sentAt.y);
        if (drift < 20) {
          const was = this.calibrated();
          this.noteCalibration(sentAt, os);
          // Said once, because "it doesn't follow my mouse" has two very
          // different causes — never calibrated, or calibrated wrongly — and
          // without this there is no way to tell them apart from outside.
          if (!was && this.calibrated()) console.log("[face] cursor tracking calibrated — he can follow the mouse off-window now");
        }
        return;
      }

      // Outside the window. Uncalibrated means hold the last angle — the same
      // behaviour this replaces, so degrading to it is safe.
      const client = this.desktopToClient(os);
      if (client) this.lookAt(client.x, client.y);
    } catch {
      // Server gone; voice.js owns that. Here it just means no angle this tick.
    } finally {
      this.cursorBusy = false;
    }
  }

  /**
   * Find the tempo and the downbeat from recent onsets.
   *
   * For a candidate period p, sum a unit vector per onset at angle 2*pi*t/p. If
   * the onsets fall on a grid of that spacing the vectors point the same way and
   * the sum is long; if they are scattered the vectors cancel. So one calculation
   * gives both answers at once — the LENGTH is how confident we are in the
   * tempo, and the ANGLE is where the beat sits. That is why this is worth doing
   * properly rather than histogramming the gaps between onsets.
   *
   * Onsets that are not beats — a snare, a fill, a ghost note — are scattered
   * across the cycle, so they add little and cancel each other. That is the
   * property being bought: the grid ignores them instead of nodding to them.
   */
  fitGrid() {
    const now = this.musicSeconds;
    // Eight seconds of memory: long enough to be sure, short enough to follow a
    // track changing.
    this.onsets = this.onsets.filter((t) => now - t < 8);
    if (this.onsets.length < 6) {
      this.gridConfidence *= 0.7; // let it lapse rather than clinging to a stale fit
      return;
    }

    let best = null;
    let scoreSum = 0;
    let scoreCount = 0;
    // 60 to 190 bpm. Below that a nod looks like it stalled, above it he twitches.
    for (let bpm = 60; bpm <= 190; bpm += 0.5) {
      const period = 60 / bpm;
      let re = 0;
      let im = 0;
      for (const t of this.onsets) {
        const angle = (2 * Math.PI * t) / period;
        re += Math.cos(angle);
        im += Math.sin(angle);
      }
      let score = Math.hypot(re, im) / this.onsets.length;

      // Half and double time score identically on a perfect grid — the maths
      // cannot tell 70 from 140. Nudge toward the middle of the range so it
      // settles on the tempo a person would tap, rather than nodding at half
      // speed or twice speed depending on rounding.
      score *= 1 - Math.abs(Math.log2(bpm / 120)) * 0.12;

      scoreSum += score;
      scoreCount++;
      if (!best || score > best.score) best = { period, score, angle: Math.atan2(im, re) };
    }

    // Confidence is how far the winner beats the FIELD, not its absolute size.
    //
    // Taking the best of 261 candidates inflates random data — measured, twenty
    // scattered onsets scored 0.32 against real music's 0.33, which is no margin
    // at all and exactly the kind of knife-edge threshold that made the previous
    // detector work on one track and die on the next. A real tempo produces a
    // sharp peak in an otherwise flat landscape; noise produces a flat landscape
    // with a slightly tall bump. The ratio sees the difference; the magnitude
    // does not.
    const meanScore = scoreSum / Math.max(1, scoreCount);
    const prominence = best.score / Math.max(meanScore, 1e-6);

    this.period = best.period;
    // Ease rather than jump, so one ambiguous fit can't drop him out of grid mode
    // mid-bar.
    this.gridConfidence = lerp(this.gridConfidence, prominence, 0.5);

    // Where the next beat lands. `frac` is the grid's offset within a period.
    const frac = best.angle / (2 * Math.PI);
    const k = Math.ceil(now / best.period - frac);
    const next = (k + frac) * best.period;
    // Only re-phase when the new fit disagrees by a meaningful part of a beat.
    // Nudging every fit makes the nod jitter around the beat it is meant to hold.
    if (!this.nextBeatAt || Math.abs(next - this.nextBeatAt) > best.period * 0.12) {
      this.nextBeatAt = next;
    }
  }

  /** True once both axes have enough spread for the fit to mean anything. */
  calibrated() {
    return Boolean(this.desktopToClient({ x: 0, y: 0 }));
  }

  /** Aim the head at a point in client coordinates. */
  lookAt(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const centreX = rect.left + rect.width / 2;
    const centreY = rect.top + rect.height / 2;
    // Reach is a little under the canvas size, so the corners of the window are
    // roughly full deflection rather than the head pinning the moment you leave.
    const reach = Math.max(rect.width, rect.height) * 0.75;

    const clamp = (value) => Math.max(-1, Math.min(1, value));
    this.lookTarget.x = clamp((clientX - centreX) / reach);
    this.lookTarget.y = clamp((clientY - centreY) / reach);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const size = Math.floor(Math.min(rect.width, rect.height));
    const dpr = window.devicePixelRatio || 1;
    if (!size || (size === this.size && dpr === this.dpr)) return;

    this.canvas.width = size * dpr;
    this.canvas.height = size * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.size = size;
    this.dpr = dpr;
    this.body = buildBody(size, dpr, this.zoom, this.channel, this.channelCount, this.volume);
    // The set is drawn flat into here each frame, then projected onto the real
    // canvas. Kept at the same resolution so the projection doesn't soften it.
    this.flat = document.createElement("canvas");
    this.flat.width = size * dpr;
    this.flat.height = size * dpr;
    // Regenerating noise per frame is the expensive way to do this; four tiles
    // cycled fast enough is indistinguishable and costs nothing.
    this.noise = buildNoise(Math.max(64, Math.round(size / 3)));
  }

  /**
   * The idle float, in the units the set is drawn in.
   *
   * Two sine waves at unrelated speeds so the drift never visibly repeats,
   * scaled down by `settle` so a programme channel holds still. ONE definition,
   * called by both `draw()` and `knobAt()` — see the note in knobAt about why
   * that matters more than it looks.
   */
  floatOffset(u) {
    const bob = this.mode.bob * (1 - this.settle);
    return {
      driftX: Math.sin(this.time * 0.53) * 0.01 * u * bob,
      driftY: (Math.sin(this.time * 0.85) * 0.018 + Math.sin(this.time * 0.37) * 0.012) * u * bob,
      tilt: Math.sin(this.time * 0.44) * 0.017 * bob,
    };
  }

  setState(state) {
    if (!MODES[state] || state === this.state) return;
    this.state = state;
    this.mode = MODES[state];
    // A channel change should look like one — and specifically like a tear,
    // not whichever fault happened to be queued next.
    this.fault = "tear";
    this.glitch = 1;
    if (state !== "speaking") this.spectrum = null;
  }

  setLevel(level) {
    this.rawLevel = Math.max(0, Math.min(1, level || 0));
  }

  /**
   * Music coming out of the speakers, from lib/../voice.js capturing system audio.
   *
   * Optional, and called with `?.` — CLAUDE.md's rule that anything a face needs
   * beyond setState/setLevel/setSpectrum/start goes on this way, so the required
   * interface stays four and a renderer that doesn't want to dance never hears
   * about it.
   *
   * Deliberately a separate channel from setSpectrum(). That one is Greg's own
   * voice and owns the screen while he speaks; this must never talk over him.
   */
  setMusic(data) {
    this.music = data ?? null;
  }

  /**
   * Everything the nod panel needs to show, in one read.
   *
   * Deliberately a snapshot rather than the live object: the panel displays it,
   * it does not steer from it. The only thing the panel writes is `nodTuning`.
   */
  nodDebug() {
    return {
      listening: this.musicVisible(),
      bpm: this.period > 0 ? 60 / this.period : 0,
      confidence: this.gridConfidence,
      onGrid: Boolean(this.onGrid),
      onsetsPerMin: this.onsets.length ? (this.onsets.length / 8) * 60 : 0,
      beatsSeen: this.beatsSeen,
      // The two numbers that matter most, and the pair three rounds of tuning
      // were spent without: how big the nod is, and what it competes with.
      nodPeakPx: this.nodPeakPx,
      idleFloatPx: this.idleFloatPx ?? 0,
      spring: this.beat,
      sinceBeat: this.sinceBeat,
    };
  }

  /** The screen shows music only when its own voice isn't using it. */
  musicVisible() {
    return Boolean(this.music) && this.state !== "speaking" && this.state !== "error";
  }

  setSpectrum(data) {
    this.spectrum = data;
  }

  /**
   * Which channel the set is showing.
   *
   * Optional, called with `?.` like setMusic and setUptimeStart — a renderer
   * without channels is simply never told about them, so the required interface
   * stays at four methods.
   *
   * The size change happens UNDER the static rather than easing into it. Easing
   * would mean magnifying a bitmap that was rasterised at the old scale for the
   * length of the transition, which is soft in exactly the way this feature
   * exists to fix: the whole point of leaning in is that small text becomes
   * legible. A wipe hides an instant rebuild, and a real set changing channel
   * bangs rather than glides anyway.
   */
  /**
   * The renderer for a channel somebody added themselves.
   *
   * Two ways an add-on can be drawn, and this decides which:
   *
   *   render.js in its folder   fetched once and cached, by id
   *   a `display` block only    the shared declarative renderer
   *
   * The import is fired once and never awaited — this is called from draw(),
   * sixty times a second, and awaiting anything there would stall the picture.
   * Until it lands the channel shows its standby card, which is what every
   * other channel shows while its feed is loading anyway.
   *
   * **A bad add-on must cost the add-on, not the face.** A renderer that fails
   * to load, or throws while drawing, is remembered as failed and replaced with
   * the declarative one — the same rule that makes createFace() fall back
   * rather than throw, and for the same reason: this is somebody else's code
   * running inside the thing that draws Greg.
   */
  addonRenderer() {
    const info = this.channelInfo;
    if (!info?.addon) return null;

    const cached = this.addonRenderers.get(info.id);
    if (typeof cached === "function") return cached;

    const declarative = (ctx, x, y, w, h, view) => drawAddon(ctx, x, y, w, h, view, info);

    if (!info.hasRenderer || cached === "failed") return declarative;

    if (cached === undefined) {
      this.addonRenderers.set(info.id, "loading");
      import(`/api/channels/${encodeURIComponent(info.id)}/render.js`)
        .then((module) => {
          if (typeof module.draw !== "function") throw new Error("render.js exports no draw()");
          this.addonRenderers.set(info.id, (ctx, x, y, w, h, view) => {
            try {
              module.draw(ctx, x, y, w, h, view, info);
            } catch (err) {
              console.warn(`[channels] ${info.id} renderer threw:`, err.message);
              this.addonRenderers.set(info.id, "failed");
            }
          });
        })
        .catch((err) => {
          console.warn(`[channels] could not load ${info.id}/render.js:`, err.message);
          this.addonRenderers.set(info.id, "failed");
        });
    }

    return declarative;
  }

  /**
   * @param {object} info  the channel's own entry from /api/channel, which is
   *   how the face learns a channel is an add-on. Optional: a renderer that is
   *   never told stays exactly as it was.
   */
  setChannel(number, id = null, count = 0, info = null) {
    const next = Number(number) || 1;

    // The COUNT is adopted before the early return. It only draws ticks on the
    // knob, but it arrives with the very first paint — which is usually the
    // channel already showing, so an early return would leave the dial marked
    // for two channels until the first switch.
    const countChanged = count > 0 && count !== this.channelCount;
    if (count > 0) this.channelCount = count;

    // Also before the early return, and for a subtler reason than the count: on
    // the very first paint the channel already showing IS `this.channel`, so a
    // set left on an add-on would return here and never learn that it is one —
    // and would draw colour bars instead of the channel, forever, until you
    // turned the knob.
    if (info) this.channelInfo = info;

    if (next === this.channel) {
      // The dial gained ticks but the channel did not move. Rebuild the cabinet
      // so the knob is right, WITHOUT the wipe: nothing on the screen changed,
      // and static over a picture that is staying put reads as a fault.
      if (countChanged) {
        this.size = 0;
        this.resize();
      }
      return;
    }
    this.channel = next;
    // What the channel IS, rather than which position the knob is at. The
    // renderers dispatch on this: a channel's number is a property of the dial
    // and could be renumbered, its identity could not.
    this.channelId = id ?? null;

    this.wipe = 1;
    // The same tear setState() uses, and for the same reason: a channel change
    // should look like one.
    this.fault = "tear";
    this.glitch = 1;

    this.zoom = next === 1 ? 1 : CHANNEL_ZOOM;

    // ALWAYS rebuild, not just when the zoom changed. The knob's notch points at
    // the channel showing, so it is part of the cabinet and has to be redrawn
    // even when the size is identical — which is every switch between two
    // programme channels. With only two channels today every switch also changes
    // the zoom, so a rebuild keyed on that would look correct right up until
    // somebody adds a third.
    this.size = 0; // clear the guard in resize() that would otherwise no-op
    this.resize();
  }

  /**
   * The data behind whatever channel is showing. See lib/programmes.js.
   *
   * Optional, called with `?.` like setMusic and setNowPlaying — CLAUDE.md's
   * rule that anything a face needs beyond the four required methods goes on
   * this way, so a renderer that has no programmes is simply never told about
   * them and nothing has to be stubbed out.
   *
   * `id` is carried alongside the data rather than assumed, because a reply can
   * arrive after a channel change: painting a weather card into the Ceefax
   * renderer would not throw, it would just quietly draw nothing.
   */
  setProgramme(id, data) {
    this.programmeId = id ?? null;
    this.programme = data ?? null;
    // A new page cycle starts from the top, or a refresh lands mid-rotation and
    // the page number jumps backwards for no visible reason.
    if (id !== this.lastProgrammeId) {
      this.pageAt = 0;
      this.pageSince = this.time;
      this.lastProgrammeId = id ?? null;
    }

    if (id === "apod" && data?.date) this.loadPhoto(data.date);
    if (id === "radar" && data?.version) this.loadRadar(data);
  }

  /**
   * Fetch the radar loop, once per version.
   *
   * Ten images at ~58 KB, so worth doing exactly once — `version` comes from the
   * server and changes only when the set of frames actually changes, which is
   * about every two minutes. Loading into a SEPARATE array and swapping it in
   * only when every frame has arrived: painting a half-loaded loop makes the
   * animation stutter through the gaps, which reads as the radar itself being
   * broken rather than as a page still loading.
   */
  loadRadar(data) {
    if (data.version === this.radarVersion) return;
    this.radarVersion = data.version;

    const count = data.frames?.length ?? 0;
    if (!count) {
      this.radarFrames = [];
      return;
    }

    const loading = new Array(count);
    let arrived = 0;
    let failed = false;

    for (let i = 0; i < count; i++) {
      const image = new Image();
      image.onload = () => {
        loading[i] = image;
        // A version change mid-load means these frames are already history.
        if (++arrived === count && !failed && this.radarVersion === data.version) {
          this.radarFrames = loading;
        }
      };
      image.onerror = () => {
        failed = true;
        // Keep whatever loop is already up rather than blanking the channel:
        // twenty-minute-old rain is still worth looking at.
      };
      image.src = `/api/radar/frame?i=${i}&v=${data.version}`;
    }
  }

  /**
   * Fetch the astronomy picture, once per day.
   *
   * The same shape as the album art, and for the same reason: the image is
   * measured in megabytes, it changes once a day, and the DATE in the URL is
   * what makes caching safe — a new picture is a new URL, so yesterday's can
   * never be served for today.
   *
   * The date is re-checked inside both handlers because a photograph takes a
   * moment to decode, and a channel change or a midnight rollover in the
   * meantime would otherwise drop the wrong picture on screen.
   */
  loadPhoto(date) {
    if (date === this.photoFor) return;
    this.photoFor = date;
    this.photo = null;

    const image = new Image();
    image.onload = () => {
      if (this.photoFor === date) this.photo = image;
    };
    image.onerror = () => {
      if (this.photoFor === date) this.photo = null;
    };
    image.src = `/api/apod/image?d=${encodeURIComponent(date)}`;
  }

  /**
   * What Windows says is playing, for channel 2. See lib/nowplaying.js.
   *
   * The artwork is fetched here rather than handed in, because it is a few
   * hundred KB and only changes when the track does — `artVersion` is what makes
   * that safe, since a new track is a new URL and a stale picture can never be
   * served for a new song.
   */
  setNowPlaying(data) {
    this.nowPlaying = data ?? null;

    const version = data?.artVersion;
    if (!data?.playing || version === undefined || version === this.artVersion) return;

    this.artVersion = version;
    const image = new Image();
    image.onload = () => {
      // A switch during the load would otherwise drop last track's cover onto
      // this one.
      if (this.artVersion === version) this.art = image;
    };
    image.onerror = () => {
      if (this.artVersion === version) this.art = null;
    };
    this.art = null;
    image.src = `/api/nowplaying/art?v=${version}`;
  }

  /**
   * Which piece of the cabinet a click landed on, in client coordinates.
   *
   * Returns one of "channel-up", "channel-down", "volume-up", "volume-down", or
   * null — voice.js asks before treating a click as "interrupt him", so neither
   * knob cuts him off as a side effect of being turned. That matters most for
   * the volume: reaching for it while he is talking is the whole reason it is
   * there, and a control that silenced him by ending the sentence would be
   * answering a different question.
   *
   * The conversion goes through canvas.width/rect.width rather than assuming the
   * element is square. It is NOT: #face is width:100% height:100% inside its
   * well, while resize() makes the backing store square at min(w, h) — so the
   * bitmap is stretched to fit, and any hit test that ignored that would be
   * wrong by exactly the aspect ratio.
   */
  hitTest(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height || !this.size) return null;

    // Client -> bitmap -> the units draw() works in.
    const x = ((clientX - rect.left) * (this.canvas.width / rect.width)) / this.dpr - this.size / 2;
    const y = ((clientY - rect.top) * (this.canvas.height / rect.height)) / this.dpr - this.size / 2;

    // Nearest first, not first-match: the two knobs are 0.14u apart and each
    // takes a target twice its drawn radius, so their catchment areas overlap in
    // the middle. Testing them in order would give the whole of that overlap to
    // whichever was checked first, and the seam would sit off-centre — a click
    // visibly on the volume knob's right-hand side changing the channel instead.
    let best = null;
    for (const [index, name] of [[0, "volume"], [1, "channel"]]) {
      const knob = this.knobAt(index);
      if (!knob) continue;
      const distance = Math.hypot(x - knob.x, y - knob.y);
      // Twice the drawn radius. A knob 3% of the picture across is a hard target
      // with a mouse and an impossible one on a laptop trackpad, and the nearest
      // other thing to hit is the cabinet, which does nothing.
      if (distance > knob.r * 2) continue;
      if (!best || distance < best.distance) best = { knob, name, distance };
    }
    if (!best) return null;

    // WHICH SIDE of the knob decides the direction, because that is how a dial
    // works: push the right of it and it turns forward, the left and it turns
    // back. With ten channels a forward-only knob means nine clicks to go back
    // one, and adding a second control for it would be inventing hardware the
    // cabinet does not have. The volume reads the same way round — right is
    // louder — which is the direction every physical volume knob has ever gone.
    //
    // The comparison is against the knob's own projected centre, not the middle
    // of the canvas — at full yaw the knob slides a long way from where it sits
    // square-on, and using the canvas centre would flip the direction depending
    // on which way Greg happened to be looking.
    return `${best.name}-${x < best.knob.x ? "down" : "up"}`;
  }

  /**
   * Where a knob has ended up on the canvas, after the turn and the float.
   *
   * Mirrors project() rather than approximating it: at full yaw the near edge of
   * the set moves by a good fraction of its own width, which is several times the
   * radius of the knob being aimed at.
   */
  knobAt(index) {
    if (!this.size) return null;
    const half = this.size / 2;
    const u = half * FIT * this.zoom;

    const set = knobCentre(u, index);

    const yaw = this.look.x * MAX_YAW;
    const pitch = this.look.y * MAX_PITCH;
    const focal = FOCAL * half;
    const depth = set.x * Math.sin(yaw);
    const scale = focal / (focal + depth);

    // The same float draw() applies before projecting — from the same method, so
    // the two cannot disagree. They were duplicated expressions until settling
    // was added, which is one fact with two representations and the shape of
    // half the bugs in this file: damping the drift in draw() alone would have
    // slid the knob's hit target away from the knob being drawn.
    const { driftX, driftY } = this.floatOffset(u);

    // Mirror draw() and project() exactly, in their order. They compose as:
    //
    //   translate(half, half + zoomShift) -> translate(drift) ->
    //   scale(1, cos pitch) -> translate(0, sin(pitch) * half * 0.34)
    //
    // so the pitch slide is INSIDE the vertical squash and the zoom shift is
    // outside it. Getting that order wrong is invisible at zero pitch — which is
    // every test that forgets to point the head up or down — and off by several
    // knob radii once the pointer is anywhere near the top or bottom of the page.
    return {
      x: set.x * Math.cos(yaw) * scale + driftX,
      y: Math.cos(pitch) * (Math.sin(pitch) * half * 0.34 + set.y * scale) + this.zoomShift() + driftY,
      r: u * 0.038 * scale,
    };
  }

  /**
   * How far to slide the set so the PICTURE stays centred as the cabinet grows.
   *
   * The screen sits slightly above the middle of the cabinet (SCREEN.y), which is
   * deliberate — it leaves room for the neck. Scaling multiplies that offset, so
   * without this the picture creeps upward every time the set leans in.
   */
  zoomShift() {
    const base = (this.size / 2) * FIT;
    return -SCREEN.y * (base * this.zoom - base);
  }

  /**
   * When Greg was started, as an epoch timestamp, for the test-card clock.
   *
   * Optional: this is not one of the four methods every face must implement, and
   * voice.js calls it with `?.` so a renderer without a clock is simply never
   * told. It's the server's start time rather than the page's, so reloading the
   * window doesn't reset it.
   */
  setUptimeStart(startedAt) {
    this.uptimeStart = Number(startedAt) || null;
  }

  /**
   * How loud he is now, 0..1 — for the knob, and for the readout over the
   * picture.
   *
   * `show` exists because the two callers want different things. Turning the
   * knob, or moving the slider, should put the level on screen: a notch on a
   * dial 3% of the picture across is not a readable indication of anything, and
   * on a television the number always comes up. Adopting the saved value at
   * startup, or hearing about a change another window made, should not — an
   * on-screen display that appears without being asked for reads as a fault.
   *
   * Note it is deliberately NOT drawn during the boot sequence; see drawPicture.
   */
  setVolume(volume, { show = true } = {}) {
    const next = Math.max(0, Math.min(1, Number(volume)));
    if (!Number.isFinite(next)) return;
    if (next === this.volume && !show) return;
    this.volume = next;
    if (show) this.volumeShownAt = this.time;

    // The cabinet is rendered once to an offscreen canvas and the knob is
    // painted into it, so the notch does not move until the body is rebuilt.
    //
    // Rebuilt DIRECTLY rather than through `this.size = 0; this.resize()`, which
    // is how setChannel does it — resize() also regenerates four noise tiles,
    // and a volume knob is clicked ten times in a row on the way to silent where
    // a channel is clicked once. The body alone is the part that changed.
    if (this.size) {
      this.body = buildBody(this.size, this.dpr, this.zoom, this.channel, this.channelCount, this.volume);
    }
  }

  /**
   * The sentence he is saying, or null when he has stopped.
   *
   * Set per sentence rather than per answer, so the subtitle keeps time with
   * the speech the way a real one does — voice.js already plays one clip per
   * sentence, so the seam was already there.
   */
  setSpeech(text) {
    const clean = String(text ?? "").trim();
    this.speechText = clean || null;
  }

  /** "auto" | "always" | "off" — see subtitlesFor(). */
  setSubtitleMode(mode) {
    this.subtitleMode = mode ?? "auto";
  }

  /** Whether the words are on screen right now. */
  get subtitling() {
    return subtitlesFor(this.subtitleMode, this.volume);
  }

  /**
   * Warm the set up: tube strike, POST, Windows 98 splash.
   *
   * Optional and called with `?.`, like setMusic, setChannel and
   * setUptimeStart — the required interface stays at four methods and a
   * renderer that has no tube to strike is simply never asked to strike one.
   *
   * Resolves when the picture is ready, so the caller can hold the spoken
   * greeting until the set has finished coming on. It resolves rather than
   * rejects on every path, including a second call arriving while one is
   * already running: this is awaited inside wake(), and anything that throws
   * there costs the user their microphone.
   */
  playBoot(info = {}, { onBeat } = {}) {
    if (this.boot) return this.bootDone ?? Promise.resolve();

    try {
      // The face passes the beats straight through without knowing what they
      // are for. It draws; sound belongs with whatever owns the audio graph.
      this.boot = new BootSequence(info, { onBeat });
    } catch (err) {
      console.warn("[face] boot sequence failed to start:", err.message);
      this.boot = null;
      return Promise.resolve();
    }

    this.bootDone = new Promise((resolve) => {
      // A failsafe on a wall clock, because the sequence is advanced by
      // requestAnimationFrame and rAF does not run in a background tab. Wake
      // Greg, switch tabs, and update() simply stops being called — the boot
      // never finishes, the promise never settles, and wake() waits forever
      // holding back the greeting AND the listener. The cost of that bug is the
      // microphone, which is too high for an animation to be allowed to risk.
      const failsafe = setTimeout(() => this.finishBoot?.(), 9000);

      this.finishBoot = () => {
        clearTimeout(failsafe);
        this.boot = null;
        this.finishBoot = null;
        this.bootDone = null;
        // Come out of it the way this set changes channel — a burst of static
        // rather than a dissolve. It also covers the cut to the test card.
        this.wipe = 1;
        this.fault = "burst";
        this.glitch = 1;
        resolve();
      };
    });
    return this.bootDone;
  }

  /** Cut the sequence short — any click on the face while it is running. */
  skipBoot() {
    if (!this.boot) return false;
    this.boot.skip();
    this.finishBoot?.();
    return true;
  }

  get booting() {
    return Boolean(this.boot);
  }

  start() {
    let last = performance.now();
    const frame = (now) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;

      // The device pixel ratio can change without the element changing size —
      // dragging the window to a monitor with different scaling, or the ratio
      // simply not being settled when the face was constructed. Neither the
      // ResizeObserver nor the resize event fires for that, and the result is a
      // canvas stuck at the wrong backing-store resolution, drawn soft. Reading
      // devicePixelRatio is free; getBoundingClientRect (inside resize) is not,
      // so only reach for it when the ratio has actually moved.
      if ((window.devicePixelRatio || 1) !== this.dpr) this.resize();

      try {
        this.update(dt);
        this.draw();
        this.failures = 0;
      } catch (err) {
        // draw() clears the canvas before it paints, so a throw partway through
        // leaves a blank screen — the picture never appears and nothing says
        // why. Report it, but keep going: some causes are transient (a resize
        // landing mid-frame, a canvas the compositor hasn't allocated yet) and
        // giving up on the first one turns a flicker into a permanent blank.
        this.failures = (this.failures ?? 0) + 1;
        if (this.failures === 1 || this.failures === 120) this.reportFailure(err);
        if (this.failures > 240) {
          console.error("[face] giving up after 240 consecutive failures:", err);
          return;
        }
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  update(dt) {
    this.time += dt;

    const ease = 1 - Math.pow(0.004, dt);
    this.glow = lerp(this.glow, this.mode.glow, ease);
    this.snow = lerp(this.snow, this.mode.snow, ease);
    this.roll = lerp(this.roll, this.mode.roll, ease);

    // Fast attack, slow release — the picture should jump on a syllable and
    // settle gently, rather than twitching.
    this.level =
      this.rawLevel > this.level
        ? lerp(this.level, this.rawLevel, 1 - Math.pow(0.001, dt))
        : lerp(this.level, this.rawLevel, 1 - Math.pow(0.25, dt));

    // Each colour bar tracks its own slice of the spectrum.
    // Bob to the beat. Driven by the bass, because that is what a beat mostly is
    // — following overall loudness gives a head that wobbles constantly through
    // a busy mix instead of nodding on the kick.
    //
    // Two speeds, like the level smoothing above: snap up on a hit, fall back
    // slowly. Equal rates in both directions read as a wobble rather than a nod.
    // ---- Nodding to the beat -----------------------------------------------
    //
    // Position used to follow the bass amplitude directly, which looked twitchy
    // and slightly random — because it was. Bass level wobbles continuously
    // within a bar, so every transient moved the head and nothing corresponded
    // to the beat you can actually hear.
    //
    // Now it is a spring that gets kicked. An onset detector fires on the kick
    // drum, and each hit adds velocity to a spring-damper. The bounce, the
    // overshoot and the settle all fall out of the physics, so the motion is
    // continuous even though the input is discrete — which is what makes it read
    // as bouncing rather than tracking.
    const bass = this.musicVisible() ? this.music.bass ?? 0 : 0;

    // A slow running mean is the bar to clear. Comparing against a fixed
    // threshold would fire constantly on loud music and never on quiet music.
    //
    // It has to be genuinely slow — a mean that converges in a third of a second
    // rises with the kick it is supposed to be measuring, so the ratio never
    // opens up. About a second and a half of memory, so it tracks the track and
    // not the beat.
    // Onsets are found in the RISE, not the level.
    //
    // Comparing bass against its own running mean sounds reasonable and is
    // fragile: a mastered track's limiter keeps the floor high, so peak-over-
    // average lands near 1.29 against a 1.28 threshold. Measured on exactly such
    // a signal, the old rule found beats for a few seconds while the mean was
    // still low and then **zero in the following twenty** — which is why it
    // seemed to work on one track and die on the next.
    //
    // Positive spectral flux — how much the bass jumped since last frame —
    // survives compression, because a limiter flattens sustained level but
    // leaves the attack transient intact. It is also what actual beat trackers
    // use.
    const flux = Math.max(0, bass - this.prevBass);
    this.prevBass = bass;
    this.fluxMean = lerp(this.fluxMean, flux, 1 - Math.pow(0.6, dt));

    this.sinceBeat += dt;
    this.musicSeconds = this.musicVisible() ? this.musicSeconds + dt : 0;

    // The refractory period is what stops the "random" part: without it a single
    // kick with a messy tail retriggers two or three times. 0.16 s caps it at
    // 375 bpm, far above any real tempo, while still allowing fast double-kicks.
    // Half a second, so the first frames of a track can't set him off before the
    // flux baseline has seen anything.
    const warmedUp = this.musicSeconds > 0.5;

    // The absolute floor matters as much as the ratio: flux averages near zero
    // on quiet passages, so ratio alone would fire on the faintest ripple.
    // An onset is a candidate, not a nod. Everything below decides which
    // candidates were actually beats.
    const onset =
      warmedUp &&
      flux > this.fluxMean * this.nodTuning.onsetRatio &&
      flux > this.nodTuning.onsetFloor &&
      this.sinceOnset > 0.12;
    if (onset) {
      this.sinceOnset = 0;
      this.onsets.push(this.musicSeconds);
      if (this.onsets.length > 80) this.onsets.shift();
      this.lastOnsetStrength = Math.min(1, bass);
    }
    this.sinceOnset += dt;

    // Re-fit the grid a few times a second. Doing it per frame is wasted work;
    // the tempo of a track does not change at 60 Hz.
    this.sinceFit += dt;
    if (this.sinceFit > 0.35) {
      this.sinceFit = 0;
      this.fitGrid();
    }

    let nod = false;
    // Hysteresis, not a single threshold. Confidence wanders as onsets come and
    // go, and a bare 2.6 let him flip between grid-timed and onset-timed nodding
    // several times a track — two different rhythms alternating, which reads as
    // jitter even though each is steady on its own. Enter grid mode at 2.6, keep
    // it until 2.0.
    //
    // Measured real music 3.5-6.2, scattered noise 1.4-1.9, so both edges have
    // margin rather than splitting a hair.
    const enter = this.nodTuning.gridEnter;
    const stay = this.nodTuning.gridStay;
    this.onGrid = this.gridConfidence > (this.onGrid ? stay : enter);

    if (this.onGrid && this.period > 0) {
      // Confident: nod on the grid, whether or not this particular beat had a
      // detectable onset. This is the whole point — a fill, a dropped kick or a
      // syncopated bar no longer changes the timing of his head.
      if (this.musicSeconds >= this.nextBeatAt) {
        nod = true;
        // Step forward rather than reset, so a slow frame can't lose the beat.
        while (this.nextBeatAt <= this.musicSeconds) this.nextBeatAt += this.period;
      }
    } else if (onset && this.sinceBeat > 0.28) {
      // No usable tempo yet — fall back to nodding on onsets, which is what it
      // did before the grid existed. Degrading to the previous behaviour rather
      // than to nothing.
      nod = true;
    }

    if (nod) {
      // Louder hits push harder, but not proportionally — a chorus should not
      // throw the head off the screen.
      //
      // POSITIVE, because canvas Y grows downward and the draw does
      // translate(0, +beatY): the head must drop into the kick. Negative here
      // renders a head that bounces up off every beat, which looks wrong in a way
      // that is hard to name while watching it.
      this.beatVel += this.nodTuning.kick + this.lastOnsetStrength * this.nodTuning.kickScale;
      this.sinceBeat = 0;
      this.beatsSeen++;
      // Said once. Splits "the detector never fires" from "it fires and I can't
      // see it" — two failures that look identical from the other side of the
      // screen, and which cost three rounds of guessing to tell apart.
      if (this.beatsSeen === 1) console.log("[face] beat detected — nodding");
    }
    this.sinceBeat += dt;

    // Self-diagnosis, said once. "He doesn't move" has two very different causes
    // — no audio arriving at all, or audio arriving that never trips the detector
    // — and from outside the browser there is no way to tell them apart. Report
    // the actual numbers after ten seconds of music with no beat rather than
    // leaving it to guesswork.
    if (this.musicVisible()) {
      if (this.musicSeconds > 10 && !this.beatsSeen && !this.beatWarned) {
        this.beatWarned = true;
        console.warn(
          `[face] 10s of music and no beat detected. bass=${bass.toFixed(3)} ` +
            `flux=${flux.toFixed(4)} fluxMean=${this.fluxMean.toFixed(4)} ` +
            `ratio=${(flux / (this.fluxMean || 1e-6)).toFixed(2)} ` +
            `(needs ratio > 1.9 and flux > 0.012). If bass is near zero the capture has no ` +
            `audio; if flux stays tiny the track has no attack transients.`
        );
      }
    }

    // Spring back to rest.
    //
    // These are not free parameters. At 150/11 the ring period was 0.51 s and a
    // 120 bpm beat is 0.50 s — the spring was resonating with the music, each
    // kick landing exactly as the previous oscillation came round, so the two
    // interfered and the motion went chaotic. It also reversed direction seven
    // times per nod, which is jitter by definition.
    //
    // 400/34 puts the ring period at 0.31 s — comfortably shorter than a beat at
    // any sane tempo — with a damping ratio of 0.85, near critical. Measured: ONE
    // direction reversal per impulse, settled in 0.23 s. A clean dip and return,
    // finished before the next beat arrives.
    const STIFFNESS = this.nodTuning.stiffness;
    const DAMPING = this.nodTuning.damping;
    this.beatVel += (-STIFFNESS * this.beat - DAMPING * this.beatVel) * dt;
    this.beat += this.beatVel * dt;
    // A springy system given a bad frame can run away; this is the guard rail.
    this.beat = Math.max(-1.2, Math.min(1.2, this.beat));
    if (!this.musicVisible() && Math.abs(this.beat) < 0.002) this.beat = 0;

    // Overall loudness, for the bar colour. Smoothed harder than the bands: the
    // whole picture shifting hue should follow the track, not every snare.
    const loud = this.musicVisible() ? Math.min(1, (this.music.level ?? 0) * 1.6) : 0;
    this.loudness = lerp(this.loudness, loud, 1 - Math.pow(0.25, dt));

    for (let i = 0; i < this.bands.length; i++) {
      // Music takes the equaliser when he isn't using it himself.
      const target = this.musicVisible()
        ? this.sampleFrom(this.music.spectrum, (i + 0.5) / this.bands.length)
        : this.sample((i + 0.5) / this.bands.length);
      this.bands[i] = target > this.bands[i] ? lerp(this.bands[i], target, 1 - Math.pow(0.002, dt)) : lerp(this.bands[i], target, 1 - Math.pow(0.3, dt));
    }

    // Settling on a programme channel, and coming back out of it on the test
    // card. Eased over about a second — slower than the static wipe, so the set
    // is already holding still by the time the picture resolves, rather than
    // visibly creeping to a stop afterwards.
    // Keyed on the ZOOM rather than the channel number: leaning in is the thing
    // that makes holding still matter, so if the two ever stop coinciding this
    // follows the one that actually causes the problem.
    //
    // The beat nod is deliberately NOT damped. It only runs when system audio
    // has been shared on purpose, and on the Now Playing channel it is the whole
    // point — this is about the drift and the head-turn that never stop.
    this.settle = lerp(this.settle, this.zoom > 1 ? 1 : 0, 1 - Math.pow(0.05, dt));

    // Slower than the audio easing: a head turning should lag behind a pointer,
    // and matching it exactly looks like the cursor is dragging the set around.
    //
    // The target is scaled by how settled he is, so on a programme channel the
    // head eases to square-on and stays there however far the cursor roams.
    // Damping `look` itself rather than ignoring the pointer keeps `lookAt()`
    // and `hitTest()` reading the same numbers as the renderer.
    const looking = 1 - Math.pow(0.02, dt);
    const reach = 1 - this.settle;
    this.look.x = lerp(this.look.x, this.lookTarget.x * reach, looking);
    this.look.y = lerp(this.look.y, this.lookTarget.y * reach, looking);

    this.rollOffset = (this.rollOffset + this.roll * dt * 0.55) % 1;

    // Mains hum on the picture: a slow, shallow brightness wobble.
    this.flicker = 0.97 + Math.sin(this.time * 7.3) * 0.012 + Math.sin(this.time * 23.1) * 0.008;

    this.nextGlitchAt -= dt;
    if (this.nextGlitchAt <= 0) {
      this.fault = FAULTS[Math.floor(Math.random() * FAULTS.length)];
      this.glitch = 1;
      this.nextGlitchAt = 4 + Math.random() * 9;
    }
    // Static spits should snap away; the others can linger a moment.
    this.glitch = Math.max(0, this.glitch - dt * (this.fault === "burst" ? 7 : 3.2));

    // The channel-change wipe. Roughly 0.4 s of static, which is long enough to
    // hide the rebuild underneath it and short enough not to feel like a fault.
    this.wipe = Math.max(0, this.wipe - dt * 2.4);

    // Last, so the boot's own timing is not competing with a glitch scheduled
    // for the same frame.
    if (this.boot) {
      this.boot.update(dt);
      if (this.boot.finished) this.finishBoot?.();
    }
  }

  // Put the whole failure somewhere it can be read. The status bar truncates,
  // so the full message goes in the hint line, which wraps, along with the
  // measurements needed to tell a sizing fault from anything else.
  reportFailure(err) {
    const detail =
      `${err.name}: ${err.message} — canvas ${this.size}px @${this.dpr}x, ` +
      `body ${this.body ? `${this.body.width}x${this.body.height}` : "null"}, ` +
      `noise ${this.noise.length}×${this.noise[0]?.width ?? 0}px`;

    console.error("[face]", detail, err);

    const hint = document.getElementById("hint");
    if (hint) {
      hint.textContent = detail;
      hint.style.color = "#800000";
    }
    const badge = document.getElementById("badge");
    if (badge) {
      badge.textContent = "face error";
      badge.classList.add("warn");
      badge.title = detail;
    }
  }

  /**
   * A test-card bar, coloured by how loud the music is.
   *
   * Three things move together, because changing only one reads as a bug rather
   * than a reaction: the hue rotates, the colour saturates, and it brightens.
   * The rotation is capped at 50 degrees so the card stays recognisable — a full
   * sweep just looks like a broken television, and this set has real faults of
   * its own to not be confused with.
   *
   * Each bar is offset a little further round than the last, so loud passages
   * fan the seven colours apart instead of sliding them in lockstep.
   */
  barColour(i) {
    const base = TOP_BARS_HSL[i];
    const drive = this.loudness;
    // Each bar's OWN frequency band, which is what was missing. Overall loudness
    // moves all seven together — a uniform wash that reads as a tint, not as
    // music. Per-band brightness makes the bars fire independently, so you can
    // see the bassline in the left of the picture and a hi-hat in the right.
    const band = this.bands[i] ?? 0;
    // The kick flashes the whole card, tying the picture to the nod.
    const hit = Math.max(0, this.beat) * 0.9;

    // Hue travels with loudness, each bar a little further round than the last so
    // loud passages fan the card apart instead of sliding it in one block.
    const hue = (base.h + drive * (170 + i * 26) + band * 40) % 360;

    // Grey has no hue to rotate, so it earns one on the way up — otherwise the
    // first bar sits dead while the other six move, which reads as a fault.
    const sat = base.s === 0 ? Math.min(90, (drive * 0.6 + band * 0.7) * 110) : Math.min(100, base.s + band * 15);

    // Brightness is mostly the band now. Clamped either side of black and white:
    // past those the bar stops carrying information and just glares.
    const light = Math.max(8, Math.min(82, base.l + band * 46 + drive * 10 + hit * 18 - (base.s === 0 ? 26 : 0)));

    return `hsl(${hue.toFixed(1)} ${sat.toFixed(1)}% ${light.toFixed(1)}%)`;
  }

  // Same reading, any analyser. Music is louder and far wider-band than speech,
  // so it needs its own divisor — sharing speech's would peg every bar flat to
  // the top of the screen on anything with a bassline.
  sampleFrom(data, t) {
    if (!data || !data.length) return 0;
    const span = Math.floor(data.length * 0.62);
    const at = Math.min(span - 1, Math.floor(t * span));
    let sum = 0;
    let count = 0;
    for (let i = Math.max(0, at - 1); i <= Math.min(span - 1, at + 1); i++) {
      sum += data[i];
      count++;
    }
    return Math.min(1, sum / count / 235);
  }

  // Pull a 0..1 magnitude out of the analyser for a position across the screen.
  sample(t) {
    if (!this.spectrum || !this.spectrum.length) return 0;
    // The top of the range is mostly empty on speech, so read the lower half.
    const span = Math.floor(this.spectrum.length * 0.55);
    const at = Math.min(span - 1, Math.floor(t * span));
    let sum = 0;
    let count = 0;
    for (let i = Math.max(0, at - 1); i <= Math.min(span - 1, at + 1); i++) {
      sum += this.spectrum[i];
      count++;
    }
    return Math.min(1, sum / count / 210);
  }

  draw() {
    const { ctx, size } = this;
    if (!size || !this.body) return;

    // `half` positions things on the canvas; `u` is the unit the set is drawn
    // in. They are not the same — see FIT.
    const half = size / 2;
    // The set grows on any channel but the test card, so the picture stops being
    // 20% of the canvas. It is a bigger `u` rather than a scaled-up bitmap: the
    // cabinet and the programme are both rasterised at the larger size, which is
    // the difference between text you can read and text you can't.
    const u = half * FIT * this.zoom;
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(half, half + this.zoomShift());

    // ---- Float ------------------------------------------------------------
    // Shared with knobAt(), and scaled down to nothing on a programme channel.
    const { driftX, driftY, tilt } = this.floatOffset(u);

    // The beat, on top of the idle float rather than replacing it: he keeps
    // breathing while he nods. Down on the hit, because a head dropping into a
    // kick reads as rhythm and a head rising off it reads as a hiccup.
    // These numbers are the whole feature. At the original 0.055 the spring's
    // 0.19 peak came out as 1.6-3.1 px of movement, against an idle float of
    // 2.8-5.4 px that never stops — the nod was smaller than the drift it had to
    // be seen against, so it was invisible however well the beat was detected.
    // Three rounds of tuning the detector went into a motion nothing could have
    // shown. **Measure the output in pixels before tuning the input.**
    // 1.7 rather than 0.42 because the stiffer spring peaks at 0.046 instead of
    // 0.190 for the same impulse — this keeps the nod the same size on screen
    // while the motion underneath it is completely different.
    const beatY = this.beat * u * this.nodTuning.depth;

    // Measured HERE, where the motion actually becomes pixels, rather than
    // inferred from the spring position — this is the number that was never
    // taken, and taking it is the whole point of the panel. Held at its peak for
    // a moment so a value that appears for two frames is still readable.
    const nodPx = Math.abs(beatY);
    if (nodPx > this.nodPeakPx || this.time > this.nodPeakDecayAt) {
      this.nodPeakPx = nodPx;
      this.nodPeakDecayAt = this.time + 0.9;
    }
    // The idle float it has to be seen against, for the same reason: a nod
    // smaller than the drift underneath it is invisible however well timed.
    this.idleFloatPx = Math.abs(driftY - beatY);
    // A counter-rotation so it reads as a nod rather than a lift. Same story:
    // 0.03 gave a third of a degree, against an idle tilt of a full degree.
    const beatTilt = this.beat * this.nodTuning.tilt;

    ctx.translate(driftX, driftY + beatY);

    // ---- Glow the screen throws onto the dark behind it --------------------
    // Left unprojected: it's light falling on the room, not part of the set.
    const cast = ctx.createRadialGradient(0, 0, u * 0.15, 0, 0, u * 1.15);
    const castStrength = (0.16 + this.level * 0.2) * this.glow;
    cast.addColorStop(0, `rgba(150, 200, 255, ${castStrength})`);
    cast.addColorStop(0.55, `rgba(90, 140, 210, ${castStrength * 0.28})`);
    cast.addColorStop(1, "rgba(60, 100, 170, 0)");
    ctx.fillStyle = cast;
    ctx.beginPath();
    ctx.arc(0, 0, u * 1.15, 0, Math.PI * 2);
    ctx.fill();

    // An offscreen canvas can come back with no dimensions — the browser
    // refusing an allocation is the usual reason — and drawing from one throws
    // rather than doing nothing. Rebuilding is both safer and self-healing;
    // clearing `size` is what forces resize() past its no-op guard.
    if (!this.body.width || !this.body.height || !this.flat.width) {
      this.size = 0;
      ctx.restore();
      this.resize();
      return;
    }

    // ---- Draw the set flat, then turn it to face the pointer ---------------
    this.drawFlat(half, u, size);
    ctx.rotate(tilt + beatTilt);
    this.project(ctx, half, size);

    ctx.restore();
  }

  /** The whole set, square-on, into the offscreen canvas the projection reads. */
  drawFlat(half, u, size) {
    const ctx = this.flat.getContext("2d");
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    ctx.save();
    ctx.translate(half, half);
    ctx.drawImage(this.body, -half, -half, size, size);

    ctx.save();
    screenPath(ctx, u);
    ctx.clip();
    // The tube sits behind the bezel, so the picture shifts against the turn —
    // the parallax you get looking into a recessed screen from an angle. The
    // projection handles the cabinet; this is the extra depth inside it.
    ctx.save();
    ctx.translate(-this.look.x * u * 0.03, -this.look.y * u * 0.022);
    this.drawPicture(ctx, u);
    ctx.restore();
    this.drawGlass(ctx, u);
    ctx.restore();

    ctx.restore();
  }

  /**
   * Project the flat set as if it had turned to face the pointer.
   *
   * Each vertical strip is placed at its own depth and scaled by how far away
   * that depth is, which is what produces a trapezoid: the edge swinging toward
   * you grows, the edge swinging away shrinks. Pitch is handled as an overall
   * vertical foreshortening, which is enough to read as tipping up or down
   * without needing a second axis of slicing.
   */
  project(ctx, half, size) {
    const yaw = this.look.x * MAX_YAW;
    const pitch = this.look.y * MAX_PITCH;
    const focal = FOCAL * half;

    // Where a point across the face lands once the head has turned.
    //
    // `depth` is how much farther from you that point has swung. Turning to look
    // left sends the left edge away and brings the right edge forward — the same
    // way you see more of someone's right cheek when they look to their left —
    // so the far edge shrinks and the near edge grows.
    const place = (nx) => {
      const x = nx * half;
      const depth = x * Math.sin(yaw);
      const scale = focal / (focal + depth);
      return { x: x * Math.cos(yaw) * scale, scale };
    };

    ctx.save();
    // Tipping: squash vertically and slide the set the way it leans, so it
    // rotates about its neck rather than its middle.
    ctx.scale(1, Math.cos(pitch));
    ctx.translate(0, Math.sin(pitch) * half * 0.34);

    const source = this.flat.width;
    for (let i = 0; i < SLICES; i++) {
      const left = place((i / SLICES) * 2 - 1);
      const right = place(((i + 1) / SLICES) * 2 - 1);

      const width = right.x - left.x;
      if (width <= 0) continue;

      const scale = (left.scale + right.scale) / 2;
      const height = size * scale;

      ctx.drawImage(
        this.flat,
        (i / SLICES) * source, 0, source / SLICES, this.flat.height,
        // Half a pixel of overlap, or the seams between strips show as lines.
        left.x, -height / 2, width + 0.5, height
      );
    }

    ctx.restore();
  }

  drawPicture(ctx, u) {
    const x = -SCREEN.w * u;
    const y = -SCREEN.h * u + SCREEN.y * u;
    const w = SCREEN.w * 2 * u;
    const h = SCREEN.h * 2 * u;

    ctx.save();
    ctx.globalAlpha = this.flicker;

    // The set is coming on, so there is no programme yet — and deliberately no
    // caption, clock, snow or roll either. "PLEASE STAND BY" across a POST
    // screen is the same mistake as the full caption box across the album art,
    // and a machine that is booting is not one that has lost vertical hold.
    // The glass, scanlines and shadow mask are applied outside this method and
    // still land on top, which is most of why it reads as a screen.
    if (this.boot) {
      this.boot.draw(ctx, x, y, w, h);
      ctx.restore();
      return;
    }

    // Rolling: draw the pattern twice, offset, so it wraps seamlessly as it
    // slips — a television losing vertical hold, not a texture scrolling.
    // A "slip" fault borrows the same mechanism for a moment.
    const slip = this.fault === "slip" ? this.glitch * this.glitch * h * 0.16 : 0;
    const offset = (this.roll > 0.01 ? this.rollOffset * h : 0) + slip;
    this.drawProgramme(ctx, x, y + offset, w, h);
    if (offset > 0.5) {
      this.drawProgramme(ctx, x, y + offset - h, w, h);
      // The tear line where the frame wraps.
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(x, y + offset - h * 0.012, w, h * 0.024);
    }

    // Snow on top of everything — plus an extra spit during a "burst" fault, and
    // the full-picture static of a channel change.
    const burst = this.fault === "burst" ? this.glitch * 0.55 : 0;
    const snow = Math.min(1, this.snow + burst + this.wipe);
    if (snow > 0.02 && this.noise.length) {
      const tile = this.noise[Math.floor(this.time * 24) % this.noise.length];
      if (tile && tile.width && tile.height) {
        ctx.globalAlpha = snow * this.flicker;
        ctx.drawImage(tile, x, y, w, h);
        ctx.globalAlpha = this.flicker;
      }
    }

    if (this.glitch > 0.02) this.drawFault(ctx, x, y, w, h, offset);

    // The hum bar: mains and refresh not quite agreeing, so a soft band crawls
    // slowly up the picture. Faint enough not to distract, and the reason the
    // screen is never completely still.
    const humHeight = h * 0.17;
    const humY = y - humHeight + (1 - ((this.time / 11) % 1)) * (h + humHeight * 2);
    const hum = ctx.createLinearGradient(0, humY, 0, humY + humHeight);
    hum.addColorStop(0, "rgba(255,255,255,0)");
    hum.addColorStop(0.5, "rgba(255,255,255,0.06)");
    hum.addColorStop(1, "rgba(255,255,255,0)");
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = hum;
    ctx.fillRect(x, humY, w, humHeight);
    ctx.restore();

    // The caption box — this is most of Greg's expression.
    //
    // On a programme channel it becomes a subtitle instead: small, along the
    // bottom, and only when it has something to say. The full box sat squarely
    // across the album art and the track title, and a permanent "PLEASE STAND
    // BY" over a picture is a fault card rather than an expression — the
    // programme is the point of the channel, and interrupting it to announce
    // that nothing is happening defeats it.
    const caption = this.mode.caption;
    if (caption) {
      if (this.channel === 1) this.drawCaption(ctx, caption, x, y, w, h);
      else if (this.state !== "idle") this.drawSubtitle(ctx, caption, x, y, w, h);
    }

    // Broadcast test cards carried a clock. This one counts up from the moment
    // Greg was started, so it says how long he's been awake. Hidden while he
    // speaks, when the bars are busy being an equaliser — and kept to the test
    // card, since on a programme it lands on top of the picture.
    if (this.uptimeStart && this.channel === 1 && this.state !== "speaking") this.drawClock(ctx, x, y, w, h);

    // What he is saying, when it cannot be heard. Before the volume readout, so
    // turning the knob while he talks puts the level over the words rather than
    // the other way round — the readout is the thing you just asked for.
    this.drawSpeechSubtitle(ctx, x, y, w, h);

    // The volume readout, if it has just been asked for. LAST, so it is over
    // everything — that is what an on-screen display is — and at the TOP, which
    // is the one part of the picture none of Greg's own furniture uses: the
    // caption sits at the middle, the clock at 0.575 and the subtitle at 0.735.
    // It is drawn over a programme's header for a second and a bit, which is
    // exactly what a television does.
    this.drawVolume(ctx, x, y, w, h);

    ctx.restore();
  }

  /**
   * Page 888: what he is saying, in teletext, along the bottom.
   *
   * White on black boxes tight to the text, in the teletext font, centred and
   * at most two lines — which is what Ceefax subtitles looked like, and also
   * happens to be the most legible thing available at a 312 px picture.
   *
   * It sits at the same height as the programme subtitle (0.735), and the two
   * cannot collide: `MODES.speaking.caption` is null, so nothing else is drawn
   * in that band while he is talking. That is the stale-strip lesson applied
   * before rather than after — check what already occupies the space.
   *
   * The little cyan 888 is not decoration. Text appearing over the picture with
   * no explanation is a puzzle; the page number is what a viewer of the period
   * would have recognised, and it says "this is a subtitle" without a sentence
   * of English telling you so.
   */
  drawSpeechSubtitle(ctx, x, y, w, h) {
    if (!this.subtitling) return;

    const fontSize = Math.max(6, h * 0.058);
    ctx.save();
    ctx.font = `${fontSize}px ${TELETEXT_FONT}`;
    ctx.textBaseline = "middle";

    // The grid, measured rather than assumed at 0.55em — the same reason the
    // Ceefax renderer measures its own advance width. A machine that falls
    // through to a different monospace font must not overflow the picture.
    const advance = ctx.measureText("00000000").width / 8;
    const cols = Math.max(8, Math.floor((w * 0.9) / advance));

    // The marker shows whenever subtitles are on, including between sentences —
    // it says the feature is on, not that he is mid-word. Without that, muting
    // him and getting silence with nothing on screen is the very state this
    // exists to remove.
    const tagSize = Math.max(5, h * 0.045);
    ctx.font = `${tagSize}px ${TELETEXT_FONT}`;
    ctx.textAlign = "right";
    const tag = "888";
    const tagW = ctx.measureText(tag).width;
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillRect(x + w - tagW - tagSize * 1.2, y + h * 0.03, tagW + tagSize * 0.8, tagSize * 1.5);
    ctx.fillStyle = "#33e0e0";
    ctx.fillText(tag, x + w - tagSize * 0.6, y + h * 0.03 + tagSize * 0.75);

    // FOUR lines, not the two a broadcast subtitle would use, and the reason is
    // the honesty gap rather than the aesthetic. Two lines is ~74 characters —
    // and it is ~74 at every window size, because the font scales with the
    // picture and the column count barely moves, the same finding the Ceefax
    // channel landed on. A muted set has no other copy of the answer, so a
    // sentence clipped at 74 characters loses it outright. Rendering the real
    // thing is what showed this: "before three in the…" on a perfectly ordinary
    // weather sentence.
    const lines = subtitleLines(this.speechText, cols, 4);
    if (!lines.length) {
      ctx.restore();
      return;
    }

    ctx.font = `${fontSize}px ${TELETEXT_FONT}`;
    ctx.textAlign = "center";
    const lineH = fontSize * 1.42;
    const padX = advance * 0.5;
    // Anchored so the LAST line always lands on the same baseline. Growing
    // upward from a fixed bottom means a two-line sentence does not shift a
    // one-line sentence off the mark, which is what makes a run of subtitles
    // readable rather than jumpy.
    const bottom = y + h * 0.735 + lineH / 2;
    const cx = x + w / 2;

    for (const [index, line] of lines.entries()) {
      const midY = bottom - (lines.length - 1 - index) * lineH - lineH / 2;
      const textW = ctx.measureText(line).width;
      ctx.fillStyle = "rgba(0,0,0,0.85)";
      ctx.fillRect(cx - textW / 2 - padX, midY - lineH / 2, textW + padX * 2, lineH);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(line, cx, midY + fontSize * 0.06);
    }

    ctx.restore();
  }

  // How long the readout stays up, and how much of that is spent fading.
  static VOLUME_HOLD = 1.15;
  static VOLUME_FADE = 0.45;

  /**
   * VOLUME ▮▮▮▮▮▮▯▯▯▯ 70% across the top of the picture, briefly.
   *
   * The knob is the control, but a notch on a dial 3% of the picture across
   * cannot be read as a number — at a 390 canvas that knob is about 6 px, which
   * is why every television that ever had a volume knob and a screen eventually
   * put the level on the screen. Ten segments, matching the ten clicks it takes
   * to cross the range, so the picture and the control agree about how far one
   * click goes.
   *
   * Nothing is drawn during the boot sequence: drawPicture returns before this
   * while `this.boot` is set, for the same reason the caption and the clock are
   * held back — a POST screen with a volume bar over it is a set that has
   * finished starting up.
   */
  drawVolume(ctx, x, y, w, h) {
    const age = this.time - this.volumeShownAt;
    const { VOLUME_HOLD, VOLUME_FADE } = FaceTV;
    if (!(age >= 0) || age > VOLUME_HOLD + VOLUME_FADE) return;
    const alpha = age <= VOLUME_HOLD ? 1 : 1 - (age - VOLUME_HOLD) / VOLUME_FADE;

    const fontSize = Math.max(6, h * 0.062);
    const pad = fontSize * 0.7;
    const boxH = fontSize * 2;
    const boxW = w * 0.84;
    const boxX = x + (w - boxW) / 2;
    const boxY = y + h * 0.07;

    ctx.save();
    ctx.globalAlpha *= alpha;

    ctx.fillStyle = "rgba(6,8,14,0.82)";
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = Math.max(1, h * 0.004);
    ctx.strokeRect(boxX, boxY, boxW, boxH);

    const midY = boxY + boxH / 2;
    ctx.textBaseline = "middle";

    // The word, then the number, then whatever room is left goes to the bar —
    // measured rather than allotted by eye. The boot screen's [ OK ] column was
    // placed by counting characters and held for exactly one length of context
    // size; the same mistake here would put the bar through the percentage the
    // first time somebody's volume reached three digits.
    ctx.font = `bold ${fontSize * 0.8}px "MS Sans Serif", Tahoma, sans-serif`;
    ctx.textAlign = "left";
    ctx.fillStyle = "#f2f4ff";
    const label = "VOLUME";
    ctx.fillText(label, boxX + pad, midY);
    const labelW = ctx.measureText(label).width;

    ctx.font = `bold ${fontSize * 0.85}px "MS Sans Serif", Tahoma, sans-serif`;
    ctx.textAlign = "right";
    const reading = volumeLabel(this.volume);
    // Muted is amber rather than white. It is the one state where the absence of
    // sound is a setting and not a fault, and it is worth being able to tell
    // those apart at a glance from across a room.
    ctx.fillStyle = this.volume <= 0 ? "#ffcc55" : "#f2f4ff";
    ctx.fillText(reading, boxX + boxW - pad, midY);
    const readingW = ctx.measureText(reading).width;

    const barX = boxX + pad + labelW + pad;
    const barW = boxX + boxW - pad - readingW - pad - barX;
    if (barW <= 0) {
      ctx.restore();
      return; // too narrow to say anything true; the number already did
    }

    const segments = 10;
    const gap = Math.max(1, barW * 0.018);
    const segW = (barW - gap * (segments - 1)) / segments;
    const segH = fontSize * 0.72;
    // Rounded UP, so any volume above silent lights at least one segment. A bar
    // reading empty while sound is coming out is the picture disagreeing with
    // the speakers, which is the disagreement this whole arrangement exists to
    // prevent.
    const lit = Math.ceil(this.volume * segments);
    for (let i = 0; i < segments; i++) {
      ctx.fillStyle = i < lit ? "#7ce0a0" : "rgba(255,255,255,0.16)";
      ctx.fillRect(barX + i * (segW + gap), midY - segH / 2, segW, segH);
    }

    ctx.restore();
  }

  // One fault, four flavours. Each is a thing a real set does when it loses its
  // grip on the signal, which is what keeps them legible rather than decorative.
  drawFault(ctx, x, y, w, h, offset) {
    if (this.fault === "tear") {
      const sliceY = y + ((this.time * 900) % h);
      const shift = (Math.random() - 0.5) * w * 0.08 * this.glitch;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, sliceY, w, h * 0.05 * this.glitch);
      ctx.clip();
      this.drawBars(ctx, x + shift, y + offset, w, h);
      ctx.restore();
      return;
    }

    if (this.fault === "fringe") {
      // Two offset copies added back over the picture: chroma drifting off the
      // luma, which is what colour separation actually looks like.
      const shift = w * 0.012 * this.glitch;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.22 * this.glitch;
      this.drawBars(ctx, x + shift, y + offset, w, h);
      this.drawBars(ctx, x - shift, y + offset, w, h);
      ctx.restore();
    }
    // "slip" is applied through the roll offset, and "burst" through the snow,
    // so both are already on screen by the time we get here.
  }

  drawClock(ctx, x, y, w, h) {
    const text = formatUptime(Date.now() - this.uptimeStart);
    const fontSize = Math.max(6, h * 0.062);
    ctx.font = `${fontSize}px "Consolas", "Lucida Console", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const padX = fontSize * 0.6;
    const padY = fontSize * 0.34;
    const width = ctx.measureText(text).width + padX * 2;
    const height = fontSize + padY * 2;
    const cx = x + w / 2;
    // Below the caption, still clear of the castellation strip at 0.64.
    const cy = y + h * 0.575;

    ctx.fillStyle = "rgba(8,8,10,0.92)";
    ctx.fillRect(cx - width / 2, cy - height / 2, width, height);
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = Math.max(1, h * 0.004);
    ctx.strokeRect(cx - width / 2, cy - height / 2, width, height);

    ctx.fillStyle = "#eaeaea";
    ctx.fillText(text, cx, cy + fontSize * 0.06);
  }

  /**
   * Whatever channel is showing, drawn into the picture rectangle.
   *
   * Everything that happens to the picture — the roll, the tear, the colour
   * fringe, the wrap when vertical hold slips — goes through here rather than
   * through the test card directly, so a new channel inherits all of it for
   * free and cannot be the one thing on the set that never glitches.
   */
  drawProgramme(ctx, x, y, w, h) {
    // A feed that has gone stale gets a strip along the bottom, and the
    // programme gets what is left of the picture.
    //
    // Reserved HERE rather than inside each renderer, and that is the fix for a
    // real bug rather than a tidiness preference: the first version had every
    // renderer draw the strip itself, at the bottom, over whatever was already
    // there. On Ceefax it cut the fastext bar in half; on the weather channel it
    // landed across the forecast temperatures; on the astronomy picture it sat
    // on the credit. One shared helper drawing into space nobody reserved is
    // four collisions, not one. Doing it in the dispatch means a channel added
    // later cannot forget.
    const data = this.feed(this.channelId);
    const staleH = data?.stale ? h * 0.062 : 0;
    const inner = h - staleH;

    // Dispatched on the channel's IDENTITY, not its number. A number is a
    // position on a dial and could be reordered; "weather" could not.
    //
    // The eight programme renderers live in public/channels/, one file each,
    // and are looked up rather than switched on — so adding a channel is one
    // file there plus one line in its index, and nothing here changes at all.
    // They used to be methods on this class and had taken it to 3,822 lines.
    //
    // Now-playing stays a method: it predates all of this, owns its own artwork
    // and level meter, and moving it would be a second change hiding inside
    // this one.
    const renderer = RENDERERS[this.channelId] ?? this.addonRenderer();
    if (renderer) renderer(ctx, x, y, w, inner, this.viewFor());
    else if (this.channelId === "nowplaying") this.drawNowPlaying(ctx, x, y, w, inner);
    else this.drawBars(ctx, x, y, w, inner);

    if (staleH) {
      this.drawStaleStrip(ctx, x, y + inner, w, staleH, `${STALE_LEAD[this.channelId] ?? "May be out of date"} — ${data.warning ?? "the feed did not answer"}`);
    }
  }

  /**
   * The read-only surface a channel renderer gets.
   *
   * Deliberately small, and that is the whole reason the extraction was
   * mechanical rather than a rewrite: measured across all eight renderers, they
   * reached for exactly six things on the face — the feed, the standby card,
   * the clock, the page-cycle origin, and the two loaded images. Nothing else.
   *
   * Keep it that way. A renderer that needs a seventh thing is usually a
   * renderer doing something that belongs out here instead — the stale strip is
   * the example, drawn by drawProgramme() because the space has to be reserved
   * before dispatch.
   *
   * Rebuilt each call rather than cached, because `time` moves every frame and
   * a stale clock would freeze every animation on the set. It is six property
   * reads; the allocation is not worth avoiding.
   */
  viewFor() {
    return {
      feed: (id) => this.feed(id),
      time: this.time,
      pageSince: this.pageSince,
      photo: this.photo,
      radarFrames: this.radarFrames,
    };
  }

  /**
   * The data for the channel showing, or null.
   *
   * Guarded on the id matching, because a reply can land after the channel has
   * already moved on — the poll goes out, the user turns the knob, the reply
   * arrives. Painting last channel's data into this channel's renderer would
   * not throw; it would draw a wrong picture confidently, which is worse.
   */
  feed(id) {
    return this.programmeId === id ? this.programme : null;
  }

  /**
   * The "we have nothing yet" card, shared by every programme channel.
   *
   * A blank screen and a broken screen look identical, and a channel that says
   * nothing while it loads reads as the one that is broken. Naming the state is
   * the whole job.
   */

  /**
   * A strip along the bottom saying the picture is not current.
   *
   * `stale` and `error` are different facts and are never collapsed: stale
   * means this IS real, just not fresh, and the picture stays up. That is what
   * a television does when a feed hiccups, and it is the same distinction
   * lib/programmes.js draws server-side.
   */
  drawStaleStrip(ctx, x, y, w, h, text) {
    ctx.fillStyle = "rgba(120,80,20,0.85)";
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "rgba(255,225,170,0.95)";
    ctx.font = `${Math.max(5, h * 0.62)}px "MS Sans Serif", Tahoma, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(ellipsize(ctx, text, w * 0.94), x + w * 0.03, y + h / 2);
  }

  /**
   * Channel 2: what Windows says is playing, with the album art.
   *
   * Deliberately NOT hidden while Greg talks, the way the music visualiser is.
   * A television does not stop showing the programme because someone in the room
   * spoke — his expression stays in the caption box and the level meter along
   * the bottom, both of which are drawn over the top of this.
   */
  drawNowPlaying(ctx, x, y, w, h) {
    const track = this.nowPlaying;

    // Deep blue rather than black: a CRT showing a real picture never reaches
    // black, and the difference is most of what makes it read as "on".
    const back = ctx.createLinearGradient(x, y, x, y + h);
    back.addColorStop(0, "#0d1430");
    back.addColorStop(0.55, "#0a0f22");
    back.addColorStop(1, "#05070f");
    ctx.fillStyle = back;
    ctx.fillRect(x, y, w, h);

    if (!track || !track.playing) {
      this.drawNoProgramme(ctx, x, y, w, h, track);
      return;
    }

    const pad = w * 0.055;
    const headerH = h * 0.155;

    // ---- The ident strip, like a channel logo in the corner ----------------
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    ctx.fillRect(x, y, w, headerH);
    ctx.fillStyle = "#7fd4ff";
    ctx.font = `bold ${Math.max(6, h * 0.062)}px "MS Sans Serif", Tahoma, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(track.status === "Paused" ? "PAUSED" : "NOW PLAYING", x + pad, y + headerH / 2);

    if (track.source) {
      ctx.fillStyle = "rgba(200,220,255,0.55)";
      ctx.textAlign = "right";
      ctx.fillText(track.source.toUpperCase(), x + w - pad, y + headerH / 2);
    }

    // ---- The cover ---------------------------------------------------------
    const meterH = h * 0.075;
    const bodyTop = y + headerH + h * 0.06;
    const bodyBottom = y + h - meterH - h * 0.13;
    const coverSize = Math.max(1, bodyBottom - bodyTop);
    const coverX = x + pad;

    if (this.art && this.art.width) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(coverX, bodyTop, coverSize, coverSize);
      ctx.clip();
      ctx.drawImage(this.art, coverX, bodyTop, coverSize, coverSize);
      ctx.restore();
    } else {
      // A hole where the art should be looks like a failure; a blank record
      // sleeve looks like a record with no cover, which is what it is.
      ctx.fillStyle = "rgba(255,255,255,0.07)";
      ctx.fillRect(coverX, bodyTop, coverSize, coverSize);
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.lineWidth = Math.max(1, h * 0.005);
      ctx.strokeRect(coverX, bodyTop, coverSize, coverSize);
      ctx.fillStyle = "rgba(255,255,255,0.28)";
      ctx.font = `${Math.max(6, coverSize * 0.13)}px "MS Sans Serif", Tahoma, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("♪", coverX + coverSize / 2, bodyTop + coverSize / 2);
    }

    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = Math.max(1, h * 0.004);
    ctx.strokeRect(coverX, bodyTop, coverSize, coverSize);

    // ---- Title, artist, album ----------------------------------------------
    const textX = coverX + coverSize + w * 0.05;
    const textW = x + w - pad - textX;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";

    const titleSize = Math.max(7, h * 0.095);
    ctx.font = `bold ${titleSize}px "MS Sans Serif", Tahoma, sans-serif`;
    ctx.fillStyle = "#f4f7ff";
    const titleLines = wrapText(ctx, track.title || "Untitled", textW, 2);
    let at = bodyTop + titleSize;
    for (const line of titleLines) {
      ctx.fillText(line, textX, at);
      at += titleSize * 1.18;
    }

    if (track.artist) {
      const artistSize = Math.max(6, h * 0.078);
      ctx.font = `${artistSize}px "MS Sans Serif", Tahoma, sans-serif`;
      ctx.fillStyle = "#9fd0ff";
      at += artistSize * 0.35;
      ctx.fillText(ellipsize(ctx, track.artist, textW), textX, at);
      at += artistSize * 1.1;
    }

    // A podcast episode carries its show in `artist` and has no album, so
    // printing one would be inventing it.
    if (track.kind === "Music" && track.album && track.album !== track.title) {
      const albumSize = Math.max(5, h * 0.062);
      ctx.font = `${albumSize}px "MS Sans Serif", Tahoma, sans-serif`;
      ctx.fillStyle = "rgba(190,205,235,0.6)";
      at += albumSize * 0.4;
      ctx.fillText(ellipsize(ctx, track.album, textW), textX, at);
    }

    // ---- Progress ----------------------------------------------------------
    if (track.duration > 0) {
      const elapsed = this.elapsedNow(track);
      const barY = y + h - meterH - h * 0.075;
      const barH = Math.max(2, h * 0.018);
      const barW = w - pad * 2;

      ctx.fillStyle = "rgba(255,255,255,0.16)";
      ctx.fillRect(x + pad, barY, barW, barH);
      ctx.fillStyle = "#7fd4ff";
      ctx.fillRect(x + pad, barY, barW * Math.min(1, elapsed / track.duration), barH);

      const timeSize = Math.max(5, h * 0.055);
      ctx.font = `${timeSize}px "Consolas", "Lucida Console", monospace`;
      ctx.fillStyle = "rgba(200,220,255,0.75)";
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      ctx.fillText(clock(elapsed), x + pad, barY + barH + h * 0.014);
      ctx.textAlign = "right";
      ctx.fillText(clock(track.duration), x + w - pad, barY + barH + h * 0.014);
    }

    // ---- The level meter along the bottom ----------------------------------
    // Driven by whichever analyser is live: his own voice while he talks, the
    // speakers otherwise. It is the one part of this channel that moves, and a
    // now-playing screen that does not move is a poster.
    this.drawMeter(ctx, x, y + h - meterH, w, meterH);
  }

  /** Channel 2 with nothing to show. */
  drawNoProgramme(ctx, x, y, w, h, track) {
    const message = track?.pending ? "TUNING IN" : track?.error ? "NO SIGNAL" : "NOTHING PLAYING";

    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = `bold ${Math.max(7, h * 0.1)}px "MS Sans Serif", Tahoma, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(message, x + w / 2, y + h * 0.44);

    if (!track?.pending) {
      ctx.fillStyle = "rgba(190,205,235,0.4)";
      ctx.font = `${Math.max(5, h * 0.055)}px "MS Sans Serif", Tahoma, sans-serif`;
      ctx.fillText("start something and it will appear here", x + w / 2, y + h * 0.56);
    }

    this.drawMeter(ctx, x, y + h - h * 0.075, w, h * 0.075);
  }

  /** A row of thin bars along the bottom of a channel, from the live analyser. */
  drawMeter(ctx, x, y, w, h) {
    const bars = 28;
    const gap = w / bars;
    const width = gap * 0.62;
    const live = this.state === "speaking" ? this.spectrum : this.music?.spectrum;

    for (let i = 0; i < bars; i++) {
      const t = (i + 0.5) / bars;
      const value = live
        ? this.state === "speaking"
          ? this.sample(t)
          : this.sampleFrom(this.music.spectrum, t)
        : 0;
      // A floor, so an idle meter is a row of dim pips rather than nothing.
      const level = Math.max(0.06, Math.min(1, value));
      ctx.fillStyle = `rgba(127,212,255,${0.22 + level * 0.6})`;
      ctx.fillRect(x + i * gap + (gap - width) / 2, y + h * (1 - level), width, h * level);
    }
  }

  /**
   * Where the track has got to, right now.
   *
   * The reading arrives once every few seconds, so the bar would jump in steps
   * without this. `at` is when the reading was taken; the rest is arithmetic.
   * Only while actually playing — interpolating a paused track would walk the
   * bar forward through a track that is standing still.
   */
  elapsedNow(track) {
    const base = track.position ?? 0;
    if (track.status !== "Playing") return base;
    const since = (Date.now() - (track.at ?? Date.now())) / 1000;
    return Math.max(0, Math.min(track.duration ?? Infinity, base + since));
  }









  drawBars(ctx, x, y, w, h) {
    const topH = h * 0.64;
    const midH = h * 0.09;
    const botH = h - topH - midH;
    const barW = w / TOP_BARS.length;

    // ---- The seven colour bars ---------------------------------------------
    for (let i = 0; i < TOP_BARS.length; i++) {
      // Music draws a proper spectrum analyser: a dim column with a bright bar
      // rising from the bottom. Speech keeps the original behaviour, where the
      // bar drops from the top — that reads as a test card being modulated,
      // which is right for a television talking, and wrong for one playing music.
      if (this.musicVisible()) {
        const band = this.bands[i];
        // A floor so the card never goes fully dark between beats.
        const barH = Math.max(topH * 0.05, band * topH);
        const dim = TOP_BARS_HSL[i];
        ctx.fillStyle = `hsl(${dim.h} ${dim.s * 0.5}% ${dim.s === 0 ? 12 : 9}%)`;
        ctx.fillRect(x + i * barW, y, barW + 0.5, topH);
        ctx.fillStyle = this.barColour(i);
        ctx.fillRect(x + i * barW, y + topH - barH, barW + 0.5, barH);
      } else {
        ctx.fillStyle = TOP_BARS[i];
        // Speaking turns the bars into an equaliser: each one drops from the top
        // by its own band, so his voice is legible as a shape.
        const lift = this.state === "speaking" ? this.bands[i] * topH * 0.5 : 0;
        ctx.fillRect(x + i * barW, y + lift, barW + 0.5, topH - lift);
      }

      // Listening puts a soft pulse through the picture instead, so the card
      // stays intact while still reacting to you.
      if (this.state === "listening" && this.level > 0.02) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = `rgba(255,255,255,${this.level * 0.18})`;
        ctx.fillRect(x + i * barW, y, barW + 0.5, topH);
        ctx.restore();
      }
    }

    // ---- Castellation strip -------------------------------------------------
    for (let i = 0; i < MID_BARS.length; i++) {
      ctx.fillStyle = MID_BARS[i];
      ctx.fillRect(x + i * barW, y + topH, barW + 0.5, midH);
    }

    // ---- -I / white / +Q / PLUGE -------------------------------------------
    const units = BOTTOM_BARS.reduce((total, bar) => total + bar.units, 0);
    let at = x;
    for (const bar of BOTTOM_BARS) {
      const width = (bar.units / units) * w;
      ctx.fillStyle = bar.color;
      ctx.fillRect(at, y + topH + midH, width + 0.5, botH);
      at += width;
    }
  }

  drawCaption(ctx, text, x, y, w, h) {
    const fontSize = Math.max(7, h * 0.085);
    ctx.font = `bold ${fontSize}px "MS Sans Serif", Tahoma, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const padX = fontSize * 0.7;
    const padY = fontSize * 0.45;
    const width = ctx.measureText(text).width + padX * 2;
    const height = fontSize + padY * 2;
    const cx = x + w / 2;
    const cy = y + h * 0.44;

    ctx.fillStyle = "#f2f2f2";
    ctx.fillRect(cx - width / 2, cy - height / 2, width, height);
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = Math.max(1, h * 0.006);
    ctx.strokeRect(cx - width / 2, cy - height / 2, width, height);

    ctx.fillStyle = "#101010";
    ctx.fillText(text, cx, cy + fontSize * 0.06);
  }

  /** Greg's expression on a programme channel: a subtitle over the picture. */
  drawSubtitle(ctx, text, x, y, w, h) {
    const fontSize = Math.max(6, h * 0.062);
    ctx.font = `bold ${fontSize}px "MS Sans Serif", Tahoma, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const padX = fontSize * 0.6;
    const padY = fontSize * 0.32;
    const width = ctx.measureText(text).width + padX * 2;
    const height = fontSize + padY * 2;
    const cx = x + w / 2;
    // Low enough to read as a subtitle, high enough to clear the progress bar
    // and the level meter underneath it.
    const cy = y + h * 0.735;

    ctx.fillStyle = "rgba(6,8,14,0.78)";
    ctx.fillRect(cx - width / 2, cy - height / 2, width, height);
    ctx.fillStyle = "#f2f4ff";
    ctx.fillText(text, cx, cy + fontSize * 0.06);
  }

  // Everything that makes it read as glass rather than a printed card.
  drawGlass(ctx, u) {
    const x = -SCREEN.w * u;
    const y = -SCREEN.h * u + SCREEN.y * u;
    const w = SCREEN.w * 2 * u;
    const h = SCREEN.h * 2 * u;

    // The shadow mask is a property of the TUBE, so it is sized from the
    // unzoomed unit and does not grow when the set leans in. Scaling it with the
    // picture put a 12-pixel colour stripe across the album art and turned a
    // photograph into a moiré — the mask was coarser than the thing it was
    // supposed to be made of. Same pitch at both sizes; finer relative to the
    // picture exactly when the picture is bigger, which is when it matters.
    const grain = u / this.zoom;

    // Scanlines.
    const step = Math.max(2, grain * 0.018);
    ctx.fillStyle = "rgba(0,0,0,0.16)";
    for (let sy = y; sy < y + h; sy += step) ctx.fillRect(x, sy, w, step * 0.42);

    // Aperture-grille tint: a very fine vertical RGB shimmer.
    ctx.save();
    ctx.globalCompositeOperation = "overlay";
    // Lighter on a programme channel: at 0.16 the tint is invisible on flat
    // colour bars and overwhelming on a photograph.
    ctx.globalAlpha = this.channel === 1 ? 0.16 : 0.09;
    const cell = Math.max(3, grain * 0.012);
    for (let sx = x; sx < x + w; sx += cell * 3) {
      ctx.fillStyle = "#ff2020";
      ctx.fillRect(sx, y, cell, h);
      ctx.fillStyle = "#20ff20";
      ctx.fillRect(sx + cell, y, cell, h);
      ctx.fillStyle = "#2020ff";
      ctx.fillRect(sx + cell * 2, y, cell, h);
    }
    ctx.restore();

    // Corner darkening — a CRT is a curved surface, and the corners fall away.
    const vignette = ctx.createRadialGradient(0, SCREEN.y * u, u * 0.2, 0, SCREEN.y * u, u * 0.95);
    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(0.65, "rgba(0,0,0,0.18)");
    vignette.addColorStop(1, "rgba(0,0,0,0.62)");
    ctx.fillStyle = vignette;
    ctx.fillRect(x, y, w, h);

    // The big soft reflection across the top-left of the glass.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const sheen = ctx.createLinearGradient(x, y, x + w * 0.75, y + h * 0.8);
    sheen.addColorStop(0, "rgba(255,255,255,0.16)");
    sheen.addColorStop(0.32, "rgba(255,255,255,0.05)");
    sheen.addColorStop(0.55, "rgba(255,255,255,0)");
    ctx.fillStyle = sheen;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Geometry
//
// One description of the screen, used for both the clip and the picture, so the
// two can never drift apart.
// ---------------------------------------------------------------------------

// Everything is drawn against a unit `u` that is deliberately smaller than half
// the canvas. The antenna reaches past the top of the set and the whole head
// drifts as it floats, so drawing to the true half-size clips the aerials off.
const FIT = 0.86;

// How far the head actually turns to face the pointer, in radians.
const MAX_YAW = 0.46;   // ~26 degrees left/right
const MAX_PITCH = 0.30; // ~17 degrees up/down

// Distance from the viewer to the set, in half-canvas units. Smaller means a
// stronger perspective — the near edge flares and the far edge collapses. Too
// small and the head looks like it's being sucked into the screen.
const FOCAL = 3.1;

// Vertical strips used to project the turn. A flat image can only be sheared by
// an affine transform, which gives a parallelogram and reads as tipping over.
// Turning needs a trapezoid, so the set is sliced and each strip is drawn at its
// own depth. Enough slices that the edges stay smooth, few enough to be cheap.
const SLICES = 64;

const SCREEN = { w: 0.60, h: 0.44, y: -0.06, r: 0.09 };
const CASE = { w: 0.74, h: 0.60, y: -0.06, r: 0.13 };

// How much bigger the set gets on a channel other than the test card.
//
// The picture is 0.516 of the canvas across at rest, which is 20% of its AREA —
// the cabinet, the case and the float around it eat the other 80%. That is fine
// for colour bars and a two-word caption, and hopeless for anything with text or
// a photograph in it. 1.55 takes the picture to 0.80 of the canvas across and
// 44% of its area, while leaving enough cabinet in shot that it still reads as a
// television rather than a panel.
const CHANNEL_ZOOM = 1.55;

// The value used before the server has said how many channels there are — it
// arrives with the first paint. Only used to draw ticks on the knob, so being
// one out for a moment costs a tick mark, not a channel.
const CHANNEL_COUNT = 2;

// The subtitle font. The same stack the Ceefax channel uses, because a subtitle
// on this set IS teletext — page 888 — and because a monospace grid is what
// subtitleLines() counts against.
const TELETEXT_FONT = `"Consolas", "Lucida Console", "Courier New", monospace`;

// How far the dial swings between the first channel and the last, in radians.
// About 132 degrees: enough that two adjacent channels are visibly different,
// not so much that the notch points at the underside of the cabinet.
const KNOB_SWEEP = 2.3;

/**
 * Where the channel knob points, for a given channel.
 *
 * The spread is DERIVED from the number of channels rather than fixed. The
 * first version used a fixed 1.15 radians per step, which was correct for
 * exactly two channels and put channel 6 at 2.9 radians — most of the way round
 * the dial and pointing out of the bottom of the set. It reproduces the old
 * geometry exactly when there are two, so nothing moved on the channels that
 * already existed.
 */
function channelAngle(channel, count = CHANNEL_COUNT) {
  const spread = count > 1 ? KNOB_SWEEP / (count - 1) : 0;
  const middle = (count + 1) / 2;
  return (channel - middle) * spread;
}

// Both knobs sit centred in the bezel — the band between the bottom of the
// picture and the bottom of the cabinet — rather than being offset from the
// cabinet edge by a guessed amount, which sat them too high and crowded the
// screen. Derived this way they stay put if the proportions ever change, and
// the hit test and the drawing cannot drift apart.
const KNOB_X = [0.42, 0.56];

function knobCentre(u, index) {
  const bezelTop = (SCREEN.y + SCREEN.h) * u;
  const bezelBottom = (CASE.y + CASE.h) * u;
  return { x: KNOB_X[index] * u, y: (bezelTop + bezelBottom) / 2 };
}

function screenPath(ctx, u) {
  ctx.beginPath();
  ctx.roundRect(-SCREEN.w * u, (-SCREEN.h + SCREEN.y) * u, SCREEN.w * 2 * u, SCREEN.h * 2 * u, SCREEN.r * u);
}

function casePath(ctx, u) {
  ctx.beginPath();
  ctx.roundRect(-CASE.w * u, (-CASE.h + CASE.y) * u, CASE.w * 2 * u, CASE.h * 2 * u, CASE.r * u);
}

// ---------------------------------------------------------------------------
// The television set, drawn once
// ---------------------------------------------------------------------------

function buildBody(size, dpr, zoom = 1, channel = 1, channelCount = CHANNEL_COUNT, volume = 1) {
  const canvas = document.createElement("canvas");
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(size / 2, size / 2);

  const u = (size / 2) * FIT * zoom;
  const line = Math.max(1, u * 0.012);

  // ---- Antenna, behind the case so it appears to sprout from the top -------
  ctx.strokeStyle = "#8a8a8a";
  ctx.lineWidth = Math.max(1.5, u * 0.017);
  ctx.lineCap = "round";
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(side * 0.05 * u, (-CASE.h + CASE.y + 0.04) * u);
    ctx.quadraticCurveTo(side * 0.2 * u, -0.95 * u, side * 0.34 * u, -1.02 * u);
    ctx.stroke();

    ctx.fillStyle = "#c8c8c8";
    ctx.beginPath();
    ctx.arc(side * 0.34 * u, -1.02 * u, u * 0.026, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#5a5a5a";
    ctx.lineWidth = line * 0.6;
    ctx.stroke();
    ctx.strokeStyle = "#8a8a8a";
    ctx.lineWidth = Math.max(1.5, u * 0.017);
  }

  // The mount where the two rods meet the cabinet.
  ctx.fillStyle = "#9a9a9a";
  ctx.beginPath();
  ctx.ellipse(0, (-CASE.h + CASE.y + 0.03) * u, u * 0.075, u * 0.042, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#4a4a4a";
  ctx.lineWidth = line * 0.8;
  ctx.stroke();

  // ---- A short neck, so it reads as a head rather than a floating object ---
  const neck = ctx.createLinearGradient(-0.09 * u, 0, 0.09 * u, 0);
  neck.addColorStop(0, "#6f6a60");
  neck.addColorStop(0.4, "#b3ada0");
  neck.addColorStop(1, "#5d584f");
  ctx.fillStyle = neck;
  ctx.beginPath();
  ctx.roundRect(-0.09 * u, (CASE.h + CASE.y - 0.02) * u, 0.18 * u, 0.16 * u, u * 0.03);
  ctx.fill();
  ctx.strokeStyle = "#3b372f";
  ctx.lineWidth = line * 0.8;
  ctx.stroke();

  // ---- The cabinet ---------------------------------------------------------
  // Warm grey-beige plastic, yellowed with age, lit from the upper left.
  const shell = ctx.createLinearGradient(-CASE.w * u, (-CASE.h + CASE.y) * u, CASE.w * u, (CASE.h + CASE.y) * u);
  shell.addColorStop(0, "#e8e2d2");
  shell.addColorStop(0.28, "#d6cfbc");
  shell.addColorStop(0.6, "#bdb5a1");
  shell.addColorStop(0.85, "#9e9784");
  shell.addColorStop(1, "#837d6c");

  ctx.save();
  casePath(ctx, u);
  ctx.fillStyle = shell;
  ctx.fill();

  ctx.clip();
  // Top highlight and bottom shade, so the box has volume.
  const top = ctx.createLinearGradient(0, (-CASE.h + CASE.y) * u, 0, (-CASE.h + CASE.y + 0.22) * u);
  top.addColorStop(0, "rgba(255,255,250,0.55)");
  top.addColorStop(1, "rgba(255,255,250,0)");
  ctx.fillStyle = top;
  ctx.fillRect(-u, -u, size, size);

  const bottom = ctx.createLinearGradient(0, (CASE.h + CASE.y - 0.3) * u, 0, (CASE.h + CASE.y) * u);
  bottom.addColorStop(0, "rgba(60,54,40,0)");
  bottom.addColorStop(1, "rgba(60,54,40,0.35)");
  ctx.fillStyle = bottom;
  ctx.fillRect(-u, -u, size, size);
  ctx.restore();

  // Cabinet outline — the reference stickers are line art, and a definite
  // outline is what keeps that character.
  ctx.save();
  casePath(ctx, u);
  ctx.strokeStyle = "#3a352b";
  ctx.lineWidth = line * 1.4;
  ctx.stroke();
  ctx.restore();

  // ---- The screen recess ---------------------------------------------------
  // A bevel around the tube: dark at the top-left, light at the bottom-right,
  // which is the opposite of a raised surface and reads as "sunken".
  ctx.save();
  screenPath(ctx, u);
  ctx.fillStyle = "#0b0b0d";
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(
    (-SCREEN.w - 0.022) * u,
    (-SCREEN.h + SCREEN.y - 0.022) * u,
    (SCREEN.w + 0.022) * 2 * u,
    (SCREEN.h + 0.022) * 2 * u,
    (SCREEN.r + 0.02) * u
  );
  ctx.strokeStyle = "rgba(70,64,50,0.75)";
  ctx.lineWidth = u * 0.03;
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,245,0.5)";
  ctx.lineWidth = u * 0.008;
  ctx.stroke();
  ctx.restore();

  // ---- Controls, bottom right ---------------------------------------------
  // Positions come from knobCentre() so the drawing and the hit test cannot
  // drift apart.
  const knobY = knobCentre(u, 0).y;
  for (const i of [0, 1]) {
    const cx = knobCentre(u, i).x;
    const r = u * 0.038;

    // Both knobs wear ticks, because a dial that moves says nothing about what
    // it is moving between. The right-hand one gets a tick per channel; the
    // left-hand one is the volume and gets a graduated scale, which is what a
    // continuous control wears — you cannot tick every value of it, and five
    // marks over the same arc read as a range rather than as five positions.
    ctx.strokeStyle = "rgba(58,53,43,0.7)";
    ctx.lineWidth = Math.max(1, u * 0.005);
    const marks =
      i === 1
        ? Array.from({ length: channelCount }, (_, c) => channelAngle(c + 1, channelCount))
        : Array.from({ length: 5 }, (_, n) => volumeAngle(n / 4, KNOB_SWEEP));
    for (const angle of marks) {
      ctx.beginPath();
      ctx.moveTo(cx + Math.sin(angle) * r * 1.25, knobY - Math.cos(angle) * r * 1.25);
      ctx.lineTo(cx + Math.sin(angle) * r * 1.5, knobY - Math.cos(angle) * r * 1.5);
      ctx.stroke();
    }
    const dial = ctx.createLinearGradient(cx - r, knobY - r, cx + r, knobY + r);
    dial.addColorStop(0, "#f0ebdd");
    dial.addColorStop(0.5, "#c3bca8");
    dial.addColorStop(1, "#7e7868");
    ctx.fillStyle = dial;
    ctx.beginPath();
    ctx.arc(cx, knobY, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#3a352b";
    ctx.lineWidth = line;
    ctx.stroke();

    // The pointer notch. Neither knob is decoration any more: the right one
    // points at the channel actually showing and the left one at how loud he
    // actually is, so the cabinet cannot disagree with either the picture or the
    // sound. The left one used to sit at a fixed -0.7 and mean nothing.
    ctx.save();
    ctx.translate(cx, knobY);
    ctx.rotate(i === 0 ? volumeAngle(volume, KNOB_SWEEP) : channelAngle(channel, channelCount));
    ctx.strokeStyle = "#3a352b";
    ctx.lineWidth = Math.max(1, u * 0.008);
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.25);
    ctx.lineTo(0, -r * 0.82);
    ctx.stroke();
    ctx.restore();
  }

  // ---- Speaker grille, bottom left ----------------------------------------
  // Four slots, centred on the same line as the knobs: the stack is three gaps
  // plus one slot tall, so half of that is the offset that centres it.
  const slotGap = u * 0.032;
  const slotHeight = u * 0.014;
  const grilleTop = knobY - (slotGap * 3 + slotHeight) / 2;

  ctx.fillStyle = "rgba(58,53,43,0.55)";
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.roundRect(-0.6 * u, grilleTop + i * slotGap, u * 0.34, slotHeight, u * 0.007);
    ctx.fill();
  }

  return canvas;
}



/** Seconds as m:ss, or h:mm:ss for anything long enough to need it. */
function clock(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  const pad = (n) => String(n).padStart(2, "0");
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}





/** Wrap to a character count, not a pixel width. */



/** Milliseconds as a countdown a person can read at a glance. */


/**
 * One aircraft: a triangle pointing the way it is going.
 *
 * Brightness carries altitude, so a stack of traffic reads as a stack rather
 * than as a cloud — the ones low and close are the ones on approach, and they
 * should not look the same as something at cruise. It is a secondary cue only;
 * the list beside the scope gives the exact figure.
 */




/**
 * The session as a line, against the previous close.
 *
 * Scaled to the data's own range and NOT to zero — a 1.3% day against a zero
 * baseline is a dead flat line, which says "nothing happened" about a day when
 * something did. That is the opposite call from the Kp sparkline, which is
 * pinned to its scale precisely so a quiet day looks quiet: there, the question
 * is "is anything happening"; here, the previous close is drawn as the
 * reference and the question is "which side of it are we on".
 */


/** Open-Meteo gives words rather than a code path, so it needs its own reading. */

/**
 * One weather symbol, centred on (cx, cy) inside radius r.
 *
 * Everything is drawn from r, so the same call works at the 20 px it gets in
 * the forecast strip and the 60 px it gets as the headline symbol.
 */

// ---------------------------------------------------------------------------
// Space weather
// ---------------------------------------------------------------------------

/** Two RGB triplets, mixed. `t` is clamped, because a bad reading must not throw. */

/**
 * The Kp dial: an arc from 0 to 9 with a needle on it.
 *
 * Storm level starts at 5, so the arc changes colour there rather than running
 * a smooth gradient the whole way. A smooth gradient implies the scale is
 * continuous in meaning; it is not — 4 is a quiet day and 5 is a named storm.
 */

/**
 * A line of recent values, scaled to `max`.
 *
 * Fixed to the scale's own maximum rather than to the data's. Auto-scaling
 * would make a flat, quiet three hours look like a dramatic mountain range —
 * the one thing this chart must never do, since "is anything happening" is the
 * only question it is being asked.
 */

// Counts up rather than down, and stays legible past a day. Fixed-width digits
// so the box doesn't twitch every second.
function formatUptime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n) => String(n).padStart(2, "0");
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600) % 24;
  const days = Math.floor(total / 86400);
  return days
    ? `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

// ---------------------------------------------------------------------------
// Snow
//
// Four tiles cycled at 24fps. Generating noise every frame is the obvious way
// and costs far more than it's worth for something the eye reads as random.
// ---------------------------------------------------------------------------

function buildNoise(size) {
  const tiles = [];
  for (let t = 0; t < 4; t++) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const image = ctx.createImageData(size, size);
    for (let i = 0; i < image.data.length; i += 4) {
      const value = Math.random() * 255;
      image.data[i] = value;
      image.data[i + 1] = value;
      image.data[i + 2] = value;
      image.data[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    tiles.push(canvas);
  }
  return tiles;
}
