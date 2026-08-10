import { ellipsize, standby } from "./shared.js";

function mixColour(from, to, t) {
  const k = Math.max(0, Math.min(1, t || 0));
  const c = from.map((v, i) => Math.round(v + (to[i] - v) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function drawKpDial(ctx, cx, cy, r, kp) {
  const START = Math.PI * 0.75;
  const SWEEP = Math.PI * 1.5;
  const value = Math.max(0, Math.min(9, kp || 0));

  ctx.save();
  ctx.lineCap = "butt";
  ctx.lineWidth = Math.max(2, r * 0.17);

  // The track, in two pieces so the storm end is visibly a different country.
  ctx.strokeStyle = "rgba(255,255,255,0.13)";
  ctx.beginPath();
  ctx.arc(cx, cy, r, START, START + SWEEP * (5 / 9));
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,120,80,0.22)";
  ctx.beginPath();
  ctx.arc(cx, cy, r, START + SWEEP * (5 / 9), START + SWEEP);
  ctx.stroke();

  // The reading.
  if (value > 0.02) {
    ctx.strokeStyle = value >= 5 ? "#ff7a4d" : value >= 4 ? "#ffc14d" : "#5fd0ff";
    ctx.beginPath();
    ctx.arc(cx, cy, r, START, START + SWEEP * (value / 9));
    ctx.stroke();
  }

  // Ticks at every whole Kp, so the arc is a scale rather than a bar.
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = Math.max(1, r * 0.035);
  for (let k = 0; k <= 9; k++) {
    const a = START + SWEEP * (k / 9);
    const outer = r * 1.16;
    const inner = r * (k % 3 === 0 ? 1.0 : 1.08);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
    ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(190,205,245,0.55)";
  ctx.font = `${Math.max(4, r * 0.26)}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("0", cx + Math.cos(START) * r * 1.45, cy + Math.sin(START) * r * 1.45);
  ctx.fillText("9", cx + Math.cos(START + SWEEP) * r * 1.45, cy + Math.sin(START + SWEEP) * r * 1.45);

  ctx.restore();
}

function drawSparkline(ctx, x, y, w, h, values, max) {
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.04)";
  ctx.fillRect(x, y, w, h);

  // Storm level, so the line has something to be above or below. Uses the same
  // inset plot height as the trace, or the two scales disagree and the storm
  // line sits a few pixels off where a value of 5 actually lands.
  const stormY = y + (h - Math.max(1, h * 0.05)) * (1 - 5 / max);
  ctx.strokeStyle = "rgba(255,140,90,0.35)";
  ctx.lineWidth = Math.max(1, h * 0.02);
  ctx.setLineDash([h * 0.12, h * 0.12]);
  ctx.beginPath();
  ctx.moveTo(x, stormY);
  ctx.lineTo(x + w, stormY);
  ctx.stroke();
  ctx.setLineDash([]);

  if (values.length > 1) {
    const step = w / (values.length - 1);
    // A small inset at the bottom, so a reading of zero — which is what this
    // shows on most nights — draws a line just inside the frame rather than
    // exactly along its lower edge, where it is indistinguishable from the
    // frame itself. The chart still starts at zero; it is the stroke that is
    // kept off the border, not the scale that is shifted.
    const floor = Math.max(1, h * 0.05);
    const plotH = h - floor;
    const at = (i) => ({
      x: x + i * step,
      y: y + plotH * (1 - Math.max(0, Math.min(max, values[i])) / max),
    });

    ctx.beginPath();
    ctx.moveTo(x, y + h);
    for (let i = 0; i < values.length; i++) {
      const p = at(i);
      ctx.lineTo(p.x, p.y);
    }
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
    ctx.fillStyle = "rgba(95,208,255,0.16)";
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < values.length; i++) {
      const p = at(i);
      if (i) ctx.lineTo(p.x, p.y);
      else ctx.moveTo(p.x, p.y);
    }
    ctx.strokeStyle = "#5fd0ff";
    ctx.lineWidth = Math.max(1, h * 0.055);
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  ctx.restore();
}

// -------------------------------------------------------------------------
// Channel 6: Space Weather
//
// One number, and whether it means anything from here. The K index sits at 0
// or 1 almost all the time, which is exactly why it is worth watching: on the
// rare night it does not, something is happening in the sky.
//
// The aurora line is honest about latitude rather than flattering. From 36°
// north the answer is almost always no, and a channel that implies otherwise
// sends somebody out into a field for nothing.
// -------------------------------------------------------------------------

export function draw(ctx, x, y, w, h, view) {
  const data = view.feed("spacewx");
  const kp = data?.kp ?? 0;
  // The background carries the reading before you have read a single word:
  // deep blue when quiet, through green, to a red that only a real storm
  // reaches. It is the fastest possible answer to "should I care".
  const heat = Math.min(1, kp / 7);
  const back = ctx.createLinearGradient(x, y, x, y + h);
  back.addColorStop(0, mixColour([10, 18, 44], [70, 16, 20], heat));
  back.addColorStop(0.65, mixColour([6, 12, 30], [46, 10, 14], heat));
  back.addColorStop(1, "#03060f");
  ctx.fillStyle = back;
  ctx.fillRect(x, y, w, h);

  if (!data || data.error) {
    standby(ctx, x, y, w, h, {
      message: data?.error ? "NO SIGNAL" : "TUNING IN",
      detail: data?.error ?? "asking NOAA",
    });
    return;
  }

  const pad = w * 0.05;
  const headerH = h * 0.115;

  ctx.fillStyle = "rgba(255,255,255,0.07)";
  ctx.fillRect(x, y, w, headerH);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#9fb9ff";
  ctx.font = `bold ${Math.max(6, h * 0.055)}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.fillText("SPACE WEATHER", x + pad, y + headerH / 2);
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(190,205,245,0.55)";
  ctx.font = `${Math.max(5, h * 0.048)}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.fillText("NOAA SWPC", x + w - pad, y + headerH / 2);

  // ---- The dial ----------------------------------------------------------
  const dialR = Math.min(h * 0.2, w * 0.19);
  const dialX = x + pad + dialR;
  const dialY = y + headerH + h * 0.06 + dialR * 0.72;
  drawKpDial(ctx, dialX, dialY, dialR, kp);

  // ---- The reading -------------------------------------------------------
  const textX = dialX + dialR * 1.45;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  ctx.fillStyle = "#f2f6ff";
  ctx.font = `bold ${Math.max(10, h * 0.155)}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.fillText(`Kp ${kp.toFixed(1)}`, textX, dialY - h * 0.035);

  ctx.font = `${Math.max(5, h * 0.055)}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.fillStyle = kp >= 5 ? "#ffb36b" : "rgba(190,205,245,0.8)";
  const scale = data.scale && data.scale !== "—" ? `${data.scale} ${data.condition}` : data.condition;
  ctx.fillText(`${scale} · ${data.trend}`, textX, dialY + h * 0.055);

  // ---- Three hours of history -------------------------------------------
  // A single number cannot say whether it is on the way up, and "rising" as a
  // word is a claim the reader has no way to check. The line is the evidence.
  const sparkTop = dialY + dialR * 0.95;
  const sparkH = h * 0.16;
  const sparkW = w - pad * 2;
  drawSparkline(ctx, x + pad, sparkTop, sparkW, sparkH, data.history ?? [], 9);

  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(160,180,225,0.5)";
  ctx.font = `${Math.max(4, h * 0.04)}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.fillText("3 HOURS", x + pad, sparkTop + sparkH + h * 0.012);
  ctx.textAlign = "right";
  ctx.fillText(`peak ${(data.peak3h ?? 0).toFixed(1)}`, x + w - pad, sparkTop + sparkH + h * 0.012);

  // ---- Aurora, from HERE -------------------------------------------------
  const auroraH = h * 0.155;
  const auroraY = y + h - auroraH;
  const visible = data.aurora?.visible === true;
  ctx.fillStyle = visible ? "rgba(30,120,80,0.55)" : "rgba(255,255,255,0.05)";
  ctx.fillRect(x, auroraY, w, auroraH);

  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = visible ? "#9dffce" : "rgba(190,205,245,0.6)";
  ctx.font = `bold ${Math.max(5, h * 0.048)}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.fillText("AURORA", x + pad, auroraY + auroraH * 0.32);

  ctx.font = `${Math.max(5, h * 0.046)}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.fillStyle = visible ? "rgba(220,255,235,0.9)" : "rgba(190,205,245,0.55)";
  ctx.fillText(
    ellipsize(ctx, data.aurora?.text ?? "", w - pad * 2),
    x + pad,
    auroraY + auroraH * 0.72
  );
}
