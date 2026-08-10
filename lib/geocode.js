// Turning a place name into coordinates, via Open-Meteo's geocoder.
//
// Same family as the weather API Greg already uses: free, keyless, no signup.
// It also hands back the timezone, which saves a second lookup when we want to
// say what time it is somewhere.

const ENDPOINT = "https://geocoding-api.open-meteo.com/v1/search";

const TTL = 60 * 60 * 1000; // place names don't move
const cache = new Map();

/**
 * @param {string} query
 * @returns {Promise<Array<{name, country, region, latitude, longitude, timezone, population}>>}
 */
export async function geocode(query, { count = 5 } = {}) {
  const term = String(query ?? "").trim();
  if (!term) return [];

  const key = `${term.toLowerCase()}|${count}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.results;

  const url = `${ENDPOINT}?name=${encodeURIComponent(term)}&count=${count}&language=en&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`the geocoder returned ${res.status}`);

  const results = ((await res.json()).results ?? []).map((r) => ({
    name: r.name,
    country: r.country ?? "",
    // ISO-2, and the reason it is kept: it decides which Google News edition to
    // read. Without it, asking about Seoul returns the US edition's English
    // coverage of Korea rather than what Korea is actually reading.
    countryCode: r.country_code ?? "",
    region: r.admin1 ?? "",
    latitude: r.latitude,
    longitude: r.longitude,
    timezone: r.timezone ?? "",
    population: r.population ?? null,
  }));

  cache.set(key, { at: Date.now(), results });
  return results;
}

/** The single best match, in the shape getWeather and getNews want. */
export async function locate(query) {
  const [best] = await geocode(query, { count: 1 });
  if (!best) return null;
  return {
    city: best.name,
    // The country reads better than the province for anywhere Greg is likely to
    // be asked about, and it's what makes a news search find anything.
    region: best.country || best.region,
    latitude: best.latitude,
    longitude: best.longitude,
    timezone: best.timezone,
  };
}
