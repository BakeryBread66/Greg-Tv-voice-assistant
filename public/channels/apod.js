import { ellipsize, wrapText, standby } from "./shared.js";

// -------------------------------------------------------------------------
// Channel 5: Sky at Night — NASA's picture of the day
//
// One photograph, filling the screen. Everything else on the set is
// information; this one is only worth having if the picture is allowed to be
// the whole picture, so the caption is a scrim over the bottom of it rather
// than a panel beside it.
// -------------------------------------------------------------------------

export function draw(ctx, x, y, w, h, view) {
  ctx.fillStyle = "#04060e";
  ctx.fillRect(x, y, w, h);

  const data = view.feed("apod");
  if (!data || data.error) {
    standby(ctx, x, y, w, h, {
      message: data?.error ? "NO SIGNAL" : "TUNING IN",
      detail: data?.error ?? "asking NASA",
    });
    return;
  }

  if (view.photo && view.photo.width) {
    // Cover, not contain: an astronomy photograph with letterbox bars round
    // it looks like a mistake, and the crop costs less than the bars do.
    const scale = Math.max(w / view.photo.width, h / view.photo.height);
    const dw = view.photo.width * scale;
    const dh = view.photo.height * scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.drawImage(view.photo, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    ctx.restore();
  } else {
    standby(ctx, x, y, w, h, { message: "RECEIVING", detail: data.title, tint: "rgba(180,200,255,0.55)" });
  }

  // ---- The caption -------------------------------------------------------
  // A scrim rather than a bar: the photograph carries on underneath it, which
  // is the difference between a caption on a picture and a picture squashed
  // into a box.
  const scrimH = h * 0.32;
  const scrim = ctx.createLinearGradient(x, y + h - scrimH, x, y + h);
  scrim.addColorStop(0, "rgba(0,0,0,0)");
  scrim.addColorStop(0.45, "rgba(0,0,0,0.62)");
  scrim.addColorStop(1, "rgba(0,0,0,0.9)");
  ctx.fillStyle = scrim;
  ctx.fillRect(x, y + h - scrimH, w, scrimH);

  const pad = w * 0.045;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  const titleSize = Math.max(7, h * 0.075);
  ctx.font = `bold ${titleSize}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.fillStyle = "#f4f8ff";
  let at = y + h - scrimH + titleSize * 1.5;
  for (const line of wrapText(ctx, data.title ?? "", w - pad * 2, 2)) {
    ctx.fillText(line, x + pad, at);
    at += titleSize * 1.2;
  }

  const creditSize = Math.max(5, h * 0.046);
  ctx.font = `${creditSize}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.fillStyle = "rgba(190,205,235,0.72)";
  ctx.fillText(ellipsize(ctx, data.credit ?? "", w - pad * 2), x + pad, at + creditSize * 0.6);

  // A video day still gets a still, from `thumbs=true` — but the set must not
  // imply it is playing something it cannot play.
  if (data.isVideo) {
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(255,220,140,0.8)";
    ctx.fillText("VIDEO — STILL SHOWN", x + w - pad, y + h - scrimH + creditSize * 1.6);
  }
}
