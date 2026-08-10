// Air quality, from Open-Meteo's keyless feed.
//
// The same provider the weather already uses, so this needs no new account, no
// key and no new location plumbing — it takes a place the way getWeather() does
// and falls back to the user's own.
//
// **Pollen is a fact about the place, not a feature of the channel.** Open-Meteo
// serves pollen from the CAMS European model, so every pollen field comes back
// null in North America — measured, on the user's own coordinates, before a line
// of this was written. So the channel is called Air Quality and shows pollen
// only where the feed genuinely has it. Naming it for something it cannot show
// would be the boot screen's "all processing local" all over again: a label that
// is true in one place and a lie in another.
//
// Same shape as the NWS coverage flag: `pollen: null` means not covered here,
// and that is said in words rather than left as empty gauges.

import { getLocation } from "./location.js";

const ENDPOINT = "https://air-quality-api.open-meteo.com/v1/air-quality";
const POLLENS = ["alder_pollen", "birch_pollen", "grass_pollen", "mugwort_pollen", "olive_pollen", "ragweed_pollen"];
const CURRENT = ["us_aqi", "pm2_5", "pm10", "ozone", "nitrogen_dioxide", "sulphur_dioxide", ...POLLENS];

/**
 * The US AQI bands, which are the point of the number.
 *
 * 51 means nothing on its own; "Moderate, fine for most people" is the answer to
 * the question actually being asked. The advice is deliberately plain and
 * non-medical — this says what the scale says, and does not tell anybody with
 * asthma what to do, for the same reason `adviceRule()` stops him giving
 * investment advice.
 */
export const AQI_BANDS = [
  { upTo: 50, name: "Good", advice: "Air quality is fine.", colour: "#3ec46d" },
  { upTo: 100, name: "Moderate", advice: "Fine for most people; unusually sensitive people may notice it.", colour: "#e8d44d" },
  { upTo: 150, name: "Unhealthy for Sensitive Groups", advice: "Sensitive groups should take it easier outdoors.", colour: "#f0913c" },
  { upTo: 200, name: "Unhealthy", advice: "Everyone may notice effects outdoors.", colour: "#e2564a" },
  { upTo: 300, name: "Very Unhealthy", advice: "Avoid prolonged effort outdoors.", colour: "#a06cc4" },
  { upTo: Infinity, name: "Hazardous", advice: "Stay indoors if you can.", colour: "#8b3a4a" },
];

export function aqiBand(value) {
  // Absence before conversion. `Number(null)` and `Number("")` are both 0, and 0
  // is the cleanest air on the scale — so a missing reading would come back as
  // "Good", which is the worst direction this particular failure can go: it
  // tells somebody the air is fine when nothing has been measured at all.
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return AQI_BANDS.find((band) => n <= band.upTo) ?? AQI_BANDS.at(-1);
}

/**
 * Pollen levels, or null where the model does not reach.
 *
 * Returns null — not an empty object and not zeroes — when every grain count is
 * missing, because "no pollen data here" and "no pollen today" are different
 * facts and collapsing them would have the channel report a clean spring
 * morning in a place it knows nothing about. The same distinction the alert
 * watch draws between checked-and-clear and never-checked.
 */
export function pollenFrom(current = {}) {
  // Absence before conversion, and this is the FIFTH place in this project that
  // has needed saying. `Number(null)` is 0, so filtering on `isFinite(Number(x))`
  // keeps every missing reading as a zero — and a zero grain count is a real,
  // meaningful value here. The feed returning null for all six in North America
  // would have come out as a channel confidently reporting no pollen anywhere.
  const present = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));

  const found = POLLENS.map((key) => ({
    name: key.replace("_pollen", ""),
    grains: current[key],
  })).filter((entry) => present(entry.grains));

  if (!found.length) return null;
  return found
    .map((entry) => ({ ...entry, grains: Number(entry.grains), level: pollenLevel(entry.grains) }))
    .sort((a, b) => b.grains - a.grains);
}

/** Grains per cubic metre, in words. Bands are the CAMS convention. */
export function pollenLevel(grains) {
  const n = Number(grains) || 0;
  if (n < 1) return "none";
  if (n < 20) return "low";
  if (n < 50) return "moderate";
  if (n < 100) return "high";
  return "very high";
}

/**
 * Read the air where the user is, or somewhere they named.
 *
 * `place` is optional and has the same shape the weather and news take, so a
 * globe click reaches it for free.
 */
export async function getAirQuality(config = {}, place = null) {
  const where = place ?? (await getLocation(config));
  const latitude = Number(where?.latitude);
  const longitude = Number(where?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { error: "I do not know where to check the air for." };
  }

  const url =
    `${ENDPOINT}?latitude=${latitude}&longitude=${longitude}` +
    `&current=${CURRENT.join(",")}&timezone=auto`;

  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`air quality service returned ${res.status}`);
  const data = await res.json();

  const current = data.current ?? {};
  const aqi = Number(current.us_aqi);
  const band = aqiBand(aqi);

  return {
    place: where.city ?? "here",
    aqi: Number.isFinite(aqi) ? Math.round(aqi) : null,
    band: band?.name ?? null,
    advice: band?.advice ?? null,
    colour: band?.colour ?? null,
    // The individual pollutants, so the number above can be explained rather
    // than just asserted. Nulls are dropped rather than shown as zero.
    pollutants: [
      { name: "PM2.5", value: current.pm2_5, unit: "µg/m³" },
      { name: "PM10", value: current.pm10, unit: "µg/m³" },
      { name: "Ozone", value: current.ozone, unit: "µg/m³" },
      { name: "NO₂", value: current.nitrogen_dioxide, unit: "µg/m³" },
      { name: "SO₂", value: current.sulphur_dioxide, unit: "µg/m³" },
    ].filter((p) => Number.isFinite(Number(p.value)))
      .map((p) => ({ ...p, value: Math.round(Number(p.value) * 10) / 10 })),
    pollen: pollenFrom(current),
    // Said in words so nothing downstream has to infer it from a null.
    pollenNote: pollenFrom(current) ? null : "Pollen counts are not published for this part of the world.",
    at: current.time ?? null,
  };
}

/** One sentence, for the tool and for a globe click. */
export function airToSentence(air) {
  if (!air || air.error) return air?.error ?? "I could not read the air quality.";
  if (air.aqi === null) return `I could not get an air quality reading for ${air.place}.`;
  const worst = air.pollen?.[0];
  const pollen = worst && worst.level !== "none" ? ` ${worst.name} pollen is ${worst.level}.` : "";
  return `Air quality in ${air.place} is ${air.band}, ${air.aqi} on the US index. ${air.advice}${pollen}`;
}
