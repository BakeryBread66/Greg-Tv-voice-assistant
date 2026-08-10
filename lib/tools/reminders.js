// Reminders tools: schema and handler together.
//
// They used to be 400 lines apart in lib/brain.js — one entry in a 23-item
// array, one case in a 23-case switch — with nothing stopping the two
// drifting. `run` receives (input, ctx); ctx carries what a handler needs
// from the brain and cannot import for itself.

import { addReminder, cancelReminder, listReminders } from "../reminders.js";

export const reminders = [
  {
    name: "set_reminder",
    description:
      // Trimmed of its tail ("Greg will speak up when it comes due…"), which was
      // flavour rather than routing or argument-filling, and of the recurrence
      // examples that the `repeat` parameter below already carries. Every rule
      // this project measured — the clock-time format, `at` being required with
      // `repeat` — is kept word for word.
      "Set a timer, a one-off reminder, or a repeating daily one. Use in_minutes or in_seconds for a countdown ('in ten minutes'), or at for a clock time ('at 3pm'). Add repeat for anything that happens every day.",
    parameters: {
      type: "object",
      properties: {
        in_minutes: { type: "number", description: "Countdown length in minutes." },
        in_seconds: { type: "number", description: "Countdown length in seconds, for short timers." },
        at: { type: "string", description: "A clock time, formatted as '3pm', '3:30 pm' or '15:30'. Convert phrases like 'quarter past four' into this form yourself. Required when repeat is set." },
        repeat: {
          type: "string",
          enum: ["daily", "weekdays"],
          description:
            // One example per case rather than three. The recurrence phrasings
            // themselves are matched in CODE — reminderWasClaimedNotSet() — so
            // the schema does not have to enumerate them to be safe.
            "Set for anything recurring. 'daily' for every day ('every morning'); 'weekdays' for Monday to Friday only. Leave empty for a one-off.",
        },
        text: { type: "string", description: "What it is for, e.g. 'the pasta', 'call the dentist' or 'take your medicine'." },
      },
      required: [],
    },
    async run(input, ctx) {
    return addReminder({
      inMinutes: input.in_minutes,
      inSeconds: input.in_seconds,
      at: input.at,
      text: input.text,
      repeat: input.repeat,
    });
    },
  },
  {
    name: "list_reminders",
    description: "List the timers and reminders that are currently set.",
    parameters: { type: "object", properties: {}, required: [] },
    async run(input, ctx) {
    const all = listReminders();
    return all.length ? { reminders: all } : { reminders: [], note: "nothing is set" };
    },
  },
  {
    name: "cancel_reminder",
    description: "Cancel a timer or reminder by describing it, or pass 'all' to cancel everything.",
    parameters: {
      type: "object",
      properties: { which: { type: "string", description: "Words identifying the reminder, e.g. 'dentist', or 'all'." } },
      required: ["which"],
    },
    async run(input, ctx) {
    const cancelled = cancelReminder(input.which ?? "");
    return cancelled.length ? { cancelled } : { cancelled: [], note: "nothing matched" };
    },
  },
];
