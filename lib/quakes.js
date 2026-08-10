// Recent earthquakes from the USGS feeds.
//
// Free, no key, no signup, and no rate limit worth designing around — but the
// globe polls it, and the feed only regenerates every minute or so, meaning
// anything more often than that is just re-downloading the same file.

const BASE = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary";

// The useful slices. Bigger magnitudes over longer windows, or everything over
// a short one — asking for everything over a month is tens of thousands of dots.
export const FEEDS = {
  "2.5_day": "magnitude 2.5 and above, past day",
  all_day: "everything recorded, past day",
  "4.5_week": "magnitude 4.5 and above, past week",
  significant_month: "significant quakes, past month",
};

const TTL = 5 * 60 * 1000;
const cache = new Map(); // feed -> { at, data }

/**
 * @returns {Promise<{ feed: string, description: string, quakes: Array }>}
 */
export async function getQuakes({ feed = "2.5_day" } = {}) {
  if (!FEEDS[feed]) feed = "2.5_day";

  const hit = cache.get(feed);
  if (hit && Date.now() - hit.at < TTL) return hit.data;

  const res = await fetch(`${BASE}/${feed}.geojson`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`the USGS feed returned ${res.status}`);
  const raw = await res.json();

  const quakes = (raw.features ?? [])
    .filter((f) => Array.isArray(f.geometry?.coordinates))
    .map((f) => {
      const [lon, lat, depth] = f.geometry.coordinates;
      return {
        magnitude: f.properties.mag,
        place: f.properties.place ?? "somewhere",
        lat,
        lon,
        // Kilometres below the surface. Deep quakes are felt far less, which is
        // why the globe colours by this rather than only sizing by magnitude.
        depth: Math.round(depth ?? 0),
        at: f.properties.time,
        url: f.properties.url,
        tsunami: Boolean(f.properties.tsunami),
      };
    })
    // Strongest first, so a truncated list is still the interesting one.
    .sort((a, b) => (b.magnitude ?? 0) - (a.magnitude ?? 0));

  const data = { feed, description: FEEDS[feed], quakes };
  cache.set(feed, { at: Date.now(), data });
  return data;
}

/** Spoken summary, for when Greg is asked rather than the globe drawing them. */
export function quakesToSentence(data, count = 3) {
  if (!data.quakes.length) return `Nothing above that magnitude has been recorded — ${data.description}.`;
  const top = data.quakes.slice(0, count);
  const lines = top.map((q) => `magnitude ${q.magnitude?.toFixed(1) ?? "unknown"} ${q.place}`);
  return `The largest recently: ${lines.join(", then ")}.`;
}
