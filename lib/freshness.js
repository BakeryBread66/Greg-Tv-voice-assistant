// How old is this, and does the question care?
//
// The failure this exists for is subtle and was documented for three sessions
// before anyone fixed it: Greg reads last year's version of a story and reports
// it as current. Every word is faithful to its source, nothing is fabricated,
// and the answer is still wrong. It is harder to catch than a made-up fact
// precisely because there is nothing false in it.
//
// It is live in the very query CLAUDE.md uses as its example. Searching for the
// USA TODAY breakfast ranking returns, in one result set:
//
//     yahoo.com          2026-08-05   <- this year's
//     cardinalpine.com   2026-08-05   <- this year's
//     timeout.com        2025-07-23   <- last year's
//     charlotteobserver  2025-07-18   <- last year's
//
// DuckDuckGo's no-JS endpoint carries no dates whatsoever — no date classes, no
// date-prefixed snippets, nothing (measured). So recency cannot be judged from
// the search listing at all; it has to come off the page.
//
// The fix is in two halves, and the first matters more:
//
//   1. ALWAYS say how old it is. A dated answer — "as of last July" — is correct
//      and honest even when it is not the newest story. This is the half that
//      turns a wrong answer into a right one.
//   2. When the question asked for currency and the page turns out to be old,
//      spend one more fetch on the next candidate. This half improves the odds;
//      it is not what makes the answer honest.

// ---------------------------------------------------------------------------
// Reading the date off a page
// ---------------------------------------------------------------------------

