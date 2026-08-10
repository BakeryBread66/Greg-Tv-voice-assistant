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
    const forecast = await getWeather(ctx.config, { days: input.days ?? 3, place });
  
    // Any warning in force gets attached, so "are there any weather warnings?"
    // is answerable without a second tool. It costs NOTHING: lib/alertwatch.js
    // is already polling this location every three minutes to decide whether
    // to interrupt, so this is reading a value that is already in memory.
    //
    // Home only. The watcher only knows about where the user is, and quietly
    // reporting Chapel Hill's warnings against a forecast for Reykjavik would
    // be the fabricated-source failure with the geography swapped.
    if (!place) {
      const watch = alertWatchStatus();
      let alerts = activeAlerts();
      let known = watch.checked && !watch.stale;
  
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
      if (!known && watch.covered !== false) {
        try {
          const loc = await getLocation(ctx.config);
          alerts = await getNwsAlerts(loc.latitude, loc.longitude);
          known = true;
        } catch (err) {
          // 400 and 404 both mean "no feed covers this point" — see the note
          // in lib/alertwatch.js about the two endpoints disagreeing.
          known = false;
          if (err.status === 400 || err.status === 404) watch.covered = false;
        }
      }
  
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
        forecast.warningsNote = watch.covered === false
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
    const here = place ?? (await getLocation(ctx.config));

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

    try {
      const air = await getAirQuality(ctx.config, here);
      if (!air.error && air.aqi !== null) {
        forecast.airQuality = {
          index: air.aqi,
          band: air.band,
          ...(air.pollen?.length ? { pollen: `${air.pollen[0].name} ${air.pollen[0].level}` } : {}),
        };
      }
    } catch {
      // The forecast is the answer; the air is a bonus.
    }

    return forecast;
    },
  },
];
