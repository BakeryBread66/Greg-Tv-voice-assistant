// The US National Weather Service — api.weather.gov, keyless, no account.
//
// Greg already has weather from Open-Meteo, so this is not "weather again". It
// answers two things Open-Meteo cannot:
//
//   1. A WORDED forecast. "A slight chance of rain showers between 8am and 9am,
//      then a chance of showers and thunderstorms" is a sentence a person wrote,
//      and it reads like a broadcast rather than a row of numbers. That is the
//      whole reason the weather channel is worth having as a *programme*.
//   2. ACTIVE ALERTS. Greg has no concept of a warning today. A tornado warning
//      ought to interrupt whatever is showing, because that is what televisions
//      have always done.
//
// Open-Meteo stays for the numbers and for anywhere outside NWS coverage — this
// is a US-only service and says so plainly rather than pretending otherwise.

import { getLocation } from "./location.js";

// api.weather.gov asks for a User-Agent that identifies the application and a
// way to contact whoever runs it. Anonymous requests get rate limited harder.
const HEADERS = {
  "User-Agent": "(Greg, a local voice assistant; github.com/local/greg)",
  Accept: "application/geo+json",
};

// A grid square is a fixed property of a coordinate, so once resolved it never
// needs asking again. Keyed on the rounded coordinate: NWS resolves to a ~2.5km
// grid, so four decimal places would be a cache that never hits.
const points = new Map();

async function fetchJson(url, timeoutMs = 12000) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const err = new Error(`api.weather.gov returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Which NWS office, grid square and forecast zone a coordinate falls in.
 *
 * Returns null OUTSIDE the United States rather than throwing — that is not a
 * failure, it is the service correctly saying it does not cover Reykjavik, and
 * the caller should fall back to Open-Meteo rather than show an error.
 */
async function resolvePoint(latitude, longitude) {
  const key = `${latitude.toFixed(3)},${longitude.toFixed(3)}`;
  if (points.has(key)) return points.get(key);

  let resolved = null;
  try {
    const data = await fetchJson(`https://api.weather.gov/points/${key}`);
    const p = data.properties;
    resolved = {
      office: p.gridId,
      gridX: p.gridX,
      gridY: p.gridY,
      forecast: p.forecast,
      hourly: p.forecastHourly,
      radar: p.radarStation,
      city: p.relativeLocation?.properties?.city ?? "",
      state: p.relativeLocation?.properties?.state ?? "",
      timeZone: p.timeZone ?? null,
    };
  } catch (err) {
    // A 404 here means "not in the US". Anything else is a real fault and
    // shouldn't be cached as though the place were permanently out of range.
    if (err.status !== 404) throw err;
  }

  points.set(key, resolved);
  return resolved;
}

/**
 * Which radar station covers a coordinate, e.g. "KRAX" for Chapel Hill.
 *
 * Exported separately from the forecast because the radar channel wants only
 * this, and pulling a whole forecast to read four letters off it would spend a
 * request on nothing. Null outside NWS coverage, which is a fact rather than a
 * failure — same as everything else here.
 */
export async function getRadarStation(latitude, longitude) {
  const point = await resolvePoint(latitude, longitude);
  return point ? { station: point.radar, office: point.office, place: [point.city, point.state].filter(Boolean).join(", ") } : null;
}

/**
 * The forecast, in the NWS's own words.
 *
 * Periods alternate day and night and are already named ("Overnight", "Friday",
 * "Friday Night"), which is exactly how a forecast is read out loud.
 */
