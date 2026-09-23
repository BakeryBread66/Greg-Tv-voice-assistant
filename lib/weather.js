// Weather via Open-Meteo — free, no API key, no signup.
import { getLocation } from "./location.js";

// WMO weather interpretation codes -> plain English
const CODES = {
  0: "clear",
  1: "mostly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "foggy",
  48: "freezing fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "freezing drizzle",
  57: "heavy freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "freezing rain",
  67: "heavy freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light rain showers",
  81: "rain showers",
  82: "violent rain showers",
  85: "snow showers",
  86: "heavy snow showers",
  95: "a thunderstorm",
  96: "a thunderstorm with hail",
  99: "a severe thunderstorm with hail",
};

const describe = (code) => CODES[code] ?? "unsettled";

// How long one Open-Meteo answer is reused.
//
// "What's the weather?" is the single commonest thing anyone asks Greg, and it
// used to cost a fresh request every time - measured from his own log, weather
// turns took a median 5.0 s against 2.2 s for asking the time, which is the same
// one tool call with no network in it. Open-Meteo recomputes current conditions
// every fifteen minutes, so ten minutes of reuse never hides a change the
// service itself has published.
//
// Seven days are always fetched and sliced to what was asked for, so the tool
// (three days), the weather channel (four) and basic mode (two) share one
// request instead of making three.
export const FORECAST_TTL_MS = 10 * 60 * 1000;
const FETCH_DAYS = 7;
const forecasts = new Map(); // key -> { at, promise }

/** Forget every cached forecast. For tests, and for a moved location pin. */
export function clearWeatherCache() {
  forecasts.clear();
}

function cacheKey(loc, tempUnit, windUnit) {
  return `${Number(loc.latitude).toFixed(3)},${Number(loc.longitude).toFixed(3)}|${tempUnit}|${windUnit}`;
}

/**
 * The raw Open-Meteo answer for a place, from the cache when it is fresh.
 *
 * The promise is what is cached, not the result, so a question that arrives
 * while the startup prefetch is still in flight waits for that request instead
 * of making a second one. A failure is never cached: the next ask tries again.
 */
function fetchForecast(loc, tempUnit, windUnit, now = Date.now()) {
  const key = cacheKey(loc, tempUnit, windUnit);
  const hit = forecasts.get(key);
  if (hit && now - hit.at < FORECAST_TTL_MS) return hit.promise;

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&temperature_unit=${tempUnit}&wind_speed_unit=${windUnit}&timezone=auto` +
    `&forecast_days=${FETCH_DAYS}`;

  const promise = (async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`weather service returned ${res.status}`);
    return res.json();
  })();
  forecasts.set(key, { at: now, promise });
  promise.catch(() => {
    if (forecasts.get(key)?.promise === promise) forecasts.delete(key);
  });
  return promise;
}

/**
 * @param {object} config
 * @param {object} [opts]
 * @param {number} [opts.days]
 * @param {{city:string, region?:string, latitude:number, longitude:number}} [opts.place]
 *   Somewhere other than home — the globe passes whatever you clicked on.
 */
export async function getWeather(config, { days = 3, place = null } = {}) {
  const loc = place ?? (await getLocation(config));
  const tempUnit = config.units?.temperature ?? "fahrenheit";
  const windUnit = config.units?.windSpeed ?? "mph";
  const degrees = tempUnit === "celsius" ? "C" : "F";

  const data = await fetchForecast(loc, tempUnit, windUnit);
  // Absence is not zero: a missing or non-numeric `days` gets the default rather
  // than becoming NaN and slicing to nothing.
  const wanted = Number.isFinite(Number(days)) && days !== null && days !== "" ? Math.round(Number(days)) : 3;
  const count = Math.min(Math.max(wanted, 1), FETCH_DAYS);

  const c = data.current;
  const label = [loc.city, loc.region].filter(Boolean).join(", ") || "your area";

  const forecast = data.daily.time.slice(0, count).map((date, i) => ({
    date,
    day: new Date(`${date}T12:00:00`).toLocaleDateString("en-US", { weekday: "long" }),
    conditions: describe(data.daily.weather_code[i]),
    high: Math.round(data.daily.temperature_2m_max[i]),
    low: Math.round(data.daily.temperature_2m_min[i]),
    chanceOfPrecipitation: `${data.daily.precipitation_probability_max[i] ?? 0}%`,
  }));

  // The request already asks for timezone=auto, so the wall-clock time where you
  // clicked comes back for free — no second lookup, no extra service. Worked out
  // NOW rather than kept with the cached answer, which may be minutes old.
  let localTime = null;
  try {
    localTime = new Date().toLocaleTimeString("en-US", {
      timeZone: data.timezone,
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    // An unrecognised zone shouldn't cost us the forecast.
  }

  return {
    location: label,
    timezone: data.timezone ?? null,
    localTime,
    now: {
      conditions: describe(c.weather_code),
      temperature: `${Math.round(c.temperature_2m)}°${degrees}`,
      feelsLike: `${Math.round(c.apparent_temperature)}°${degrees}`,
      humidity: `${c.relative_humidity_2m}%`,
      wind: `${Math.round(c.wind_speed_10m)} ${windUnit}`,
    },
    forecast,
  };
}

// Used by the no-API-key fallback mode: turns the data into a sentence Greg can say.
export function weatherToSentence(w) {
  const today = w.forecast[0];
  return (
    `Right now in ${w.location} it's ${w.now.temperature} and ${w.now.conditions}, ` +
    `feels like ${w.now.feelsLike}. Today you're looking at a high of ${today.high} ` +
    `and a low of ${today.low}, with ${today.chanceOfPrecipitation} chance of precipitation.`
  );
}
