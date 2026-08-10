// What each channel is actually SHOWING, as opposed to which channel is on.
//
// lib/channels.js owns the switch. This owns the picture: one entry per channel
// that has live data behind it, saying where the data comes from and how often
// it is worth asking again.
//
// It exists so that adding a channel stays what CLAUDE.md promised it would be —
// one entry in CHANNELS, one entry here, one renderer — rather than growing a
// fourth bespoke endpoint in server.js with its own cache and its own idea of
// what "stale" means. The now-playing channel predates this and keeps its own
// route, because it is genuinely different: it owns a live PowerShell process
// and hands back a few hundred KB of album art.
//
// Three properties every entry gets for free, and all three were learned
// elsewhere in this project:
//
//   - **In-flight de-duplication.** Two windows on the same channel must not
//     spend two of NASA's fifty daily requests to be told the same thing.
//   - **Stale on error.** A feed that blinks should not blank the screen. The
//     last good picture stays up, marked stale, which is what a television does.
//   - **A poll interval the SERVER states.** The page asks how often to come
//     back rather than deciding for itself, so the rate limit is enforced in the
//     one place that knows about it.

import { getNews } from "./news.js";
import { getNwsReport } from "./nws.js";
import { getWeather } from "./weather.js";
import { getApod } from "./apod.js";
import { getSpaceWeather } from "./spacewx.js";
import { getRadar } from "./radar.js";
import { getStocks } from "./stocks.js";
import { getOverhead } from "./overhead.js";
import { listReminders } from "./reminders.js";
import { getEngineering } from "./engineering.js";
import { sunAndMoon } from "./sunmoon.js";
import { getAirQuality } from "./airquality.js";
import { getLocation } from "./location.js";

/**
 * `pollMs` is what the browser is told to wait between requests while the
 * channel is up. `ttlMs` is how long a fetched answer is served from memory —
 * they are different numbers on purpose, so several viewers polling on their own
 * clocks still only cost one trip to the source.
 */
export const PROGRAMMES = {
  ceefax: {
    pollMs: 60000,
    ttlMs: 240000,
    load: (config) => loadCeefax(config),
  },
  weather: {
    pollMs: 60000,
    // A forecast is reissued a few times a day and alerts rather more often.
    // Four minutes is well inside both and keeps api.weather.gov comfortable.
    ttlMs: 240000,
    load: (config) => loadWeather(config),
  },
  apod: {
    // Once an hour. The picture changes once a DAY, and the keyless demo key
    // allows fifty requests in that time across everything sharing this IP.
    pollMs: 900000,
    ttlMs: 3600000,
    load: (config) => getApod(config),
  },
  spacewx: {
    pollMs: 60000,
    ttlMs: 120000,
    load: (config) => loadSpaceWeather(config),
  },
  stocks: {
    // Sized for an open market. The loader returns `preferredPollMs` and slows
    // itself right down outside trading hours — see below.
    pollMs: 60000,
    ttlMs: 45000,
    load: (config) => getStocks(config),
  },
  agenda: {
    // The only channel that touches no network at all — it reads Greg's own
    // reminder store. Polled often because it costs nothing and because a timer
    // set by voice while the channel is up should appear on it promptly; the
    // countdown itself is interpolated in the renderer between polls.
    pollMs: 15000,
    ttlMs: 5000,
    load: () => loadAgenda(),
  },
  engineering: {
    // Fast, because a meter that updates every minute is a screenshot. This
    // touches no network — nvidia-smi answers in ~180 ms and Ollama's /api/ps
    // is on this machine — and the page only polls while the channel is up, so
    // the cost is bounded by someone actually watching it.
    pollMs: 2000,
    ttlMs: 1500,
    load: (config) => getEngineering(config),
  },
  sunmoon: {
    // The slowest poll on the set, and the only channel that makes NO request
    // of anything: it is arithmetic on a date and a coordinate. Sunrise moves by
    // a minute or two a day, so even five minutes is generous — it exists to
    // cross midnight and to catch the location changing, not to animate.
    pollMs: 300000,
    ttlMs: 240000,
    load: async (config) => sunAndMoon(await getLocation(config)),
  },
  air: {
    // Open-Meteo publishes hourly and is unmetered in practice, so this is
    // paced by how often the number can actually change rather than by a quota.
    pollMs: 300000,
    ttlMs: 240000,
    load: (config) => getAirQuality(config),
  },
  flights: {
    // The tightest of any channel's discipline, and the only one where the
    // QUOTA rather than politeness sets the number: OpenSky allows roughly 400
    // anonymous requests a day, so an hour with this channel up costs about
    // sixty of them. The TTL matches lib/flights.js's own cache, so a second
    // window costs nothing at all.
    pollMs: 60000,
    ttlMs: 45000,
    load: (config) => getOverhead(config),
  },
  radar: {
    // The station publishes a new sweep about every two minutes, so this is the
    // one channel where polling faster than the source would be pure waste.
    // lib/radar.js has its own floor under this as well.
    pollMs: 60000,
    ttlMs: 60000,
    load: (config) => getRadar(config),
  },
};

