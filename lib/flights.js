// Live aircraft from the OpenSky Network.
//
// Free and keyless, but the anonymous quota is roughly 400 credits a day — a
// poll every ten seconds would exhaust it before lunch. So: only ever a bounding
// box (cheaper than the whole world), a cache keyed on a coarse grid so small
// camera nudges reuse the last answer, and a TTL that makes a session's worth of
// watching cost a few dozen requests rather than thousands.
//
// It fails quietly on purpose. Flights are a garnish; running out of quota
// should dim the layer, not break the dashboard.

const ENDPOINT = "https://opensky-network.org/api/states/all";

const TTL = 45 * 1000;
const cache = new Map();
const MAX_CACHE = 12;

// OpenSky returns each aircraft as a bare array. These are the columns we use.
const ICAO = 0, CALLSIGN = 1, ORIGIN = 2, LON = 5, LAT = 6, ON_GROUND = 8, VELOCITY = 9, HEADING = 10, GEO_ALT = 13;

/**
 * Aircraft currently inside a box around a point.
 *
 * @param {object} opts
 * @param {number} opts.lat
 * @param {number} opts.lon
 * @param {number} [opts.span]  Box height in degrees; width is scaled by latitude.
 * @param {number} [opts.limit]
 */
export async function getFlights({ lat, lon, span = 6, limit = 300 } = {}) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error("need a latitude and longitude");
  }

  // Longitude degrees get narrower toward the poles; without this correction a
  // box over Norway covers a sliver of ground and a box over the equator a slab.
  const half = Math.min(Math.max(span, 1), 20) / 2;
  const widen = 1 / Math.max(0.2, Math.cos(latitude * (Math.PI / 180)));
  const halfLon = Math.min(half * widen, 30);

  const box = {
    lamin: Math.max(-90, latitude - half),
    lamax: Math.min(90, latitude + half),
    lomin: Math.max(-180, longitude - halfLon),
    lomax: Math.min(180, longitude + halfLon),
  };

  // Round the key so nudging the camera doesn't spend a request.
  const key = [box.lamin, box.lamax, box.lomin, box.lomax].map((n) => n.toFixed(0)).join(",");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return { ...hit.data, cached: true };

  const url =
    `${ENDPOINT}?lamin=${box.lamin.toFixed(4)}&lomin=${box.lomin.toFixed(4)}` +
    `&lamax=${box.lamax.toFixed(4)}&lomax=${box.lomax.toFixed(4)}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });

  if (res.status === 429) throw new Error("OpenSky is rate-limiting us — try again in a few minutes");
  if (!res.ok) throw new Error(`OpenSky returned ${res.status}`);

  const raw = await res.json();

  const aircraft = (raw.states ?? [])
    .filter((s) => Number.isFinite(s[LAT]) && Number.isFinite(s[LON]) && !s[ON_GROUND])
    .map((s) => ({
      id: s[ICAO],
      callsign: (s[CALLSIGN] ?? "").trim() || "unknown",
      country: s[ORIGIN] ?? "",
      lat: s[LAT],
      lon: s[LON],
      altitude: Math.round(s[GEO_ALT] ?? 0),
      heading: s[HEADING] ?? 0,
      speed: Math.round((s[VELOCITY] ?? 0) * 2.23694), // m/s -> mph
    }))
    // Highest first, so trimming the list keeps the airliners over the traffic
    // circling a regional field.
    .sort((a, b) => b.altitude - a.altitude)
    .slice(0, limit);

  const data = { aircraft, box, at: raw.time ? raw.time * 1000 : Date.now() };

  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), data });
  return { ...data, cached: false };
}
