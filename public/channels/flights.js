import { ellipsize, standby } from "./shared.js";

// ---------------------------------------------------------------------------
// Flights
// ---------------------------------------------------------------------------

// Green phosphor, because this is the one channel drawn entirely from numbers
// rather than from somebody else's picture — so it can look like a radar scope
// without having to agree with anybody's palette.
const PHOSPHOR = {
  bright: "#78ffaa",
  dim: "rgba(120,255,170,0.55)",
  grid: "rgba(120,255,170,0.22)",
};

export function drawAircraftMark(ctx, x, y, size, heading, altitudeFt) {
  // 0 ft to about cruise. Clamped rather than scaled to the highest in view, or
  // a quiet sky of light aircraft would render as bright as an airliner.
  const high = Math.max(0, Math.min(1, (altitudeFt ?? 0) / 38000));
  ctx.save();
  ctx.translate(x, y);
  // Canvas rotation is clockwise from the +x axis and headings are clockwise
  // from north, which is -y. The triangle below is drawn nose-up, so the
  // rotation is the heading exactly — no offset, and getting that wrong points
  // every aircraft ninety degrees off in a way that still looks plausible.
  ctx.rotate((heading ?? 0) * (Math.PI / 180));
  ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.lineTo(size * 0.62, size * 0.72);
  ctx.lineTo(0, size * 0.34);
  ctx.lineTo(-size * 0.62, size * 0.72);
  ctx.closePath();
  ctx.fillStyle = `rgba(${Math.round(140 + high * 115)},255,${Math.round(180 + high * 60)},${0.5 + high * 0.5})`;
  ctx.fill();
  ctx.restore();
}

// -------------------------------------------------------------------------
// Channel 9: Flights
//
// A plan-position indicator — the user at the centre, aircraft plotted around
// them, north up. This is the one channel drawn entirely from numbers rather
// than from somebody else's picture, which is why it gets to be green
// phosphor: it costs nothing, it is unmistakably a radar scope, and it does
// not have to agree with anyone else's colour scheme.
//
// The positions arrive as kilometres north and east of the user, already
// projected in lib/overhead.js. Doing the spherical geometry there rather than
// here means the latitude correction happens once, in a place it can be tested
// without a canvas.
// -------------------------------------------------------------------------

