// Greg's face: a gold-and-black chrome helmet.
//
// The shell is polished gold, the visor is glossy black, and Greg's expression
// lives in an LED array behind the visor — dim and breathing when idle, sweeping
// when he's listening, chasing while he thinks, and driven by his own voice when
// he speaks.
//
// The gold shell is rendered once to an offscreen canvas (it never changes);
// only the sheen, the visor reflections and the LEDs are redrawn each frame.

const MOODS = {
  //        LED colour      glow  spin   led brightness
  // Idle sits deliberately low: at rest the visor should read as plain black
  // glass, the way the real helmet does, with only a hint of life behind it.
  idle:      { hue: 42,  sat: 92, glow: 0.34, spin: 0.10, led: 0.16 },
  listening: { hue: 187, sat: 95, glow: 0.85, spin: 0.30, led: 0.95 },
  thinking:  { hue: 33,  sat: 96, glow: 0.70, spin: 1.35, led: 0.80 },
  speaking:  { hue: 46,  sat: 96, glow: 1.00, spin: 0.45, led: 1.00 },
  error:     { hue: 356, sat: 90, glow: 0.75, spin: 0.08, led: 0.70 },
};

import { COLS, ROWS, ledValue, sample } from "./led-panel.js";

const lerp = (a, b, t) => a + (b - a) * t;

export class Face {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");

    this.state = "idle";
    this.target = { ...MOODS.idle };
    this.current = { ...MOODS.idle };

    this.level = 0;
    this.rawLevel = 0;
    this.spectrum = null;

    this.spin = 0;
    this.time = 0;
    this.blink = 0;
    this.nextBlinkAt = 3 + Math.random() * 4;

