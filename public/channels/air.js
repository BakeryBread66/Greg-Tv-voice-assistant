// Channel 13 — Air Quality.
//
// One big number with the word that explains it, because 51 means nothing on
// its own and "Moderate" is the answer to the question actually being asked.
// The band's colour carries the same fact a second way, and the pollutants
// below explain where the number came from.
//
// Pollen appears only where the feed has it. In North America every field comes
// back null — Open-Meteo serves pollen from a European model — and that is said
// in a sentence rather than shown as a row of empty gauges, because "not
// published here" and "none today" are different facts.

import { standby, ellipsize } from "./shared.js";

export function draw(ctx, x, y, w, h, view) {
  const data = view.feed("air");
  if (!data) return standby(ctx, x, y, w, h, "AIR QUALITY", "reading the air");
  if (data.error) return standby(ctx, x, y, w, h, "AIR QUALITY", data.error);
  if (data.aqi === null) return standby(ctx, x, y, w, h, "AIR QUALITY", `no reading for ${data.place}`);

  ctx.fillStyle = "#0a0d12";
  ctx.fillRect(x, y, w, h);

  const pad = w * 0.06;
  const colour = data.colour ?? "#8fa0b8";

  // A wash of the band's colour, kept faint: it should tint the picture, not
  // become it. On a CRT a full-strength fill of that green would bloom.
  const wash = ctx.createLinearGradient(0, y, 0, y + h);
  wash.addColorStop(0, hexAlpha(colour, 0.28));
  wash.addColorStop(1, "rgba(10,13,18,0)");
  ctx.fillStyle = wash;
  ctx.fillRect(x, y, w, h);

  // ---- Ident --------------------------------------------------------------
  //
  // The house pattern, which both new channels were missing: a strip along the
  // top naming the CHANNEL, not just the place. Without it the picture is a big
  // number and a colour, and a number with no label is a puzzle — the whole
  // reason the Markets channel prints "NASDAQ" and Flights prints "FLIGHTS ·"
  // in front of the town.
  const headerH = h * 0.11;
  ctx.fillStyle = hexAlpha(colour, 0.14);
  ctx.fillRect(x, y, w, headerH);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#dbe6f5";
  ctx.font = `bold ${Math.max(6, h * 0.052)}px "MS Sans Serif", Tahoma, sans-serif`;
  // The city only. `place` can be "Chapel Hill, North Carolina", which is right
  // for the spoken sentence and too long for an ident — it truncates to
  // "CHAPEL HILL, NORTH…" and reads as a rendering fault. Same note as flights.
  const town = String(data.place ?? "").split(",")[0];
  ctx.fillText(ellipsize(ctx, `AIR QUALITY · ${town.toUpperCase()}`, w * 0.66), x + pad, y + headerH / 2);

  ctx.textAlign = "right";
  ctx.fillStyle = "#8ea0ba";
  ctx.font = `${Math.max(5, h * 0.046)}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.fillText("OPEN-METEO", x + w - pad, y + headerH / 2);

  // The number, as big as it can be without crowding the band name under it.
  const figure = h * 0.30;
  ctx.font = `bold ${figure}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = colour;
  const numberY = y + headerH + h * 0.04 + figure;
  ctx.fillText(String(data.aqi), x + pad, numberY);
  const numberW = ctx.measureText(String(data.aqi)).width;

  ctx.font = `${Math.max(6, h * 0.055)}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.fillStyle = "#8ea0ba";
  ctx.fillText("US AQI", x + pad + numberW + pad * 0.5, numberY - figure * 0.55);

  // The word is the point. Wrapped by hand rather than ellipsized, because
  // "Unhealthy for Sensitive Groups" is the band people most need to read and
  // it is the longest one by far.
  const bandSize = Math.max(7, h * 0.075);
  ctx.font = `bold ${bandSize}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.fillStyle = colour;
  const bandLines = wrapWords(ctx, data.band ?? "", w - pad * 2 - numberW - pad * 0.5);
  bandLines.slice(0, 2).forEach((line, i) => {
    ctx.fillText(line, x + pad + numberW + pad * 0.5, numberY - figure * 0.55 + bandSize * (1.3 + i * 1.15));
  });

  // The pollutants, along the bottom, as a row of small readings — enough to
  // explain the number without turning the channel into a laboratory report.
  const bottom = y + h - pad * 0.8;
  const small = Math.max(6, h * 0.052);
  ctx.font = `${small}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.textBaseline = "bottom";

  const shown = data.pollutants.slice(0, 4);
  if (shown.length) {
    const cell = (w - pad * 2) / shown.length;
    shown.forEach((p, i) => {
      const cellX = x + pad + cell * i;
      ctx.textAlign = "left";
      ctx.fillStyle = "#7f8ea6";
      ctx.fillText(p.name, cellX, bottom - small * 1.25);
      ctx.fillStyle = "#dbe6f5";
      ctx.fillText(String(p.value), cellX, bottom);
    });
  }

  // Pollen, or the honest absence of it.
  const noteY = bottom - small * 3.1;
  ctx.textAlign = "left";
  if (data.pollen?.length) {
    const worst = data.pollen[0];
    ctx.fillStyle = "#c9d6e8";
    ctx.fillText(`Pollen: ${worst.name} ${worst.level} (${worst.grains}/m³)`, x + pad, noteY);
  } else if (data.pollenNote) {
    ctx.fillStyle = "#6c7a90";
    // The short form, not the sentence in the data. "Pollen counts are not
    // published for this part of the world" is the right wording for the model
    // to read out and it reaches the picture's right-hand edge with nothing to
    // spare at a 390 canvas — measured off the string actually drawn, which is
    // the same check the boot screen's [ OK ] column needed. Ellipsized as
    // well, so a future rewording cannot quietly overflow.
    ctx.fillText(ellipsize(ctx, "Pollen: not published here", w - pad * 2), x + pad, noteY);
  }
}

/** #rrggbb plus an alpha, since the bands are stored as plain hex. */
function hexAlpha(hex, alpha) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex));
  if (!m) return `rgba(140,160,190,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Greedy wrap against the current font. */
function wrapWords(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !line) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
