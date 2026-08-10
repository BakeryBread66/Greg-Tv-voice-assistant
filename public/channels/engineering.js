import { ellipsize, standby } from "./shared.js";

// ---------------------------------------------------------------------------
// Engineering
//
// What the machine is doing, on the set that is running on it.
//
// Built as meters rather than a table of figures, and that is a size decision
// rather than a stylistic one: this picture is ~312px wide in the smallest
// window the CSS allows, where a dense readout becomes unreadable long before a
// bar does. The numbers are printed beside every bar anyway — colour is never
// the only signal here, the same rule the markets channel follows, because red
// and green are the two most commonly confused colours there are.
//
// The resident-model list at the bottom is the part that earns the channel. VRAM
// is this project's binding resource: brain, eyes, ears and cloned voice all
// want the same card, and gaming mode exists to hand 11 GB of it back.
// ---------------------------------------------------------------------------

const LABEL = "#9fb4c8";
const VALUE = "#e8f0f8";

// Thresholds are for the BAR COLOUR only — nothing is hidden or emphasised on
// the strength of them, so a badly chosen number costs a shade and never a fact.
function meterColour(pct) {
  if (pct === null) return "#5a6b7a";
  if (pct >= 90) return "#ff5b4a";
  if (pct >= 70) return "#ffb020";
  return "#49d17a";
}

/**
 * One labelled meter.
 *
 * `text` is what goes on the right — always the real figures, never a repeat of
 * the percentage, so the bar and the text carry different information.
 */
function meter(ctx, x, y, w, h, { label, pct, text }) {
  // The value column has to fit "14.2/24.0 GB" without ellipsizing — at 0.34 it
  // came out as "14.2 / 24.0…", which is a meter that has hidden the number it
  // exists to show. Widened, and the strings below dropped the spaces around
  // the slash rather than trusting the column to be generous.
  const labelW = w * 0.18;
  const textW = w * 0.40;
  const barX = x + labelW;
  const barW = w - labelW - textW;

  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = LABEL;
  ctx.font = `${h * 0.78}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.fillText(label, x, y + h / 2);

  // The trough, so an empty meter still reads as a meter rather than as nothing.
  ctx.fillStyle = "rgba(255,255,255,0.09)";
  ctx.fillRect(barX, y + h * 0.22, barW, h * 0.56);

  if (pct !== null) {
    ctx.fillStyle = meterColour(pct);
    ctx.fillRect(barX, y + h * 0.22, barW * Math.max(0, Math.min(1, pct / 100)), h * 0.56);
  } else {
    // "Not reported" is a fact and must not look like zero — nvidia-smi answers
    // "[N/A]" for anything the driver does not expose.
    ctx.fillStyle = LABEL;
    ctx.font = `${h * 0.62}px "MS Sans Serif", Tahoma, sans-serif`;
    ctx.fillText("not reported", barX + h * 0.3, y + h / 2);
  }

  ctx.textAlign = "right";
  ctx.fillStyle = VALUE;
  ctx.font = `${h * 0.78}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.fillText(ellipsize(ctx, text, textW * 0.92), x + w, y + h / 2);
  ctx.textAlign = "left";
}

const round = (n, places = 0) => (n === null || n === undefined ? null : Number(n.toFixed(places)));

