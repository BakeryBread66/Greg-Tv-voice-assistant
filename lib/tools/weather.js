// Weather tools: schema and handler together.
//
// They used to be 400 lines apart in lib/brain.js — one entry in a 23-item
// array, one case in a 23-case switch — with nothing stopping the two
// drifting. `run` receives (input, ctx); ctx carries what a handler needs
// from the brain and cannot import for itself.

import { activeAlerts, alertWatchStatus } from "../alertwatch.js";
import { getLocation } from "../location.js";
import { getNwsAlerts } from "../nws.js";
import { getWeather } from "../weather.js";
import { sunAndMoon } from "../sunmoon.js";
import { getAirQuality } from "../airquality.js";
import { withinMs } from "../deadline.js";

// How long the answer waits for the two extras - the warning check and the
// air - before going without them. Both normally answer in well under a second;
// this is for the day api.weather.gov takes twelve, which is its timeout.
export const EXTRAS_MS = 3000;

/**
 * Are any warnings in force at home? From the background watch when it has
 * looked recently, and otherwise by looking - bounded, so a slow warning service
 * costs this answer at most EXTRAS_MS rather than its full twelve seconds.
 *
 * Returns `known: false` when it could not find out, which the tool then SAYS,
 * because "no warnings" and "could not check" must never read the same.
 */
export async function checkWarnings(config, { waitMs = EXTRAS_MS } = {}) {
  const watch = alertWatchStatus();
  let alerts = activeAlerts();
  let known = watch.checked && !watch.stale;
  let covered = watch.covered;

  // If the watch has not actually looked yet, LOOK. This started as a note
  // in the tool result saying "NOT CHECKED, say you do not know" — and
  // that failed the way every prompt instruction in this project has
  // failed: measured 1 run in 3, Greg still answered "there are no active
  // weather warnings for Chapel Hill right now" having consulted nothing.
  //
  // So the ambiguity is removed rather than described. get_weather is
  // already a network call; one more small keyless request, only on the
  // cold path, means there is always a real answer or a real failure and
  // never an empty list that means two things. Seventh time this project
  // has swapped a prompt rewrite for a code gate.
  if (!known && covered !== false) {
    try {
      const loc = await getLocation(config);
      alerts = await withinMs(getNwsAlerts(loc.latitude, loc.longitude), waitMs, "the warning service");
      known = true;
    } catch (err) {
      // 400 and 404 both mean "no feed covers this point" - see the note in
      // lib/alertwatch.js about the two endpoints disagreeing. A timeout is
      // neither: it means not checked, and says nothing about coverage.
      known = false;
      if (err.status === 400 || err.status === 404) covered = false;
    }
  }
  return { alerts, known, covered };
}

export const weather = [
  {
    name: "get_weather",
    description:
      "Get current conditions and the forecast for the user's location. Use for any weather question, including 'do I need a jacket' style questions.",
    parameters: {
      type: "object",
      properties: {
        days: { type: "integer", description: "Days of forecast, 1 to 7. Use 1 for right-now questions, 3 for a general forecast." },
        place: {
          type: "string",
          description:
            "Somewhere other than home, e.g. 'Tokyo' or 'Iceland'.",
        },
      },
      required: [],
    },
    async run(input, ctx) {
    const place = await ctx.resolvePlace(input.place);
    const here = place ?? (await getLocation(ctx.config));

    // All three at once. They used to run one after another - the forecast,
    // then the warning check, then the air - so every weather answer waited for
    // the SUM of three services, and the weather question averaged 5.0 s in his
    // log against 2.2 s for asking the time. The forecast is the answer and gets
    // its full timeout. The other two are extras: each gets EXTRAS_MS, after
    // which it is reported as not checked rather than holding the answer up.
    // Each extra catches its own failure, so a rejected forecast cannot leave an
    // unhandled rejection behind it.
    const [forecast, warnings, air] = await Promise.all([
      getWeather(ctx.config, { days: input.days ?? 3, place }),
      place ? Promise.resolve(null) : checkWarnings(ctx.config),
      withinMs(getAirQuality(ctx.config, here), EXTRAS_MS, "the air quality service").catch(() => null),
    ]);

    // Any warning in force gets attached, so "are there any weather warnings?"
    // is answerable without a second tool. It costs NOTHING: lib/alertwatch.js
    // is already polling this location every three minutes to decide whether
    // to interrupt, so this is reading a value that is already in memory.
    //
    // Home only. The watcher only knows about where the user is, and quietly
    // reporting Chapel Hill's warnings against a forecast for Reykjavik would
    // be the fabricated-source failure with the geography swapped.
    if (warnings) {
      const { alerts, known, covered } = warnings;
      if (alerts.length) {
        forecast.warningsInForce = alerts.map((a) => ({
          event: a.event,
          severity: a.severity,
          area: a.area,
          headline: a.headline,
          from: a.sender,
        }));
      } else if (known) {
        // Checked, and there are genuinely none. Said explicitly rather than
        // by omission, because a model reading a missing field infers whatever
        // suits the sentence it is already writing.
        forecast.warningsInForce = [];
        forecast.warningsNote = "Checked just now: no weather warnings are in force here.";
      } else {
        forecast.warningsNote = covered === false
          ? "NO WARNING FEED. This location is outside the US National Weather Service's area. Say you cannot check warnings here rather than saying there are none."
          : "COULD NOT CHECK. The warning service did not answer. Say you were unable to check rather than saying there are no warnings.";
      }
    }
  
    // The sky and the air, carried on the answer he was already giving.
    //
    // This is where "when does it get dark?" and "how's the air out there?" get
    // ANSWERED, and putting them here rather than behind tools of their own is
    // what let two channels be added without repeating a mistake this project
    // has made twice: "what's playing" and "what is the NASDAQ at" both changed
    // channel instead of answering, and the fix both times was to give the
    // question somewhere else to go. The channels SHOW; this TELLS.
    //
    // Free in schema terms — only descriptions cost tokens per turn, and these
    // add none. The sun costs no request either, being arithmetic.
    //
    // `place` is NULL for the user's own location, which is the common case, so
    // it has to be resolved rather than passed straight through. Handing null
    // to sunAndMoon returns "I do not know where you are" — which would have
    // meant sunrise worked for every city except the one they live in.
    try {
      const sky = sunAndMoon(here);
      if (!sky.error) {
        forecast.sun = {
          sunrise: sky.sunrise,
          sunset: sky.sunset,
          daylight: sky.dayLength,
          ...(sky.note ? { note: sky.note } : {}),
        };
        forecast.moon = `${sky.moon.name}, ${sky.moon.illumination}% lit`;
      }
    } catch {
      // Never worth failing a forecast over.
    }

    // The forecast is the answer; the air is a bonus, and a late or failed one
    // is simply left out.
    if (air && !air.error && air.aqi !== null) {
      forecast.airQuality = {
        index: air.aqi,
        band: air.band,
        ...(air.pollen?.length ? { pollen: `${air.pollen[0].name} ${air.pollen[0].level}` } : {}),
      };
    }

    return forecast;
    },
  },
];
