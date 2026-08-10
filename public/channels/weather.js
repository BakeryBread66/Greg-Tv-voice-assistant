import { ellipsize, wrapText, standby } from "./shared.js";

const ALERT_COLOURS = {
  Extreme: { background: "#b3001b", text: "#fff2f2" },
  Severe: { background: "#c8500f", text: "#fff6ec" },
  Moderate: { background: "#8a6a10", text: "#fff9e8" },
  Minor: { background: "#2f5a7a", text: "#eef6ff" },
  Unknown: { background: "#404a5a", text: "#eef1f6" },
};

function skyFromWords(conditions = "") {
  const words = String(conditions).toLowerCase();
  if (words.includes("thunder")) return "storm";
  if (/snow|freezing|sleet|grains/.test(words)) return "snow";
  if (/rain|drizzle|shower/.test(words)) return "rain";
  if (/fog/.test(words)) return "fog";
  // "mostly clear" and "partly cloudy" both have to be caught before the bare
  // "cloud" test, or every broken sky reads as overcast. Same trap as
  // lib/nws.js's prose fallback, and it bites here for the same reason.
  if (/partly|mostly clear/.test(words)) return "partcloud";
  if (/cloud|overcast/.test(words)) return "cloud";
  if (/clear/.test(words)) return "clear";
  return "cloud";
}