export function draw(ctx, x, y, w, h, view) {
  const data = view.feed("engineering");

  if (!data) {
    standby(ctx, x, y, w, h, { message: "ENGINEERING", detail: "Reading the machine…" });
    return;
  }
  if (data.error) {
    standby(ctx, x, y, w, h, { message: "ENGINEERING", detail: data.error });
    return;
  }

  ctx.fillStyle = "#050a10";
  ctx.fillRect(x, y, w, h);

  const pad = w * 0.05;
  const left = x + pad;
  const inner = w - pad * 2;
  const rowH = h * 0.093;

  // ---- Header -------------------------------------------------------------
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = VALUE;
  ctx.font = `bold ${h * 0.075}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.fillText("ENGINEERING", left, y + h * 0.075);

  ctx.textAlign = "right";
  ctx.fillStyle = LABEL;
  ctx.font = `${h * 0.058}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.fillText(ellipsize(ctx, data.gpu?.name ?? "no GPU", inner * 0.56), x + w - pad, y + h * 0.078);
  ctx.textAlign = "left";

  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = Math.max(1, h * 0.004);
  ctx.beginPath();
  ctx.moveTo(left, y + h * 0.125);
  ctx.lineTo(x + w - pad, y + h * 0.125);
  ctx.stroke();

  // ---- Meters -------------------------------------------------------------
  let row = y + h * 0.155;

  if (data.gpu) {
    const vramPct =
      data.gpu.vramTotalMiB ? (data.gpu.vramUsedMiB / data.gpu.vramTotalMiB) * 100 : null;

    meter(ctx, left, row, inner, rowH, {
      label: "GPU",
      pct: data.gpu.utilPct,
      text: data.gpu.utilPct === null ? "—" : `${round(data.gpu.utilPct)}%`,
    });
    row += rowH * 1.15;

    meter(ctx, left, row, inner, rowH, {
      label: "VRAM",
      pct: vramPct,
      text:
        data.gpu.vramTotalMiB === null
          ? "—"
          : `${(data.gpu.vramUsedMiB / 1024).toFixed(1)}/${(data.gpu.vramTotalMiB / 1024).toFixed(1)} GB`,
    });
    row += rowH * 1.15;
  } else {
    // No card is a fact, not a fault — the same call as the radar channel
    // outside its coverage. It says so and carries on with the rest.
    ctx.fillStyle = LABEL;
    ctx.font = `${h * 0.062}px "MS Sans Serif", Tahoma, sans-serif`;
    ctx.fillText(ellipsize(ctx, data.gpuNote ?? "No GPU reading", inner), left, row + rowH * 0.5);
    row += rowH * 1.3;
  }

  meter(ctx, left, row, inner, rowH, {
    label: "CPU",
    pct: data.cpu?.busyPct ?? null,
    text: data.cpu?.busyPct === null ? "—" : `${round(data.cpu.busyPct)}%  ${data.cpu?.threads ?? "?"}T`,
  });
  row += rowH * 1.15;

  meter(ctx, left, row, inner, rowH, {
    label: "RAM",
    pct: data.memory?.totalGB ? (data.memory.usedGB / data.memory.totalGB) * 100 : null,
    text: data.memory?.totalGB
      ? `${data.memory.usedGB.toFixed(1)}/${data.memory.totalGB.toFixed(0)} GB`
      : "—",
  });
  row += rowH * 1.35;

  // ---- The strip of things a bar cannot say -------------------------------
  if (data.gpu) {
    const cells = [
      ["TEMP", data.gpu.tempC === null ? "—" : `${round(data.gpu.tempC)}°C`],
      ["POWER", data.gpu.powerW === null ? "—" : `${round(data.gpu.powerW)}W`],
      ["FAN", data.gpu.fanPct === null ? "—" : `${round(data.gpu.fanPct)}%`],
      ["CLOCK", data.gpu.clockMHz === null ? "—" : `${round(data.gpu.clockMHz)}MHz`],
    ];
    const cellW = inner / cells.length;
    for (const [i, [label, value]] of cells.entries()) {
      const cx = left + cellW * (i + 0.5);
      ctx.textAlign = "center";
      ctx.fillStyle = LABEL;
      ctx.font = `${h * 0.045}px "MS Sans Serif", Tahoma, sans-serif`;
      ctx.fillText(label, cx, row);
      ctx.fillStyle = VALUE;
      ctx.font = `bold ${h * 0.062}px "MS Sans Serif", Tahoma, sans-serif`;
      ctx.fillText(value, cx, row + h * 0.062);
    }
    ctx.textAlign = "left";
    row += h * 0.115;
  }

  // ---- What is actually on the card ---------------------------------------
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.beginPath();
  ctx.moveTo(left, row);
  ctx.lineTo(x + w - pad, row);
  ctx.stroke();
  row += h * 0.045;

  ctx.fillStyle = LABEL;
  ctx.font = `${h * 0.048}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.fillText("MODELS RESIDENT", left, row);
  row += h * 0.055;

  if (data.models === null) {
    // Could not ask, which is NOT the same as nothing being loaded. Collapsing
    // the two would put "no models" on screen while Ollama was busy — the same
    // shape as an empty alert list meaning both "checked, clear" and "never
    // checked", which this project has already been caught by once.
    ctx.fillStyle = "#ffb020";
    ctx.font = `${h * 0.055}px "MS Sans Serif", Tahoma, sans-serif`;
    ctx.fillText(ellipsize(ctx, data.modelsNote ?? "Could not ask Ollama", inner), left, row);
  } else if (!data.models.length) {
    ctx.fillStyle = LABEL;
    ctx.font = `${h * 0.055}px "MS Sans Serif", Tahoma, sans-serif`;
    // "the card is free" is nonsense on a machine that has no card — the
    // reassurance only means something when there is something to be free.
    ctx.fillText(data.gpu ? "nothing loaded — the card is free" : "nothing loaded", left, row);
  } else {
    ctx.font = `${h * 0.055}px "MS Sans Serif", Tahoma, sans-serif`;
    for (const model of data.models.slice(0, 3)) {
      ctx.textAlign = "left";
      ctx.fillStyle = VALUE;
      ctx.fillText(ellipsize(ctx, model.name, inner * 0.62), left, row);
      ctx.textAlign = "right";
      ctx.fillStyle = LABEL;
      ctx.fillText(`${(model.vramMiB / 1024).toFixed(1)} GB`, x + w - pad, row);
      row += h * 0.062;
    }
    ctx.textAlign = "left";
  }
}
