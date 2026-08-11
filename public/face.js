// Picks how to draw Greg's face.
//
// The television is the real one: a floating CRT head showing SMPTE colour bars,
// with the picture itself carrying his expression. If it cannot be loaded, the
// reduced face below takes over — it is deliberately not another renderer in
// another file, for the reason set out at MinimalFace.
//
// Whatever is chosen must implement the same four methods: setState, setLevel,
// setSpectrum and start. That interface is the entire contract between the face
// and everything else, which is what made swapping the helmet for a television
// a change to this file and one new one, rather than a rewrite. Everything a
// face can do BEYOND those four — playBoot, setChannel, hitTest, setVolume and
// the rest — is called with `?.`, so a renderer that does not offer them is
// simply never asked. Verified rather than assumed: of the sixteen methods
// voice.js calls on the face, only those four are called directly.

// Put the reason on screen. A face that silently fails to appear is the hardest
// kind of bug to report, and "it doesn't show up" is all anyone can tell you.
/**
 * A module that could not be FETCHED, as against one that loaded and threw.
 *
 * These are different faults with different fixes and they must not read the
 * same. A fetch failure means a file is not there — an incomplete copy, a
 * half-finished download, a folder that was moved without its subfolders. A
 * module that loads and throws is a bug in Greg.
 *
 * Reported by somebody who installed from a copied folder rather than a clone:
 * the television face never appeared, Greg fell back to the older head, and the
 * only clue was "Failed to fetch dynamically imported module" — which names no
 * file and suggests no cause. The browser deliberately withholds the failing
 * URL here for cross-origin reasons, so the message is all there is; it has to
 * carry its own diagnosis.
 */
export function isMissingModule(err) {
  const text = String(err?.message ?? "");
  return /failed to fetch dynamically imported module|error loading dynamically imported module|failed to load module script/i.test(text);
}

function reportFaceError(err) {
  const missing = isMissingModule(err);
  const badge = document.getElementById("badge");
  if (badge) {
    badge.textContent = missing ? "face error: files missing from this install" : `face error: ${err.message}`.slice(0, 90);
    badge.classList.add("warn");
    badge.title = missing
      ? `A file the television face needs could not be loaded, so Greg is on his reduced face.\n\n` +
        `This is almost always an incomplete copy rather than a bug — public/channels/ holds 14 files ` +
        `and every one of them has to be there. Copying the folder by hand or downloading it as a zip ` +
        `is the usual way to lose some.\n\nCheck the Network tab for the request that 404s, or take a ` +
        `fresh clone.\n\n${err?.stack ?? err}`
      : String(err?.stack ?? err);
  }

  if (missing) {
    console.error(
      "The television face could not load: a module it imports was not served.\n" +
      "public/channels/ must contain all 14 files, plus boot.js, volume.js and subtitles.js beside face-tv.js.\n" +
      "Open the Network tab and look for the 404 — that names the missing file. A fresh clone fixes it.",
      err
    );
  }
}

// ---------------------------------------------------------------------------
// The reduced face
//
// It lives HERE, in the same file as createFace, and that is the whole design.
// The gold helmet and its hand-drawn stand-in used to do this job from two
// files of their own, and the real-world trigger for reaching them was never
// WebGL — it was somebody installing from a copied folder with files missing.
// A fallback that is itself a separate file is least likely to be there exactly
// when it is needed, and the old chain ended in an UNGUARDED
// `await import("./face-2d.js")`: an install missing both that and face-tv.js
// did not degrade, it killed the page outright — no microphone, no buttons, no
// listeners — while the HTML carried on looking perfectly fine. Nothing to
// fetch cannot fail to fetch.
//
// So it is small on purpose. It answers the one question a face has to answer —
// is he listening, thinking, talking, or broken — and it shows the level, so
// you can see him hearing you. It does not pretend to be the television.
// ---------------------------------------------------------------------------

const STATES = {
  idle:      { ring: "#2f6d5a", glow: "#4fd6a8", label: "" },
  listening: { ring: "#3f8f4a", glow: "#6dff8a", label: "LISTENING" },
  thinking:  { ring: "#8a6a24", glow: "#ffc857", label: "THINKING" },
  speaking:  { ring: "#2f7d8f", glow: "#5fd8ff", label: "SPEAKING" },
  error:     { ring: "#8f3030", glow: "#ff6b6b", label: "ERROR" },
};

