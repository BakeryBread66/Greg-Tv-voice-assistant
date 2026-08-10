// Screen tools: schema and handler together.
//
// They used to be 400 lines apart in lib/brain.js — one entry in a 23-item
// array, one case in a 23-case switch — with nothing stopping the two
// drifting. `run` receives (input, ctx); ctx carries what a handler needs
// from the brain and cannot import for itself.

import { captureScreen, saveScreenshot, selfInShot, getWindowRect } from "../screen.js";
import { channelState } from "../channels.js";

export const screen = [
  {
    name: "look_at_screen",
    description:
      "Look at what is on the user's screen right now. Use for any question about what they are looking at, what is on their screen, reading something on their display, or helping with whatever they are working on. Pass their question through so the answer is about what they actually asked.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "What the user wants to know about the screen, in their own words.",
        },
      },
      required: [],
    },
    async run(input, ctx) {
    const vision = ctx.config.vision ?? {};
    if (vision.enabled === false) return { error: "screen vision is switched off in ctx.config.json" };
    if (typeof ctx.provider?.describeImage !== "function") {
      return { error: "the current brain can't look at images" };
    }
  
    const shot = await captureScreen({
      maxWidth: vision.maxWidth ?? 1280,
      display: vision.display ?? "primary",
    });
  
    // Asked as a separate, tool-free call. The instruction not to guess matters
    // more here than anywhere else: a vision model handed a blurry screenshot
    // will happily describe the application it expects rather than the one
    // that's there.
    const description = await ctx.provider.describeImage({
      imageBase64: shot.base64,
      prompt:
        `This is a screenshot of the user's computer screen. They asked: "${input.question || "what's on my screen?"}"\n\n` +
        `Describe what is actually visible and relevant to that question. Name the applications, windows and on-screen text you can genuinely read. ` +
        `If what they asked about isn't visible, say exactly that. Never guess at detail you cannot see. Be concise — a few sentences at most.`,
    });
  
    // Whether he is looking at himself, decided from geometry rather than left
    // to the vision model — which is deliberately NOT told to look for him.
    // Priming it would get his window "recognised" on a monitor he isn't on,
    // and a vision model told what to expect reports what it expects: that is
    // the whole reason lib/vision.js makes this model pass a swatch test first.
    const self = selfInShot(getWindowRect(), shot.bounds);
    const channel = channelState();

    return {
      screen: description,
      resolution: shot.size,
      // What he looks like right now, so he can match himself to whatever the
      // description above happens to call him.
      yourOwnWindow: self.onScreen
        ? `You are on this screen ${self.where}: a window titled "${ctx.config.name ?? "Greg"}" drawn as an old television, ` +
          `currently on channel ${channel.channel} (${channel.name}). If the description mentions a television, a CRT, ` +
          `colour bars or a retro-looking window, that is you.`
        : self.known
          ? `You are NOT on this screen — your window is ${self.why}. Nothing in that description is you, however much it sounds like it.`
          : `Whether your own window is on this screen is unknown, so do not claim to see yourself.`,
    };
    },
  },
  {
    name: "take_screenshot",
    description:
      "Save a picture of the user's screen to a file they can keep. Use when they ask you to take, grab, capture or save a screenshot. This SAVES an image — it does not tell you what is on the screen. If they want to know what they are looking at, use look_at_screen instead.",
    parameters: {
      type: "object",
      properties: {
        whole_desktop: {
          type: "boolean",
          description: "True to capture every monitor as one wide image. False or omitted captures just the main screen.",
        },
      },
      required: [],
    },
    async run(input, ctx) {
    const settings = ctx.config.screenshots ?? {};
    if (settings.enabled === false) return { error: "taking screenshots is switched off in ctx.config.json" };
  
    const shot = await saveScreenshot({
      folder: settings.folder ?? "screenshots",
      display: input.whole_desktop ? "all" : settings.display ?? "primary",
      // 0 keeps it at native resolution — this one is for the user to look at.
      maxWidth: settings.maxWidth ?? 0,
    });
  
    console.log(`[screenshot] ${shot.path} (${shot.size}, ${Math.round(shot.bytes / 1024)} KB)`);
  
    // `file` and `where` are what Greg should say. The full path is here for
    // completeness but the prompt tells him not to read it out — a Windows
    // path spoken aloud is unbearable.
    return {
      saved: true,
      file: shot.file,
      where: settings.folder ? String(settings.folder) : "the screenshots folder next to start-greg.bat",
      resolution: shot.size,
      path: shot.path,
    };
    },
  },
];
