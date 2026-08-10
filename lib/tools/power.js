// Power tools: schema and handler together.
//
// They used to be 400 lines apart in lib/brain.js — one entry in a 23-item
// array, one case in a 23-case switch — with nothing stopping the two
// drifting. `run` receives (input, ctx); ctx carries what a handler needs
// from the brain and cannot import for itself.

import { setGamingMode, setVision } from "../power.js";

export const power = [
  {
    name: "set_vision",
    description:
      "Turn your eyes on or off. Use when the user says to open or close your eyes, stop or start watching the screen, or asks you to free up video memory. Turning them off releases about 5.9 GB of VRAM; turning them on costs a few seconds to reload. You must call it — saying your eyes are off without calling it leaves them on.",
    parameters: {
      type: "object",
      properties: {
        on: { type: "boolean", description: "true to open your eyes, false to close them." },
      },
      required: ["on"],
    },
    async run(input, ctx) {
    if (typeof input.on !== "boolean") return { error: "say whether to turn your eyes on or off" };
    const result = await setVision(input.on, ctx.config);
    // The refusal path is the important one: enabling eyes that never passed
    // the startup eyesight test must come back as an error, so the honesty rule
    // makes Greg report a failure rather than announce eyes he hasn't got.
    if (!result.ok) return { error: result.error };
    console.log(`[eyes] switched ${input.on ? "on" : "off"}${result.unloaded ? ", vision model unloaded" : ""}`);
    return {
      eyes: input.on ? "open" : "closed",
      freedVram: input.on ? null : "about 5.9 GB",
    };
    },
  },
  {
    name: "set_gaming_mode",
    description:
      "Switch gaming mode on or off. Use when the user says they are about to play a game, wants their graphics card back, or asks you to use less memory — and when they are finished. On: closes your eyes and drops your cloned voice back to the built-in one, freeing about 10 GB. Off: restores both. You must call it; announcing it without calling it changes nothing.",
    parameters: {
      type: "object",
      properties: {
        on: { type: "boolean", description: "true for gaming mode, false to restore." },
      },
      required: ["on"],
    },
    async run(input, ctx) {
    if (typeof input.on !== "boolean") return { error: "say whether to turn gaming mode on or off" };
    const result = await setGamingMode(input.on, ctx.config);
    console.log(`[power] gaming mode ${input.on ? "on" : "off"} — eyes: ${result.eyes}, voice: ${result.voice}`);
    return {
      gamingMode: input.on ? "on" : "off",
      eyes: result.eyes,
      voice: result.voice,
      freedVram: input.on ? "about 10 GB" : null,
    };
    },
  },
];