export async function getNwsForecast(latitude, longitude) {
  const point = await resolvePoint(latitude, longitude);
  if (!point) return null;

  const data = await fetchJson(point.forecast);
  const periods = (data.properties?.periods ?? []).map((p) => ({
    name: p.name,
    daytime: Boolean(p.isDaytime),
    temperature: p.temperature,
    unit: p.temperatureUnit,
    wind: [p.windSpeed, p.windDirection].filter(Boolean).join(" "),
    // The one-liner for the card and the paragraph for the voice. Both come
    // from the feed; neither is assembled here, which is the point.
    short: p.shortForecast,
    detailed: p.detailedForecast,
    // The icon URL encodes the sky condition as a path segment — "tsra_hi,30"
    // is thunderstorms at 30%. Cheaper and more reliable to read than the prose.
    sky: skyFrom(p.icon, p.shortForecast),
    precipitation: p.probabilityOfPrecipitation?.value ?? null,
  }));

  return {
    office: point.office,
    radar: point.radar,
    city: point.city,
    state: point.state,
    place: [point.city, point.state].filter(Boolean).join(", "),
    updated: data.properties?.updated ?? null,
    periods,
  };
}

/**
 * A coarse sky condition, for choosing a symbol to draw.
 *
 * Read off the icon path rather than the prose, because the prose is written
 * for a human and varies ("Chance Showers And Thunderstorms" against "Slight
 * Chance Rain Showers then Mostly Sunny"), while the icon path is a controlled
 * vocabulary. Falls back to the words when the icon is missing or unfamiliar.
 *
 * Only the FIRST condition is read, and that matters. The path is
 * `land/day/sct/tsra_hi,20` for a period that is mostly sunny and *then* has a
 * slight chance of storms — searching the whole string finds "tsra" and paints
 * a thunderstorm over a sunny day at 11% chance of rain. The segments are
 * ordered first-half-of-period then second, so the first one is the headline.
 */
export function skyFrom(icon, short = "") {
  const full = String(icon ?? "").toLowerCase();
  // land/{day|night}/{condition}[,{percent}][/{condition}]?size=medium
  const first = /\/(?:day|night)\/([a-z_]+)/.exec(full)?.[1];

  if (first) {
    // "wind_bkn" is broken cloud AND windy. The cloud is the more useful thing
    // to draw, so the prefix is stripped and only a bare "wind" means wind.
    const code = first.replace(/^wind_/, "");
    if (code.startsWith("tsra")) return "storm";
    if (/^(snow|blizzard|sleet|fzra|rain_snow|rain_sleet|rain_fzra)/.test(code)) return "snow";
    if (/^(rain|drizzle|hurricane|tropical)/.test(code)) return "rain";
    if (/^(fog|haze|smoke|dust)/.test(code)) return "fog";
    if (code === "wind") return "wind";
    if (/^(ovc|bkn)/.test(code)) return "cloud";
    if (code === "sct") return "partcloud";
    if (/^(skc|few|hot|cold)/.test(code)) return "clear";
  }

  // No icon, or a code this doesn't know. Fall back to the words — and only to
  // the words BEFORE "then", for the same reason the icon takes its first
  // segment: "Mostly Sunny then Chance Showers" is a sunny period.
  const words = String(short).toLowerCase().split(/\bthen\b/)[0];
  const has = (...needles) => needles.some((n) => words.includes(n));
  if (has("thunder")) return "storm";
  if (has("snow", "blizzard", "sleet", "ice", "freezing")) return "snow";
  if (has("rain", "shower", "drizzle")) return "rain";
  if (has("fog", "haze", "smoke")) return "fog";
  if (has("wind", "breezy", "blustery")) return "wind";
  // "partly cloudy" contains "cloudy", so the partial forms must be tested
  // first or every broken sky reads as overcast.
  if (has("partly", "mostly sunny", "mostly clear")) return "partcloud";
  if (has("cloudy", "overcast")) return "cloud";
  if (has("clear", "sunny", "fair")) return "clear";
  return "cloud";
}

// The National Weather Service's own severity ladder, ordered. Used to decide
// what is worth interrupting for and what colour to paint it, so the ordering
// is load-bearing rather than decorative.
const SEVERITY_RANK = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 0 };

/**
 * Everything currently in force for one point.
 *
 * By point rather than by zone: a zone covers a whole county and would announce
 * a coastal flood warning to somebody thirty miles inland. The point query is
 * the NWS doing that geometry for us.
 */
