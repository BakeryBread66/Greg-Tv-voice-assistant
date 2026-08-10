// Greg's expression: the LED array behind the visor.
//
// Shared by both renderers — the 2D helmet paints it straight onto the canvas,
// the 3D one paints it to a texture — so his behaviour is identical either way.

export const COLS = 17;
export const ROWS = 7;

/**
 * Brightness 0..1 for a single LED.
 * @param {object} s  { state, time, spin, level, spectrum }
 */
export function ledValue(s, col, row) {
  const midRow = (ROWS - 1) / 2;
  const t = col / (COLS - 1);

  switch (s.state) {
    case "speaking": {
      // Equaliser bars, driven by Greg's own voice.
      const energy = s.spectrum ? sample(s.spectrum, t) : s.level;
      const bars = energy * (ROWS / 2 + 0.6) + 0.35;
      const distance = Math.abs(row - midRow);
      return distance <= bars ? 1 - (distance / (bars + 0.8)) * 0.55 : 0;
    }

    case "listening": {
      // A pulse sweeping across, reacting to how loudly you're talking.
      const head = ((s.time * 1.5) % 1.35) - 0.175;
      const near = 1 - Math.min(1, Math.abs(t - head) * 7);
      const centre = 1 - Math.abs(row - midRow) / (midRow + 1);
      return Math.max(near * centre, centre * (0.16 + s.level * 0.7) * 0.55);
    }

    case "thinking": {
      // Light chasing around the edge of the array.
      const onEdge = row === 0 || row === ROWS - 1 || col === 0 || col === COLS - 1;
      if (!onEdge) return 0;
      const perimeter = 2 * (COLS + ROWS) - 4;
      let index;
      if (row === 0) index = col;
      else if (col === COLS - 1) index = COLS - 1 + row;
      else if (row === ROWS - 1) index = COLS - 1 + ROWS - 1 + (COLS - 1 - col);
      else index = perimeter - row;
      const head = (s.spin * 26) % perimeter;
      const gap = (index - head + perimeter) % perimeter;
      const trail = gap < 9 ? 1 - gap / 9 : 0;
      // Never fully dark between passes.
      return Math.max(trail, 0.13);
    }

    case "error": {
      const flicker = 0.5 + 0.5 * Math.sin(s.time * 11);
      return row === Math.round(midRow) ? 0.35 + flicker * 0.5 : 0;
    }

    default: {
      // Idle: a slow breath along the centre rows.
      const breath = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(s.time * 1.25 - t * 2.4));
      const centre = 1 - Math.abs(row - midRow) / (midRow + 0.7);
      return Math.max(0, centre * breath * (0.5 + s.level * 0.9));
    }
  }
}

export function sample(spectrum, t) {
  if (!spectrum || !spectrum.length) return 0;
  const folded = t < 0.5 ? t * 2 : (1 - t) * 2;
  const bins = Math.floor(spectrum.length * 0.55);
  const index = Math.min(bins - 1, Math.floor(folded * bins));
  return (spectrum[index] / 255) ** 1.4;
}

/**
 * Paint the array onto a canvas — used as the emissive texture in 3D.
 * Transparent background so it can be blended additively over the glass.
 */
export function paintLedTexture(ctx, width, height, s, brightness) {
  ctx.clearRect(0, 0, width, height);
  if (brightness < 0.02) return;

  const cellW = width / COLS;
  const cellH = height / ROWS;
  const dotW = cellW * 0.6;
  const dotH = cellH * 0.48;
  const hue = s.hue.toFixed(0);
  const sat = s.sat.toFixed(0);

  ctx.globalCompositeOperation = "lighter";
  ctx.shadowColor = `hsla(${hue}, ${sat}%, 60%, 0.9)`;

  for (let col = 0; col < COLS; col++) {
    for (let row = 0; row < ROWS; row++) {
      const value = ledValue(s, col, row);
      if (value <= 0.02) continue;

      const a = Math.min(1, value * brightness);
      ctx.shadowBlur = Math.max(2, cellW * 0.5 * a);
      ctx.fillStyle = `hsla(${hue}, ${sat}%, ${52 + a * 34}%, ${a})`;

      const x = col * cellW + (cellW - dotW) / 2;
      const y = row * cellH + (cellH - dotH) / 2;
      ctx.beginPath();
      ctx.roundRect(x, y, dotW, dotH, dotH * 0.35);
      ctx.fill();
    }
  }

  ctx.shadowBlur = 0;
  ctx.globalCompositeOperation = "source-over";
}
