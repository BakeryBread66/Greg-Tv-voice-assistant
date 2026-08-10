import { ellipsize, standby } from "./shared.js";

// ---------------------------------------------------------------------------
// Markets
// ---------------------------------------------------------------------------

// Green up and red down is the convention and breaking it would confuse more
// than it helped — but colour is never the ONLY signal on this channel, because
// red and green are the two most commonly confused colours there are. Every
// figure carries an arrow as well.
const MARKET = {
  up: { text: "#5ee08f", line: "#5ee08f", fill: "rgba(94,224,143,0.14)" },
  down: { text: "#ff7a6b", line: "#ff7a6b", fill: "rgba(255,122,107,0.14)" },
  flat: { text: "rgba(200,215,240,0.75)", line: "rgba(200,215,240,0.75)", fill: "rgba(200,215,240,0.10)" },
};

// Spelled out rather than left as a status code. "POST" means nothing to anyone
// who does not already know, and this channel's whole risk is a number being
// read as more current than it is.
const SESSION_LABEL = {
  open: "OPEN",
  closed: "CLOSED",
  pre: "PRE-MARKET",
  post: "AFTER HOURS",
  unknown: "",
};

function drawSessionChart(ctx, x, y, w, h, series, previousClose, tint) {
  const values = series.map((p) => p.c);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (Number.isFinite(previousClose)) {
    lo = Math.min(lo, previousClose);
    hi = Math.max(hi, previousClose);
  }
  const span = hi - lo || 1;
  const pad = span * 0.12;
  lo -= pad;
  hi += pad;

  const at = (i) => ({
    x: x + (i / (series.length - 1)) * w,
    y: y + h * (1 - (values[i] - lo) / (hi - lo)),
  });

  // The reference line first, so the trace sits over it.
  if (Number.isFinite(previousClose)) {
    const py = y + h * (1 - (previousClose - lo) / (hi - lo));
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = Math.max(1, h * 0.012);
    ctx.setLineDash([h * 0.06, h * 0.06]);
    ctx.beginPath();
    ctx.moveTo(x, py);
    ctx.lineTo(x + w, py);
    ctx.stroke();
    ctx.restore();

    // The label flips to whichever side of the line has room. On a strong day
    // the reference sits hard against the bottom of the chart and on a bad one
    // hard against the top — the first version always drew it above, so it was
    // clipped by the chart's own edge in exactly the cases where the day was
    // most worth looking at. Right-aligned as well, because the left end is
    // where the trace starts and the label was landing in the fill.
    const nearTop = py - y < h * 0.34;
    ctx.save();
    ctx.textAlign = "right";
    ctx.textBaseline = nearTop ? "top" : "bottom";
    ctx.fillStyle = "rgba(255,255,255,0.34)";
    ctx.font = `${Math.max(4, h * 0.14)}px "MS Sans Serif", Tahoma, sans-serif`;
    ctx.fillText("prev close", x + w - w * 0.008, py + (nearTop ? h * 0.04 : -h * 0.04));
    ctx.restore();
  }

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  for (let i = 0; i < series.length; i++) {
    const p = at(i);
    ctx.lineTo(p.x, p.y);
  }
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
  ctx.fillStyle = tint.fill;
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < series.length; i++) {
    const p = at(i);
    if (i) ctx.lineTo(p.x, p.y);
    else ctx.moveTo(p.x, p.y);
  }
  ctx.strokeStyle = tint.line;
  ctx.lineWidth = Math.max(1, h * 0.045);
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.restore();
}

// -------------------------------------------------------------------------
// Channel 8: Markets
//
// The NASDAQ Composite and a few listed share prices. A READOUT, deliberately
// — the numbers, the move, the session, and nothing that characterises any of
// it. No arrows-as-verdicts, no green glow of approval, no "best performer".
// Greg is not anybody's financial adviser and the moment a screen starts
// ranking things it is making a suggestion.
//
// The session state is as load-bearing as the price. The market is shut more
// hours of the week than it is open, and a level with nothing next to it reads
// as live when it is last Friday's close.
// -------------------------------------------------------------------------