export async function getNwsAlerts(latitude, longitude) {
  const data = await fetchJson(
    `https://api.weather.gov/alerts/active?point=${latitude.toFixed(4)},${longitude.toFixed(4)}`
  );

  return (data.features ?? [])
    .map((feature) => {
      const p = feature.properties;
      return {
        id: p.id,
        event: p.event,
        severity: p.severity ?? "Unknown",
        rank: SEVERITY_RANK[p.severity] ?? 0,
        urgency: p.urgency ?? "Unknown",
        certainty: p.certainty ?? "Unknown",
        // The headline carries the whole thing in one line, including who
        // issued it and until when — which is precisely what a caption wants.
        headline: p.headline ?? p.event,
        area: p.areaDesc ?? "",
        // Wire copy arrives hard-wrapped at ~70 columns for teleprinters that
        // stopped existing decades ago. Unwrap it, or every renderer inherits
        // line breaks in the wrong places.
        description: unwrap(p.description),
        instruction: unwrap(p.instruction),
        sender: p.senderName ?? "the National Weather Service",
        onset: p.onset ?? p.effective ?? null,
        ends: p.ends ?? p.expires ?? null,
      };
    })
    .sort((a, b) => b.rank - a.rank);
}

/**
 * Undo the hard wrapping in NWS wire copy.
 *
 * A single newline inside a paragraph is a teleprinter artefact and becomes a
 * space; a blank line is a real paragraph break and is kept. Doing the naive
 * thing — replacing every newline with a space — runs the paragraphs together
 * and loses the bullet structure that warnings use for "WHAT / WHERE / WHEN".
 */
function unwrap(text) {
  if (!text) return "";
  return String(text)
    .replace(/\r/g, "")
    .split(/\n{2,}/)
    .map((para) => para.replace(/\n/g, " ").replace(/\s{2,}/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** Is this worth interrupting the programme for? */
export function worthInterrupting(alert) {
  // Severe and above only. Air Quality Alerts and Heat Advisories run to dozens
  // nationwide on an ordinary day — interrupting for those would train the user
  // to ignore the one that matters, which is worse than never interrupting.
  if (alert.rank < SEVERITY_RANK.Severe) return false;
  // "Future" means it starts in some hours. That is a forecast, not an alarm.
  return alert.urgency === "Immediate" || alert.urgency === "Expected";
}

/** A sentence Greg can say. Kept here so the announcement and the card agree. */
export function describeAlert(alert) {
  const where = alert.area ? ` for ${alert.area.split(";")[0].trim()}` : "";
  const until = alert.ends
    ? ` until ${new Date(alert.ends).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`
    : "";
  return `${alert.event}${where}${until}, from ${alert.sender}.`;
}

/**
 * Everything the weather channel needs, in one call.
 *
 * The forecast and the alerts are fetched together but settled independently:
 * a warning is the more important of the two, and losing it because the
 * forecast endpoint was slow would be exactly backwards.
 */
export async function getNwsReport(config, { place = null } = {}) {
  const loc = place ?? (await getLocation(config));
  const { latitude, longitude } = loc;

  const [forecast, alerts] = await Promise.allSettled([
    getNwsForecast(latitude, longitude),
    getNwsAlerts(latitude, longitude),
  ]);

  const report = forecast.status === "fulfilled" ? forecast.value : null;

  return {
    // No NWS coverage is a fact about the place, not an error — the caller
    // falls back to Open-Meteo on it rather than showing a fault card.
    covered: Boolean(report),
    place: report?.place || [loc.city, loc.region].filter(Boolean).join(", ") || "your area",
    office: report?.office ?? null,
    radar: report?.radar ?? null,
    periods: report?.periods ?? [],
    alerts: alerts.status === "fulfilled" ? alerts.value : [],
    alertsFailed: alerts.status === "rejected" ? alerts.reason.message : null,
    forecastFailed: forecast.status === "rejected" ? forecast.reason.message : null,
  };
}
