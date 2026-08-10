// Which search result is worth reading.
//
// `search_web` opens one page and stakes the answer on it, which is the right
// call — snippets are written to withhold the answer — but it opened the FIRST
// one, and DuckDuckGo's ordering varies between identical calls. Measured
// failure: one run in three answered "Hardee's" from a "best breakfast chains"
// round-up, faithfully quoting a page that listed a dozen restaurants and
// answered nothing. Every word true to its source, and the wrong answer.
//
// Nothing here fetches. It decides which of the four results already in hand is
// the one to spend a page-read on, using only the title, the snippet and the
// URL — so the whole decision costs nothing and can be proven without a network.
//
// **The signal is a year, and it is in the URL.** Earlier in this same session I
// measured "a date in the URL path" against four article pages, found it in none
// of them, and wrote it off. That was four pages. On a real result set for a
// ranking question, four of six carry one:
//
//     usatoday.com/story/money/food/2024/07/20/...      <- last year's
//     usatoday.com/story/travel/10best/awards/2023/...  <- three years old
//     iheart.com/content/2025-07-29-best-fast-food...   <- and titled "For 2025"
//     starnewsonline.com/story/.../2026/08/05/...       <- the one that answers
//
// A date extractor for a fetched ARTICLE is a different question from a date
// hint in a LISTING, and the same signal can be worthless for one and decisive
// for the other. Measure the thing you are actually going to use.

import { freshnessWanted } from "./freshness.js";

// Not preceded or followed by another digit, so the digit soup in
// "article310925290.html" cannot produce a year.
const YEAR = /(?<!\d)(20[0-3]\d)(?!\d)/g;

/**
 * The years a title or URL names, newest first.
 *
 * Both are searched because publishers put it in either: iheart in the path,
 * USA TODAY in both, and plenty of headlines say "of 2023" over a URL that
 * says nothing.
 */
export function yearsIn(...texts) {
  const found = new Set();
  for (const text of texts) {
    for (const match of String(text ?? "").matchAll(YEAR)) found.add(Number(match[1]));
  }
  return [...found].sort((a, b) => b - a);
}

// A round-up is a list of options, not an answer. These are the shapes they
// actually take, taken from real result sets rather than imagined:
//   "10 best restaurants for fast food breakfast"
//   "Top fast food restaurants for breakfast, burgers, and more"
//   "Here are the top fast food restaurants for breakfast, burgers and more"
const LISTICLE = [
  /^\s*\d+\s+(best|top|greatest|worst)\b/i,       // "10 best ..."
  /\b(here are|these are) the (top|best)\b/i,
  /\b(ranked|round[- ]?up|listicle)\b/i,
  /,\s*and more\b/i,                              // the round-up's tell
];

export function looksLikeListicle(title = "") {
  return LISTICLE.some((pattern) => pattern.test(String(title)));
}

/**
 * Does the question want ONE answer?
 *
 * A round-up is the right result for "what are the best breakfast chains" and
 * the wrong one for "which chain was named best" — so the listicle penalty is
 * gated on the question being singular. Without this gate the ranker would
 * actively hurt every "give me some options" search.
 */
// The noun does NOT have to sit immediately after "which" — measured failing on
// "which fast food chain did USA TODAY name the best for breakfast", which is
// about as singular as a question gets and matched nothing, because two words of
// adjective stood in the way. Up to three intervening words now.
//
// Matching the SINGULAR noun form is what keeps "what are the best breakfast
// chains" out: `chain\b` cannot match inside "chains", so the plural asks for
// options and gets them.
const SUBJECTS =
  "one|chain|restaurant|company|team|player|city|model|product|brand|film|movie|book|band|album|song|car|phone|laptop|country|state|airline|bank";

const SINGULAR = new RegExp(
  [
    `\\b(which|what)\\s+(?:\\w+\\s+){0,3}(${SUBJECTS})\\b`,
    `\\bwho\\s+(won|is|was|makes|owns)\\b`,
    `\\b(was|were) named\\b`,
    `\\bdid\\b[^.?]{0,40}\\bname\\b`, // "did USA TODAY name the best..."
    `\\bwon\\b`,
    `\\bwinner\\b`,
    `\\bnumber one\\b`,
    `\\bno\\.? ?1\\b`,
  ].join("|"),
  "i",
);

export function wantsOneAnswer(query = "") {
  return SINGULAR.test(String(query));
}

/**
 * Pick the result to open.
 *
 * Returns the index and a plain-English reason, which the caller puts in front
 * of the model when it did NOT read the top hit — a page arriving in place of
 * the highest-ranked one should say so rather than quietly substituting itself.
 *
 * Scoring is deliberately small and additive. Every term is a thing measured on
 * a real result set, and a result with no signals at all scores 0 and keeps its
 * search-engine order, which is the right default when we know nothing.
 */
export function pickToRead(results = [], query = "", now = new Date()) {
  const usable = results.filter((r) => r?.url);
  if (!usable.length) return null;

  const thisYear = now.getFullYear();
  const wantsFresh = freshnessWanted(query);
  const singular = wantsOneAnswer(query);
  // A year the user asked for themselves is not staleness — "the 2023 rankings"
  // should read the 2023 page.
  const askedFor = yearsIn(query);

  const scored = usable.map((result, order) => {
    const years = yearsIn(result.title, result.url);
    const reasons = [];
    let score = 0;

    // Search-engine order still counts for something — it is the only signal
    // that reflects what the whole web thinks. Small, so one real signal beats it.
    score -= order * 0.35;

    const newest = years[0] ?? null;

    if (askedFor.length) {
      // The user named a year, so "current" is not what they want — and merely
      // not punishing the year they asked for is not enough. Measured: asking
      // "which chain won in 2023" still read the 2026 page, because the 2023
      // result only had its penalty waived while everything else kept a
      // freshness bonus. Wanting a specific vintage has to be a REWARD.
      if (newest !== null) {
        if (askedFor.includes(newest)) {
          score += 2.5;
          reasons.push(`names ${newest}, which was asked for`);
        } else {
          score -= 1.5;
          reasons.push(`names ${newest}, not ${askedFor[0]}`);
        }
      }
    } else if (newest !== null) {
      const age = thisYear - newest;
      if (age >= 1) {
        // Two years old is not twice as bad as one — it is simply out, and the
        // cap stops a 2019 page and a 2023 page being separated by noise.
        score -= Math.min(age, 3) * (wantsFresh ? 1.6 : 1.0);
        reasons.push(`names ${newest}`);
      } else if (age <= 0) {
        score += 0.6;
        reasons.push(`names ${newest}`);
      }
    }

    if (singular && looksLikeListicle(result.title)) {
      // The measured failure: a round-up ranking first for a question with one
      // right answer, read faithfully, wrong name reported.
      score -= 2.2;
      reasons.push("is a round-up");
    }

    return { index: order, result, score, reasons, years };
  });

  const best = scored.reduce((a, b) => (b.score > a.score ? b : a));
  const top = scored[0];

  return {
    index: best.index,
    result: best.result,
    // Only worth saying when we passed over the top hit — and only worth
    // naming a reason when there is one. The fallback used to read "the
    // highest-ranked result ranked first", which is not a reason, it is a
    // tautology, and it would have been handed to the model as an explanation.
    why:
      best.index === 0
        ? null
        : top.reasons.length
          ? `The highest-ranked result ${top.reasons.join(" and ")}, so this better-matching result was read instead.`
          : "This was read instead of the highest-ranked result, which matched the question less well.",
    scored,
  };
}
