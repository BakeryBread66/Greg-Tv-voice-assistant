// Channel 12 — Sun & Moon.
//
// The moon is drawn rather than printed, because a phase is a shape and a
// percentage is not: "83% waxing gibbous" takes a moment to picture and a lit
// disc takes none. The terminator is an ellipse whose width is the cosine of
// the phase angle, which is what makes a real moon's shadow curve rather than
// cut straight across.
//
// Everything else is the times, in two columns, at a size that survives the
// smallest window the CSS allows.

import { standby, ellipsize } from "./shared.js";

export function draw(ctx, x, y, w, h, view) {
  // feed(id), not feed — the id is checked inside, so a reply that arrives
  // after a channel change cannot be painted into the wrong slot.
  const data = view.feed("sunmoon");
  if (!data) return standby(ctx, x, y, w, h, { message: "SUN & MOON", detail: "working out the sky" });
  if (data.error) return standby(ctx, x, y, w, h, { message: "SUN & MOON", detail: data.error });

  ctx.fillStyle = "#060814";
  ctx.fillRect(x, y, w, h);

  // A night sky that knows whether it is night. Deep blue when the sun is up,
  // near black when it is down — the same picture reading differently at eight
  // in the morning and eight at night, which is the point of the channel.
  const sky = ctx.createLinearGradient(0, y, 0, y + h);
  sky.addColorStop(0, data.isUp ? "#123a6b" : "#05060f");
  sky.addColorStop(1, data.isUp ? "#2f6ea8" : "#0b1024");
  ctx.fillStyle = sky;
  ctx.fillRect(x, y, w, h);

  const pad = w * 0.06;

  // ---- Ident --------------------------------------------------------------
  // The same strip every other programme channel wears. This one arguably needs
  // it least — a moon and a list of times explain themselves — but a channel
  // that names itself and one that does not is a set with two conventions, and
  // the times alone do not say whether they are today's or tomorrow's.
  const headerH = h * 0.11;
  ctx.fillStyle = "rgba(150,180,255,0.10)";
  ctx.fillRect(x, y, w, headerH);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#dfe6ff";
  ctx.font = `bold ${Math.max(6, h * 0.052)}px "MS Sans Serif", Tahoma, sans-serif`;
  const town = String(data.place ?? "").split(",")[0];
  ctx.fillText(ellipsize(ctx, `SUN & MOON · ${town.toUpperCase()}`, w * 0.66), x + pad, y + headerH / 2);

  ctx.textAlign = "right";
  ctx.fillStyle = "#8f9dc6";
  ctx.font = `${Math.max(5, h * 0.046)}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.fillText(data.isUp ? "DAY" : "NIGHT", x + w - pad, y + headerH / 2);

  // The moon, top right, sized to the picture.
  const radius = Math.min(w, h) * 0.15;
  const cx = x + w - pad - radius;
  const cy = y + headerH + h * 0.02 + radius;
  drawMoon(ctx, cx, cy, radius, (data.moon?.illumination ?? 0) / 100, data.moon?.waxing !== false);

  ctx.font = `${Math.max(6, h * 0.055)}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillStyle = "#aab6dd";
  ctx.fillText(data.moon?.name ?? "", cx, cy + radius + h * 0.03);
  ctx.fillStyle = "#7f8bb0";
  ctx.fillText(`${data.moon?.illumination ?? 0}% lit`, cx, cy + radius + h * 0.095);

  // The sun's day, as a list. Rows are laid out from a single line height so
  // adding one cannot push the last off the bottom unnoticed.
  const rows = [
    ["Sunrise", data.sunrise],
    ["Sunset", data.sunset],
    ["Daylight", data.dayLength],
    ["Dawn", data.dawn],
    ["Dusk", data.dusk],
    ["Golden", data.goldenEvening],
  ].filter(([, value]) => value);

  const size = Math.max(7, h * 0.068);
  const lineH = size * 1.55;
  ctx.font = `${size}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.textBaseline = "middle";
  let rowY = y + headerH + h * 0.02 + lineH * 0.7;

  for (const [label, value] of rows) {
    ctx.textAlign = "left";
    ctx.fillStyle = "#8f9dc6";
    ctx.fillText(label, x + pad, rowY);
    ctx.textAlign = "left";
    ctx.fillStyle = "#eef2ff";
    ctx.fillText(String(value), x + pad + w * 0.24, rowY);
    rowY += lineH;
  }

  // Polar day and night are the interesting case and must not read as a fault.
  if (data.note) {
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffcc55";
    ctx.font = `${Math.max(6, h * 0.06)}px "MS Sans Serif", Tahoma, sans-serif`;
    ctx.fillText(data.note, x + w / 2, y + h - h * 0.08);
  }
}

/**
 * A moon lit from one side.
 *
 * The lit fraction is turned into the WIDTH of the terminator ellipse, which is
 * what makes a crescent curve. Drawing a straight-edged shadow — the obvious
 * approach — produces something nobody has ever seen in the sky.
 */
export function drawMoon(ctx, cx, cy, r, lit, waxing) {
  ctx.save();

  // The dark disc first, so the lit part is painted onto it.
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "#1b2036";
  ctx.fill();

  const fraction = Math.max(0, Math.min(1, lit));

  // The lit shape is the limb on the sunward side, closed by the terminator
  // back across the disc.
  //
  //   k = 1 - 2*lit  is +1 at new, 0 at quarter, -1 at full
  //
  // |k| is the terminator's half-width — zero at a quarter, which is why the
  // straight edge appears exactly there — and the SIGN of k decides whether the
  // ellipse bulges into the lit side (a crescent) or away from it (a gibbous).
  // Getting that sign backwards draws a perfectly convincing moon showing the
  // opposite phase, which is exactly what the first version did: 83% waxing
  // gibbous came out as a thin crescent. Same class of mistake as the head
  // turning away from the cursor. **Check it against a picture.**
  const k = 1 - 2 * fraction;

  ctx.beginPath();
  // The limb: the half-circle on the sunward side. Waxing means lit on the
  // right, so the arc runs from the top down the right-hand side.
  ctx.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2, !waxing);
  // The terminator, back up to the top. When the moon is gibbous (k < 0) the
  // ellipse sweeps the other way so it adds to the lit area instead of cutting
  // into it.
  ctx.ellipse(cx, cy, Math.abs(k) * r, r, 0, Math.PI / 2, -Math.PI / 2, k < 0 ? !waxing : waxing);
  ctx.closePath();
  ctx.fillStyle = "#f2eddc";
  ctx.fill();

  // A rim, so a new moon is still a moon rather than a hole in the picture.
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(200,210,255,0.35)";
  ctx.lineWidth = Math.max(1, r * 0.04);
  ctx.stroke();

  ctx.restore();
}