const cache = new Map(); // id -> { data, at, inFlight }

/**
 * The current picture for a channel.
 *
 * Never throws for a channel that has worked once: a source going down returns
 * the last good reading with `stale` set, and the renderers show that as a
 * caption rather than as a fault. Only a channel that has NEVER loaded reports
 * an error, because there is genuinely nothing else to show.
 */
/**
 * Register a channel somebody dropped into `channels/`.
 *
 * The whole point of doing it this way: an add-on gets in-flight
 * de-duplication, stale-on-error and a server-stated poll interval — the three
 * properties described at the top of this file — for the price of a URL in a
 * JSON file. Nothing about the caching had to be written twice, and there is
 * still no fourth bespoke endpoint in server.js.
 */
export function addProgramme(id, { load, pollMs = 300_000, ttlMs = null }) {
  PROGRAMMES[id] = {
    load,
    pollMs,
    // Slightly under the poll, so a second window arriving just behind the
    // first is served from cache rather than starting its own request.
    ttlMs: ttlMs ?? Math.max(1000, pollMs - 5000),
  };
}

export async function getProgramme(id, config) {
  const programme = PROGRAMMES[id];
  if (!programme) return { error: `no programme called "${id}"` };

  const entry = cache.get(id) ?? { data: null, at: 0, inFlight: null };
  cache.set(id, entry);

  const fresh = entry.data && Date.now() - entry.at < programme.ttlMs;
  if (fresh) return withMeta(id, entry.data, programme, entry.at);

  if (!entry.inFlight) {
    entry.inFlight = programme
      .load(config)
      .then((data) => {
        entry.data = data;
        entry.at = Date.now();
        entry.error = null;
        return data;
      })
      .catch((err) => {
        entry.error = err.message;
        // Push the clock forward on a failure too, or a dead source is retried
        // on every single poll — which is how a rate limit becomes permanent.
        entry.at = Date.now();
        if (entry.data) return entry.data;
        throw err;
      })
      .finally(() => {
        entry.inFlight = null;
      });
  }

  try {
    const data = await entry.inFlight;
    return withMeta(id, data, programme, entry.at, entry.error);
  } catch (err) {
    return { id, error: err.message, pollMs: programme.pollMs };
  }
}

function withMeta(id, data, programme, at, error = null) {
  return {
    ...data,
    id,
    // `fetchedAt`, not `at`. The first version used `at` and silently clobbered
    // the space weather reading's OWN `at` — the timestamp NOAA stamped on the
    // measurement — with the moment this cache happened to fill. Both are real
    // times and they are minutes apart, so nothing would have looked wrong; the
    // channel would just have quietly credited NOAA with a reading time it
    // never gave. Envelope fields have to be named so they cannot land on a
    // payload's.
    fetchedAt: at,
    // The page reads this and sets its own timer from it, so a rate limit is
    // enforced where it is understood rather than guessed at in the browser.
    //
    // A loader may override it, because some know their own cadence better than
    // the registry can: the market feed drops to a quarter-hour once the
    // exchange has shut, since asking every minute for a number that last
    // changed on Friday afternoon is noise on somebody else's server. Named
    // `preferredPollMs` rather than `pollMs` so it is an explicit request rather
    // than a payload field that happens to collide with the envelope — the trap
    // `fetchedAt` exists to avoid.
    pollMs: data?.preferredPollMs ?? programme.pollMs,
    // `stale` means "this is real, just not current". Distinct from `error`,
    // which means there is nothing to show at all.
    stale: Boolean(error) || Boolean(data?.stale),
    warning: error ?? data?.warning ?? null,
  };
}

