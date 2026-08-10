// News tools: schema and handler together.
//
// They used to be 400 lines apart in lib/brain.js — one entry in a 23-item
// array, one case in a 23-case switch — with nothing stopping the two
// drifting. `run` receives (input, ctx); ctx carries what a handler needs
// from the brain and cannot import for itself.

import { getNews } from "../news.js";
import { translateHeadlines } from "../translate.js";

export const news = [
  {
    name: "get_local_news",
    description:
      "Get recent news headlines. Defaults to the user's own city. Use for any question about news, headlines, or current events.",
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["local", "national", "world", "topic"], description: "Which slice of the news to fetch." },
        topic: { type: "string", description: "Subject to search when scope is 'topic', e.g. 'Carolina Panthers'." },
        count: { type: "integer", description: "How many headlines, 1 to 10. Default 6." },
        place: {
          type: "string",
          description:
            "Somewhere other than home, e.g. 'Tokyo'.",
        },
      },
      required: [],
    },
    async run(input, ctx) {
    const result = await getNews(ctx.config, {
      // Passed in rather than imported by news.js, so the feed still works with
      // no brain running — basic mode reads headlines too.
      translate: (headlines, language) => translateHeadlines(ctx.provider, headlines, language),
      scope: input.scope ?? "local",
      topic: input.topic ?? "",
      limit: Math.min(Math.max(input.count ?? 6, 1), 10),
      place: await ctx.resolvePlace(input.place),
    });

    // Say what was read and in what language. A translated Korean front page
    // presented as though it were English coverage is a quiet lie about the
    // source, which is the same failure as inventing a publication name — and
    // the whole reason this exists is that the English coverage of Korea was
    // not what Korea was reading.
    if (result.translated) {
      result.note =
        `These are ${result.language} headlines from that country's own news front page, translated into English. ` +
        `Say they are local headlines, translated. Each story keeps its untranslated wording in "original".`;
    } else if (result.needsTranslation) {
      result.note =
        `These headlines are in ${result.language} and could NOT be translated. Say that plainly rather than ` +
        `attempting to read them aloud or guessing at what they say.`;
    }

    return result;
    },
  },
];
