import { ellipsize, wrapText, standby } from "./shared.js";

function countdown(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `in ${total}s`;
  const mins = Math.floor(total / 60);
  if (mins < 60) return `in ${mins}m ${String(total % 60).padStart(2, "0")}s`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h ${String(mins % 60).padStart(2, "0")}m`;
  const days = Math.floor(hours / 24);
  return `in ${days}d ${hours % 24}h`;
}

// -------------------------------------------------------------------------
// Channel 10: Agenda
//
// What Greg has been asked to remember, on his face. The only channel that
// touches no network at all — it reads the same store `list_reminders` reads,
// so the screen and the spoken answer can never disagree about what is set.
//
// The countdown is interpolated here rather than polled, the same way the
// now-playing progress bar is: the reading carries `dueAt`, and the rest is
// arithmetic. Polling once a second to animate a clock would be absurd.
// -------------------------------------------------------------------------

export function draw(ctx, x, y, w, h, view) {
  const back = ctx.createLinearGradient(x, y, x, y + h);
  back.addColorStop(0, "#161022");
  back.addColorStop(0.6, "#100b19");
  back.addColorStop(1, "#08060e");
  ctx.fillStyle = back;
  ctx.fillRect(x, y, w, h);

  const data = view.feed("agenda");
  const pad = w * 0.05;
  const headerH = h * 0.115;

  // ---- Ident, with the real clock ---------------------------------------
  const now = new Date();
  ctx.fillStyle = "rgba(255,255,255,0.07)";
  ctx.fillRect(x, y, w, headerH);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#d9b8ff";
  ctx.font = `bold ${Math.max(6, h * 0.055)}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.fillText(now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }).toUpperCase(), x + pad, y + headerH / 2);

  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(215,200,245,0.75)";
  ctx.font = `${Math.max(5, h * 0.052)}px "Consolas", "Lucida Console", monospace`;
  ctx.fillText(now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }), x + w - pad, y + headerH / 2);

  if (!data) {
    standby(ctx, x, y + headerH, w, h - headerH, { message: "…", detail: "" });
    return;
  }

  const items = data.items ?? [];
  if (!items.length) {
    standby(ctx, x, y + headerH, w, h - headerH, {
      message: "NOTHING SCHEDULED",
      detail: "ask him to remind you about something",
      tint: "rgba(217,184,255,0.5)",
    });
    return;
  }

  // ---- The next one, given the space it deserves -------------------------
  const next = items[0];
  const top = y + headerH + h * 0.05;

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#b98cff";
  ctx.font = `bold ${Math.max(5, h * 0.05)}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.fillText("NEXT", x + pad, top);

  const titleSize = Math.max(8, h * 0.088);
  ctx.font = `bold ${titleSize}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.fillStyle = "#f4f0ff";
  let at = top + titleSize * 1.25;
  for (const line of wrapText(ctx, next.text ?? "", w - pad * 2, 2)) {
    ctx.fillText(line, x + pad, at);
    at += titleSize * 1.16;
  }

  // The countdown, recomputed every frame from the timestamp — the poll only
  // has to catch a NEW item, not animate this one.
  const remaining = Math.max(0, (next.dueAt ?? 0) - Date.now());
  ctx.font = `${Math.max(6, h * 0.062)}px "Consolas", "Lucida Console", monospace`;
  ctx.fillStyle = remaining < 60000 ? "#ffb36b" : "#9fd0ff";
  const label = next.repeat
    ? `${next.dueAtLocal} · ${next.every}`
    : `${next.dueAtLocal} · ${countdown(remaining)}`;
  ctx.fillText(label, x + pad, at + h * 0.03);

  // ---- The rest ----------------------------------------------------------
  const rest = items.slice(1, 6);
  if (!rest.length) return;

  const listTop = Math.max(at + h * 0.09, y + h * 0.46);
  const rowH = Math.min(h * 0.1, (y + h - listTop - h * 0.03) / rest.length);

  for (let i = 0; i < rest.length; i++) {
    const item = rest[i];
    const ry = listTop + rowH * (i + 0.5);

    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.font = `${Math.max(5, rowH * 0.42)}px "MS Sans Serif", Tahoma, sans-serif`;
    ctx.fillStyle = "rgba(240,235,255,0.88)";
    // Reserve the right-hand column for the time, or a long reminder runs
    // straight through it.
    ctx.fillText(ellipsize(ctx, item.text ?? "", w - pad * 2 - w * 0.3), x + pad, ry);

    ctx.textAlign = "right";
    ctx.font = `${Math.max(4, rowH * 0.38)}px "Consolas", "Lucida Console", monospace`;
    ctx.fillStyle = "rgba(190,175,225,0.65)";
    // "today" is the default case and saying it on every row is noise; the
    // day only earns its place when it is NOT today.
    const when = item.repeat ? item.every : item.when === "today" ? item.dueAtLocal : `${item.when} ${item.dueAtLocal}`;
    ctx.fillText(ellipsize(ctx, when ?? "", w * 0.3), x + w - pad, ry);

    if (i) {
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = Math.max(1, h * 0.002);
      ctx.beginPath();
      ctx.moveTo(x + pad, listTop + rowH * i);
      ctx.lineTo(x + w - pad, listTop + rowH * i);
      ctx.stroke();
    }
  }

  if (items.length > 6) {
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(190,175,225,0.5)";
    ctx.font = `${Math.max(4, h * 0.04)}px "MS Sans Serif", Tahoma, sans-serif`;
    ctx.fillText(`+${items.length - 6} more`, x + w - pad, y + h - h * 0.02);
  }
}