class MinimalFace {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.state = "idle";
    this.level = 0;
    this.shown = 0;
    this.time = 0;
    this.size = 0;
    this.dpr = 0;
  }

  /**
   * The device pixel ratio is checked every frame, not only when the CSS size
   * changes. Moving the window to a monitor with different scaling fires
   * neither `resize` nor a ResizeObserver, and both helmets had that bug to the
   * end — they drew soft on the second monitor and nobody could say why.
   * Reading devicePixelRatio is free; getBoundingClientRect is not, so the
   * expensive call only happens once the cheap one has moved.
   */
  measure() {
    const dpr = window.devicePixelRatio || 1;
    if (dpr === this.dpr && this.size) return;

    const rect = this.canvas.getBoundingClientRect();
    const size = Math.floor(Math.min(rect.width, rect.height));
    if (!size) return; // laid out at zero; try again next frame

    this.canvas.width = size * dpr;
    this.canvas.height = size * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.size = size;
    this.dpr = dpr;
  }

  setState(state) {
    if (STATES[state]) this.state = state;
  }

  setLevel(level) {
    const n = Number(level);
    this.level = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  }

  setSpectrum() {
    // Taken and ignored. The bars are the television's job; here the level
    // already says everything this face is able to say.
  }

  start() {
    let last = performance.now();
    const frame = (now) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      // A bad frame must cost the frame, not the loop. Some causes are
      // transient, and giving up on the first one turns a flicker into a
      // permanently blank screen — which is the failure this face exists for.
      try {
        this.measure();
        this.draw(dt);
      } catch { /* keep going */ }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  draw(dt) {
    const { ctx, size } = this;
    if (!size) return;

    this.time += dt;
    // Rises fast so you see him hear you, falls slowly so it does not flicker.
    const rate = this.level > this.shown ? 12 : 4;
    this.shown += (this.level - this.shown) * Math.min(1, rate * dt);

    const look = STATES[this.state] ?? STATES.idle;
    const mid = size / 2;
    const base = size * 0.26;
    // Breathing when quiet, so an idle face is never mistaken for a frozen one.
    const idle = Math.sin(this.time * 1.6) * size * 0.006;
    const r = base + this.shown * size * 0.11 + idle;

    ctx.fillStyle = "#05070a";
    ctx.fillRect(0, 0, size, size);

    ctx.lineWidth = Math.max(2, size * 0.018);
    ctx.strokeStyle = look.ring;
    ctx.beginPath();
    ctx.arc(mid, mid, base, 0, Math.PI * 2);
    ctx.stroke();

    ctx.globalAlpha = 0.55 + this.shown * 0.45;
    ctx.strokeStyle = look.glow;
    ctx.beginPath();
    ctx.arc(mid, mid, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    if (look.label) {
      ctx.fillStyle = look.glow;
      ctx.font = `bold ${Math.max(7, size * 0.045)}px "MS Sans Serif", Tahoma, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(look.label, mid, mid);
    }

    // Says what it is, every frame. Somebody looking at this needs to know they
    // are not looking at Greg's real face — otherwise the reduced face is
    // itself the confusing bug report.
    ctx.fillStyle = "rgba(150,170,190,0.45)";
    ctx.font = `${Math.max(6, size * 0.032)}px "MS Sans Serif", Tahoma, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText("REDUCED FACE", mid, size - Math.max(8, size * 0.05));
  }
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {"auto"|"tv"|"minimal"} preference
 * @returns {Promise<{face: object, canvas: HTMLCanvasElement, renderer: string}>}
 */
export async function createFace(canvas, preference = "auto") {
  if (preference !== "minimal") {
    try {
      const { FaceTV } = await import("./face-tv.js");
      return { face: new FaceTV(canvas), canvas, renderer: "tv" };
    } catch (err) {
      // This function is awaited at the top level of voice.js, so anything that
      // escapes here takes the entire page down with it — no listeners, no
      // microphone, no buttons — while the HTML carries on looking perfectly
      // fine. A broken face must cost you the face, not the assistant.
      console.error("TV face failed to start, falling back to the reduced face:", err);
      reportFaceError(err);
    }
  }

  return { face: new MinimalFace(canvas), canvas, renderer: "minimal" };
}
