// ---------------------------------------------------------------------------
// Drawing helpers shared by every channel renderer.
//
// Text on a small screen: track titles are written for a phone, not for 250
// pixels of CRT — "1999 - 2019 Remaster (feat. ...)" is normal. Both of these
// measure against the font actually in use rather than guessing at a character
// count, because the font is proportional and a guess is wrong by a factor of
// two on capitals.
//
// The teletext channel deliberately does NOT use them: a fixed character grid is
// a different problem, and measuring pixels there would let the wrap point drift
// between the fonts in the stack while the columns stayed put. See ceefax.js.
// ---------------------------------------------------------------------------

export function ellipsize(ctx, text, maxWidth) {
  const full = String(text ?? "");
  if (maxWidth <= 0) return "";
  if (ctx.measureText(full).width <= maxWidth) return full;

  let cut = full.length;
  while (cut > 1 && ctx.measureText(`${full.slice(0, cut)}…`).width > maxWidth) cut--;
  return `${full.slice(0, cut).trimEnd()}…`;
}

export function wrapText(ctx, text, maxWidth, maxLines) {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const lines = [];
  let line = "";

  for (let i = 0; i < words.length; i++) {
    const candidate = line ? `${line} ${words[i]}` : words[i];

    // `!line` forces a single word too long for the line to be taken anyway;
    // ellipsize deals with it below rather than looping forever.
    if (ctx.measureText(candidate).width <= maxWidth || !line) {
      line = candidate;
      continue;
    }

    // Out of room on the last line we are allowed: put everything that is left
    // on it and mark it. Text that simply stops mid-title reads as a rendering
    // fault rather than as a long name.
    if (lines.length === maxLines - 1) {
      return [...lines, ellipsize(ctx, `${line} ${words.slice(i).join(" ")}`, maxWidth)];
    }

    lines.push(line);
    line = words[i];
  }

  lines.push(ellipsize(ctx, line, maxWidth));
  return lines;
}

export function standby(ctx, x, y, w, h, { message, detail = "", tint = "rgba(255,255,255,0.5)" }) {
  ctx.fillStyle = tint;
  ctx.font = `bold ${Math.max(7, h * 0.1)}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(message, x + w / 2, y + h * (detail ? 0.44 : 0.5));

  if (detail) {
    ctx.fillStyle = "rgba(190,205,235,0.45)";
    ctx.font = `${Math.max(5, h * 0.055)}px "MS Sans Serif", Tahoma, sans-serif`;
    for (const [i, line] of wrapText(ctx, detail, w * 0.82, 2).entries()) {
      ctx.fillText(line, x + w / 2, y + h * 0.57 + i * h * 0.075);
    }
  }
}