/** Drop everything, so a settings change (a new location) is picked up at once. */
export function clearProgrammes() {
  cache.clear();
}

// ---------------------------------------------------------------------------
// The channels themselves
// ---------------------------------------------------------------------------

/**
 * Ceefax: three pages of headlines, cycled by the renderer.
 *
 * Page numbers because that is how teletext worked and because they give the
 * cycle something to count — 101 home, 102 national, 103 world, the way the BBC
 * actually numbered them. The three feeds are settled independently so a thin
 * local feed does not cost you the world page.
 */
async function loadCeefax(config) {
  const [local, national, world] = await Promise.allSettled([
    getNews(config, { scope: "local", limit: 7 }),
    getNews(config, { scope: "national", limit: 7 }),
    getNews(config, { scope: "world", limit: 7 }),
  ]);

  const page = (number, title, result) => ({
    number,
    title,
    stories: result.status === "fulfilled" ? result.value.stories : [],
    failed: result.status === "rejected" ? result.reason.message : null,
  });

  const loc = await getLocation(config).catch(() => null);
  const home = (local.status === "fulfilled" && local.value.scope) || loc?.city || "Home";

  return {
    pages: [
      page(101, home.toUpperCase(), local),
      page(102, "NATIONAL", national),
      page(103, "WORLD", world),
      // A page with nothing on it is still a page, and dropping it silently
      // would renumber the others between refreshes — which on a cycling
      // display reads as the set losing its place.
    ],
  };
}

/**
 * The weather channel: the NWS's own words where it reaches, Open-Meteo where
 * it doesn't.
 *
 * Both, in the US: the worded forecast is what makes it a programme, and the
 * current temperature is the one number NWS's forecast endpoint does not give
 * you — its periods start at the next one, so "right now" has to come from
 * somewhere else.
 */
async function loadWeather(config) {
  const [nws, meteo] = await Promise.allSettled([getNwsReport(config), getWeather(config, { days: 4 })]);

  const report = nws.status === "fulfilled" ? nws.value : null;
  const numbers = meteo.status === "fulfilled" ? meteo.value : null;

  if (!report?.covered && !numbers) {
    throw new Error(nws.reason?.message ?? meteo.reason?.message ?? "no weather source answered");
  }

  return {
    place: report?.covered ? report.place : numbers?.location ?? "your area",
    // Named so the card can credit whoever actually supplied the words. Getting
    // this wrong would be the fabricated-citation failure from CLAUDE.md in a
    // different costume.
    source: report?.covered ? `NWS ${report.office}` : "Open-Meteo",
    covered: Boolean(report?.covered),
    now: numbers?.now ?? null,
    localTime: numbers?.localTime ?? null,
    periods: report?.periods ?? [],
    // The numeric fallback, used when NWS has nothing to say — outside the US,
    // or when only that half of the pair came back.
    daily: numbers?.forecast ?? [],
    alerts: report?.alerts ?? [],
  };
}

/**
 * Everything Greg has been asked to remember to do, grouped by day.
 *
 * No network, no key, no failure mode worth speaking of — it reads the same
 * store `list_reminders` reads, so the screen and the spoken answer can never
 * disagree about what is set.
 */
function loadAgenda() {
  const items = listReminders();
  const now = new Date();

  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = startOfDay(now);
  const day = 86400000;

  return {
    now: now.getTime(),
    items: items.map((item) => {
      // Which day it falls on, as a label rather than a date — "tomorrow" is
      // what a person wants to read, and a repeating item has no single date at
      // all so it gets its own word.
      const at = startOfDay(new Date(item.dueAt));
      const days = Math.round((at - today) / day);
      return {
        ...item,
        when: item.repeat ? (item.every ?? "repeating") : days <= 0 ? "today" : days === 1 ? "tomorrow" : days < 7 ? new Date(item.dueAt).toLocaleDateString("en-US", { weekday: "long" }) : new Date(item.dueAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        days,
      };
    }),
    stale: false,
  };
}

async function loadSpaceWeather(config) {
  // The aurora verdict needs a latitude, and being honest that it is not
  // visible from 36° north is most of the value of the channel.
  const loc = await getLocation(config).catch(() => null);
  const reading = await getSpaceWeather({ latitude: loc?.latitude ?? null });
  return { ...reading, place: [loc?.city, loc?.region].filter(Boolean).join(", ") || "" };
}
