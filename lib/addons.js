// Channels people add themselves.
//
// A folder in `channels/` is a channel. Nothing is registered, imported or
// edited: the folder IS the registration, which is how `personas/` and
// `voices/` already work — drop a .json in one and the character exists, drop a
// .wav in the other and the voice exists. Channels were the one part of the set
// that still needed a code change in three separate files, and this closes it.
//
//   channels/tides/
//     channel.json    what it is called, where the data comes from
//     render.js       optional — draw(ctx, x, y, w, h, view)
//
// The declarative half matters more than the renderer. `lib/programmes.js`
// already gives every channel in-flight de-duplication, stale-on-error and a
// server-stated poll interval; describing a feed as a URL means an add-on gets
// all three without writing a line of server code, and without a fourth bespoke
// endpoint appearing in server.js.
//
// **A channel.json is as trusted as config.json — and no more.** It is a file
// on the user's own disk, the same footing personas sit on. But "trusted" and
// "allowed to say anything" are different: every string is capped, the poll
// interval has a floor, and the URL is checked, because the person who wrote
// the file and the person running it are not always the same once packs get
// shared.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const ADDON_FOLDER = path.join(ROOT, "channels");

// The built-in channels occupy 1..13. Add-ons start after whatever the last one
// is, so installing one can never renumber a channel somebody has learned.
// Their own numbers shift if a FOLDER is added or removed, which is why ids and
// names are what everything else keys off.
export const FIRST_ADDON_NUMBER = 100;

// Floors and ceilings. Every one of these exists because the file is hand-
// written and a typo must cost the typo rather than the machine.
const MIN_POLL_MS = 10_000; // `config.alerts.pollMs` has the same kind of floor
const MAX_NAME = 24;
const MAX_DESCRIPTION = 48;
const MAX_ALIASES = 8;
const MAX_ALIAS = 32;

/**
 * Ports this machine's own services listen on.
 *
 * A channel that fetches from Greg's own API, his Whisper, his Piper, his clone
 * or Ollama is not fetching a feed — it is poking the machine it runs on, and a
 * shared pack has no business doing that. `lib/readpage.js` refuses private
 * addresses for the same reason and this is the same class of input, one step
 * further from the user's own hands.
 *
 * Other localhost ports are ALLOWED on purpose: somebody's home server is a
 * perfectly good source for a channel, and refusing it would rule out the most
 * interesting thing a person could build here.
 */
const OWN_PORTS = new Set(["4747", "4748", "4749", "4750", "11434"]);

const text = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Is this somewhere a channel may fetch from?
 *
 * Returns a reason rather than a boolean, because a channel that silently does
 * not appear is the worst outcome for somebody who has just written one — the
 * whole point of the folder being the registration is that it either works or
 * says why.
 */
export function checkUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return "the url is not a valid address";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return `${url.protocol} is not a protocol I will fetch`;
  }
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (local && OWN_PORTS.has(url.port)) {
    return `port ${url.port} is one of Greg's own services, not a feed`;
  }
  return null;
}

/**
 * Fill {lat}, {lon} and {city} from wherever the user is.
 *
 * This is most of why a declarative feed is worth having: nearly every channel
 * anybody would write is "this data, for where I am", and without it every
 * add-on would need its own copy of the location plumbing.
 */
export function fillUrl(template, place = {}) {
  return String(template)
    .replaceAll("{lat}", encodeURIComponent(place.latitude ?? ""))
    .replaceAll("{lon}", encodeURIComponent(place.longitude ?? ""))
    .replaceAll("{city}", encodeURIComponent(place.city ?? ""));
}

/** Walk a dotted path into a fetched payload, e.g. "properties.periods". */
export function pick(data, dotted) {
  if (!dotted) return data;
  let value = data;
  for (const key of String(dotted).split(".")) {
    if (value === null || value === undefined) return null;
    value = value[key];
  }
  return value ?? null;
}

/**
 * Turn one folder's channel.json into something CHANNELS and PROGRAMMES accept.
 *
 * Returns `{ channel, problems }`. A file with problems still produces a
 * channel where it can — a missing description is not a reason to make somebody
 * a channel disappear — but anything that would break the set (no name, an
 * unusable url) refuses the whole thing and says so.
 */
