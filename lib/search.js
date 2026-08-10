// Web search — no API key, no account.
//
// DuckDuckGo's no-JavaScript endpoint for general queries, with Wikipedia as a
// backstop (more reliable for factual lookups, and it keeps working if DDG ever
// changes its markup).

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#34": '"' };

function clean(html = "") {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
      if (ENTITIES[code]) return ENTITIES[code];
      if (/^#x/i.test(code)) return String.fromCodePoint(parseInt(code.slice(2), 16));
      if (/^#/.test(code)) return String.fromCodePoint(parseInt(code.slice(1), 10));
      return match;
    })
    .replace(/\s+/g, " ")
    .trim();
}

// DDG wraps every result in a redirect: /l/?uddg=<encoded real url>
//
// Returns the URL as well as the host. It used to return only the hostname and
// drop the link, which meant a result could be reported but never opened — and
// since snippets are written to withhold the answer, that left Greg permanently
// one click short of the thing he had just found.
function realLink(href = "") {
  try {
    const encoded = /[?&]uddg=([^&]+)/.exec(href)?.[1];
    const raw = encoded ? decodeURIComponent(encoded) : href;
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
    return { url: url.toString(), source: url.hostname.replace(/^www\./, "") };
  } catch {
    return { url: "", source: "" };
  }
}

async function duckduckgo(query, limit) {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`search returned ${res.status}`);
  const html = await res.text();

  const titles = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => clean(m[1]));

  return titles.slice(0, limit).map((m, i) => ({
    title: clean(m[2]),
    snippet: snippets[i] ?? "",
    ...realLink(m[1]),
  }));
}

async function wikipedia(query, limit) {
  const url =
    `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*` +
    `&srsearch=${encodeURIComponent(query)}&srlimit=${limit}`;
  const res = await fetch(url, { headers: { "User-Agent": "GregVoiceAssistant/1.0" }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`wikipedia returned ${res.status}`);

  const hits = ((await res.json()).query?.search ?? []).slice(0, limit);

  // Search snippets alone are usually just the article's opening boilerplate,
  // which rarely contains the actual answer. Pull each article's summary
  // instead — that's where the facts live.
  return await Promise.all(
    hits.map(async (hit) => {
      let extract = clean(hit.snippet);
      try {
        const page = await fetch(
          `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit.title.replace(/ /g, "_"))}`,
          { headers: { "User-Agent": "GregVoiceAssistant/1.0" }, signal: AbortSignal.timeout(8000) }
        );
        if (page.ok) {
          const summary = await page.json();
          if (summary.extract) extract = summary.extract;
        }
      } catch {
        // keep the search snippet
      }
      return {
        title: hit.title,
        snippet: extract.slice(0, 600),
        source: "en.wikipedia.org",
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, "_"))}`,
      };
    })
  );
}

/**
 * Search the web.
 * @returns {Promise<{query: string, results: Array<{title, snippet, source}>}>}
 */
export async function searchWeb(query, { limit = 4 } = {}) {
  const q = String(query ?? "").trim();
  if (!q) throw new Error("nothing to search for");

  let results = [];

  // DuckDuckGo throttles bursts of requests and answers with an empty page.
  // One short retry clears that up most of the time.
  for (let attempt = 0; attempt < 2 && !results.length; attempt++) {
    try {
      if (attempt) await new Promise((r) => setTimeout(r, 1200));
      results = await duckduckgo(q, limit);
    } catch (err) {
      console.warn(`[search] duckduckgo attempt ${attempt + 1} failed: ${err.message}`);
    }
  }

  if (!results.length) {
    console.warn("[search] duckduckgo gave nothing, falling back to wikipedia");
    try {
      results = await wikipedia(q, limit);
    } catch (err) {
      throw new Error(`search is unavailable right now (${err.message})`);
    }
  }

  results = results.filter((r) => r.title);

  return {
    query: q,
    results,
    // Told plainly so Greg says "I couldn't find that" instead of inventing one.
    note: results.length ? undefined : "No results found. Tell the user you couldn't find this rather than answering from memory.",
  };
}