function drawSky(ctx, cx, cy, r, kind, daytime = true) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const sunny = kind === "clear" || kind === "partcloud";
  const cloudy = kind !== "clear";

  if (sunny) {
    // Off to the upper left when there is a cloud to sit behind, centred when
    // there is not.
    const sx = kind === "clear" ? cx : cx - r * 0.28;
    const sy = kind === "clear" ? cy : cy - r * 0.3;
    const sr = r * (kind === "clear" ? 0.5 : 0.34);

    if (daytime) {
      ctx.fillStyle = "#ffd34d";
      ctx.beginPath();
      ctx.arc(sx, sy, sr, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "#ffd34d";
      ctx.lineWidth = Math.max(1, r * 0.09);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(sx + Math.cos(a) * sr * 1.35, sy + Math.sin(a) * sr * 1.35);
        ctx.lineTo(sx + Math.cos(a) * sr * 1.75, sy + Math.sin(a) * sr * 1.75);
        ctx.stroke();
      }
    } else {
      // A crescent, cut by punching a second disc out of the first. `xor`
      // rather than a second fill in the background colour, because the symbol
      // is drawn over a gradient and a solid patch would show as a rectangle.
      ctx.save();
      ctx.globalCompositeOperation = "xor";
      ctx.fillStyle = "#e8eeff";
      ctx.beginPath();
      ctx.arc(sx, sy, sr, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(sx + sr * 0.42, sy - sr * 0.34, sr * 0.92, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  if (cloudy) {
    const cloudY = kind === "partcloud" ? cy + r * 0.22 : cy;
    const cloudX = kind === "partcloud" ? cx + r * 0.14 : cx;
    const scale = kind === "partcloud" ? 0.82 : 1;

    ctx.fillStyle = kind === "storm" || kind === "rain" ? "#8f9dae" : "#c9d4e2";
    ctx.beginPath();
    ctx.arc(cloudX - r * 0.34 * scale, cloudY + r * 0.06 * scale, r * 0.3 * scale, 0, Math.PI * 2);
    ctx.arc(cloudX + r * 0.02 * scale, cloudY - r * 0.14 * scale, r * 0.4 * scale, 0, Math.PI * 2);
    ctx.arc(cloudX + r * 0.42 * scale, cloudY + r * 0.08 * scale, r * 0.28 * scale, 0, Math.PI * 2);
    ctx.rect(cloudX - r * 0.34 * scale, cloudY + r * 0.04 * scale, r * 0.78 * scale, r * 0.32 * scale);
    ctx.fill();
  }

  if (kind === "rain" || kind === "storm") {
    ctx.strokeStyle = "#6fb6ff";
    ctx.lineWidth = Math.max(1, r * 0.1);
    for (let i = -1; i <= 1; i++) {
      const dx = cx + i * r * 0.32;
      ctx.beginPath();
      ctx.moveTo(dx, cy + r * 0.45);
      ctx.lineTo(dx - r * 0.1, cy + r * 0.82);
      ctx.stroke();
    }
  }

  if (kind === "storm") {
    ctx.fillStyle = "#ffd34d";
    ctx.beginPath();
    ctx.moveTo(cx + r * 0.1, cy + r * 0.34);
    ctx.lineTo(cx - r * 0.16, cy + r * 0.74);
    ctx.lineTo(cx + r * 0.02, cy + r * 0.74);
    ctx.lineTo(cx - r * 0.1, cy + r * 1.06);
    ctx.lineTo(cx + r * 0.26, cy + r * 0.6);
    ctx.lineTo(cx + r * 0.06, cy + r * 0.6);
    ctx.closePath();
    ctx.fill();
  }

  if (kind === "snow") {
    ctx.strokeStyle = "#dcecff";
    ctx.lineWidth = Math.max(1, r * 0.08);
    for (let i = -1; i <= 1; i++) {
      const fx = cx + i * r * 0.32;
      const fy = cy + r * 0.66;
      for (let a = 0; a < 3; a++) {
        const angle = (a / 3) * Math.PI;
        ctx.beginPath();
        ctx.moveTo(fx - Math.cos(angle) * r * 0.14, fy - Math.sin(angle) * r * 0.14);
        ctx.lineTo(fx + Math.cos(angle) * r * 0.14, fy + Math.sin(angle) * r * 0.14);
        ctx.stroke();
      }
    }
  }

  if (kind === "fog" || kind === "wind") {
    ctx.strokeStyle = kind === "fog" ? "#b9c6d6" : "#9fd0ff";
    ctx.lineWidth = Math.max(1, r * 0.11);
    for (let i = 0; i < 3; i++) {
      const ly = cy + r * (0.42 + i * 0.26);
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.62, ly);
      ctx.lineTo(cx + r * (i === 1 ? 0.68 : 0.44), ly);
      ctx.stroke();
    }
  }

  ctx.restore();
}

// -------------------------------------------------------------------------
// Channel 4: Weather
//
// The National Weather Service's own words. That is the point of it — the
// numbers were already available on request, and a card that only shows
// numbers is a dashboard. "A slight chance of rain showers between 8am and
// 9am, then a chance of showers and thunderstorms" is a sentence a person
// wrote, and reading it makes the set a television.
//
// A warning in force takes the top of the screen away from everything else.
// -------------------------------------------------------------------------

export function draw(ctx, x, y, w, h, view) {
  const back = ctx.createLinearGradient(x, y, x, y + h);
  back.addColorStop(0, "#0a1c33");
  back.addColorStop(0.6, "#071426");
  back.addColorStop(1, "#040a14");
  ctx.fillStyle = back;
  ctx.fillRect(x, y, w, h);

  const data = view.feed("weather");
  if (!data || (!data.periods?.length && !data.daily?.length)) {
    standby(ctx, x, y, w, h, {
      message: data?.error ? "NO SIGNAL" : "TUNING IN",
      detail: data?.error ?? "asking the weather service",
    });
    return;
  }

  const pad = w * 0.045;
  let top = y;

  // ---- A warning, if there is one ---------------------------------------
  const alert = data.alerts?.[0];
  if (alert) {
    const bandH = h * 0.155;
    const colour = ALERT_COLOURS[alert.severity] ?? ALERT_COLOURS.Unknown;
    // Severe and above pulses. Below that it is a steady band: a moderate
    // advisory that flashes for as long as it is in force is the boy who
    // cried wolf rendered in software.
    const pulse = alert.rank >= 3 ? 0.78 + Math.sin(view.time * 4) * 0.22 : 1;
    ctx.globalAlpha = pulse;
    ctx.fillStyle = colour.background;
    ctx.fillRect(x, top, w, bandH);
    ctx.globalAlpha = 1;

    ctx.fillStyle = colour.text;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = `bold ${Math.max(6, h * 0.072)}px "MS Sans Serif", Tahoma, sans-serif`;
    ctx.fillText(ellipsize(ctx, alert.event.toUpperCase(), w - pad * 2), x + pad, top + bandH * 0.34);

    ctx.font = `${Math.max(5, h * 0.05)}px "MS Sans Serif", Tahoma, sans-serif`;
    ctx.globalAlpha = 0.85;
    ctx.fillText(ellipsize(ctx, alert.area || alert.headline, w - pad * 2), x + pad, top + bandH * 0.72);
    ctx.globalAlpha = 1;

    // More than one in force at a time is common in bad weather, and showing
    // one while silently dropping the rest is how a tornado warning ends up
    // hidden behind a flood advisory.
    if (data.alerts.length > 1) {
      ctx.textAlign = "right";
      ctx.font = `bold ${Math.max(5, h * 0.05)}px "MS Sans Serif", Tahoma, sans-serif`;
      ctx.fillText(`+${data.alerts.length - 1}`, x + w - pad, top + bandH * 0.34);
    }

    top += bandH;
  }

  // ---- Ident strip -------------------------------------------------------
  const headerH = h * 0.115;
  ctx.fillStyle = "rgba(255,255,255,0.07)";
  ctx.fillRect(x, top, w, headerH);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#8fd0ff";
  ctx.font = `bold ${Math.max(6, h * 0.055)}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.fillText(ellipsize(ctx, (data.place || "WEATHER").toUpperCase(), w * 0.6), x + pad, top + headerH / 2);

  // Whoever actually supplied the words gets the credit. Saying "NWS RAH"
  // over an Open-Meteo forecast would be the fabricated-source failure from
  // CLAUDE.md with the citation moved into a picture.
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(190,215,245,0.55)";
  ctx.font = `${Math.max(5, h * 0.048)}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.fillText(data.source ?? "", x + w - pad, top + headerH / 2);
  top += headerH;

  // ---- Now, and the words ------------------------------------------------
  const stripH = h * 0.2;
  const bodyTop = top + h * 0.03;
  const period = data.periods?.[0] ?? null;
  const symbolR = Math.min(h * 0.085, w * 0.075);
  const symbolX = x + pad + symbolR;
  const symbolY = bodyTop + symbolR * 1.05;

  drawSky(ctx, symbolX, symbolY, symbolR, period?.sky ?? "cloud", period?.daytime ?? true);

  const temp = data.now?.temperature ?? (period ? `${period.temperature}°${period.unit}` : "--");
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#f2f7ff";
  ctx.font = `bold ${Math.max(10, h * 0.145)}px "MS Sans Serif", Tahoma, sans-serif`;
  const tempX = symbolX + symbolR * 1.35;
  ctx.fillText(temp, tempX, symbolY - h * 0.012);

  ctx.fillStyle = "rgba(190,215,245,0.7)";
  ctx.font = `${Math.max(5, h * 0.05)}px "MS Sans Serif", Tahoma, sans-serif`;
  const feels = data.now?.feelsLike && data.now.feelsLike !== temp ? `feels ${data.now.feelsLike}` : "";
  ctx.fillText([data.now?.conditions, feels].filter(Boolean).join(" · "), tempX, symbolY + h * 0.062);

  // The worded forecast: the reason this channel exists, so it gets the space.
  //
  // The top of it is the LOWER of two things — clear of the symbol, and clear
  // of the "feels like" line — rather than a single multiple of the symbol
  // radius. The first version used only the symbol, and on a tall picture the
  // conditions line reached further down than the symbol did: "OVERNIGHT" was
  // printed straight through "overcast · feels 77°F". Two things can each be
  // positioned correctly and still collide, so the clearance has to be taken
  // from whichever actually ends up furthest down.
  const wordsX = x + pad;
  let wordsY = Math.max(symbolY + symbolR * 1.3, symbolY + h * 0.062 + h * 0.078);
  if (period) {
    ctx.fillStyle = "#7fd4ff";
    ctx.font = `bold ${Math.max(5, h * 0.055)}px "MS Sans Serif", Tahoma, sans-serif`;
    ctx.fillText(period.name.toUpperCase(), wordsX, wordsY);
    wordsY += h * 0.062;

    const bodySize = Math.max(5, h * 0.052);
    ctx.font = `${bodySize}px "MS Sans Serif", Tahoma, sans-serif`;
    ctx.fillStyle = "rgba(225,238,255,0.88)";
    const room = Math.max(1, Math.floor((y + h - stripH - h * 0.03 - wordsY) / (bodySize * 1.28)));
    for (const line of wrapText(ctx, period.detailed || period.short || "", w - pad * 2, room)) {
      ctx.fillText(line, wordsX, wordsY);
      wordsY += bodySize * 1.28;
    }
  } else {
    // Outside NWS coverage there are no words, only numbers — say so rather
    // than leaving an empty half-screen that reads as a fault.
    ctx.fillStyle = "rgba(190,215,245,0.5)";
    ctx.font = `${Math.max(5, h * 0.052)}px "MS Sans Serif", Tahoma, sans-serif`;
    ctx.fillText("No worded forecast here — numbers only.", wordsX, wordsY);
  }

  // ---- The strip along the bottom: the next few periods ------------------
  const cards = (data.periods?.length ? data.periods.slice(1, 5) : data.daily.slice(1, 5)).map((p) =>
    p.name
      ? { label: p.name, temp: `${p.temperature}°`, sky: p.sky, daytime: p.daytime }
      : { label: p.day?.slice(0, 3) ?? "", temp: `${p.high}°`, sky: skyFromWords(p.conditions), daytime: true }
  );

  if (cards.length) {
    const stripY = y + h - stripH;
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fillRect(x, stripY, w, stripH);

    const cellW = w / cards.length;
    for (let i = 0; i < cards.length; i++) {
      const cx = x + cellW * (i + 0.5);
      ctx.textAlign = "center";

      ctx.fillStyle = "rgba(190,215,245,0.7)";
      ctx.font = `${Math.max(5, h * 0.042)}px "MS Sans Serif", Tahoma, sans-serif`;
      // Period names run long ("Saturday Night"), and a name that overflows
      // into its neighbour is worse than one that is shortened.
      ctx.fillText(ellipsize(ctx, cards[i].label, cellW * 0.94), cx, stripY + stripH * 0.2);

      drawSky(ctx, cx, stripY + stripH * 0.5, Math.min(stripH * 0.19, cellW * 0.17), cards[i].sky, cards[i].daytime);

      ctx.fillStyle = "#e8f2ff";
      ctx.font = `bold ${Math.max(6, h * 0.055)}px "MS Sans Serif", Tahoma, sans-serif`;
      ctx.fillText(cards[i].temp, cx, stripY + stripH * 0.84);

      if (i) {
        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.lineWidth = Math.max(1, h * 0.003);
        ctx.beginPath();
        ctx.moveTo(x + cellW * i, stripY + stripH * 0.15);
        ctx.lineTo(x + cellW * i, stripY + stripH * 0.85);
        ctx.stroke();
      }
    }
  }
}
