// Tuning the nod, by someone who can see it.
//
// This panel is the single most-repeated unheeded instruction in CLAUDE.md.
// Six rounds of tuning went into the beat-driven nod across one session, every
// judgement round-tripping through the user, because the assistant doing the
// tuning can neither see nor hear the result — and three separate sessions then
// wrote down the same conclusion: **build the sliders first.**
//
// So: every number the nod depends on, live, with the measured output beside it.
//
// The readout matters as much as the sliders. The nod was invisible for three
// rounds because it peaked at 1.6-3.1 px against an idle float of 2.8-5.4 px
// that never stops — nobody had measured the output, so three rounds of detector
// work fed a motion nothing could have shown. NOD PEAK and IDLE FLOAT are that
// number and the thing it competes with, side by side. If the first is not
// comfortably bigger than the second, no amount of detector tuning will help.
//
// Open it with ?nod on the address, the same way ?mic opens the microphone
// readout. Off unless asked for.

const FIELDS = [
  { key: "depth", label: "Nod depth", min: 0.2, max: 6, step: 0.1,
    hint: "Spring position to pixels. The one to move FIRST — see NOD PEAK." },
  { key: "stiffness", label: "Stiffness", min: 60, max: 900, step: 10,
    hint: "Ring period. Too low and it resonates with the beat." },
  { key: "damping", label: "Damping", min: 4, max: 80, step: 1,
    hint: "0.85 of critical at 400/34: one reversal, settled in 0.23 s." },
  { key: "kick", label: "Kick", min: 0.2, max: 8, step: 0.1,
    hint: "Impulse per beat." },
  { key: "kickScale", label: "Loud-hit kick", min: 0, max: 8, step: 0.1,
    hint: "Extra impulse from a loud beat." },
  { key: "tilt", label: "Tilt", min: 0, max: 2, step: 0.05,
    hint: "Counter-rotation, so it reads as a nod rather than a lift." },
  { key: "onsetRatio", label: "Onset ratio", min: 1.1, max: 5, step: 0.05,
    hint: "Flux over its running mean. Lower = more onsets." },
  { key: "onsetFloor", label: "Onset floor", min: 0.001, max: 0.08, step: 0.001,
    hint: "Absolute floor, so quiet passages don't fire on a ripple." },
  { key: "gridEnter", label: "Grid enter", min: 1.2, max: 6, step: 0.1,
    hint: "Confidence needed to trust a tempo. Real music 3.5-6.2, noise 1.4-1.9." },
  { key: "gridStay", label: "Grid stay", min: 1.0, max: 6, step: 0.1,
    hint: "And to keep trusting it. Below Grid enter, or he flips mid-track." },
];

const CSS = `
.nod-panel {
  position: fixed; right: 10px; top: 10px; z-index: 60;
  width: 268px; max-height: calc(100vh - 20px);
  display: flex; flex-direction: column;
  background: var(--face); padding: 3px; border: 2px solid;
  border-color: var(--face-light) var(--dark) var(--dark) var(--face-light);
  box-shadow: inset 1px 1px 0 var(--white), inset -1px -1px 0 var(--shadow), 3px 3px 0 rgba(0,0,0,0.35);
  font-size: 11px;
}
.nod-panel .nod-title {
  height: 18px; display: flex; align-items: center; justify-content: space-between;
  padding: 0 4px; background: linear-gradient(90deg, var(--title-a), var(--title-b));
  color: var(--white); font-weight: bold; cursor: default;
}
.nod-panel .nod-body { padding: 6px; overflow-y: auto; }
.nod-readout {
  display: grid; grid-template-columns: auto auto; gap: 1px 8px;
  padding: 5px 6px; margin-bottom: 6px;
  background: #000; color: #4dff88; font-family: "Consolas", "Lucida Console", monospace;
  border: 2px solid; border-color: var(--dark) var(--face-light) var(--face-light) var(--dark);
}
.nod-readout span:nth-child(even) { text-align: right; }
.nod-readout .warn { color: #ffcc33; }
.nod-beat {
  height: 10px; margin-bottom: 6px; background: #101010;
  border: 2px solid; border-color: var(--dark) var(--face-light) var(--face-light) var(--dark);
}
.nod-beat.hit { background: #4dff88; }
.nod-row { margin-bottom: 5px; }
.nod-row label { display: flex; justify-content: space-between; gap: 6px; }
.nod-row input { width: 100%; margin: 1px 0 0; }
.nod-row .nod-hint { color: #444; display: block; line-height: 1.3; }
.nod-actions { display: flex; gap: 5px; margin-top: 4px; }
.nod-actions .btn { flex: 1; }
`;

/**
 * @param {object} face   the renderer — must expose nodTuning and nodDebug()
 * @returns {() => void}  a teardown, so a face swap doesn't leave a dead panel
 */
