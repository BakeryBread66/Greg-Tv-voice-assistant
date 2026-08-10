// Timers and reminders.
//
// Survives a restart: anything still in the future is re-armed when Greg starts,
// and anything that came due while he was off is announced straight away rather
// than silently lost.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILE = path.join(ROOT, "reminders.json");

// { id, text, dueAt (ms), kind: "timer" | "reminder", repeat?: "daily" | "weekdays" }
let items = [];
const handles = new Map();
let announce = () => {};

// How stale a missed recurring reminder can be and still be worth saying.
//
// Medicine is the case that decides this: if Greg was off at nine and you start
// him at eleven, you want to hear about it. If he has been off for three days
// you do not want three announcements, and "time to take your medicine" at
// midnight for a dose due yesterday morning is worse than silence — it is
// wrong, and acting on it would be a double dose. So: announce once, name the
// time it was actually due, and only within the same part of the same day.
const LATE_WINDOW_MS = 12 * 3600 * 1000;

const WEEKEND = new Set([0, 6]);

/**
 * The next time a repeating reminder is due after `from`.
 *
 * Steps in whole DAYS on a Date rather than adding 86400000 ms, so "nine every
 * morning" stays at nine through a daylight-saving change instead of drifting an
 * hour twice a year.
 */
function nextOccurrence(from, repeat) {
  const next = new Date(from);
  do {
    next.setDate(next.getDate() + 1);
  } while (repeat === "weekdays" && WEEKEND.has(next.getDay()));
  return next.getTime();
}

/** Roll forward until it is in the future — covers Greg having been off for days. */
function rollForward(dueAt, repeat, now = Date.now()) {
  let when = dueAt;
  let guard = 0;
  while (when <= now && guard++ < 4000) when = nextOccurrence(when, repeat);
  return when;
}

const save = () => {
  try {
    fs.writeFileSync(FILE, JSON.stringify({ items }, null, 2));
  } catch (err) {
    console.error("[reminders] could not save:", err.message);
  }
};

function fire(item, { late = false } = {}) {
  // Captured before rescheduling, so the announcement names the time it was
  // actually due rather than the next one.
  const wasDueAt = item.dueAt;
  handles.delete(item.id);

  if (item.repeat) {
    item.dueAt = rollForward(item.dueAt, item.repeat);
    save();
    arm(item);
  } else {
    items = items.filter((i) => i.id !== item.id);
    save();
  }

  announce({ ...item, dueAt: wasDueAt, late, dueAtLocal: clockOf(wasDueAt) });
}

const clockOf = (ms) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

function arm(item) {
  const delay = item.dueAt - Date.now();
  // setTimeout tops out around 24.8 days; anything longer gets re-armed in stages.
  const capped = Math.min(delay, 2_000_000_000);
  const handle = setTimeout(() => (delay > capped ? arm(item) : fire(item)), Math.max(capped, 0));
  handles.set(item.id, handle);
}

/** Start the store. `onFire` is called whenever something comes due. */
export function initReminders(onFire) {
  announce = onFire;

  try {
    items = JSON.parse(fs.readFileSync(FILE, "utf8")).items ?? [];
  } catch {
    items = [];
  }

  const now = Date.now();
  const overdue = items.filter((i) => i.dueAt <= now);

  // A repeating reminder is never discarded for having been missed — that is the
  // whole point of it. It is rolled on to its next occurrence and re-armed;
  // only one-offs are consumed.
  const missed = [];
  for (const item of overdue) {
    const wasDueAt = item.dueAt;
    if (item.repeat) {
      item.dueAt = rollForward(item.dueAt, item.repeat, now);
      // Worth saying only if it is still the same stretch of day — see
      // LATE_WINDOW_MS. Otherwise it rolls on silently.
      if (now - wasDueAt <= LATE_WINDOW_MS) {
        missed.push({ ...item, dueAt: wasDueAt, dueAtLocal: clockOf(wasDueAt), late: true });
      }
    } else {
      missed.push({ ...item, dueAtLocal: clockOf(wasDueAt), late: true });
    }
  }

  items = items.filter((i) => i.dueAt > now);
  items.forEach(arm);
  save();

  // Announce anything missed while Greg was shut down, once he's listening.
  if (missed.length) setTimeout(() => missed.forEach((i) => announce(i)), 4000);

  return { restored: items.length, missed: missed.length, repeating: items.filter((i) => i.repeat).length };
}

