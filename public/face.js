// Picks how to draw Greg's face.
//
// The television is the real one: a floating CRT head showing SMPTE colour bars,
// with the picture itself carrying his expression. The gold helmet and its
// hand-drawn stand-in are kept because they still work and cost nothing to
// leave in — add ?face=3d or ?face=2d to the address to see them.
//
// Whatever is chosen must implement the same four methods: setState, setLevel,
// setSpectrum and start. That interface is the entire contract between the face
// and everything else, which is what made swapping the helmet for a television
// a change to this file and one new one, rather than a rewrite.

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
      ? `A file the television face needs could not be loaded, so Greg fell back to his older face.\n\n` +
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

function supportsWebGL() {
  try {
    // Probe on a throwaway canvas: a canvas only ever gets one kind of context,
    // so testing on the real one would burn it for the 2D fallback.
    const probe = document.createElement("canvas");
    return Boolean(probe.getContext("webgl2") || probe.getContext("webgl"));
  } catch {
    return false;
  }
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {"auto"|"tv"|"3d"|"2d"} preference
 * @returns {Promise<{face: object, canvas: HTMLCanvasElement, renderer: string}>}
 */
export async function createFace(canvas, preference = "auto") {
  if (preference === "auto" || preference === "tv") {
    try {
      const { FaceTV } = await import("./face-tv.js");
      return { face: new FaceTV(canvas), canvas, renderer: "tv" };
    } catch (err) {
      // This function is awaited at the top level of voice.js, so anything that
      // escapes here takes the entire page down with it — no listeners, no
      // microphone, no buttons — while the HTML carries on looking perfectly
      // fine. A broken face must cost you the face, not the assistant.
      console.error("TV face failed to start, falling back:", err);
      reportFaceError(err);
    }
  }

  if (preference !== "2d" && supportsWebGL()) {
    try {
      const { Face3D } = await import("./face-3d.js");
      const face = new Face3D(canvas);
      await face.init();
      return { face, canvas, renderer: "3d" };
    } catch (err) {
      console.warn("3D face unavailable, falling back to 2D:", err.message);
      // A failed WebGL attempt may already have claimed the canvas, so swap in
      // a clean one before asking for a 2D context.
      const fresh = canvas.cloneNode(false);
      canvas.replaceWith(fresh);
      canvas = fresh;
    }
  }

  const { Face } = await import("./face-2d.js");
  return { face: new Face(canvas), canvas, renderer: "2d" };
}