export function draw(ctx, x, y, w, h, view) {
  const back = ctx.createLinearGradient(x, y, x, y + h);
  back.addColorStop(0, "#0a1220");
  back.addColorStop(0.6, "#070d18");
  back.addColorStop(1, "#04070e");
  ctx.fillStyle = back;
  ctx.fillRect(x, y, w, h);

  const data = view.feed("stocks");
  if (!data || data.error || !data.index) {
    standby(ctx, x, y, w, h, {
      message: data?.error ? "NO SIGNAL" : "TUNING IN",
      detail: data?.error ?? "asking for the market figures",
    });
    return;
  }

  const pad = w * 0.045;
  const index = data.index;
  const up = (index.change ?? 0) > 0;
  const flat = !index.change;
  const tint = flat ? MARKET.flat : up ? MARKET.up : MARKET.down;

  // ---- Ident, and whether the market is actually open -------------------
  const headerH = h * 0.115;
  ctx.fillStyle = "rgba(255,255,255,0.07)";
  ctx.fillRect(x, y, w, headerH);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#8fd0ff";
  ctx.font = `bold ${Math.max(6, h * 0.055)}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.fillText(ellipsize(ctx, (index.name || "NASDAQ").toUpperCase(), w * 0.62), x + pad, y + headerH / 2);

  // Open gets a live pip; everything else says plainly what it is. "CLOSED"
  // has to be as readable as the price it qualifies.
  const state = SESSION_LABEL[data.session] ?? "";
  ctx.textAlign = "right";
  ctx.font = `bold ${Math.max(5, h * 0.048)}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.fillStyle = data.session === "open" ? "#9dffce" : "rgba(200,215,240,0.6)";
  ctx.fillText(state, x + w - pad, y + headerH / 2);
  if (data.session === "open") {
    const r = Math.max(1.5, h * 0.011);
    ctx.beginPath();
    ctx.arc(x + w - pad - ctx.measureText(state).width - r * 2.6, y + headerH / 2, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(157,255,206,${0.45 + Math.sin(view.time * 3) * 0.35})`;
    ctx.fill();
  }

  // ---- The level, and the move ------------------------------------------
  const bodyTop = y + headerH + h * 0.045;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#f2f7ff";
  const levelSize = Math.max(11, h * 0.135);
  ctx.font = `bold ${levelSize}px "MS Sans Serif", Tahoma, sans-serif`;
  const level = index.price === null ? "—" : index.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  ctx.fillText(level, x + pad, bodyTop + levelSize);

  // The arrow does the work colour alone cannot: red and green are the two
  // most commonly confused colours there are, and a chart that means the
  // opposite thing to some viewers is not a chart.
  const moveSize = Math.max(6, h * 0.07);
  ctx.font = `bold ${moveSize}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.fillStyle = tint.text;
  const arrow = flat ? "—" : up ? "▲" : "▼";
  const move =
    index.change === null
      ? ""
      : `${arrow} ${Math.abs(index.change).toFixed(2)}  ${index.changePercent >= 0 ? "+" : "−"}${Math.abs(index.changePercent).toFixed(2)}%`;
  ctx.fillText(move, x + pad, bodyTop + levelSize + moveSize * 1.35);

  // ---- The session's shape ----------------------------------------------
  // Scaled to the day's own range rather than to zero — an index that moved
  // 1.3% would be a dead flat line against a zero baseline, which says
  // "nothing happened" about a day when something did. The previous close is
  // drawn as the reference instead, so the line being above or below it is the
  // comparison that carries meaning.
  const chartTop = bodyTop + levelSize + moveSize * 1.9;
  const rowsTop = y + h * 0.6;
  const chartH = Math.max(h * 0.08, rowsTop - chartTop - h * 0.03);
  if (index.series?.length > 1) {
    drawSessionChart(ctx, x + pad, chartTop, w - pad * 2, chartH, index.series, index.previousClose, tint);
  }

  // ---- The board ---------------------------------------------------------
  const rows = (data.rows ?? []).slice(0, 6);
  if (rows.length) {
    const rowH = (y + h - rowsTop - h * 0.02) / rows.length;
    const nameW = w * 0.36;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const ry = rowsTop + rowH * (i + 0.5);

      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.font = `bold ${Math.max(5, rowH * 0.5)}px "Consolas", "Lucida Console", monospace`;
      ctx.fillStyle = "#dce8ff";
      ctx.fillText(row.symbol, x + pad, ry);

      if (row.failed) {
        // A ticker that did not come back says so in its own row. Leaving it
        // blank would read as "unchanged", which is a different claim.
        ctx.textAlign = "right";
        ctx.font = `${Math.max(4, rowH * 0.42)}px "MS Sans Serif", Tahoma, sans-serif`;
        ctx.fillStyle = "rgba(200,215,240,0.4)";
        ctx.fillText("no data", x + w - pad, ry);
        continue;
      }

      ctx.textAlign = "left";
      ctx.font = `${Math.max(4, rowH * 0.4)}px "MS Sans Serif", Tahoma, sans-serif`;
      ctx.fillStyle = "rgba(190,210,240,0.45)";
      ctx.fillText(ellipsize(ctx, row.name ?? "", nameW), x + pad + w * 0.115, ry);

      const rowUp = (row.change ?? 0) > 0;
      const rowFlat = !row.change;
      ctx.textAlign = "right";
      ctx.font = `${Math.max(5, rowH * 0.46)}px "Consolas", "Lucida Console", monospace`;
      ctx.fillStyle = "#e8f2ff";
      ctx.fillText(row.price === null ? "—" : row.price.toFixed(2), x + w - pad - w * 0.2, ry);

      ctx.fillStyle = (rowFlat ? MARKET.flat : rowUp ? MARKET.up : MARKET.down).text;
      ctx.fillText(
        row.changePercent === null
          ? ""
          : `${rowFlat ? "—" : rowUp ? "▲" : "▼"} ${Math.abs(row.changePercent).toFixed(2)}%`,
        x + w - pad,
        ry
      );
    }
  }
}