const friendly = (ms) => {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return `${Math.max(1, Math.round(ms / 1000))} seconds`;
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return `${hours} hour${hours === 1 ? "" : "s"}${rest ? ` ${rest} minutes` : ""}`;
};

/**
 * Parse a clock time like "3pm", "3:30 pm", "15:30" into the next time it occurs.
 * Returns null if it isn't a time.
 */
export function parseClockTime(input, now = new Date()) {
  const match = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i.exec(String(input ?? ""));
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = match[3]?.toLowerCase();

  if (hour > 23 || minute > 59) return null;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;

  const due = new Date(now);
  due.setHours(hour, minute, 0, 0);
  if (due <= now) due.setDate(due.getDate() + 1); // already passed today -> tomorrow
  return due;
}

/** Create a timer (relative), a reminder (clock time), or a repeating one. */
export function addReminder({ inMinutes, inSeconds, at, text, repeat }) {
  let dueAt;
  let kind;

  const repeats = repeat === "daily" || repeat === "weekdays" ? repeat : null;
  // A countdown that repeats is not a thing anyone means — "remind me every day
  // in ten minutes" has no fixed point to recur on. Say so rather than creating
  // something that fires at a time which drifts every day.
  if (repeats && !at) throw new Error("a repeating reminder needs a time of day, like 9am");

  if (inSeconds || inMinutes) {
    const ms = (Number(inSeconds) || 0) * 1000 + (Number(inMinutes) || 0) * 60000;
    if (!(ms > 0)) throw new Error("that duration doesn't make sense");
    if (ms > 30 * 24 * 3600 * 1000) throw new Error("that's further out than a month");
    dueAt = Date.now() + ms;
    kind = "timer";
  } else if (at) {
    const parsed = parseClockTime(at) ?? (isNaN(Date.parse(at)) ? null : new Date(Date.parse(at)));
    if (!parsed) throw new Error(`I couldn't read "${at}" as a time`);
    dueAt = parsed.getTime();
    // "every weekday at 9am" said on a Saturday must not fire on the Sunday.
    if (repeats === "weekdays" && WEEKEND.has(new Date(dueAt).getDay())) {
      dueAt = rollForward(dueAt, "weekdays", dueAt - 1);
    }
    kind = "reminder";
  } else {
    throw new Error("I need either a duration or a time");
  }

  const item = {
    id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    text: String(text ?? "").trim() || (kind === "timer" ? "your timer" : "your reminder"),
    dueAt,
    kind,
    ...(repeats ? { repeat: repeats } : {}),
  };

  items.push(item);
  arm(item);
  save();

  return {
    id: item.id,
    text: item.text,
    kind,
    repeat: repeats,
    every: repeats === "daily" ? "every day" : repeats === "weekdays" ? "every weekday" : null,
    dueIn: friendly(dueAt - Date.now()),
    dueAtLocal: clockOf(dueAt),
  };
}

export function listReminders() {
  return items
    .slice()
    .sort((a, b) => a.dueAt - b.dueAt)
    .map((i) => ({
      id: i.id,
      text: i.text,
      kind: i.kind,
      repeat: i.repeat ?? null,
      every: i.repeat === "daily" ? "every day" : i.repeat === "weekdays" ? "every weekday" : null,
      dueIn: friendly(i.dueAt - Date.now()),
      dueAtLocal: clockOf(i.dueAt),
      // The raw timestamp as well as the friendly string. The Agenda channel
      // groups by day and counts down between polls, and neither can be done
      // from "in about 20 minutes" without parsing English back into a time.
      dueAt: i.dueAt,
    }));
}

/** Cancel by id, or by matching words in the text. */
export function cancelReminder(query) {
  const needle = String(query ?? "").toLowerCase().trim();
  if (!needle) throw new Error("which one?");

  const matches = items.filter(
    (i) => i.id === needle || i.text.toLowerCase().includes(needle) || needle.includes(i.text.toLowerCase())
  );
  const target = needle === "all" ? items.slice() : matches.length ? matches : [];

  if (!target.length) return [];

  for (const item of target) {
    clearTimeout(handles.get(item.id));
    handles.delete(item.id);
  }
  items = items.filter((i) => !target.includes(i));
  save();

  return target.map((i) => i.text);
}
