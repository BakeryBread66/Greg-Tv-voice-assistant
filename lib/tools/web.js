// Web tools: schema and handler together.
//
// They used to be 400 lines apart in lib/brain.js — one entry in a 23-item
// array, one case in a 23-case switch — with nothing stopping the two
// drifting. `run` receives (input, ctx); ctx carries what a handler needs
// from the brain and cannot import for itself.

import { readPage } from "../readpage.js";
import { searchWeb } from "../search.js";
import { shouldTrySecond } from "../freshness.js";
import { pickToRead } from "../ranking.js";
import { siteUrl, openUrl, SITE_NAMES } from "../websites.js";

export const web = [
  {
    name: "search_web",
    description:
      "Search the web for current or specific information. Use this whenever you are not certain of an answer — recent events, people, products, prices, sports results, anything after your training data.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "What to search for, as a short search phrase." } },
      required: ["query"],
    },
    async run(input, ctx) {
    const query = input.query ?? "";
    const found = await searchWeb(query, { limit: 4 });

    // Open a result and read it, without waiting to be asked.
    //
    // Search snippets are written to withhold the answer — "a North Carolina
    // chain was named the best, but there's only one place you get it near
    // Wilmington" — so a search that stops at snippets routinely leaves Greg
    // one click short of what he just found. One page per search: enough to
    // answer the question, bounded so a vague query can't spider the web.
    //
    // WHICH result, decided before anything is fetched — see lib/ranking.js.
    // This used to be results[0], which is how a "best breakfast chains"
    // round-up ended up in front of the model and "Hardee's" got reported as
    // the answer, faithfully, one run in three.
    const pick = pickToRead(found.results ?? [], query);
    if (!pick) return found;

    // Best first, so the second chance below goes to the next best candidate
    // rather than to whatever happened to rank second.
    const ordered = [...pick.scored].sort((a, b) => b.score - a.score).map((s) => s.result);
    const top = ordered[0];

    const asPage = (result, page) =>
      page.text
        ? { title: result.title, source: page.source, text: page.text, note: page.note, published: page.published, age: page.age }
        // Say why rather than staying silent, so the model reports "I couldn't
        // open it" instead of quietly answering from the snippet alone.
        : { title: result.title, source: result.source, error: page.error };

    const page = await readPage(top.url, { maxChars: 3500 });
    found.topResult = asPage(top, page);

    // Said plainly when the highest-ranked result was passed over. A page
    // arriving in place of the top hit should say so rather than quietly
    // substituting itself.
    if (pick.why && found.topResult.note) found.topResult.note += ` ${pick.why}`;

    // NOT DONE, and deliberately: neutralising the competing round-up snippets.
    //
    // Choosing the right page to read does not stop the model answering from a
    // different result's one-line teaser, and measured, it doesn't: with the
    // correct article in topResult, one run in three named Whataburger off a
    // "10 best restaurants" snippet. Two fixes were tried and NEITHER worked.
    //
    //   baseline (ranker only)          2/3 right, 1 answered from a snippet
    //   + a note telling it not to      2/3 — the usual score for a prompt
    //   + replacing those snippets      0/3, and two runs then claimed there was
    //     with "(a round-up ...)"       no definitive answer at all
    //
    // The third is the interesting one: the tool result was verified good at the
    // moment it failed — the right page read, "Biscuitville" in its first two
    // hundred characters — so replacing misleading text with an explicitly
    // NEGATIVE sentence appears to have read as evidence of absence. Swapping a
    // wrong answer for "I couldn't find it" is not an improvement.
    //
    // Reverted rather than tuned further. Every sample here is n=3 against a
    // result set DuckDuckGo reorders between identical calls, which is not
    // enough to tell a real effect from noise — and this project has a section
    // about six rounds of exactly that. Whoever picks this up: get a fixed
    // corpus of result sets first, so the thing being measured holds still.

    // One second chance, and only when the question asked for something current.
    //
    // DuckDuckGo's ordering varies between identical calls and its result set
    // routinely mixes years — the ranking query CLAUDE.md uses as its example
    // returns this year's story and last year's side by side, with nothing in
    // the listing to tell them apart. When the top hit turns out to be old and
    // the user asked for the latest, it is worth one more fetch to find out
    // whether something newer was sitting at number two.
    //
    // Bounded at one: two pages per search, and only on a query that asked.
    if (shouldTrySecond(query, page.ageDays) && ordered[1]) {
      const alt = await readPage(ordered[1].url, { maxChars: 3500 });
      if (alt.text && alt.ageDays !== null && alt.ageDays < page.ageDays) {
        found.topResult = asPage(ordered[1], alt);
        // Said plainly, because the model is about to be handed a different page
        // from the one that ranked first and should not pretend otherwise.
        found.topResult.note += ` The highest-ranked result was older (${page.age}); this newer one was used instead.`;
      } else {
        found.topResult.note += ` The next result was no newer, so this remains the best available — it is still ${page.age}.`;
      }
    }

    return found;
    },
  },
  {
    name: "read_page",
    description:
      "Read the full text of a web page or news article, given its URL. Use when a search result's snippet doesn't contain the answer, or the user wants more about a story. Search results carry a url field — pass that. News headlines do NOT have a usable url: to follow up on one, search_web the headline first, then read the best result.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "The full URL, taken from a search result or news headline." } },
      required: ["url"],
    },
    async run(input, ctx) {
    const page = await readPage(input.url ?? "", { maxChars: 5000 });
    if (page.error) return { error: page.error };
    return page;
    },
  },
  {
    name: "open_website",
    // The enum already tells the model which sites exist, so the description
    // does not list them again — the same duplication trimmed out of the other
    // schemas to make room for this tool in the first place.
    description:
      "Open a website in the user's browser. Use for 'open YouTube', 'pull up Wikipedia', 'search YouTube for...', 'show me that on a map'. Opens a new window; it does not read the page.",
    parameters: {
      type: "object",
      properties: {
        site: { type: "string", enum: SITE_NAMES },
        search: { type: "string", description: "What to search for there. Empty for the front page." },
      },
      required: ["site"],
    },
    async run(input, ctx) {
    // The model names a site; the URL is built in lib/websites.js. It never
    // passes a URL, so a search result or a fetched page cannot talk Greg into
    // opening something in a browser holding the user's sessions.
    const target = siteUrl(input.site ?? "", input.search ?? "");
    if (!target) {
      return {
        error: `NOTHING WAS OPENED. There is no site called "${input.site}" on the list.`,
        tell_the_user: `I can only open ${SITE_NAMES.join(", ")}.`,
      };
    }
    try {
      openUrl(target.url);
      return { opened: target.label, url: target.url, searched: target.searched };
    } catch (err) {
      return { error: `NOTHING WAS OPENED. ${err.message}` };
    }
    },
  },
];
