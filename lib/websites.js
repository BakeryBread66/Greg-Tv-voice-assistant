// Opening a website, without ever letting a model choose a URL.
//
// This is a different kind of risk from lib/readpage.js and it is worth being
// explicit about why. read_page pulls text INTO the model: a hostile page costs
// you a bad answer. Opening a URL puts a page into the user's real browser,
// carrying their real sessions — and URLs reach the model from search results
// and fetched articles, which readpage.js already labels as written by
// strangers. A model talked into READING a link is a much smaller problem than
// a model talked into OPENING one.
//
// So the model never handles a URL. It names a site from a fixed list and
// optionally supplies search words, and the URL is built here. That makes the
// dangerous case unreachable rather than discouraged, which is the same choice
// lib/vision.js makes by withdrawing the screen tool from a model that fails
// its eyesight test: a tool it does not have is one it cannot misuse.
//
// It is also cheaper. A free-form url parameter would need warnings around it
// that cost more tokens every turn than this whole list does.

import { spawn } from "node:child_process";

/**
 * Where each name goes, and how it searches.
 *
 * `search` is a template rather than a flag so a site whose search lives on a
 * different host, or under a different query name, needs no special case. A
 * site with no template simply ignores search words rather than pretending.
 */
export const SITES = {
  youtube: { label: "YouTube", home: "https://www.youtube.com", search: "https://www.youtube.com/results?search_query={q}" },
  google: { label: "Google", home: "https://www.google.com", search: "https://www.google.com/search?q={q}" },
  wikipedia: { label: "Wikipedia", home: "https://en.wikipedia.org", search: "https://en.wikipedia.org/w/index.php?search={q}" },
  maps: { label: "Google Maps", home: "https://www.google.com/maps", search: "https://www.google.com/maps/search/{q}" },
  github: { label: "GitHub", home: "https://github.com", search: "https://github.com/search?q={q}" },
  reddit: { label: "Reddit", home: "https://www.reddit.com", search: "https://www.reddit.com/search/?q={q}" },
};

export const SITE_NAMES = Object.keys(SITES);

/**
 * The URL for a site, with optional search words.
 *
 * Returns null for a site that is not on the list, which the caller must report
 * rather than paper over — silently opening something else would be the "a
 * voice this machine does not have is SAID, never substituted" rule in a place
 * where the substitution lands in somebody's browser.
 */
export function siteUrl(site, search = "") {
  // Fold case and spacing the way persona and voice names are folded: nobody
  // says "you tube" the same way twice, and the model is not reliable about it.
  const key = String(site ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  const entry = SITES[key] ?? SITES[Object.keys(SITES).find((k) => k === key)];
  if (!entry) return null;

  const words = String(search ?? "").trim();
  if (!words || !entry.search) return { url: entry.home, label: entry.label, searched: false };

  return {
    url: entry.search.replace("{q}", encodeURIComponent(words)),
    label: entry.label,
    searched: true,
  };
}

/**
 * Open a resolved URL in the user's ordinary browser.
 *
 * Deliberately NOT the app-mode window server.js opens Greg in. That window has
 * no address bar, no reload and no permission UI — fine for Greg himself, and
 * exactly wrong for a page somebody is about to browse. `start` hands it to
 * whatever browser they actually use.
 */
export function openUrl(url) {
  if (!/^https:\/\//.test(url)) throw new Error(`refusing to open a non-https address: ${url}`);
  // The empty "" is start's title argument. Without it a quoted URL is taken AS
  // the title and nothing opens.
  spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
}
