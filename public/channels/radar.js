import { standby } from "./shared.js";

// How long each radar frame is held, and how long the newest one stays up at the
// end of the cycle. Both are what broadcast radar loops do: fast enough that the
// motion reads as motion, with a pause on the latest so the eye can see where
// the rain actually got to.
const RADAR_FRAME_SECONDS = 0.34;

const RADAR_HOLD_SECONDS = 1.4;

// -------------------------------------------------------------------------
// Channel 7: Radar
//
// The last twenty minutes of rain, moving. This is the only channel where the
// MOTION carries the information — a still radar image says it is raining
// somewhere, and a loop says whether it is coming towards you, which is the
// question anybody actually has.
//
// The frames arrive ready-made from the NWS with the coastline, the county
// lines and the range rings already on them, so there is no map to draw here.
// -------------------------------------------------------------------------

export function draw(ctx, x, y, w, h, view) {
  ctx.fillStyle = "#05080f";
  ctx.fillRect(x, y, w, h);

  const data = view.feed("radar");

  if (data && data.covered === false) {
    // No station is a fact about the place, not a fault — same as the weather
    // channel outside NWS coverage.
    standby(ctx, x, y, w, h, {
      message: "NO RADAR",
      detail: `No weather radar covers ${data.place || "this area"}.`,
    });
    return;
  }

  const frames = view.radarFrames;
  if (!data || data.error || !frames.length) {
    standby(ctx, x, y, w, h, {
      message: data?.error ? "NO SIGNAL" : "TUNING IN",
      detail: data?.error ?? "waiting for the radar",
    });
    return;
  }

  // ---- Which frame ------------------------------------------------------
  // A hold on the newest frame, which is what every broadcast radar loop does
  // and is the reason they are readable: without the pause the eye never gets
  // to see where the rain ended up, only that it moved.
  const cycle = frames.length * RADAR_FRAME_SECONDS + RADAR_HOLD_SECONDS;
  const into = view.time % cycle;
  const at = Math.min(frames.length - 1, Math.floor(into / RADAR_FRAME_SECONDS));
  const frame = frames[at];

  // ---- The picture ------------------------------------------------------
  //
  // Almost NO chrome of our own, and that is a decision made after looking at
  // a frame rather than before. The NWS "standard" image is already a finished
  // broadcast graphic: its own header with the warning-type key (tornado,
  // severe thunderstorm, flash flood), the state and county lines, the
  // highways, named towns, the coastline, the dBZ colour scale, its own
  // timestamp, and any active warning polygon drawn straight onto the map. The
  // ident strip and clock this originally had would have sat on top of all of
  // it and duplicated most of it.
  //
  // So the only thing added is the one piece of information a still frame
  // cannot carry: where you are in the loop.
  //
  // Contained, not cropped. The station is at the centre of the image and the
  // interesting weather is usually at the EDGE — cropping to fill would throw
  // away the storm that is about to arrive, which is what this channel is for.
  const barH = h * 0.075;
  const boxH = h - barH;

  if (frame && frame.width) {
    const scale = Math.min(w / frame.width, boxH / frame.height);
    const dw = frame.width * scale;
    const dh = frame.height * scale;
    ctx.drawImage(frame, x + (w - dw) / 2, y + (boxH - dh) / 2, dw, dh);
  }

  // ---- Where we are in the loop -----------------------------------------
  // A tick per frame, filling as it runs. It says how far through you are
  // without needing to be read, which a timestamp does not — and the frame
  // already carries the exact time, in the NWS's own footer.
  const pad = w * 0.03;
  const newest = at === frames.length - 1;
  const midY = y + h - barH / 2;

  // The word and the ticks share this strip rather than being stacked, and
  // neither is allowed onto the picture. The first version put "LATEST" over
  // the image and it landed squarely on the NWS's own timestamp — the frame
  // is a finished graphic with its own furniture, so the only safe place for
  // ours is the space we reserved.
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.font = `bold ${Math.max(5, barH * 0.5)}px "MS Sans Serif", Tahoma, sans-serif`;
  const label = newest ? "LATEST" : `−${(frames.length - 1 - at) * 2} MIN`;
  ctx.fillStyle = newest ? "#9dffce" : "rgba(190,215,245,0.6)";
  ctx.fillText(label, x + w - pad, midY);

  const labelW = ctx.measureText("−00 MIN").width + pad;
  const trackW = w - pad * 2 - labelW;
  const tickW = trackW / frames.length;
  const tickH = Math.max(1, barH * 0.26);

  for (let i = 0; i < frames.length; i++) {
    ctx.fillStyle = i === at ? (newest ? "#9dffce" : "#7fd4ff") : i < at ? "rgba(127,212,255,0.4)" : "rgba(255,255,255,0.14)";
    ctx.fillRect(x + pad + i * tickW, midY - tickH / 2, tickW * 0.78, tickH);
  }
}
