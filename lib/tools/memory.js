// Memory tools: schema and handler together.
//
// They used to be 400 lines apart in lib/brain.js — one entry in a 23-item
// array, one case in a 23-case switch — with nothing stopping the two
// drifting. `run` receives (input, ctx); ctx carries what a handler needs
// from the brain and cannot import for itself.

import { searchConversations } from "../conversation-log.js";
import { forget, remember } from "../memory.js";
import { lastAnswer } from "../provenance.js";

export const memory = [
  {
    name: "recall_conversation",
    description:
      // "It only reads; it changes nothing" removed: it was there to keep this
      // out of the honesty rule's orbit, and the watchdog test now enforces that
      // from the tool's NAME instead — a guard in code beats a sentence in a
      // schema, and this one costs tokens on every single turn.
      "Look back through what you and the user have actually said in past conversations. Use when they refer to something from before — 'what did we talk about yesterday', 'what did I ask you about the car', 'remind me what you told me'. This searches a verbatim log, so quote what was really said rather than paraphrasing from nothing.",
    parameters: {
      type: "object",
      properties: {
        about: {
          type: "string",
          description: "Words to look for. Leave empty to get the most recent exchanges.",
        },
        sinceDays: {
          type: "number",
          description: "Only look back this many days. Use 1 for 'yesterday', 7 for 'last week'.",
        },
      },
      required: [],
    },
    async run(input, ctx) {
    const found = searchConversations(input.about ?? "", {
      limit: 6,
      sinceDays: Number(input.sinceDays) > 0 ? Number(input.sinceDays) : null,
    });
    if (!found.length) {
      // Say it plainly. A model handed an empty list will otherwise fill the
      // silence with a conversation that never happened — the same failure as
      // the invented news headlines.
      return { found: 0, note: "Nothing in the log matches that. Say you don't have a record of it rather than guessing at what was said." };
    }
    return { found: found.length, exchanges: found };
    },
  },
  {
    name: "remember_about_user",
    description:
      "Save a durable fact about the user so it is still known in future conversations — their name, preferences, where they work, ongoing projects, people in their life. Use it whenever they tell you something lasting about themselves, or ask you to remember something.",
    parameters: {
      type: "object",
      properties: { fact: { type: "string", description: "The fact, written as a short third-person sentence, e.g. 'The user's dog is called Rex'." } },
      required: ["fact"],
    },
    async run(input, ctx) {
    return { saved: remember(input.fact ?? "") };
    },
  },
  {
    name: "forget_about_user",
    description: "Delete previously remembered facts. Use when the user asks you to forget something. Pass 'everything' to clear all of it.",
    parameters: {
      type: "object",
      properties: { about: { type: "string", description: "A word or phrase identifying what to forget, or 'everything'." } },
      required: ["about"],
    },
    async run(input, ctx) {
    const removed = forget(input.about ?? "");
    return removed.length ? { forgotten: removed } : { forgotten: [], note: "nothing matched" };
    },
  },
  {
    // Not in the honesty sentence, and correctly so: it reports, it changes
    // nothing. It is also excluded from the provenance record it reads, or
    // asking twice would have him explain the explanation.
    name: "explain_last_answer",
    description:
      "Say where your previous answer came from — which tools you called and what they returned. Use when asked 'how do you know that', 'where did you get that', 'are you sure', or 'what did you check'.",
    parameters: { type: "object", properties: {}, required: [] },
    async run() {
      const last = lastAnswer();
      if (!last) {
        return { note: "There is no previous answer on record. Say so plainly rather than guessing at what you might have checked." };
      }
      return {
        theirQuestion: last.question,
        // An empty list is the most useful thing this tool reports, so it says
        // so in words rather than handing back [] for a model to fill in.
        checked: last.steps.length ? last.steps.map((s) => s.detail) : undefined,
        note: last.steps.length
          ? "These are the only things you consulted. Do not add a source that is not in this list."
          : "You called NO tools for that answer — it came from what you already knew, not from checking anything. Say that plainly.",
      };
    },
  },
];