export function draw(ctx, x, y, w, h, view) {
  ctx.fillStyle = "#02100a";
  ctx.fillRect(x, y, w, h);

  const data = view.feed("flights");
  if (!data || data.error) {
    standby(ctx, x, y, w, h, {
      message: data?.error ? "NO SIGNAL" : "SCANNING",
      detail: data?.error ?? "asking who is up there",
      tint: "rgba(120,255,170,0.55)",
    });
    return;
  }

  const pad = w * 0.035;
  const headerH = h * 0.11;

  // ---- Ident ------------------------------------------------------------
  ctx.fillStyle = "rgba(120,255,170,0.08)";
  ctx.fillRect(x, y, w, headerH);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = PHOSPHOR.bright;
  ctx.font = `bold ${Math.max(6, h * 0.052)}px "MS Sans Serif", Tahoma, sans-serif`;
  // The city only. `place` is "Chapel Hill, North Carolina" — the full form is
  // right for the spoken sentence and too long for an ident strip, where it
  // truncated to "CHAPEL HILL, NORTH…" and read as a rendering fault.
  const town = String(data.place || "").split(",")[0];
  ctx.fillText(ellipsize(ctx, `FLIGHTS · ${town.toUpperCase()}`, w * 0.6), x + pad, y + headerH / 2);

  ctx.textAlign = "right";
  ctx.fillStyle = PHOSPHOR.dim;
  ctx.font = `${Math.max(5, h * 0.046)}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.fillText(`${data.count} IN RANGE`, x + w - pad, y + headerH / 2);

  // ---- The scope ---------------------------------------------------------
  // Square area on the left; the list takes the rest. The picture is wider
  // than it is tall, so a centred circle would leave two dead columns.
  const scopeTop = y + headerH + h * 0.02;
  const scopeH = h - headerH - h * 0.05;
  const radius = Math.min(scopeH / 2, w * 0.28);
  const cx = x + pad + radius;
  const cy = scopeTop + scopeH / 2;

  ctx.save();
  ctx.strokeStyle = PHOSPHOR.grid;
  ctx.lineWidth = Math.max(1, radius * 0.012);

  for (const fraction of [1 / 3, 2 / 3, 1]) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius * fraction, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(cx - radius, cy);
  ctx.lineTo(cx + radius, cy);
  ctx.moveTo(cx, cy - radius);
  ctx.lineTo(cx, cy + radius);
  ctx.stroke();

  // The sweep. Pure decoration — the data arrives all at once, not by
  // rotation — but it is the single thing that makes a circle read as a radar
  // scope rather than as a pie chart, and it costs one gradient.
  const sweep = (view.time * 0.9) % (Math.PI * 2);
  const trail = ctx.createConicGradient ? ctx.createConicGradient(sweep - 0.6, cx, cy) : null;
  if (trail) {
    trail.addColorStop(0, "rgba(120,255,170,0)");
    trail.addColorStop(0.09, "rgba(120,255,170,0.18)");
    trail.addColorStop(0.1, "rgba(120,255,170,0)");
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = trail;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    ctx.restore();
  }
  ctx.strokeStyle = "rgba(120,255,170,0.5)";
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(sweep) * radius, cy + Math.sin(sweep) * radius);
  ctx.stroke();

  // Compass letters, so "north up" is stated rather than assumed.
  ctx.fillStyle = PHOSPHOR.dim;
  ctx.font = `${Math.max(4, radius * 0.14)}px "MS Sans Serif", Tahoma, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("N", cx, cy - radius - radius * 0.11);
  ctx.fillText("S", cx, cy + radius + radius * 0.11);
  ctx.fillText("E", cx + radius + radius * 0.11, cy);
  ctx.fillText("W", cx - radius - radius * 0.11, cy);
  ctx.restore();

  // ---- The aircraft ------------------------------------------------------
  const perKm = radius / Math.max(1, data.rangeKm);
  for (const plane of data.aircraft ?? []) {
    // North is UP, so a positive north offset is a negative y.
    const px = cx + plane.east * perKm;
    const py = cy - plane.north * perKm;
    drawAircraftMark(ctx, px, py, Math.max(2, radius * 0.05), plane.heading, plane.altitudeFt);
  }

  // The user, at the centre, drawn last so nothing sits on top of it.
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(1.5, radius * 0.028), 0, Math.PI * 2);
  ctx.fill();

  // ---- The list ----------------------------------------------------------
  // Clear of the "E" compass letter, which sits at radius * 1.11 — the first
  // version used a flat fraction of the picture width and the list ran
  // straight through it, because the two were measured from different things.
  // Derived from the scope now, so they cannot drift apart.
  const listX = cx + radius * 1.11 + Math.max(w * 0.035, radius * 0.14);
  const listW = x + w - pad - listX;
  if (listW > w * 0.2) {
    const rows = (data.aircraft ?? []).slice(0, 7);
    const rowH = Math.min(h * 0.085, (h - headerH - h * 0.1) / Math.max(1, rows.length));
    let at = scopeTop + h * 0.02;

    if (!rows.length) {
      ctx.textAlign = "left";
      ctx.fillStyle = PHOSPHOR.dim;
      ctx.font = `${Math.max(5, h * 0.05)}px "MS Sans Serif", Tahoma, sans-serif`;
      ctx.fillText("nothing in range", listX, at + rowH);
    }

    for (const plane of rows) {
      const overhead = plane.km <= 12;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.font = `${Math.max(5, rowH * 0.42)}px "Consolas", "Lucida Console", monospace`;
      ctx.fillStyle = overhead ? "#ffffff" : PHOSPHOR.bright;
      ctx.fillText(plane.callsign, listX, at + rowH * 0.32);

      ctx.font = `${Math.max(4, rowH * 0.34)}px "MS Sans Serif", Tahoma, sans-serif`;
      ctx.fillStyle = PHOSPHOR.dim;
      // Altitude and distance are the two numbers that answer "what is that
      // one" — the heading is on the mark itself and does not need saying.
      ctx.fillText(
        `${plane.altitudeFt.toLocaleString("en-US")} ft · ${plane.miles} mi ${plane.compass}`,
        listX,
        at + rowH * 0.72
      );

      if (overhead) {
        ctx.textAlign = "right";
        ctx.fillStyle = "#ffffff";
        ctx.font = `bold ${Math.max(4, rowH * 0.32)}px "MS Sans Serif", Tahoma, sans-serif`;
        ctx.fillText("OVERHEAD", x + w - pad, at + rowH * 0.32);
      }

      at += rowH;
    }
  }
}
