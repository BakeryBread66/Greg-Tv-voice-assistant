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

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&temperature_unit=${tempUnit}&wind_speed_unit=${windUnit}&timezone=auto` +
    `&forecast_days=${Math.min(Math.max(days, 1), 7)}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`weather service returned ${res.status}`);
  const data = await res.json();

  const c = data.current;
  const label = [loc.city, loc.region].filter(Boolean).join(", ") || "your area";

  const forecast = data.daily.time.map((date, i) => ({
    date,
    day: new Date(`${date}T12:00:00`).toLocaleDateString("en-US", { weekday: "long" }),
    conditions: describe(data.daily.weather_code[i]),
    high: Math.round(data.daily.temperature_2m_max[i]),
    low: Math.round(data.daily.temperature_2m_min[i]),
    chanceOfPrecipitation: `${data.daily.precipitation_probability_max[i] ?? 0}%`,
  }));

  // The request already asks for timezone=auto, so the wall-clock time where you
  // clicked comes back for free — no second lookup, no extra service.
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
