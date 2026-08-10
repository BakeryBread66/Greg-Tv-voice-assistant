// Channels tools: schema and handler together.
//
// They used to be 400 lines apart in lib/brain.js — one entry in a 23-item
// array, one case in a 23-case switch — with nothing stopping the two
// drifting. `run` receives (input, ctx); ctx carries what a handler needs
// from the brain and cannot import for itself.

import { CHANNELS, setChannel, turnKnob } from "../channels.js";

/**
 * How many characters the channels somebody ADDED may take in this schema.
 *
 * The built-ins are a fixed, known cost. Add-ons are not: a folder of thirty
 * would otherwise put thirty entries into a string sent on every single turn,
 * and the person who installed them would have no idea they were paying for it
 * in every unrelated conversation. Bounded here so the worst case is knowable.
 *
 * Names only, no keyword parentheses — the keywords earn their place for the
 * built-ins because they drive RECOGNITION (8/10 to 6/10 when they were cut),
 * but that argument does not stretch to spending unbounded tokens on channels
 * this project has never seen. Anything past the cap is still reachable: the
 * user says its name, the model passes the words through, and resolveChannel()
 * matches it in code.
 */
const ADDON_BUDGET = 240;

/**
 * The description, built from whatever channels exist right now.
 *
 * A function rather than a literal because add-ons are discovered at STARTUP,
 * after this module has been imported — evaluated once at import, the schema
 * would have described the shipped thirteen forever and no add-on would ever be
 * named to the model. See refreshChannelTool().
 */
export function channelDescription(list = CHANNELS) {
  const builtIn = list.filter((c) => !c.addon);
  const added = list.filter((c) => c.addon);

  let text = builtIn.map((c) => `${c.number} ${c.name} (${c.description})`).join(", ");

  if (added.length) {
    const fitted = [];
    let used = 0;
    for (const channel of added) {
      const entry = `${channel.number} ${channel.name}`;
      if (used + entry.length + 2 > ADDON_BUDGET) break;
      fitted.push(entry);
      used += entry.length + 2;
    }
    if (fitted.length) text += `, ${fitted.join(", ")}`;
    // Said out loud when some were left out, so the model knows the list it can
    // see is not the whole dial and does not tell somebody a channel does not
    // exist. Silence here would turn a budget into a lie.
    if (fitted.length < added.length) {
      text += `, and ${added.length - fitted.length} more not listed here`;
    }
  }

  return (
    `Change what is on your own screen. You are a television. Channels: ${text}. ` +
    `Pass the user's OWN WORDS through as the channel. Use "next" if they said to change channel without saying which. ` +
    `You must call it; saying you switched without calling it leaves the screen exactly as it was.`
  );
}

export const channels = [
  {
    name: "set_channel",
    // NAMES PLUS A FEW KEYWORDS — not documentation.
    //
    // This schema is sent on every single turn, whether or not anybody mentions
    // television, and written at documentation length it had reached 1058
    // characters, ~265 tokens. Every channel added taxed every conversation.
    //
    // Cutting to bare names took it to ~113 tokens and cost real accuracy:
    // routing on an indirect-phrasing battery fell from 8/10 to 6/10, and every
    // new failure was the tool NOT BEING CALLED — the model no longer recognised
    // "the rain map" or "the picture of the day" as being about a channel at
    // all. So the descriptions were doing a job, just not the one they looked
    // like they were doing: recognition, not resolution.
    //
    // Keywords are what recognition needs. RESOLVING the phrase is
    // resolveChannel()'s job in lib/channels.js, which is deterministic and
    // scored 42/42 and 10/10 on its own batteries — hence "pass the user's own
    // words through" rather than teaching the model to choose.
    description: channelDescription(),
    parameters: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          description: "What the user called it, in their words, or a number. 'next' moves one along, 'back' moves one the other way.",
        },
      },
      required: ["channel"],
    },
    async run(input, ctx) {
    const wanted = String(input.channel ?? "").trim();
    // "change the channel" with nothing named is a real thing people say, and
    // a television answers it by moving one along rather than asking which.
    // "back one" is the same thing in reverse and worth having now the dial
    // has ten positions — nine forward clicks to undo one is not a control.
    const result = /^(next|forward|on|another|whatever|up)$/i.test(wanted)
      ? turnKnob(1)
      : /^(previous|prev|back|back one|go back|last one|down|before)$/i.test(wanted)
        ? turnKnob(-1)
        : setChannel(wanted);
    if (result.error) return result;
  
    console.log(`[channel] ${result.channel} — ${result.name}`);
    return {
      channel: result.channel,
      showing: result.name,
      note: result.changed ? "The screen has changed." : "That was already the channel showing.",
    };
    },
  },
];

/**
 * Rebuild set_channel's description after add-ons have been discovered.
 *
 * Called once at startup, from server.js, after addChannels(). Without it the
 * schema is whatever existed when this module was imported — the thirteen
 * shipped channels — and a channel somebody wrote would work from the knob and
 * from `resolveChannel`, but the model would never once mention it.
 */
export function refreshChannelTool() {
  const tool = channels.find((t) => t.name === "set_channel");
  tool.description = channelDescription();
  return tool.description;
}
