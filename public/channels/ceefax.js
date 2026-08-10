import { ellipsize, wrapText, standby } from "./shared.js";

// ---------------------------------------------------------------------------
// Teletext
//
// A fixed grid is a different problem from proportional text, and the two must
// not be done with the same tools. ellipsize() and wrapText() measure pixels
// against the current font, which is exactly right for a track title and wrong
// here: on a fixed grid the unit is the CHARACTER, and measuring pixels would
// let the wrap point drift between the fonts in the stack while the columns
// stayed where they were.
// ---------------------------------------------------------------------------

// The BBC's teletext palette, which is simply the eight corners of the RGB cube
// at full brightness. Nothing was dimmed, which is why it still reads as blocky
// and electronic rather than as a colour scheme somebody chose.
const TELETEXT = {
  black: "#000000",
  red: "#ff0000",
  green: "#00ff00",
  yellow: "#ffff00",
  blue: "#0000ff",
  magenta: "#ff00ff",
  cyan: "#00ffff",
  white: "#ffffff",
  // Not a teletext colour — there was no grey. Used only for the attribution
  // line, which real Ceefax did not have to carry.
  grey: "#8a9aa8",
};

const TELETEXT_FONT = `"Consolas", "Lucida Console", "Courier New", monospace`;

// A teletext page is 40 columns. This is the ceiling rather than the value —
// the renderer takes fewer when the picture is too small for 40 to be legible.
const COLUMNS = 40;

// How long each page stays up before the cycle moves on. Real Ceefax rotated
// sub-pages at about this rate, and it is also roughly how long it takes to
// read seven headlines.
const PAGE_SECONDS = 9;

export function wrapChars(text, cols) {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= cols) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    // A single word longer than the whole line — a URL, a hyphenated place —
    // is cut rather than allowed to run off the edge of the picture.
    line = word.length > cols ? word.slice(0, cols) : word;
  }
  if (line) lines.push(line);
  return lines;
}

export function ellipsizeChars(text, cols) {
  const full = String(text ?? "");
  if (cols <= 0) return "";
  return full.length <= cols ? full : `${full.slice(0, Math.max(0, cols - 1)).trimEnd()}…`;
}

// -------------------------------------------------------------------------
// Channel 3: Ceefax
//
// Teletext, cycling three pages of headlines. It costs nothing but canvas
// work — the headlines were already being fetched — and it is the cheapest
// way to make the channels read as TELEVISION rather than as dashboards,
// which is why CLAUDE.md wanted it built early: everything after it inherits
// the visual language.
//
// Real Ceefax is 40 columns by 25 rows of blocky monospace on flat black,
// with a coloured fastext bar along the bottom. All of that is free here
// except the 40 columns, which is the whole difficulty — see below.
// -------------------------------------------------------------------------