// Measured against the real result set above, plus AP. `datePublished` in the
// JSON-LD block hit 4/4; `<time datetime>` 3/4. A date in the URL path hit
// **0/4** and is deliberately not implemented — it is the obvious signal and it
// earns nothing on real news pages.
//
// Ordered by trustworthiness, not by convenience: a publisher's structured data
// is a deliberate statement about the article, while the first <time> on the
// page might belong to a "related stories" rail.
const PUBLISHED_SIGNALS = [
  (h) => /"datePublished"\s*:\s*"([^"]{4,40})"/i.exec(h)?.[1],
  (h) => /<meta[^>]+(?:property|name)=["']article:published_time["'][^>]*content=["']([^"']+)["']/i.exec(h)?.[1],
  (h) => /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']article:published_time["']/i.exec(h)?.[1],
  (h) => /<meta[^>]+(?:property|name)=["'](?:parsely-pub-date|pubdate|publish-date|publication_date)["'][^>]*content=["']([^"']+)["']/i.exec(h)?.[1],
  (h) => /<time[^>]+datetime=["']([^"']+)["']/i.exec(h)?.[1],
];

const UPDATED_SIGNALS = [
  (h) => /"dateModified"\s*:\s*"([^"]{4,40})"/i.exec(h)?.[1],
  (h) => /<meta[^>]+(?:property|name)=["'](?:article:modified_time|og:updated_time|last-modified)["'][^>]*content=["']([^"']+)["']/i.exec(h)?.[1],
];

/** First signal that yields a date that could actually be real. */
function firstDate(signals, html, now) {
  for (const signal of signals) {
    let raw;
    try {
      raw = signal(html);
    } catch {
      continue;
    }
    if (!raw) continue;

    const at = new Date(raw);
    if (Number.isNaN(at.getTime())) continue;

    // A date in the future, or from before the web, is a parse that went wrong
    // rather than a fact. One day of slack for timezones.
    const ahead = (at.getTime() - now.getTime()) / 86400000;
    if (ahead > 1 || at.getUTCFullYear() < 1995) continue;

    return at.toISOString().slice(0, 10);
  }
  return null;
}

// A page edited more than this after it was written is one that gets maintained,
// not one that was published once. News articles sit far below it — their
// modified time is minutes or hours after publication, usually a typo fix.
const MAINTAINED_DAYS = 30;

/**
 * When a page was written, and when it was last touched.
 *
 * Both, because they answer different questions and a Wikipedia article proves
 * it: `datePublished` is **2007** — the day the article was created — while
 * `dateModified` is last month. Reading only the first, Greg called a
 * continuously-edited page nineteen years out of date, which is worse than
 * saying nothing. Reading only the second would strip the citation date off a
 * news story that had a typo fixed after publication.
 *
 * Null means "this page does not say", which is a real answer and a different
 * one from "old". Never guess: a wrong date attached to a right fact is the
 * fabricated-citation failure wearing a hat.
 */
export function pageDates(html, now = new Date()) {
  const text = String(html ?? "");
  const published = firstDate(PUBLISHED_SIGNALS, text, now);
  const updated = firstDate(UPDATED_SIGNALS, text, now);

  // An "update" before publication is a parse mismatch, not a fact.
  const sane = updated && published && updated < published ? null : updated;
  return { published, updated: sane };
}

// ---------------------------------------------------------------------------
// Saying how old it is
// ---------------------------------------------------------------------------

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "23 July 2025" — spelled out, because a bare 2025-07-23 gets read aloud digit by digit. */
export function spokenDate(iso) {
  const at = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return iso;
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
}

/** Whole days between two ISO days, positive meaning in the past. */
export function ageInDays(iso, now = new Date()) {
  const at = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return null;
  return Math.floor((now.getTime() - at.getTime()) / 86400000);
}

/**
 * How old, in words the model can copy rather than compute.
 *
 * Same lesson as spokenPercent in lib/stocks.js: handed `changePercent: 0.29` a
 * small model said "two point nine percent" one run in three. Give it something
 * to copy, not something to convert — so this returns "about 13 months ago",
 * not a day count for it to divide.
 */
export function describeAge(iso, now = new Date()) {
  const days = ageInDays(iso, now);
  if (days === null) return "";
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `about ${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `about ${Math.round(days / 30)} months ago`;
  const years = days / 365;
  if (years < 1.5) return "about a year ago";
  return `about ${Math.round(years)} years ago`;
}

// Older than this and a story is not "the latest" anything. Deliberately a soft
// number rather than a knife edge: the ONLY thing it decides is whether to spend
// one more fetch looking for something newer. The honesty comes from stating the
// date every time, which happens regardless of this value — so getting it wrong
// costs a request, never an answer.
export const STALE_DAYS = 180;

/**
 * Everything downstream needs about a page's age, from its HTML.
 *
 * `label` is the phrase to put in front of the article text and `note` is the
 * sentence handed to the model — and both exist rather than a raw date because
 * every prompt instruction this project has tried for this class of problem has
 * failed about one time in three. The date is not *described* to the model, it
 * is put in front of it with the conclusion already drawn.
 */
export function freshnessOf(html, now = new Date()) {
  const { published, updated } = pageDates(html, now);

  // Currency is judged on the last time anyone touched it; the citation date
  // stays the day it was written.
  const effective = updated ?? published;
  const ageDays = effective ? ageInDays(effective, now) : null;
  const maintained =
    published && updated && (ageInDays(published, now) - ageInDays(updated, now)) > MAINTAINED_DAYS;

  let label = null;
  if (published && maintained) label = `Published ${spokenDate(published)}, last updated ${spokenDate(updated)}`;
  else if (published) label = `Published ${spokenDate(published)}`;
  else if (updated) label = `Last updated ${spokenDate(updated)}`;

  let note;
  if (!effective) {
    // An absent date means two different things — this page carries none, and
    // nobody looked — and a model handed silence fills it. Same shape as the
    // empty-alert-list bug: say which, loudly.
    note =
      "This page gives no publication date. Do not describe it as current, recent, or this year's — " +
      "say you don't know when it was written if it matters.";
  } else if (ageDays > STALE_DAYS) {
    note =
      `${label} — ${describeAge(effective, now)}. This is NOT current. Say when it was published whenever ` +
      `you use it, and do not call it the latest, the newest, or this year's.`;
  } else {
    note = `${label} (${describeAge(effective, now)}). Say the date if the answer depends on when it was written.`;
  }

  return {
    published: published ?? null,
    updated: updated ?? null,
    ageDays,
    age: effective ? describeAge(effective, now) : null,
    stale: ageDays !== null && ageDays > STALE_DAYS,
    label,
    note,
  };
}

// ---------------------------------------------------------------------------
// Does the question care?
// ---------------------------------------------------------------------------

// "What is the tallest mountain" does not want the newest page; "what is the
// latest on the strike" does. Same shape as adviceRule and the deixis gate: no
// trigger, no extra work, nothing for the model to get wrong.
//
// Word-boundary matched, so "cabinet reshuffle" does not match "new" and
// "nowhere" does not match "now".
const WANTS_FRESH =
  /\b(latest|newest|current|currently|recent|recently|today|tonight|yesterday|this (week|month|year|morning|season)|right now|now|so far|update|updated|news|breaking|202\d|last (week|night)|still|these days|at the moment)\b/i;

/** Did the question ask for something current? */
export function freshnessWanted(query) {
  return WANTS_FRESH.test(String(query ?? ""));
}

// ---------------------------------------------------------------------------
// The code gate — because asking the model was measured failing
// ---------------------------------------------------------------------------
//
// Everything above gets the date to the model reliably: it is the first words of
// the article text and it is spelled out in the note. Measured over six runs on
// a genuinely year-old page, that was enough to stop him calling it current
// **6/6** — the harmful failure is gone.
//
// It was NOT enough to make him say when it was written: **2/6**. Which is the
// same one-in-three that every prompt instruction in this project has scored,
// arriving for the eighth time. So the date is added in code when he leaves it
// out, exactly as greetingFor() is prepended and the reminder correction is
// appended — two prompt rewrites scored nothing there and one code gate scored
// 3/3.

const MONTH_WORDS = MONTHS.map((m) => m.toLowerCase()).join("|");

/**
 * Did the reply already say WHEN this was written?
 *
 * Deliberately about the date and not about age. "This is about a year old"
 * tells the user it is stale without telling them when, and the caveat's whole
 * job is to supply the date — so a vague gesture at age does NOT suppress it.
 * A month, a year, or "last year" does, because each of those a listener can
 * actually pin to a point in time.
 */
export function mentionsDate(reply, iso) {
  const text = String(reply ?? "").toLowerCase();
  if (/\blast year\b/.test(text)) return true;
  if (new RegExp(`\\b(${MONTH_WORDS})\\b`).test(text)) return true;

  if (!iso) return false;
  const year = iso.slice(0, 4);
  if (text.includes(year)) return true;

  // He writes numbers as words, being a voice assistant — "two thousand twenty
  // five", "twenty twenty-five". A scorer that looked only for digits reported
  // 0/3 on three transcripts that had all named the date correctly.
  const spoken = ["two thousand", "twenty"].some((prefix) => text.includes(prefix)) && /twenty[- ]?(five|six|four|three)/.test(text);
  return spoken;
}

/**
 * The stale page a tool result was built on, if any.
 *
 * Handles both shapes: read_page returns the page itself, search_web wraps it
 * in topResult.
 */
export function staleSourceIn(result) {
  const page = result?.topResult ?? result;
  if (!page || typeof page !== "object") return null;
  if (!page.stale || !page.published) return null;
  return { published: page.published, age: page.age ?? null, source: page.source ?? null };
}

/**
 * The sentence to append when he answered off a stale page without saying so.
 *
 * Returns "" when there is nothing to add — no stale source, or he already
 * dated it himself.
 */
export function stalenessCaveat(reply, stale) {
  if (!stale?.published) return "";
  if (mentionsDate(reply, stale.published)) return "";
  return `That was published ${spokenDate(stale.published)}, ${stale.age ?? "a while ago"}, so there may be something newer.`;
}

/**
 * Is it worth one more fetch to look for something newer?
 *
 * A pure gate rather than an `if` buried in the tool handler, so the decision
 * can be proven without a network — the handler around it cannot be.
 *
 * Three conditions, all required: the question asked for currency, the page we
 * read has a date at all (no date is not evidence of age), and that date is old.
 */
export function shouldTrySecond(query, ageDays) {
  if (ageDays === null || ageDays === undefined) return false;
  if (ageDays <= STALE_DAYS) return false;
  return freshnessWanted(query);
}