export function initNodPanel(face) {
  // Guarded rather than assumed: only the television has a nod, and opening
  // ?nod against the 2D or 3D fallback must not throw at page level.
  if (!face?.nodTuning || typeof face.nodDebug !== "function") {
    console.warn("[nod] this face has no nod to tune");
    return () => {};
  }

  const defaults = { ...face.nodTuning };

  // Tuning survives a reload, because it will not be done in one sitting and
  // losing an hour of slider-nudging to a refresh is the fastest way to make
  // someone stop bothering. Deliberately localStorage rather than config.json:
  // these are a working set, not a setting, and they only become real when
  // somebody presses Copy values and pastes them into face-tv.js.
  const SAVED = "greg.nodTuning";
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED) ?? "null");
    // Key by key, so a stored blob from an older version cannot introduce a
    // field the renderer no longer reads or drop one it does.
    if (saved) {
      for (const key of Object.keys(defaults)) {
        if (typeof saved[key] === "number" && Number.isFinite(saved[key])) face.nodTuning[key] = saved[key];
      }
      console.log("[nod] restored saved tuning — press Reset for the shipped values");
    }
  } catch {
    /* a corrupt entry is not worth failing the panel over */
  }

  const persist = () => {
    try {
      localStorage.setItem(SAVED, JSON.stringify(face.nodTuning));
    } catch {
      /* private mode, or a full quota — the sliders still work */
    }
  };

  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  const panel = document.createElement("div");
  panel.className = "nod-panel";
  panel.innerHTML = `
    <div class="nod-title"><span>Nod tuning</span><span class="nod-close" role="button" title="Close">&#10005;</span></div>
    <div class="nod-body">
      <div class="nod-beat"></div>
      <div class="nod-readout"></div>
      <div class="nod-fields"></div>
      <div class="nod-actions">
        <button class="btn nod-reset" type="button">Reset</button>
        <button class="btn nod-copy" type="button">Copy values</button>
      </div>
    </div>`;
  document.body.appendChild(panel);

  const fieldsEl = panel.querySelector(".nod-fields");
  const readoutEl = panel.querySelector(".nod-readout");
  const beatEl = panel.querySelector(".nod-beat");
  const inputs = new Map();

  for (const field of FIELDS) {
    const row = document.createElement("div");
    row.className = "nod-row";
    row.innerHTML = `
      <label><span>${field.label}</span><b class="nod-value"></b></label>
      <input type="range" min="${field.min}" max="${field.max}" step="${field.step}">
      <small class="nod-hint">${field.hint}</small>`;

    const input = row.querySelector("input");
    const value = row.querySelector(".nod-value");
    input.value = face.nodTuning[field.key];
    value.textContent = format(face.nodTuning[field.key]);

    input.addEventListener("input", () => {
      // Written straight into the live object — no apply button, because the
      // whole point is watching the change while the music plays.
      face.nodTuning[field.key] = Number(input.value);
      value.textContent = format(Number(input.value));
      persist();
    });

    fieldsEl.appendChild(row);
    inputs.set(field.key, { input, value });
  }

  const syncInputs = () => {
    for (const [key, { input, value }] of inputs) {
      input.value = face.nodTuning[key];
      value.textContent = format(face.nodTuning[key]);
    }
  };

  panel.querySelector(".nod-reset").addEventListener("click", () => {
    Object.assign(face.nodTuning, defaults);
    syncInputs();
    try { localStorage.removeItem(SAVED); } catch { /* nothing to clear */ }
  });

  // The point of the panel is to end up with NUMBERS that can be pasted into
  // face-tv.js. Anything else and the tuning dies with the tab.
  panel.querySelector(".nod-copy").addEventListener("click", async () => {
    const text = JSON.stringify(face.nodTuning, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      flash(panel.querySelector(".nod-copy"), "Copied");
    } catch {
      // Clipboard needs a permission that may not be there. The console always
      // works, and losing the numbers is the one unacceptable outcome.
      console.log("[nod] tuning:", text);
      flash(panel.querySelector(".nod-copy"), "In console");
    }
  });

  let lastBeats = 0;
  let beatUntil = 0;

  const tick = () => {
    const d = face.nodDebug();

    if (d.beatsSeen !== lastBeats) {
      lastBeats = d.beatsSeen;
      beatUntil = performance.now() + 90;
    }
    beatEl.classList.toggle("hit", performance.now() < beatUntil);

    // NOD PEAK against IDLE FLOAT is the comparison that was missing for three
    // rounds, so it is first and it is called out when it is losing.
    const tooSmall = d.nodPeakPx > 0 && d.nodPeakPx < d.idleFloatPx * 1.5;
    readoutEl.innerHTML = [
      ["NOD PEAK", `${d.nodPeakPx.toFixed(1)} px`, tooSmall],
      ["IDLE FLOAT", `${d.idleFloatPx.toFixed(1)} px`, false],
      ["TEMPO", d.bpm ? `${d.bpm.toFixed(1)} bpm` : "—", false],
      ["CONFIDENCE", d.confidence.toFixed(2), false],
      ["MODE", d.onGrid ? "grid" : "onset", false],
      ["ONSETS/MIN", d.onsetsPerMin.toFixed(0), false],
      ["BEATS", String(d.beatsSeen), false],
      ["AUDIO", d.listening ? "yes" : "no music", !d.listening],
    ]
      .map(([k, v, warn]) => `<span>${k}</span><span class="${warn ? "warn" : ""}">${v}</span>`)
      .join("");

    raf = requestAnimationFrame(tick);
  };
  let raf = requestAnimationFrame(tick);

  const close = () => {
    cancelAnimationFrame(raf);
    panel.remove();
    style.remove();
  };
  panel.querySelector(".nod-close").addEventListener("click", close);

  console.log("[nod] panel open — click 🎵 and share system audio to feed it");
  return close;
}

function format(value) {
  return Math.abs(value) < 1 ? value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "") : String(value);
}

function flash(button, text) {
  const was = button.textContent;
  button.textContent = text;
  setTimeout(() => {
    button.textContent = was;
  }, 1200);
}