export function draw(ctx, x, y, w, h, view) {
  // Flat black, not the deep blue channel 2 uses. Teletext was generated in
  // the receiver rather than transmitted as a picture, so it really did sit
  // on true black while everything around it did not.
  ctx.fillStyle = "#000";
  ctx.fillRect(x, y, w, h);

  const data = view.feed("ceefax");
  const pages = data?.pages?.filter((p) => p.stories.length || p.failed) ?? [];

  if (!pages.length) {
    standby(ctx, x, y, w, h, {
      message: data?.error ? "PAGE NOT FOUND" : "SEARCHING",
      detail: data?.error ?? "waiting for the headlines",
      tint: data?.error ? "#f55" : "#0f0",
    });
    return;
  }

  const page = pages[Math.floor(Math.max(0, view.time - view.pageSince) / PAGE_SECONDS) % pages.length];

  // ---- The grid ---------------------------------------------------------
  //
  // The font is sized from the ROW height, so fifteen rows always fit, and
  // the column count is then clamped to whatever actually fits the width.
  //
  // Measured across canvas sizes 300 to 1200, that clamp NEVER BINDS: fifteen
  // rows make the type small enough that forty columns clear the width at
  // every size, so the page is always a real 40-column teletext page. What
  // varies is the glyph, from 5.3 px at a 300 px canvas through 6.3 at 360 and
  // 12.3 at 700. So the honest statement of the small-window problem
  // CLAUDE.md raised is that it is a GLYPH SIZE problem, not a column-count
  // one — around a 460 px canvas (8.1 px glyphs) it is comfortable, and below
  // ~360 it is legible but tight. The clamp stays as a floor; it is simply not
  // the thing doing the work, and claiming otherwise would be a fix that was
  // never exercised.
  //
  // The advance width is measured rather than assumed. Font metrics vary
  // between the fonts in the stack, and a guessed 0.55em would silently
  // overflow the picture on whichever machine fell through to the fallback.
  const rows = 15;
  const lineH = h / rows;
  const pad = w * 0.03;
  const inner = w - pad * 2;

  let fontSize = Math.max(5, lineH * 0.74);
  ctx.font = `${fontSize}px ${TELETEXT_FONT}`;
  let advance = ctx.measureText("00000000").width / 8;

  // Room for more than 40 columns: grow the type instead of running wider.
  // A page is 40 columns, and 60 narrow ones is a terminal, not Ceefax.
  if (advance * COLUMNS < inner) {
    fontSize = Math.min(lineH * 0.82, (fontSize * inner) / (advance * COLUMNS));
    ctx.font = `${fontSize}px ${TELETEXT_FONT}`;
    advance = ctx.measureText("00000000").width / 8;
  }

  const cols = Math.max(20, Math.min(COLUMNS, Math.floor(inner / advance)));
  const left = x + pad;
  const row = (n) => y + lineH * (n + 0.5);

  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  // ---- Header: page number, service, clock ------------------------------
  const clock = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const date = new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

  ctx.fillStyle = TELETEXT.cyan;
  ctx.fillText(`P${page.number}`, left, row(0));
  ctx.fillStyle = TELETEXT.white;
  ctx.fillText("CEEFAX", left + advance * 6, row(0));
  ctx.fillStyle = TELETEXT.green;
  // Right-aligned by columns rather than by pixels, so it lands on the grid
  // like everything else instead of floating half a character off it.
  const stamp = `${date} ${clock}`;
  ctx.fillText(stamp, left + advance * Math.max(0, cols - stamp.length), row(0));

  // ---- Title: yellow on blue, which is what a Ceefax section header was --
  ctx.fillStyle = TELETEXT.blue;
  ctx.fillRect(left, row(1.5) - lineH * 0.6, advance * cols, lineH * 1.2);
  ctx.fillStyle = TELETEXT.yellow;
  ctx.fillText(ellipsizeChars(page.title, cols - 2), left + advance, row(1.5));

  // ---- The stories ------------------------------------------------------
  if (page.failed) {
    ctx.fillStyle = TELETEXT.red;
    ctx.fillText(ellipsizeChars("FEED UNAVAILABLE", cols), left, row(4));
    return;
  }

  // Two rows are the header and the title bar, one is the fastext strip, and
  // one each side of the block is breathing room.
  const firstRow = 3.4;
  const lastRow = rows - 1.6;
  let at = firstRow;
  let index = 0;

  for (const story of page.stories) {
    if (at > lastRow - 1) break;
    index++;

    // Wrapped by CHARACTER, not by pixel width. On a fixed grid those are the
    // same thing, and doing it in characters means the wrap point cannot
    // drift between the fonts in the stack.
    const lines = wrapChars(`${index} ${story.headline}`, cols);
    // A headline that would be cut off mid-way by the fastext bar is worse
    // than one that is not shown — the reader cannot tell a truncated
    // headline from a short one.
    if (at + lines.length > lastRow) break;

    // Alternating white and cyan, which is how Ceefax separated adjacent
    // items without drawing a rule between them.
    ctx.fillStyle = index % 2 ? TELETEXT.white : TELETEXT.cyan;
    for (const line of lines) {
      ctx.fillText(line, left, row(at));
      at += 1;
    }

    if (story.source && at <= lastRow - 0.5) {
      ctx.fillStyle = TELETEXT.grey;
      ctx.fillText(ellipsizeChars(`  ${story.source}`, cols), left, row(at));
      at += 1;
    }
    at += 0.35;
  }

  // ---- Fastext: the four coloured buttons along the bottom --------------
  // Pure decoration here — there is nothing to press — but it is the single
  // most recognisable thing about the format, and the page is unmistakable
  // with it and merely monospaced without it.
  const barY = y + h - lineH * 1.15;
  const barH = lineH * 0.7;
  // One button per page, not always four. Real Ceefax had four fixed colours,
  // but a fourth button with nothing on it is an empty cyan block that reads
  // as a rendering fault rather than as a spare key — and there are three
  // pages. The colours stay in their traditional order.
  const colours = [TELETEXT.red, TELETEXT.green, TELETEXT.yellow, TELETEXT.cyan];
  const cell = (advance * cols) / pages.length;

  for (let i = 0; i < pages.length && i < colours.length; i++) {
    ctx.fillStyle = colours[i];
    ctx.fillRect(left + i * cell, barY, cell * 0.94, barH);
    ctx.fillStyle = "#000";
    // The page showing gets its number marked, so the cycle is legible as a
    // cycle rather than as a bar that happens to be there.
    const label = `${pages[i] === page ? "▶" : " "}${pages[i].number} ${pages[i].title}`;
    ctx.fillText(ellipsizeChars(label, Math.floor((cell * 0.9) / advance)), left + i * cell + advance * 0.3, barY + barH / 2);
  }
}
