// Personality tools: schema and handler together.
//
// They used to be 400 lines apart in lib/brain.js — one entry in a 23-item
// array, one case in a 23-case switch — with nothing stopping the two
// drifting. `run` receives (input, ctx); ctx carries what a handler needs
// from the brain and cannot import for itself.

import { TRAITS, getPersonality, personalityToSentence, setMirror, setStyle, setTrait } from "../personality.js";
import { listPersonas, resolvePersona, personaPatch } from "../personas.js";
import { applySettings } from "../settings.js";

export const personality = [
  {
    // Named in the honesty sentence BEFORE this handler was written — the order
    // CLAUDE.md has asked for since the third session, and the watchdog test now
    // fails the build if anyone forgets.
    //
    // The options are interpolated from the folder, the way set_channel's are
    // interpolated from CHANNELS: dropping a JSON file into personas/ makes the
    // character reachable by voice with no code change at all, which is the
    // whole point of shipping this as something other people can make theirs.
    name: "set_persona",
    description:
      `Become a different character entirely — name, identity and all six personality dials at once. ` +
      `Options: ${listPersonas().map((p) => p.name).join(", ")}.`,
    parameters: {
      type: "object",
      properties: {
        persona: { type: "string", description: "Which character to become, in the user's own words." },
      },
      required: ["persona"],
    },
    async run(input) {
      const found = resolvePersona(input.persona ?? "");
      if (!found) {
        return {
          error: `There is no character called "${input.persona ?? ""}".`,
          available: listPersonas().map((p) => p.name).join(", "),
        };
      }

      const result = await applySettings(personaPatch(found));
      if (result?.error) return { error: result.error };

      return {
        became: found.name,
        is: found.is,
        // Said plainly, because the VOICE does not change with the character and
        // he must not imply that it did — that would be claiming something that
        // did not happen, which is the rule this whole project is built on.
        note:
          `You are now ${found.name}. Introduce yourself briefly, in character. Your voice is unchanged — ` +
          `only who you are and how you talk. Do not recite the dial settings unless asked.`,
      };
    },
  },
  {
    name: "set_personality",
    description:
      "Change how you behave. Use it whenever the user asks you to be funnier, blunter, warmer, shorter, longer, more or less formal — and ALSO for any instruction about your manner, habits or how you address them: 'set your style to...', 'from now on call me...', 'stop saying...', 'always start with...', 'be more like...'. You must call it — saying you have changed without calling it changes nothing.",
    parameters: {
      type: "object",
      properties: {
        trait: {
          type: "string",
          enum: Object.keys(TRAITS),
          description: "Which dial to move.",
        },
        percent: {
          type: "number",
          description: "Where to set it, 0 to 100. Nudges like 'a bit funnier' should move it about 20.",
        },
        style: {
          type: "string",
          description:
            "A free-text instruction about your manner, for anything the dials don't cover — a catchphrase, a thing never to say. Replaces the previous one.",
        },
        mirror: {
          type: "boolean",
          description: "Whether to match the user's own tone and length. Set when they ask you to stop copying them, or to start.",
        },
      },
      required: [],
    },
    async run(input, ctx) {
    const changes = [];
    if (input.trait !== undefined && input.percent !== undefined) changes.push(setTrait(input.trait, input.percent));
    if (typeof input.style === "string") changes.push(setStyle(input.style));
    if (typeof input.mirror === "boolean") changes.push(setMirror(input.mirror));
  
    if (!changes.length) return { error: "nothing to change — say which setting and what to set it to" };
  
    const failed = changes.find((c) => c.error);
    if (failed) return failed;
  
    // The system prompt is rebuilt each turn, so this is live from the next
    // reply onward — worth saying, because the answer he's giving right now
    // is still in the old voice.
    console.log(`[personality] ${JSON.stringify(changes)}`);
    return { changed: changes, note: "This takes effect from your next reply, not this one." };
    },
  },
  {
    name: "get_personality",
    description:
      "Report your current personality settings. Use when the user asks what you're set to, how funny you are, or what your settings look like.",
    parameters: { type: "object", properties: {}, required: [] },
    async run(input, ctx) {
    return { ...getPersonality(), spoken: personalityToSentence() };
    },
  },
];
