// What is flying over you right now.
//
// The data is lib/flights.js, which the globe already uses — this adds only the
// geometry that turns "aircraft in a bounding box" into "aircraft over YOUR
// house, nearest first", which is a different question and the one a channel
// wants to answer.
//
// The quota is the design constraint, exactly as it is on the globe: OpenSky's
// anonymous allowance is roughly **400 requests a day**, so this polls no faster
// than the 45-second cache in lib/flights.js, and only while the channel is
// actually showing. An hour of watching costs about sixty requests, which is a
// real fraction of the day's budget — worth knowing before leaving it up.

import { getFlights } from "./flights.js";
import { getLocation } from "./location.js";

// About 220 km top to bottom. Wide enough to see something coming before it
// arrives, tight enough that the scope is not a smear of dots.
const SPAN_DEGREES = 2;

const EARTH_RADIUS_KM = 6371;
const toRad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in km. */
export function distanceKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, in degrees clockwise from north. */
export function bearing(a, b) {
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export const compassOf = (deg) => COMPASS[Math.round(((deg % 360) / 22.5)) % 16];

/**
 * Aircraft near the user, nearest first, with everything the scope needs.
 *
 * Positions are returned as OFFSETS in kilometres north and east of the user
 * rather than as raw coordinates. That keeps the projection here — where the
 * latitude correction can be done once and correctly — instead of in a renderer
 * that would otherwise have to redo spherical geometry in canvas space.
 */
export async function getOverhead(config) {
  const loc = await getLocation(config);
  const here = { lat: loc.latitude, lon: loc.longitude };

  const data = await getFlights({ lat: here.lat, lon: here.lon, span: SPAN_DEGREES, limit: 200 });

  // Half the box height, which is what the outermost range ring means.
  const rangeKm = (SPAN_DEGREES / 2) * 111;

  const aircraft = data.aircraft
    .map((a) => {
      const km = distanceKm(here, a);
      const from = bearing(here, a);
      return {
        callsign: a.callsign,
        country: a.country,
        // Feet, because that is the unit every altitude in aviation is quoted
        // in and the one on any flight tracker the user has ever seen.
        altitudeFt: Math.round((a.altitude ?? 0) * 3.28084),
        speed: a.speed,
        heading: a.heading,
        km: Math.round(km * 10) / 10,
        miles: Math.round(km * 0.621371 * 10) / 10,
        bearing: Math.round(from),
        compass: compassOf(from),
        // Plan position, in km, north-positive and east-positive.
        north: Math.cos(toRad(from)) * km,
        east: Math.sin(toRad(from)) * km,
      };
    })
    .filter((a) => a.km <= rangeKm)
    .sort((a, b) => a.km - b.km);

  return {
    place: [loc.city, loc.region].filter(Boolean).join(", ") || "your area",
    rangeKm: Math.round(rangeKm),
    count: aircraft.length,
    aircraft,
    // Directly overhead is a genuinely different fact from "nearest", and it is
    // the one worth looking up for. 12 km of ground distance is roughly what
    // sits inside a comfortable overhead cone for something at cruise.
    overhead: aircraft.find((a) => a.km <= 12) ?? null,
    at: data.at,
    // True when lib/flights.js served this from its own cache, meaning the poll
    // cost nothing against the quota.
    cached: Boolean(data.cached),
    stale: false,
  };
}

/** A sentence Greg can say. */
export function describeOverhead(data) {
  if (!data?.aircraft?.length) return `Nothing is flying over ${data?.place || "you"} right now.`;

  const nearest = data.aircraft[0];
  const where = nearest.km <= 12 ? "almost directly overhead" : `${Math.round(nearest.miles)} miles ${nearest.compass}`;
  return (
    `There are ${data.count} aircraft within range. The closest is ${nearest.callsign}, ` +
    `${where}, at ${nearest.altitudeFt.toLocaleString("en-US")} feet.`
  );
}
