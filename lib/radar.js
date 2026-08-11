// Weather radar, as an animated loop — the last twenty minutes of rain moving.
//
// The National Weather Service's RIDGE II service publishes, for every radar
// station, ten ready-made images: `{SITE}_0.gif` is the most recent and `_9` is
// about eighteen minutes older. They already have the coastline, the county
// lines and the range rings drawn on them, which is the whole reason to use
// these rather than a tile service — a radar picture with no geography under it
// tells you rain exists but not where.
//
// Two things force this through Node rather than letting the browser fetch them:
//
//   1. **radar.weather.gov sends no CORS header.** The face canvas is read back
//      as pixels in places (the music visualiser, every test in this project),
//      and one cross-origin image drawn into it taints the whole canvas.
//   2. **The frames shift position rather than changing.** `_0` is always "the
//      newest", so every URL's content changes every couple of minutes. Caching
//      by URL is useless; caching by the image's own timestamp is not, and that
//      is what turns a 580 KB refresh into a 58 KB one.

import { getRadarStation } from "./nws.js";
import { getLocation } from "./location.js";

const FRAMES = 10;
const HEADERS = { "User-Agent": "(Greg, a local voice assistant; github.com/local/greg)" };

// The station's own images update about every two minutes. Asking more often
// than that is asking for the same bytes back.
const REFRESH_MS = 100 * 1000;

let station = null;      // { station, office, place }
let stationFor = null;   // the coordinate it was resolved for
let byStamp = new Map(); // last-modified -> { bytes, contentType }
let order = [];          // last-modified strings, OLDEST first — playing order
let lastRefresh = 0;
let version = 0;         // bumped when the set of frames changes, for cache keys
let inFlight = null;

async function head(url) {
  const res = await fetch(url, { headers: HEADERS, method: "HEAD", signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`radar returned ${res.status}`);
  // The timestamp IS the frame's identity. Falling back to the URL would defeat
  // the whole cache, so a station without Last-Modified is treated as one frame
  // per position and simply re-downloaded.
  return res.headers.get("last-modified") || `${url}#${Date.now()}`;
}

async function grab(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`radar returned ${res.status}`);
  return {
    bytes: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get("content-type") || "image/gif",
  };
}

const frameUrl = (site, n) => `https://radar.weather.gov/ridge/standard/${site}_${n}.gif`;

/**
 * The current loop.
 *
 * Frames are described, not included — they are ~58 KB each and the browser
 * fetches them from /api/radar/frame so it can cache them properly. `version`
 * in that URL is what makes caching safe: a new set of frames is a new version,
 * so a stale picture can never be served for a fresh loop.
 */
export async function getRadar(config) {
  if (inFlight) return inFlight;

  inFlight = load(config)
    .catch((err) => {
      // A blink keeps the last loop up, marked stale. The frames are still in
      // memory and still perfectly watchable; they are just not current.
      if (order.length) return { ...describe(), stale: true, warning: err.message };
      throw err;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

async function load(config) {
  const loc = await getLocation(config);
  const key = `${loc.latitude.toFixed(3)},${loc.longitude.toFixed(3)}`;

  if (key !== stationFor) {
    station = await getRadarStation(loc.latitude, loc.longitude);
    stationFor = key;
    // A different station is a different picture entirely.
    byStamp = new Map();
    order = [];
  }

  // Outside NWS coverage there is no station, and that is an answer rather than
  // an error — the channel says so instead of showing a fault card.
  if (!station?.station) {
    return { covered: false, place: [loc.city, loc.region].filter(Boolean).join(", "), frames: [], version, stale: false };
  }

  if (order.length && Date.now() - lastRefresh < REFRESH_MS) return describe();

  const site = station.station;

  // Cheapest possible check first: if the newest frame has not moved, nothing
  // has, and the whole refresh is one HEAD request.
  const newest = await head(frameUrl(site, 0));
  if (order.length && order[order.length - 1] === newest) {
    lastRefresh = Date.now();
    return describe();
  }

  // Frames 0..9 are newest-first; the loop plays oldest-first, so this reverses.
  const stamps = [];
  for (let n = FRAMES - 1; n >= 0; n--) {
    stamps.push(n === 0 ? newest : await head(frameUrl(site, n)));
  }

  // Only fetch what we do not already hold. On a normal refresh that is exactly
  // one frame — the other nine have simply slid one place along.
  for (let i = 0; i < stamps.length; i++) {
    if (byStamp.has(stamps[i])) continue;
    // stamps[i] is position (FRAMES - 1 - i) in the newest-first URL numbering.
    byStamp.set(stamps[i], await grab(frameUrl(site, FRAMES - 1 - i)));
  }

  // Drop anything that has fallen off the back of the loop, or memory grows by
  // 58 KB every two minutes for as long as Greg is awake.
  const live = new Set(stamps);
  for (const stamp of [...byStamp.keys()]) if (!live.has(stamp)) byStamp.delete(stamp);

  order = stamps;
  lastRefresh = Date.now();
  version++;
  return describe();
}

function describe() {
  return {
    covered: true,
    station: station.station,
    office: station.office,
    place: station.place,
    version,
    frames: order.map((stamp, index) => ({
      index,
      // The time the NWS published that sweep, not the time we fetched it.
      at: Number.isNaN(Date.parse(stamp)) ? null : new Date(stamp).toISOString(),
    })),
    stale: false,
  };
}

/** One frame's bytes, for /api/radar/frame. */
export function getRadarFrame(index) {
  const stamp = order[index];
  return stamp ? byStamp.get(stamp) ?? null : null;
}
