// Greg starting up.
//
// Three beats, in the order a real machine does them, and all three are period
// -correct rather than decorative:
//
//   1. The tube strikes.  A CRT does not fade up. The beam lights as a bright
//      horizontal line across the middle and the picture opens out from it, with
//      the phosphor still blooming for a moment afterwards.
//   2. A POST screen.     Silver-on-black VGA text, a memory count, and a list of
//      detected devices with [ OK ] beside them.
//   3. The Windows 98 splash. Black, the four-pane flag, and the scrolling bar
//      that is the single most recognisable thing about booting a 1998 machine.
//
// **The device list is real.** Every line comes from /api/config, which already
// reports what actually loaded — the brain, the ears, the voice, the eyes and
// the location. A POST screen that listed hardware Greg does not have would be
// the fabrication failure this project spends most of its rules preventing,
// dressed up as set decoration. If the eyes failed their swatch test the line
// says so, and the memory figure is the model's real context window.
//
// Drawn flat into the picture rectangle, so the strip projection turns it with
// the head and the glass, scanlines and shadow mask land on top of it — which is
// most of why it reads as a screen rather than as an animation.

// The Win98 palette, which is genuinely these values and not an approximation.
const SILVER = "#c0c0c0";
const WHITE = "#ffffff";
const VGA_GREEN = "#00c000";
const VGA_AMBER = "#c0c000";

const MONO = `"Consolas", "Lucida Console", "Courier New", monospace`;
const UI = `"MS Sans Serif", Tahoma, sans-serif`;

// Cumulative seconds. Tuned so the whole thing is over in about four — long
// enough to be an event, short enough that you are not waiting for it. It runs
// while the microphone and the audio worklet are still being set up, so most of
// it costs nothing that was not already being spent.
const T_STRIKE = 0.42;  // tube opens
const T_POST = 2.70;    // device list finishes
const T_SPLASH = 3.95;  // splash ends
const ROW_PERIOD = 0.16; // how fast POST lines appear

// The POST grid. The content is 13 lines plus a cursor row, so 16 is the
// tightest that still leaves a bottom margin — and rows are what set the type
// size, so every spare row is legibility thrown away. At a 390px canvas, which
// is the smallest the window CSS allows, this puts the glyphs at about 6.5px:
// tight, but the same place teletext sits and it holds its columns.
const ROWS = 16;

/**
 * Turn what /api/config reported into the device list.
 *
 * Exported and pure so the wording can be proven without a canvas — every entry
 * here is a claim about the machine, and a boot screen that says [ OK ] beside
 * something that did not load is worse than no boot screen.
 */
/**
 * The copyright line's second half, which is a claim and not decoration.
 *
 * Caught by rendering the degraded case: with the brain missing, the ears on
 * browser speech and the voice on Microsoft's servers, the screen still said
 * "All processing local" — a boast that was false in precisely the state where
 * it mattered. It is derived from the same three facts as the device list now.
 */
export function tagline(info = {}) {
  const local = Boolean(info.hasBrain) && info.listening === "local" && info.speaking === "local";
  return local ? "All processing local" : "Some processing remote";
}

export function deviceLines(info = {}) {
  const rows = [];
  const add = (label, value, ok) => rows.push({ label, value, ok });

  add("Brain", info.hasBrain ? info.brainLabel || "local model" : "not found", Boolean(info.hasBrain));
  add(
    "Ears",
    info.listening === "local" ? info.earsLabel || "Whisper" : "browser speech",
    info.listening === "local",
  );
  add(
    "Voice",
    info.speaking === "local" ? info.voiceLabel || "local voice" : "cloud voice",
    info.speaking === "local",
  );
  // The eyes are the one device that can be present and still not usable — a
  // model that fails the startup swatch test has the tool withdrawn. "not
  // fitted" is the honest word for that, and it must not read as [ OK ].
  add("Eyes", info.canSeeScreen ? info.visionLabel || "vision model" : "not fitted", Boolean(info.canSeeScreen));

  const place = [info.location?.city, info.location?.region].filter(Boolean).join(", ");
  add("Home", place || "unknown", Boolean(place));

  return rows;
}