export function parseAddon(id, raw, index = 0) {
  const problems = [];
  const name = text(raw?.name, MAX_NAME) || text(id.replace(/[-_]+/g, " "), MAX_NAME);
  if (!name) {
    return { channel: null, problems: [`${id}: no name, and none could be made from the folder name`] };
  }

  const aliases = Array.isArray(raw?.aliases)
    ? raw.aliases.map((a) => text(a, MAX_ALIAS).toLowerCase()).filter(Boolean).slice(0, MAX_ALIASES)
    : [];
  // The folder name and the channel name always work, so a channel is reachable
  // by voice even when its file lists no aliases at all.
  for (const implied of [name.toLowerCase(), id.replace(/[-_]+/g, " ")]) {
    if (implied && !aliases.includes(implied)) aliases.push(implied);
  }

  let feed = null;
  if (raw?.fetch?.url) {
    const problem = checkUrl(fillUrl(raw.fetch.url, { latitude: 0, longitude: 0, city: "x" }));
    if (problem) {
      return { channel: null, problems: [`${id}: ${problem}`] };
    }
    feed = {
      url: String(raw.fetch.url),
      pick: raw.fetch.pick ? String(raw.fetch.pick) : null,
      // Clamped, not trusted. A channel asking for a 200 ms poll is a typo, and
      // the cost of honouring it lands on somebody else's free service.
      pollMs: Math.max(MIN_POLL_MS, Math.round(Number(raw.fetch.everySeconds ?? 300) * 1000) || 300_000),
    };
  } else {
    problems.push(`${id}: no fetch.url, so this channel will show whatever its renderer draws with no data`);
  }

  return {
    channel: {
      number: FIRST_ADDON_NUMBER + index,
      id,
      name,
      feed: feed ? id : null,
      aliases,
      description: text(raw?.description, MAX_DESCRIPTION) || name.toLowerCase(),
      // Everything below this line is add-on only; the built-ins have no such
      // fields and nothing in the core reads them.
      addon: true,
      fetch: feed,
      // How to draw it when there is no render.js. See public/channels/addon.js.
      display: raw?.display && typeof raw.display === "object" ? raw.display : null,
      folder: id,
    },
    problems,
  };
}

/**
 * Every add-on channel on disk, in a stable order.
 *
 * Sorted by folder name so the numbering does not depend on how the filesystem
 * feels — two machines with the same folders get the same channel numbers.
 * A missing `channels/` folder is not an error; it is the normal state.
 */
export function loadAddons({ folder = ADDON_FOLDER } = {}) {
  let entries = [];
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return { channels: [], problems: [] };
  }

  const channels = [];
  const problems = [];

  for (const name of entries) {
    const file = path.join(folder, name, "channel.json");
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      // Named out loud. A folder somebody has just created and which silently
      // does nothing is the single most frustrating way for this to fail.
      problems.push(`${name}: ${err.code === "ENOENT" ? "no channel.json in that folder" : `channel.json is not valid JSON — ${err.message}`}`);
      continue;
    }

    const id = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!id) {
      problems.push(`${name}: that folder name leaves nothing to call the channel`);
      continue;
    }

    const { channel, problems: theirs } = parseAddon(id, raw, channels.length);
    problems.push(...theirs);
    if (channel) {
      channel.hasRenderer = fs.existsSync(path.join(folder, name, "render.js"));
      channels.push(channel);
    }
  }

  return { channels, problems };
}

/**
 * The loader an add-on's feed gets, in the shape lib/programmes.js expects.
 *
 * Everything the registry gives a built-in — de-duplication, stale-on-error, a
 * server-stated poll interval — applies to whatever this returns, so an add-on
 * costs its author a URL rather than a caching strategy.
 */
export function addonLoader(channel, { fetchImpl = fetch, locate = null } = {}) {
  return async (config) => {
    // Resolved here rather than passed in, because lib/programmes.js calls
    // every loader as load(config) — matching that signature is what lets an
    // add-on sit in the registry beside the built-ins with nothing special
    // about it. `locate` is injectable so this is testable without a network.
    const place = channel.fetch.url.includes("{") ? await (locate ?? (async () => ({})))(config) : {};
    const url = fillUrl(channel.fetch.url, place ?? {});
    const problem = checkUrl(url);
    // Re-checked with the real values in place: a template that passed with a
    // stand-in city can still resolve to something else once filled.
    if (problem) return { error: problem, retryable: false };

    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`${channel.name} feed returned ${res.status}`);

    const body = await res.text();
    // A feed that hands back a megabyte would be carried in memory and pushed
    // through the event stream on every poll. Bounded here rather than trusted.
    if (body.length > 512_000) throw new Error(`${channel.name} sent more data than a channel should`);

    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error(`${channel.name} did not send JSON`);
    }

    return { data: pick(data, channel.fetch.pick), place: place?.city ?? null };
  };
}