    this.size = 0;
    this.shell = null; // offscreen gold shell

    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
    window.addEventListener("resize", () => this.resize());
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const size = Math.floor(Math.min(rect.width, rect.height));
    if (!size || size === this.size) return;

    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = size * dpr;
    this.canvas.height = size * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.size = size;
    this.shell = buildShell(size, dpr);
  }

  setState(state) {
    if (!MOODS[state] || state === this.state) return;
    this.state = state;
    this.target = MOODS[state];
    if (state !== "speaking") this.spectrum = null;
  }

  setLevel(level) {
    this.rawLevel = Math.max(0, Math.min(1, level || 0));
  }

  setSpectrum(data) {
    this.spectrum = data;
  }

  start() {
    let last = performance.now();
    const frame = (now) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      this.update(dt);
      this.draw();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  update(dt) {
    this.time += dt;

    const ease = 1 - Math.pow(0.003, dt);
    for (const key of Object.keys(this.target)) {
      if (key === "hue") {
        const delta = ((this.target.hue - this.current.hue + 540) % 360) - 180;
        this.current.hue = (this.current.hue + delta * ease + 360) % 360;
      } else {
        this.current[key] = lerp(this.current[key], this.target[key], ease);
      }
    }

    this.level =
      this.rawLevel > this.level
        ? lerp(this.level, this.rawLevel, 1 - Math.pow(0.001, dt))
        : lerp(this.level, this.rawLevel, 1 - Math.pow(0.2, dt));

    this.spin += this.current.spin * dt;

    // A "blink" here is the LED array dipping for a moment.
    this.nextBlinkAt -= dt;
    if (this.nextBlinkAt <= 0 && this.state !== "speaking") {
      this.blink = 1;
      this.nextBlinkAt = 4 + Math.random() * 6;
    }
    this.blink = Math.max(0, this.blink - dt * 5);
  }

  draw() {
    const { ctx, size } = this;
    if (!size || !this.shell) return;

    const u = size / 2;
    const { hue, sat, glow } = this.current;
    const led = (l, a = 1) => `hsla(${hue.toFixed(0)}, ${sat.toFixed(0)}%, ${l}%, ${a})`;

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(u, u);

    // ---- Ambient bloom behind the helmet, tinted by mood -------------------
    const bloom = ctx.createRadialGradient(0, 0, u * 0.2, 0, 0, u * 1.02);
    bloom.addColorStop(0, led(52, 0.16 * glow * (0.5 + this.level * 0.5)));
    bloom.addColorStop(0.6, led(45, 0.05 * glow));
    bloom.addColorStop(1, led(45, 0));
    ctx.fillStyle = bloom;
    ctx.beginPath();
    ctx.arc(0, 0, u * 1.02, 0, Math.PI * 2);
    ctx.fill();

    // ---- The gold shell (pre-rendered) -------------------------------------
    ctx.drawImage(this.shell, -u, -u, size, size);

    // ---- Sheen travelling across the polished gold -------------------------
    ctx.save();
    helmetPath(ctx, u);
    ctx.clip();
    ctx.globalCompositeOperation = "lighter";
    const sweep = ((this.time * 0.16) % 1.6) - 0.3;
    const sheen = ctx.createLinearGradient(
      (sweep - 0.34) * u * 2 - u, -u,
      (sweep + 0.34) * u * 2 - u, u
    );
    sheen.addColorStop(0, "rgba(255,240,190,0)");
    sheen.addColorStop(0.5, `rgba(255,244,205,${0.16 + this.level * 0.1})`);
    sheen.addColorStop(1, "rgba(255,240,190,0)");
    ctx.fillStyle = sheen;
    ctx.fillRect(-u, -u, size, size);
    ctx.restore();

    // ---- The black visor ---------------------------------------------------
    ctx.save();
    visorPath(ctx, u);
    ctx.clip();

    // Near-black. Any lightness here has to come from a reflection, or the
    // glass stops looking like glass and starts looking like grey plastic.
    const glass = ctx.createLinearGradient(0, -0.9 * u, 0, 0.6 * u);
    glass.addColorStop(0, "#0d0d13");
    glass.addColorStop(0.32, "#040406");
    glass.addColorStop(0.66, "#070709");
    glass.addColorStop(1, "#010102");
    ctx.fillStyle = glass;
    ctx.fillRect(-u, -u, size, size);

    // Studio strip lights reflected in the glass.
    ctx.globalCompositeOperation = "lighter";
    for (const [x, w, a] of [
      [-0.33, 0.07, 0.055],
      [-0.19, 0.035, 0.026],
      [0.2, 0.09, 0.042],
      [0.4, 0.04, 0.024],
    ]) {
      const strip = ctx.createLinearGradient((x - w) * u, 0, (x + w) * u, 0);
      strip.addColorStop(0, "rgba(198,214,255,0)");
      strip.addColorStop(0.5, `rgba(210,224,255,${a})`);
      strip.addColorStop(1, "rgba(198,214,255,0)");
      ctx.fillStyle = strip;
      ctx.fillRect((x - w) * u, -u, w * 2 * u, size);
    }

    // The big soft key highlight across the upper left of the dome.
    ctx.save();
    ctx.translate(-0.17 * u, -0.5 * u);
    ctx.rotate(-0.38);
    ctx.scale(1, 0.52);
    const key = ctx.createRadialGradient(0, 0, 0, 0, 0, 0.52 * u);
    key.addColorStop(0, "rgba(255,255,255,0.17)");
    key.addColorStop(0.4, "rgba(228,238,255,0.05)");
    key.addColorStop(1, "rgba(220,232,255,0)");
    ctx.fillStyle = key;
    ctx.beginPath();
    ctx.arc(0, 0, 0.52 * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Weaker fill light bouncing back from the lower right.
    ctx.save();
    ctx.translate(0.26 * u, 0.24 * u);
    ctx.rotate(0.5);
    ctx.scale(1, 0.45);
    const fill = ctx.createRadialGradient(0, 0, 0, 0, 0, 0.34 * u);
    fill.addColorStop(0, "rgba(255,225,170,0.07)");
    fill.addColorStop(1, "rgba(255,225,170,0)");
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(0, 0, 0.34 * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // A faint horizon line — the edge of the room reflected in the curve.
    const horizon = ctx.createLinearGradient(0, -0.06 * u, 0, 0.1 * u);
    horizon.addColorStop(0, "rgba(190,205,240,0)");
    horizon.addColorStop(0.5, "rgba(200,214,245,0.028)");
    horizon.addColorStop(1, "rgba(190,205,240,0)");
    ctx.fillStyle = horizon;
    ctx.fillRect(-u, -0.06 * u, size, 0.16 * u);

    // Darken toward the edges so the glass reads as a deep curved surface
    // rather than a flat panel. Must land before the LEDs so they stay crisp.
    ctx.globalCompositeOperation = "source-over";
    const depth = ctx.createRadialGradient(0, -0.12 * u, 0.16 * u, 0, -0.08 * u, 0.66 * u);
    depth.addColorStop(0, "rgba(0,0,0,0)");
    depth.addColorStop(0.62, "rgba(0,0,0,0.3)");
    depth.addColorStop(1, "rgba(0,0,0,0.82)");
    ctx.fillStyle = depth;
    ctx.fillRect(-u, -u, size, size);

    this.drawLeds(ctx, u, led);
    ctx.restore();

    // ---- Visor edge: a thin bright line where glass meets gold -------------
    ctx.save();
    visorPath(ctx, u);
    ctx.strokeStyle = "rgba(255,226,150,0.5)";
    ctx.lineWidth = Math.max(1, u * 0.012);
    ctx.stroke();
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = Math.max(1, u * 0.004);
    ctx.stroke();
    ctx.restore();

    ctx.restore();
  }

  // The LED array behind the visor — this is where the expression is.
  drawLeds(ctx, u, led) {
    const brightness = this.current.led * (1 - this.blink * 0.85);
    if (brightness < 0.02) return;

    // Sits a little above centre, where eyes would be.
    const left = -0.34 * u;
    const top = -0.38 * u;
    const width = 0.68 * u;
    const height = 0.4 * u;
    const cellW = width / COLS;
    const cellH = height / ROWS;
    const dotW = cellW * 0.62;
    const dotH = cellH * 0.5;

    ctx.globalCompositeOperation = "lighter";
    ctx.shadowColor = led(60, 0.85);

    for (let col = 0; col < COLS; col++) {
      for (let row = 0; row < ROWS; row++) {
        const value = ledValue(this, col, row);
        if (value <= 0.02) continue;

        const a = Math.min(1, value * brightness);
        ctx.shadowBlur = u * 0.05 * a;
        ctx.fillStyle = led(lerp(52, 86, a), a);

        const x = left + col * cellW + (cellW - dotW) / 2;
        const y = top + row * cellH + (cellH - dotH) / 2;
        ctx.beginPath();
        ctx.roundRect(x, y, dotW, dotH, dotH * 0.35);
        ctx.fill();
      }
    }

    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = "source-over";
  }

  // LED behaviour lives in led-panel.js, shared with the 3D renderer.
  sample(t) {
    return sample(this.spectrum, t);
  }
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

// Taller than it is wide, narrowing to a rounded jaw — as in the reference.
function helmetPath(ctx, u) {
  ctx.beginPath();
  ctx.moveTo(0, -0.96 * u);
  ctx.bezierCurveTo(0.4 * u, -0.96 * u, 0.63 * u, -0.62 * u, 0.63 * u, -0.16 * u);
  ctx.bezierCurveTo(0.63 * u, 0.26 * u, 0.51 * u, 0.62 * u, 0.31 * u, 0.79 * u);
  ctx.bezierCurveTo(0.21 * u, 0.88 * u, -0.21 * u, 0.88 * u, -0.31 * u, 0.79 * u);
  ctx.bezierCurveTo(-0.51 * u, 0.62 * u, -0.63 * u, 0.26 * u, -0.63 * u, -0.16 * u);
  ctx.bezierCurveTo(-0.63 * u, -0.62 * u, -0.4 * u, -0.96 * u, 0, -0.96 * u);
  ctx.closePath();
}

// The glass sits high: only a thin gold arc above it, but a broad gold chin
// below — that asymmetry is what makes the silhouette read as the helmet.
function visorPath(ctx, u) {
  ctx.beginPath();
  ctx.moveTo(0, -0.885 * u);
  ctx.bezierCurveTo(0.35 * u, -0.885 * u, 0.535 * u, -0.58 * u, 0.535 * u, -0.17 * u);
  ctx.bezierCurveTo(0.535 * u, 0.14 * u, 0.45 * u, 0.39 * u, 0.28 * u, 0.5 * u);
  ctx.bezierCurveTo(0.18 * u, 0.56 * u, -0.18 * u, 0.56 * u, -0.28 * u, 0.5 * u);
  ctx.bezierCurveTo(-0.45 * u, 0.39 * u, -0.535 * u, 0.14 * u, -0.535 * u, -0.17 * u);
  ctx.bezierCurveTo(-0.535 * u, -0.58 * u, -0.35 * u, -0.885 * u, 0, -0.885 * u);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// The gold shell, drawn once
// ---------------------------------------------------------------------------

function buildShell(size, dpr) {
  const canvas = document.createElement("canvas");
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(size / 2, size / 2);

  const u = size / 2;

  // Ear pods, drawn first so the dome overlaps them and they protrude at the
  // sides. Sat slightly low, like the reference.
  for (const side of [-1, 1]) {
    const x = side * 0.64 * u;
    const w = 0.26 * u;
    const h = 0.52 * u;
    const y = -0.02 * u;

    const metal = ctx.createLinearGradient(x - w * 0.6 * side, 0, x + w * 0.6 * side, 0);
    metal.addColorStop(0, "#4a3209");
    metal.addColorStop(0.28, "#b98d2b");
    metal.addColorStop(0.46, "#ffeeb6");
    metal.addColorStop(0.62, "#d2a33c");
    metal.addColorStop(0.84, "#7d5a14");
    metal.addColorStop(1, "#291b05");

    ctx.fillStyle = metal;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h / 2, w, h, w * 0.36);
    ctx.fill();

    ctx.strokeStyle = "rgba(255,235,175,0.45)";
    ctx.lineWidth = Math.max(1, u * 0.007);
    ctx.stroke();

    // Vent slots, biased to the outer edge where they'd actually be visible.
    ctx.fillStyle = "rgba(26,16,3,0.7)";
    for (let i = 0; i < 5; i++) {
      const sy = y - h * 0.3 + h * i * 0.15;
      ctx.beginPath();
      ctx.roundRect(x + side * w * 0.06 - w * 0.22, sy, w * 0.44, h * 0.05, h * 0.025);
      ctx.fill();
    }
  }

  // The dome. Polished metal is mostly about contrast: tight jumps from near
  // black to near white are what sell it, not a smooth ramp.
  const gold = ctx.createLinearGradient(-0.66 * u, -0.6 * u, 0.66 * u, 0.7 * u);
  gold.addColorStop(0.0, "#1d1303");
  gold.addColorStop(0.06, "#6b4c11");
  gold.addColorStop(0.13, "#d5a437");
  gold.addColorStop(0.2, "#fff6d4");
  gold.addColorStop(0.28, "#e0b348");
  gold.addColorStop(0.37, "#8a6316");
  gold.addColorStop(0.45, "#4a3309");
  gold.addColorStop(0.54, "#9c731c");
  gold.addColorStop(0.63, "#f0d281");
  gold.addColorStop(0.71, "#fffbe8");
  gold.addColorStop(0.79, "#d3a53a");
  gold.addColorStop(0.88, "#7a5613");
  gold.addColorStop(0.95, "#3a2707");
  gold.addColorStop(1.0, "#150e02");

  ctx.save();
  helmetPath(ctx, u);
  ctx.fillStyle = gold;
  ctx.fill();
  ctx.clip();

  // Warm bounce light up off the chin.
  const bounce = ctx.createLinearGradient(0, 0.2 * u, 0, 0.9 * u);
  bounce.addColorStop(0, "rgba(255,205,110,0)");
  bounce.addColorStop(0.55, "rgba(255,214,130,0.2)");
  bounce.addColorStop(1, "rgba(255,236,180,0.5)");
  ctx.fillStyle = bounce;
  ctx.fillRect(-u, -u, size, size);

  // Crisp highlight across the crown.
  const crown = ctx.createLinearGradient(0, -0.98 * u, 0, -0.55 * u);
  crown.addColorStop(0, "rgba(255,250,228,0.62)");
  crown.addColorStop(1, "rgba(255,248,220,0)");
  ctx.fillStyle = crown;
  ctx.fillRect(-u, -u, size, size);

  // A bright band hugging the outer edge. Clipping keeps the outer half of the
  // stroke off, leaving a crisp inner rim light — the thing that makes metal
  // look polished rather than painted.
  ctx.lineWidth = u * 0.1;
  const rim = ctx.createLinearGradient(-0.6 * u, -0.9 * u, 0.5 * u, 0.8 * u);
  rim.addColorStop(0, "rgba(255,252,235,0.75)");
  rim.addColorStop(0.22, "rgba(255,236,175,0.2)");
  rim.addColorStop(0.42, "rgba(90,62,14,0.5)");
  rim.addColorStop(0.62, "rgba(255,246,205,0.55)");
  rim.addColorStop(0.85, "rgba(120,84,20,0.35)");
  rim.addColorStop(1, "rgba(255,240,190,0.3)");
  ctx.strokeStyle = rim;
  helmetPath(ctx, u);
  ctx.stroke();

  // A second, tighter pass right at the edge for the hard specular line.
  ctx.lineWidth = u * 0.028;
  const edge = ctx.createLinearGradient(-0.5 * u, -0.85 * u, 0.55 * u, 0.7 * u);
  edge.addColorStop(0, "rgba(255,255,248,0.85)");
  edge.addColorStop(0.3, "rgba(255,240,190,0.15)");
  edge.addColorStop(0.55, "rgba(255,252,230,0.7)");
  edge.addColorStop(1, "rgba(60,40,8,0.4)");
  ctx.strokeStyle = edge;
  helmetPath(ctx, u);
  ctx.stroke();

  // A seam across the jaw, where the chin plate meets the dome.
  ctx.strokeStyle = "rgba(60,40,8,0.55)";
  ctx.lineWidth = Math.max(1, u * 0.011);
  ctx.beginPath();
  ctx.moveTo(-0.42 * u, 0.6 * u);
  ctx.quadraticCurveTo(0, 0.74 * u, 0.42 * u, 0.6 * u);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,240,190,0.3)";
  ctx.lineWidth = Math.max(1, u * 0.005);
  ctx.beginPath();
  ctx.moveTo(-0.42 * u, 0.615 * u);
  ctx.quadraticCurveTo(0, 0.755 * u, 0.42 * u, 0.615 * u);
  ctx.stroke();
  ctx.restore();

  // Outline to separate the helmet from the background.
  ctx.save();
  helmetPath(ctx, u);
  ctx.strokeStyle = "rgba(255,230,160,0.35)";
  ctx.lineWidth = Math.max(1, u * 0.01);
  ctx.stroke();
  ctx.restore();

  return canvas;
}


