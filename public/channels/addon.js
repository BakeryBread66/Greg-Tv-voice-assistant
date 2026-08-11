// The renderer an add-on channel gets when it does not bring its own.
//
// Most feeds are a handful of labelled values, and requiring JavaScript to show
// them would put the whole feature behind knowing how to draw on a canvas. A
// `display` block in channel.json covers that case with no code at all:
//
//   "display": {
//     "big":  { "path": "temperature", "suffix": "°" },
//     "rows": [ { "label": "Wind", "path": "wind.speed", "suffix": " mph" } ],
//     "foot": { "path": "station" }
//   }
//
// Anything more interesting than that wants a render.js, and gets one.
//
// Every value is looked up by path and formatted defensively: a feed that
// changes shape shows "—" rather than "undefined", because a channel printing
// the word undefined reads as broken code, while a dash reads as a feed that
// did not send that field — which is the true statement.

import { standby, ellipsize } from "./shared.js";

/** Walk a dotted path, tolerating anything missing on the way down. */
export function valueAt(data, dotted) {
  if (!dotted) return undefined;
  let value = data;
  for (const key of String(dotted).split(".")) {
    if (value === null || value === undefined) return undefined;
    // Numeric keys index arrays, so "periods.0.name" works on a forecast.
    value = value[key];
  }
  return value;
}

/**
 * A value as it should appear on a television.
 *
 * Absence is a dash, not "undefined" and not zero — the distinction this
 * project keeps relearning. Numbers are rounded to something a person would
 * read at a glance rather than printed to fifteen decimal places.
 */
export function format(value, { prefix = "", suffix = "", decimals = null } = {}) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "object") return "—";
  const n = Number(value);
  if (typeof value === "number" || (value !== "" && Number.isFinite(n))) {
    const places = decimals ?? (Math.abs(n) >= 100 || Number.isInteger(n) ? 0 : 1);
    return `${prefix}${n.toFixed(places)}${suffix}`;
  }
  return `${prefix}${value}${suffix}`;
}

export function draw(ctx, x, y, w, h, view, channel) {
  const wrapper = view.feed(channel.id);
  if (!wrapper) return standby(ctx, x, y, w, h, { message: channel.name.toUpperCase(), detail: "waiting for the feed" });
  if (wrapper.error) return standby(ctx, x, y, w, h, { message: channel.name.toUpperCase(), detail: wrapper.error });

  // addonLoader() wraps the payload as { data, place }, so `display` paths are
  // written against the feed's own shape rather than against our envelope.
  const data = wrapper.data ?? wrapper;
  const display = channel.display ?? {};

  ctx.fillStyle = "#0a0d14";
  ctx.fillRect(x, y, w, h);

  const pad = w * 0.06;

  // ---- Ident, the same strip every other channel wears --------------------
  const headerH = h * 0.11;
  ctx.fillStyle = "rgba(160,190,255,0.10)";
  ctx.fillRect(x, y, w, headerH);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#dbe6f5";
  ctx.font = `bold ${Math.max(6, h * 0.052)}px "MS Sans Serif", Tahoma, sans-serif`;
  const town = String(wrapper.place ?? "").split(",")[0];
  const ident = town ? `${channel.name.toUpperCase()} · ${town.toUpperCase()}` : channel.name.toUpperCase();
  ctx.fillText(ellipsize(ctx, ident, w * 0.7), x + pad, y + headerH / 2);

  let top = y + headerH + h * 0.05;

  // ---- The one big number, if the channel named one ------------------------
  if (display.big?.path) {
    const figure = h * 0.26;
    ctx.font = `bold ${figure}px "MS Sans Serif", Tahoma, sans-serif`;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#eaf1ff";
    const shown = format(valueAt(data, display.big.path), display.big);
    ctx.fillText(ellipsize(ctx, shown, w - pad * 2), x + pad, top + figure);
    // The clearance is taken from where the label actually ENDS, not from where
    // it starts. The first version advanced by less than the label's own height
    // and the first row printed straight through it — the same mistake the
    // weather channel made when "OVERNIGHT" ran through the feels-like line, and
    // caught the same way: by rendering it and looking.
    const labelSize = Math.max(6, h * 0.055);
    if (display.big.label) {
      ctx.font = `${labelSize}px "MS Sans Serif", Tahoma, sans-serif`;
      ctx.fillStyle = "#8ea0ba";
      ctx.fillText(ellipsize(ctx, display.big.label, w - pad * 2), x + pad, top + figure + labelSize * 1.3);
      top += labelSize * 1.6;
    }
    top += figure + h * 0.07;
  }

  // ---- Rows ---------------------------------------------------------------
  const rows = Array.isArray(display.rows) ? display.rows.slice(0, 6) : [];
  const size = Math.max(7, h * 0.066);
  const lineH = size * 1.5;
  ctx.font = `${size}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.textBaseline = "middle";

  for (const row of rows) {
    if (top + lineH > y + h - pad) break; // never draw off the bottom
    ctx.textAlign = "left";
    ctx.fillStyle = "#8f9dc6";
    ctx.fillText(ellipsize(ctx, String(row.label ?? ""), w * 0.4), x + pad, top);
    ctx.fillStyle = "#eef2ff";
    ctx.fillText(ellipsize(ctx, format(valueAt(data, row.path), row), w * 0.45), x + pad + w * 0.42, top);
    top += lineH;
  }

  // Nothing configured at all: say so rather than showing an empty screen,
  // which is indistinguishable from a broken channel.
  if (!display.big?.path && !rows.length) {
    ctx.textAlign = "center";
    ctx.fillStyle = "#7f8ea6";
    // Two short lines rather than one long one, and both measured. The first
    // version was a single sentence that ran off BOTH edges of the picture at
    // 820 — a message about a misconfigured channel which is itself the thing
    // on screen that looks broken.
    const size = Math.max(6, h * 0.06);
    ctx.font = `${size}px "MS Sans Serif", Tahoma, sans-serif`;
    ctx.fillText(ellipsize(ctx, "Feed loaded, nothing to show.", w - pad * 2), x + w / 2, y + h / 2 - size * 0.8);
    ctx.fillStyle = "#5f6d82";
    ctx.fillText(ellipsize(ctx, 'Add a "display" block to channel.json', w - pad * 2), x + w / 2, y + h / 2 + size * 0.8);
  }

  if (display.foot?.path) {
    ctx.textAlign = "left";
    ctx.fillStyle = "#6c7a90";
    ctx.font = `${Math.max(6, h * 0.05)}px "MS Sans Serif", Tahoma, sans-serif`;
    ctx.fillText(ellipsize(ctx, format(valueAt(data, display.foot.path), display.foot), w - pad * 2), x + pad, y + h - pad * 0.8);
  }
}