export class BootSequence {
  /**
   * @param {object} info  the /api/config payload, or {} before it arrived
   */
  /**
   * @param {object} info  the /api/config payload, or {} before it arrived
   * @param {object} opts  `onBeat(name, sequence)` fires as each beat begins
   *
   * The beats are announced rather than played here, because this class draws
   * and nothing else. The sound lives with voice.js, which owns the audio graph
   * and the volume — the same split that keeps the face a renderer.
   */
  constructor(info = {}, { onBeat = null } = {}) {
    this.info = info;
    this.devices = deviceLines(info);
    this.onBeat = onBeat;
    this.beat = null;
    // The real context window, counted up like a memory test. 32768 tokens is
    // what config.json actually asks Ollama for.
    this.memoryK = Number(info.contextTokens) || 32768;
    this.time = 0;
    this.finished = false;
    this.skipped = false;
  }

  /** Cut straight to the end — any click during the sequence. */
  skip() {
    this.skipped = true;
    this.finished = true;
    this.announce("end");
  }

  /**
   * Tell the listener a beat has started, once each.
   *
   * Guarded against throwing: this is called from update(), which is called
   * from the render loop, and a failure in a sound effect must not stop the
   * picture. The boot sequence is on the path that ends in the microphone being
   * opened — the same reason playBoot() has a wall-clock failsafe.
   */
  announce(name) {
    if (this.beat === name) return;
    this.beat = name;
    try {
      this.onBeat?.(name, this);
    } catch (err) {
      console.warn(`[boot] beat "${name}" failed:`, err.message);
    }
  }

  update(dt) {
    if (this.finished) return;
    this.time += dt;
    if (this.time >= T_SPLASH) {
      this.finished = true;
      this.announce("end");
      return;
    }
    // Named for what is happening rather than for the picture: "strike" is the
    // tube lighting, "post" is the device list having finished — which is when
    // a real machine beeps, not when it starts printing.
    if (this.time >= T_POST) this.announce("post");
    else if (this.time >= T_STRIKE) this.announce("open");
    else this.announce("strike");
  }

  /** Which beat we are on, and how far through it. */
  phase() {
    const t = this.time;
    if (t < T_STRIKE) return { name: "strike", p: t / T_STRIKE };
    if (t < T_POST) return { name: "post", p: (t - T_STRIKE) / (T_POST - T_STRIKE) };
    return { name: "splash", p: (t - T_POST) / (T_SPLASH - T_POST) };
  }

