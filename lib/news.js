// Local news via Google News RSS — free, no API key.
import { getLocation } from "./location.js";
import { editionFor } from "./editions.js";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#34": '"' };

function decode(str = "") {
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
      if (ENTITIES[code]) return ENTITIES[code];
      if (/^#x/i.test(code)) return String.fromCodePoint(parseInt(code.slice(2), 16));
      if (/^#/.test(code)) return String.fromCodePoint(parseInt(code.slice(1), 10));
      return match;
    })
    .replace(/<[^>]+>/g, "")
    .trim();
}

function parseRss(xml, limit) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .slice(0, limit)
    .map((match) => {
      const block = match[1];
      const grab = (tag) => decode(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(block)?.[1] ?? "");

      // Google appends " - Source Name" to every headline; strip it, we report the source separately.
      const source = grab("source");
      let title = grab("title");
      if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));

      const published = grab("pubDate");
      return {
        headline: title,
        // Deliberately NO url. Google's RSS <link> is a news.google.com shim that
        // redirects via JavaScript, so fetching it returns a page with no text —
        // measured 0 readable articles out of 3. Handing that to read_page would
        // make every "tell me more about that story" fail. The way through is to
        // search the headline and read the publisher's own page; the prompt says so.
        source: source || "unknown",
        published: published ? new Date(published).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "",
      };
    })
    // Local feeds are padded with obituaries, horoscopes and ad copy — not news.
    .filter((item) => item.headline && !/\bobituar(y|ies)\b|\bhoroscope\b|\bsponsored\b|\bclassifieds?\b/i.test(item.headline));
}

// Wire stories get picked up by a dozen outlets with near-identical headlines.
// Keep the first version of each and drop the rest.
function dedupe(stories) {
  const seen = new Set();
  return stories.filter((story) => {
    const fingerprint = story.headline
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .split(/\s+/)
      .filter((word) => word.length > 3)
      .slice(0, 7)
      .join(" ");
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}

async function fetchFeed(query, limit, edition = editionFor(null)) {
  // Either that edition's own front page, or a search inside it. The front page
  // is what "what is big there" actually means: a search — even in the right
  // edition — ranks by match rather than by importance, and the whole complaint
  // was that the stories were not the ones that mattered locally.
  const base = query
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(query)}`
    : "https://news.google.com/rss";
  const url = `${base}${query ? "&" : "?"}hl=${edition.hl}&gl=${edition.gl}&ceid=${encodeURIComponent(edition.ceid)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`news feed returned ${res.status}`);
  // Over-fetch, then dedupe down to the requested count.
  return dedupe(parseRss(await res.text(), limit * 3)).slice(0, limit);
}

/**
 * @param {object} config
 * @param {object} opts
 * @param {"local"|"national"|"world"|"topic"} [opts.scope]
 * @param {string} [opts.topic]  Free-text subject when scope is "topic"
 * @param {number} [opts.limit]
 * @param {{city:string, region?:string}} [opts.place]
 *   Somewhere other than home — the globe passes whatever you clicked on.
 */
export async function getNews(config, { scope = "local", topic = "", limit = 6, place = null, translate = null } = {}) {
  const loc = place ?? (await getLocation(config));
  const where = [loc.city, loc.region].filter(Boolean).join(" ");

  let query;
  let label;

  if (scope === "topic" && topic) {
    query = `${topic}`;
    label = topic;
  } else if (scope === "national") {
    query = "United States news when:2d";
    label = "national";
  } else if (scope === "world") {
    query = "world news when:2d";
    label = "world";
  } else {
    query = `${where} when:3d`;
    label = loc.city || "local";
  }

  const edition = editionFor(loc.countryCode);

  // Somewhere abroad gets that country's OWN front page rather than a search.
  // A search ranks by how well a story matches "Seoul, South Korea", which is
  // how the US edition produced World Youth Day 2027 while the Korean front page
  // led with the Democratic Party primaries. Importance is not relevance.
  const abroad = scope === "local" && edition.known && edition.gl !== "US";
  let stories = await fetchFeed(abroad ? "" : query, limit, edition);

  // Local searches for smaller towns sometimes come back thin — widen to the state.
  if (scope === "local" && stories.length < 3 && loc.region) {
    const extra = await fetchFeed(`${loc.region} news when:3d`, limit, edition);
    const seen = new Set(stories.map((s) => s.headline));
    stories = [...stories, ...extra.filter((s) => !seen.has(s.headline))].slice(0, limit);
  }

  // Turning them into English is the caller's job, because it needs the model
  // and this module has never needed one. Injected rather than imported so the
  // feed can still be read — and tested — with no brain running at all.
  let translated = false;
  if (edition.translate && stories.length && typeof translate === "function") {
    try {
      const englished = await translate(stories.map((s) => s.headline), edition.language);
      if (Array.isArray(englished) && englished.length === stories.length) {
        stories = stories.map((s, i) => ({
          ...s,
          headline: String(englished[i] ?? s.headline).trim() || s.headline,
          // Kept, and not decoration: it is the evidence for the translation,
          // and the thing to quote if somebody disputes it.
          original: s.headline,
        }));
        translated = true;
      }
    } catch (err) {
      // Untranslated Korean is useless to a speech synthesiser, but silently
      // dropping the stories would leave him saying there is no news in Korea.
      // Hand them over as they are and let the caller say what happened.
      console.warn(`[news] couldn't translate ${edition.language} headlines: ${err.message}`);
    }
  }

  return {
    scope: label,
    location: where,
    stories,
    // Said plainly so nothing downstream can present a translation as the
    // original wording, or a foreign front page as an English-language one.
    edition: edition.known ? `${edition.gl} (${edition.language})` : null,
    language: edition.language,
    translated,
    needsTranslation: edition.translate && !translated,
  };
}

// Used by the no-API-key fallback mode.
export function newsToSentence(news, count = 3) {
  if (!news.stories.length) return `I couldn't pull up any ${news.scope} headlines right now.`;
  const top = news.stories.slice(0, count);
  const lines = top.map((s, i) => `${i + 1}. ${s.headline}, from ${s.source}.`);
  return `Here are the top ${news.scope} headlines. ${lines.join(" ")}`;
}
