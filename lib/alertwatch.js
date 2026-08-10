// Watching for a weather warning, so it can interrupt whatever is showing.
//
// This is the one thing in the channel set that is useful rather than lovely,
// and the only one that wants to interrupt rather than wait to be selected. A
// television that carries on showing the album art through a tornado warning is
// a television with the priorities wrong.
//
// It is deliberately conservative, for one reason: on an ordinary day there are
// dozens of Air Quality Alerts and Heat Advisories in force across the country.
// Interrupting for those would train the user to ignore the interruption, which
// is strictly worse than never having built it — the same failure as an alarm
// clock you have learned to sleep through. So only Severe and Extreme alerts,
// only Immediate or Expected urgency, and only once per alert id.
//
// The shape is lib/power.js's and lib/channels.js's: the state lives here, the
// server subscribes, and nothing else keeps a second copy.

import { getNwsAlerts, worthInterrupting, describeAlert } from "./nws.js";
import { getLocation } from "./location.js";

// Three minutes. A warning is issued and in force within seconds, so this is
// about how late Greg can be to it — and it is a small keyless JSON request,
// so the cost of asking is not the constraint.
const DEFAULT_POLL_MS = 3 * 60 * 1000;

// Never faster than this, whatever the config says. api.weather.gov is free and
// asks for politeness rather than enforcing a quota, which means the only thing
// stopping a typo in config.json from hammering it is this line.
const MIN_POLL_MS = 20 * 1000;

// A warning that ended while Greg was off is not news. Same reasoning as the
// missed-reminder window: acting on a stale alarm is worse than silence.
const STALE_MS = 60 * 60 * 1000;

// How old the last successful check can be before what it found stops counting
// as current. Generous next to the three-minute poll — it is here to catch a
// watch that has silently stopped answering, not to flag ordinary timing.
const STALE_CHECK_MS = 15 * 60 * 1000;

let timer = null;
let announced = new Set();
let active = [];
let started = false;
let checkedAt = 0;
let coverage = null; // null = don't know yet, false = outside NWS
const listeners = new Set();

/** Everything currently in force, most severe first. */
export function activeAlerts() {
  return active;
}

/**
 * Has anything actually been checked?
 *
 * This exists because an empty list is TWO different facts and collapsing them
 * produces a confident lie. `get_weather` attaches the warnings in force, and
 * with a bare array it could not tell "I checked and there are none" from "the
 * watch has not run yet" — so asked "are there any weather warnings?" seconds
 * after startup, with alerts switched off, or outside NWS coverage, Greg
 * answered "no specific weather warnings are currently in effect" having looked
 * at nothing. Measured: he said exactly that, in a process where the watcher had
 * never polled.
 *
 * Same shape as the empty-search-result rule — a model handed an empty list
 * fills the silence — and the same shape as `proven` versus `enabled` on the
 * eyes. An absence of evidence has to arrive labelled as one.
 *
 * `stale` is separate again: the last poll worked but was a while ago, so the
 * list is real and possibly out of date.
 */
export function alertWatchStatus() {
  return {
    checked: checkedAt > 0,
    checkedAt,
    stale: checkedAt > 0 && Date.now() - checkedAt > STALE_CHECK_MS,
    // False means api.weather.gov does not cover this location at all, which is
    // a permanent answer rather than a failure to look.
    covered: coverage,
    watching: started,
  };
}

export function onAlert(listener) {
  listeners.add(listener);
}

/**
 * Begin watching. Safe to call twice.
 *
 * `config.alerts.enabled` turns it off entirely — a warning arriving as speech
 * unprompted is the most intrusive thing Greg does, and somebody who does not
 * want it needs a way to say so that is not "delete the file".
 */
export function startAlertWatch(config) {
  if (started || config.alerts?.enabled === false) return;
  started = true;

  // Straight away, then on the clock. The first poll matters: a warning already
  // in force when Greg starts is still a warning, and staying quiet about it
  // because it was issued four minutes ago would be exactly wrong.
  poll(config);
  const every = Math.max(MIN_POLL_MS, Number(config.alerts?.pollMs) || DEFAULT_POLL_MS);
  timer = setInterval(() => poll(config), every);
  // The watch must never be the reason Node stays alive at shutdown.
  timer.unref?.();
}

export function stopAlertWatch() {
  clearInterval(timer);
  timer = null;
  started = false;
  announced = new Set();
  active = [];
  checkedAt = 0;
  coverage = null;
}

async function poll(config) {
  let alerts;
  try {
    const loc = await getLocation(config);
    alerts = await getNwsAlerts(loc.latitude, loc.longitude);
  } catch (err) {
    // Outside NWS coverage, or the service is down. Neither is worth a console
    // line every three minutes for the rest of the session — but they are
    // different, and `checkedAt` is deliberately NOT set either way: a failed
    // look is not a look, and anything reading this must be able to tell.
    //
    // 400, not 404. `/points` answers 404 for a coordinate outside the United
    // States, so that is what this checked for first — but `/alerts/active`
    // answers **400 Invalid Parameter** for the same coordinate. Measured:
    // Reykjavik and a point in the mid-Atlantic both 400. With the 404 test,
    // `covered` stayed null forever outside the US and Greg would have said the
    // feed "has not answered yet" — implying it might — instead of saying there
    // is no feed for that part of the world. Two endpoints of one service,
    // two different codes for one condition.
    if (err.status === 400 || err.status === 404) coverage = false;
    return;
  }

  coverage = true;
  checkedAt = Date.now();
  active = alerts;

  // Anything that has expired can be forgotten, or the set grows for as long as
  // Greg runs. Re-announcing a warning that lapsed and was genuinely reissued is
  // correct behaviour, not a bug.
  const live = new Set(alerts.map((a) => a.id));
  for (const id of announced) if (!live.has(id)) announced.delete(id);

  for (const alert of alerts) {
    if (announced.has(alert.id)) continue;
    if (!worthInterrupting(alert)) continue;

    // Issued long enough ago that it was in force before Greg was watching.
    // Still worth saying — it is still in force — but worth saying differently,
    // the way a missed reminder names the time it was actually due.
    const onset = alert.onset ? new Date(alert.onset).getTime() : Date.now();
    const late = Date.now() - onset > STALE_MS;

    // A warning whose end time has passed is not one to wake anybody for.
    if (alert.ends && new Date(alert.ends).getTime() < Date.now()) {
      announced.add(alert.id);
      continue;
    }

    announced.add(alert.id);
    fire(alert, late);
  }
}

function fire(alert, late) {
  const lead = late ? "Still in force:" : "Weather warning.";
  const spoken = `${lead} ${describeAlert(alert)}${alert.instruction ? ` ${firstSentence(alert.instruction)}` : ""}`;

  console.log(`\n[alert] ${alert.severity} — ${alert.event} — ${alert.area}`);

  for (const listener of listeners) {
    try {
      listener({ alert, spoken, late });
    } catch (err) {
      console.warn("[alert] listener failed:", err.message);
    }
  }
}

/**
 * The first sentence of the NWS's own advice.
 *
 * The instruction block runs to several paragraphs of shelter guidance. One
 * sentence of it read aloud is a useful thing; all of it is a lecture nobody
 * listens to the end of, and the rest is on the channel for anyone who wants it.
 */
function firstSentence(text) {
  const cleaned = String(text).replace(/\s+/g, " ").trim();
  const stop = /[.!?](\s|$)/.exec(cleaned);
  return stop ? cleaned.slice(0, stop.index + 1) : cleaned.slice(0, 160);
}
