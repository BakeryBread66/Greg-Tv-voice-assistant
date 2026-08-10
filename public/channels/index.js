// Which renderer draws which channel.
//
// Adding a channel is now one file in this folder plus one line here — the
// eight renderers used to live inside face-tv.js and had taken it to 3,822
// lines, of which they were 1,073.
//
// Every renderer has the same shape: draw(ctx, x, y, w, h, view). `view` is
// the small read-only surface they need from the face — see viewFor() in
// face-tv.js. Keeping that surface narrow is what made this extraction
// mechanical: across all eight, they reached for exactly six things.

import * as ceefax from "./ceefax.js";
import * as weather from "./weather.js";
import * as apod from "./apod.js";
import * as spacewx from "./spacewx.js";
import * as radar from "./radar.js";
import * as stocks from "./stocks.js";
import * as flights from "./flights.js";
import * as agenda from "./agenda.js";
import * as engineering from "./engineering.js";
import * as sunmoon from "./sunmoon.js";
import * as air from "./air.js";

export const RENDERERS = {
  ceefax: ceefax.draw,
  weather: weather.draw,
  apod: apod.draw,
  spacewx: spacewx.draw,
  radar: radar.draw,
  stocks: stocks.draw,
  flights: flights.draw,
  agenda: agenda.draw,
  engineering: engineering.draw,
  sunmoon: sunmoon.draw,
  air: air.draw,
};

// What the stale strip says, per channel. "Out of date" alone is true and
// useless: yesterday's astronomy picture and a four-hour-old forecast are very
// different things to be looking at.
//
// Lives here rather than beside its renderer because the strip is drawn by
// drawProgramme() in face-tv.js, which reserves the space for it — see the note
// there about one shared helper drawing into space nobody reserved being four
// collisions rather than one.
export const STALE_LEAD = {
  ceefax: "Headlines may be out of date",
  weather: "Forecast may be out of date",
  apod: "An older picture",
  spacewx: "Reading may be out of date",
  radar: "Radar may be out of date",
  stocks: "Prices may be out of date",
  flights: "Aircraft positions may be out of date",
  agenda: "List may be out of date",
  engineering: "Readings may be out of date",
  // Never actually stale in the sense the others are: it is computed, not
  // fetched, so the only way here is a clock that stopped.
  sunmoon: "Times may be out of date",
  air: "Reading may be out of date",
};
