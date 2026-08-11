// Checks that Greg can actually see before he's allowed to claim he can.
//
// This exists because of a specific failure. `gemma4:e4b` reports a "vision"
// capability, accepts an image without complaint, and then describes something
// that isn't there. Shown a Reddit thread filling a bright white screen, it
// reported "a dark or abstract wallpaper, no obvious application windows open,
// a taskbar at the bottom" — a plausible desktop, entirely invented. Shown solid
// red, it answers "Black". Always "Black", for every colour, in PNG and JPEG:
// the signature of a model receiving empty pixel data rather than a hard image.
//
// A tool that silently invents is worse than no tool, and this project has been
// bitten by exactly that before (see the `think` setting in CLAUDE.md). So the
// screen tool is withheld entirely unless the model passes this test at startup.

const PROMPT = "What single colour fills this image? Answer with one word.";

// Two swatches, not one: a model that answers "red" to everything would pass a
// single red test. Both must be right.
const SWATCHES = [
  {
    name: "red",
    accepts: /\bred\b/i,
    png:
      "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJ" +
      "cEhZcwAADsMAAA7DAcdvqGQAAABQSURBVGhD7c+hDQAwDMCw/v90x/eAVSnAJCyzM3vZ/OGaBrQGtAa0BrQGtAa0" +
      "BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAd3g+8AGlPXGQAAAABJRU5ErkJggg==",
  },
  {
    name: "blue",
    accepts: /\bblue\b/i,
    png:
      "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJ" +
      "cEhZcwAADsMAAA7DAcdvqGQAAABtSURBVGhD1cgxAQAADMOg+je9CYgCDh623dkSmoQmoUloEpqEJqFJaBKahCah" +
      "SWgSmoQmoUloEpqEJqFJaBKahCahSWgSmoQmoUloEpqEJqFJaBKahCahSWgSmoQmoUloEpqEJqFJaBKahCZheYh1" +
      "7wD1IFwLAAAAAElFTkSuQmCC",
  },
];

// Two separate facts, deliberately never collapsed into one:
//
//   proven  - the model demonstrated it can see, at startup. A fact about the
//             model, established by the swatch test below, and not negotiable.
//   enabled - the user wants eyes on right now. A preference, flipped by voice
//             or by the button, mainly to get 5.9 GB of VRAM back while gaming.
//
// The tool is offered only when BOTH hold. Collapsing them would let "turn your
// eyes on" re-arm a tool that never passed the test, which is the exact failure
// this whole file exists to prevent — a switch must not become a way around the
// proof.
let state = { checked: false, proven: false, reason: "not checked yet" };
let enabled = true;

// The provider, kept from the startup call so the eyesight test can be run LATER
// than startup. Needed by `openAtStartup: false`, where the whole point is not to
// load a 5.9 GB vision model until somebody actually asks to see something.
let prover = null;

export function visionStatus() {
  return { ...state, enabled, ok: state.proven && enabled };
}

/**
 * Turn the eyes on or off at runtime.
 *
 * Refuses to enable what was never proven, and says why. Returns a result rather
 * than throwing because it is driven by a tool call, and the model needs
 * something it can report honestly.
 */
/**
 * Run the eyesight test now, if it was deferred at startup.
 *
 * Only does anything in the `openAtStartup: false` case: an already-checked
 * model is not re-tested, and a model that has no provider cannot be. Loading
 * the vision model is the expensive part, which is exactly why this is not done
 * at boot for people who have asked for the eyes to start closed.
 */
export async function proveVision(config = {}) {
  if (state.checked || !prover) return visionStatus();
  // Strip the deferral so verifyVision does the real thing rather than
  // recording the same "start closed" state again.
  const forced = { ...config, vision: { ...(config.vision ?? {}), openAtStartup: true } };
  return verifyVision(prover, forced);
}

export function setVisionEnabled(on) {
  const want = Boolean(on);

  if (want && !state.proven) {
    return {
      ok: false,
      enabled,
      error: state.checked
        ? `cannot turn eyes on: the model failed its eyesight test at startup — ${state.reason}`
        : "cannot turn eyes on: the eyesight test has not run",
    };
  }

  enabled = want;
  return { ok: true, enabled };
}

/**
 * Ask Ollama to drop the vision model from VRAM.
 *
 * Withholding the tool is instant; the memory is not. Ollama holds the model
 * until its keep-alive expires regardless of whether Greg is offering the tool,
 * so switching the eyes off without this gives the honesty of eyes-off and none
 * of the 5.9 GB back. A request with keep_alive 0 unloads it immediately.
 */
export async function unloadVisionModel(config) {
  const model = config.vision?.model ?? config.ollama?.model;
  const url = config.ollama?.url ?? "http://localhost:11434";
  if (!model) return { ok: false, error: "no vision model configured" };

  try {
    const res = await fetch(`${url}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: AbortSignal.timeout(15000),
    });
    return { ok: res.ok, model };
  } catch (err) {
    // Failing to reclaim memory must not fail the toggle itself.
    return { ok: false, model, error: err.message };
  }
}

/**
 * Show the model two known colours and insist it names both.
 * Never throws — a failure just means the screen tool stays switched off.
 */
export async function verifyVision(provider, config) {
  // Kept so the test can be run later — see proveVision.
  prover = provider;

  if (config.vision?.enabled === false) {
    state = { checked: true, proven: false, reason: "switched off in config.json" };
    enabled = false;
    return visionStatus();
  }

  // Eyes closed at startup, but NOT switched off.
  //
  // A third state, and it has to be a third one. `enabled: false` above records
  // proven:false, which makes setVisionEnabled refuse forever afterwards with
  // "the model failed its eyesight test" — a lie, since the test never ran. That
  // is the proven/enabled conflation this file exists to keep apart, arriving
  // through the config door.
  //
  // So this leaves `checked` false: nothing has been established either way, the
  // 5.9 GB model is never loaded, and the first request to open the eyes runs the
  // real test then. Startup is faster and the card stays free for people who
  // never look at their screen — which on an 8 GB machine is the difference
  // between a working cloned voice and none.
  if (config.vision?.openAtStartup === false) {
    state = { checked: false, proven: false, reason: "eyes start closed — they are tested when you first open them" };
    enabled = false;
    return visionStatus();
  }

  if (typeof provider?.describeImage !== "function") {
    state = { checked: true, proven: false, reason: "this brain can't look at images" };
    return visionStatus();
  }

  const answers = [];

  for (const swatch of SWATCHES) {
    let said;
    try {
      said = await provider.describeImage({ prompt: PROMPT, imageBase64: swatch.png });
    } catch (err) {
      state = { checked: true, proven: false, reason: err.message };
      return visionStatus();
    }

    const trimmed = said.trim().replace(/\s+/g, " ").slice(0, 24);
    answers.push(`${swatch.name} looked ${trimmed || "(blank)"}`);

    if (!swatch.accepts.test(said)) {
      state = { checked: true, proven: false, reason: `the model can't see images — ${answers.join(", ")}` };
      return visionStatus();
    }
  }

  state = { checked: true, proven: true, reason: "" };
  return visionStatus();
}