  draw(ctx, x, y, w, h) {
    // Black first, always: the tube is dark and everything below opens out of it.
    ctx.fillStyle = "#000000";
    ctx.fillRect(x, y, w, h);

    const { name, p } = this.phase();

    if (name === "strike") {
      this.drawStrike(ctx, x, y, w, h, p);
      return;
    }

    // The picture is still opening for a moment after the line has gone, so the
    // content is squashed vertically as it settles rather than snapping to full
    // height. `open` is 1 for everything after the first fraction of a second.
    const open = Math.min(1, (this.time - T_STRIKE) / 0.16 + 0.001);

    ctx.save();
    ctx.translate(x + w / 2, y + h / 2);
    ctx.scale(1, open);
    ctx.translate(-(x + w / 2), -(y + h / 2));

    if (name === "post") this.drawPost(ctx, x, y, w, h);
    else this.drawSplash(ctx, x, y, w, h, p);

    ctx.restore();

    // Phosphor bloom over the top of the opening frame — the tube is still
    // brighter than it will settle at.
    if (open < 1) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = `rgba(190,225,255,${(1 - open) * 0.5})`;
      ctx.fillRect(x, y, w, h);
      ctx.restore();
    }
  }

  // -------------------------------------------------------------------------
  // 1. The tube strikes
  // -------------------------------------------------------------------------

  drawStrike(ctx, x, y, w, h, p) {
    const cy = y + h / 2;

    // The line arrives almost instantly, blooms wide, then thins as the frame
    // starts to open. Width leads height, which is the order a tube does it in.
    const spread = Math.min(1, p / 0.35);
    const lineW = w * (0.06 + 0.94 * spread * spread);
    const thickness = Math.max(1, h * (0.012 + 0.05 * Math.sin(Math.min(1, p / 0.5) * Math.PI)));

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    // The glow around the line, which is what sells it as light rather than as a
    // white rectangle.
    const glow = ctx.createLinearGradient(0, cy - thickness * 4, 0, cy + thickness * 4);
    glow.addColorStop(0, "rgba(150,200,255,0)");
    glow.addColorStop(0.5, `rgba(190,225,255,${0.55 * spread})`);
    glow.addColorStop(1, "rgba(150,200,255,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(x + (w - lineW) / 2, cy - thickness * 4, lineW, thickness * 8);

    ctx.fillStyle = `rgba(255,255,255,${0.85 * spread})`;
    ctx.fillRect(x + (w - lineW) / 2, cy - thickness / 2, lineW, thickness);
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // 2. POST
  // -------------------------------------------------------------------------

  drawPost(ctx, x, y, w, h) {
    const rowH = h / ROWS;
    // Sized from the row height, the way the teletext channel does it — the
    // grid decides the type, never the other way round.
    const fontPx = Math.max(5, rowH * 0.82);
    ctx.font = `${fontPx}px ${MONO}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    // Measured rather than assumed at 0.6em: the font that actually resolves
    // depends on the machine, and the [ OK ] column has to line up on all of
    // them. Same reasoning as ceefax.js.
    const advance = ctx.measureText("00000000").width / 8;

    const left = x + w * 0.06;
    const right = x + w - w * 0.06;
    const rowY = (i) => y + rowH * (i + 0.9);

    // How many rows have "printed" so far.
    const elapsed = this.time - T_STRIKE;
    const shown = this.skipped ? 99 : Math.floor(elapsed / ROW_PERIOD);

    let row = 0;
    const line = (text, colour = SILVER) => {
      if (row <= shown && text) {
        ctx.fillStyle = colour;
        ctx.fillText(text, left, rowY(row));
      }
      row++;
    };

    line(`${this.info.name || "Greg"} BIOS v6.0`, WHITE);
    line(`(C) 1998-2026   ${tagline(this.info)}`, SILVER);
    line("");

    // The memory count, which really is the model's context window. Counts up
    // while its row is the newest one, then sits at the total.
    if (row <= shown) {
      const age = elapsed - row * ROW_PERIOD;
      const done = age > 0.75;
      const value = done ? this.memoryK : Math.floor((this.memoryK * age) / 0.75 / 64) * 64;
      const text = `Context Memory Test : ${value}K`;
      ctx.fillStyle = SILVER;
      ctx.fillText(text, left, rowY(row));
      if (done) {
        // Measured off the string actually drawn rather than counted by hand.
        // The hand-counted version worked only for a five-digit context size and
        // would have collided the moment anyone changed num_ctx.
        ctx.fillStyle = VGA_GREEN;
        ctx.fillText("OK", left + ctx.measureText(text).width + advance * 2, rowY(row));
      }
    }
    row++;

    line("");
    line("Detecting devices ...", WHITE);

    for (const device of this.devices) {
      if (row <= shown) {
        ctx.fillStyle = SILVER;
        ctx.fillText(`  ${device.label.padEnd(6, " ")} ${device.value}`, left, rowY(row));

        const tag = device.ok ? "[ OK ]" : "[ -- ]";
        ctx.fillStyle = device.ok ? VGA_GREEN : VGA_AMBER;
        ctx.textAlign = "right";
        ctx.fillText(tag, right, rowY(row));
        ctx.textAlign = "left";
      }
      row++;
    }

    line("");
    line(`Starting ${this.info.name || "Greg"} 98 ...`, WHITE);

    // The block cursor, blinking on the row after the last one printed. A POST
    // screen without one looks like a screenshot of a POST screen.
    const cursorRow = Math.min(row, shown + 1);
    if (Math.floor(this.time * 3) % 2 === 0) {
      ctx.fillStyle = SILVER;
      ctx.fillRect(left, rowY(cursorRow) - fontPx * 0.4, advance * 0.9, fontPx * 0.8);
    }
  }

  // -------------------------------------------------------------------------
  // 3. The Windows 98 splash
  // -------------------------------------------------------------------------

  drawSplash(ctx, x, y, w, h, p) {
    // It arrives as a cut, not a fade — the POST screen is simply replaced.
    ctx.fillStyle = "#000000";
    ctx.fillRect(x, y, w, h);

    const cx = x + w / 2;
    const flagH = h * 0.30;
    const flagW = flagH * 1.16;
    const flagX = cx - w * 0.30;
    const flagY = y + h * 0.30;

    drawFlag(ctx, flagX, flagY, flagW, flagH);

    // "Greg 98", set the way the real wordmark was: the name in a light weight
    // and the year heavy beside it.
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    const nameSize = h * 0.15;
    const textX = flagX + flagW + w * 0.045;
    ctx.fillStyle = WHITE;
    ctx.font = `${nameSize}px ${UI}`;
    ctx.fillText(this.info.name || "Greg", textX, flagY + flagH * 0.52);

    ctx.font = `bold ${nameSize * 1.5}px ${UI}`;
    ctx.fillText("98", textX, flagY + flagH * 1.06);

    // The scrolling bar. The single most recognisable thing about a 1998 boot:
    // a dark strip with a lighter band sweeping across it, on a loop, saying
    // nothing about actual progress. Kept honest by being exactly that — it is
    // decoration, and a real progress bar here would be inventing a number.
    const barH = Math.max(3, h * 0.045);
    const barY = y + h - barH * 2.2;
    const barX = x + w * 0.06;
    const barW = w * 0.88;

    ctx.fillStyle = "#000b3a";
    ctx.fillRect(barX, barY, barW, barH);

    const sweepW = barW * 0.34;
    const travel = ((this.time - T_POST) / 0.85) % 1;
    const sweepX = barX - sweepW + travel * (barW + sweepW);

    ctx.save();
    ctx.beginPath();
    ctx.rect(barX, barY, barW, barH);
    ctx.clip();
    const sweep = ctx.createLinearGradient(sweepX, 0, sweepX + sweepW, 0);
    sweep.addColorStop(0, "rgba(0,20,90,0)");
    sweep.addColorStop(0.5, "#3fa9f5");
    sweep.addColorStop(1, "rgba(0,20,90,0)");
    ctx.fillStyle = sweep;
    ctx.fillRect(sweepX, barY, sweepW, barH);
    ctx.restore();

    // Fade to black over the last moment, so the static wipe into the test card
    // has something to come out of rather than cutting from a lit screen.
    const fade = Math.max(0, (p - 0.82) / 0.18);
    if (fade > 0) {
      ctx.fillStyle = `rgba(0,0,0,${fade})`;
      ctx.fillRect(x, y, w, h);
    }
  }
}

/**
 * The four-pane flag, waved.
 *
 * Each pane is drawn as a quad with its top and bottom edges bowed, which is
 * what gives the ripple. Drawn on a tilt, because the original is.
 */
function drawFlag(ctx, x, y, w, h) {
  const colours = [
    ["#ff3b30", "#a3170f"], // red
    ["#5ac83c", "#2c7a1c"], // green
    ["#3fa9f5", "#1560a8"], // blue
    ["#ffd23f", "#c08a05"], // yellow
  ];

  const gap = w * 0.06;
  const paneW = (w - gap) / 2;
  const paneH = (h - gap) / 2;
  const bow = h * 0.11;

  ctx.save();
  ctx.translate(x, y);
  // The whole flag leans back a little, as the original does.
  ctx.transform(1, 0, -0.16, 1, h * 0.16, 0);

  for (let i = 0; i < 4; i++) {
    const col = i % 2;
    const rowIdx = Math.floor(i / 2);
    const px = col * (paneW + gap);
    const py = rowIdx * (paneH + gap);

    // The wave runs left to right, so the right-hand panes sit a touch lower.
    const lift = col === 0 ? 0 : bow * 0.55;

    ctx.beginPath();
    ctx.moveTo(px, py + lift);
    ctx.quadraticCurveTo(px + paneW / 2, py + lift - bow * 0.45, px + paneW, py + lift + bow * 0.35);
    ctx.lineTo(px + paneW, py + paneH + lift + bow * 0.35);
    ctx.quadraticCurveTo(px + paneW / 2, py + paneH + lift - bow * 0.45, px, py + paneH + lift);
    ctx.closePath();

    const grad = ctx.createLinearGradient(px, py, px + paneW, py + paneH);
    grad.addColorStop(0, colours[i][0]);
    grad.addColorStop(1, colours[i][1]);
    ctx.fillStyle = grad;
    ctx.fill();
  }

  ctx.restore();
}
