// The Memory tab in Settings: seeing, correcting and deleting what he remembers
// and what he has scheduled.
//
// Every test here points both stores at scratch files. The real memory.json and
// reminders.json are compared before and after, because both modules used to
// have one hard-coded path and this project has already had a fake medicine
// reminder written into the real store by a test.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { useMemoryFile, remember, listFactRecords, editFact, deleteFact, listFacts } from "../lib/memory.js";
import { useRemindersFile, initReminders, addReminder, listReminders, updateReminder, deleteReminder } from "../lib/reminders.js";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
const REAL = ["memory.json", "reminders.json"].map((name) => path.join(ROOT, name));
const snapshot = () => REAL.map((file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null));

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "greg-memory-tab-"));
let realBefore;

before(() => {
  realBefore = snapshot();
  useMemoryFile(path.join(DIR, "memory.json"));
  useRemindersFile(path.join(DIR, "reminders.json"));
  initReminders(() => {});
});

after(() => {
  // Disarm everything this file set, then check nothing real was touched.
  useRemindersFile(path.join(DIR, "unused.json"));
  assert.deepEqual(snapshot(), realBefore, "the real memory.json and reminders.json are unchanged");
  fs.rmSync(DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

test("facts are listed with when they were saved", () => {
  remember("The user drives a blue Subaru Outback");
  const [fact] = listFactRecords().filter((f) => f.text.includes("Subaru"));
  assert.ok(fact);
  assert.ok(Number.isFinite(Date.parse(fact.savedAt)));
});

test("editing a fact rewords that fact and no other", () => {
  // Sharing words, and neither contained in the other: remember() would
  // otherwise have merged them before this test began.
  remember("The user likes black tea");
  remember("The user likes tea cakes from the bakery");
  const result = editFact("The user likes black tea", "The user likes green tea");
  assert.equal(result.ok, true);
  const facts = listFacts();
  assert.ok(facts.includes("The user likes green tea"));
  assert.ok(facts.includes("The user likes tea cakes from the bakery"));
  assert.ok(!facts.includes("The user likes black tea"));
});

test("a fact cannot be edited into nothing, into a duplicate, or once it has gone", () => {
  remember("The user has a dog called Biscuit");
  assert.match(editFact("The user has a dog called Biscuit", "   ").error, /can't be empty/);
  assert.match(editFact("The user has a dog called Biscuit", "x".repeat(301)).error, /too long/);
  remember("The user works nights");
  assert.match(editFact("The user works nights", "The user has a dog called Biscuit").error, /already knows/);
  assert.match(editFact("Nobody said this", "anything").error, /isn't there/);
  assert.match(editFact(null, "anything").error, /isn't there/);
});

test("deleting takes exactly the fact that was clicked", () => {
  // forget("the user likes coffee") would take both of these; a click on one
  // must never remove the other.
  remember("The user likes coffee in the morning");
  remember("The user likes coffee ice cream");
  assert.equal(deleteFact("The user likes coffee in the morning").ok, true);
  assert.ok(listFacts().includes("The user likes coffee ice cream"));
  assert.ok(!listFacts().includes("The user likes coffee in the morning"));
  assert.match(deleteFact("The user likes coffee in the morning").error, /isn't there/);
  assert.match(deleteFact("").error, /isn't there/);
});

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

const DAY = 86400000;
/** A clock time some days ahead, as addReminder's `at` accepts it. */
const daysAhead = (days, hour, minute = 0) => {
  const when = new Date(Date.now() + days * DAY);
  when.setHours(hour, minute, 0, 0);
  return when;
};

test("a reminder can be renamed", () => {
  const { id } = addReminder({ at: daysAhead(3, 15).toISOString(), text: "call the dentist" });
  const result = updateReminder(id, { text: "call the dentist about Friday" });
  assert.equal(result.ok, true);
  assert.equal(listReminders().find((r) => r.id === id).text, "call the dentist about Friday");
  deleteReminder(id);
});

test("moving a one-off to a new time keeps its day", () => {
  // Parsed as "the next 4pm" it would land today. It is on its day, at 4.
  const due = daysAhead(3, 15);
  const { id } = addReminder({ at: due.toISOString(), text: "dentist" });
  updateReminder(id, { time: "16:30" });
  const moved = new Date(listReminders().find((r) => r.id === id).dueAt);
  assert.equal(moved.toDateString(), due.toDateString());
  assert.equal(moved.getHours(), 16);
  assert.equal(moved.getMinutes(), 30);
  deleteReminder(id);
});

test("a one-off moved into the past is refused, not fired or quietly moved", () => {
  const due = daysAhead(0, 23, 59);
  const { id } = addReminder({ at: due.toISOString(), text: "late" });
  // Pretend it is 23:59:30 on its day, and ask for 9am.
  const now = new Date(due).setSeconds(30);
  const result = updateReminder(id, { time: "09:00" }, now);
  assert.match(result.error, /already passed/);
  assert.equal(listReminders().find((r) => r.id === id).dueAt, due.getTime(), "unchanged");
  deleteReminder(id);
});

test("made to repeat, it goes off at the next occurrence — tonight if tonight is still ahead", () => {
  const { id } = addReminder({ at: daysAhead(2, 8).toISOString(), text: "medicine" });
  const now = new Date();
  now.setHours(10, 0, 0, 0);
  updateReminder(id, { time: "20:00", repeat: "daily" }, now.getTime());
  const item = listReminders().find((r) => r.id === id);
  assert.equal(item.repeat, "daily");
  const due = new Date(item.dueAt);
  assert.equal(due.toDateString(), now.toDateString(), "today, not the day it used to be due");
  assert.equal(due.getHours(), 20);
  deleteReminder(id);
});

test("a weekday reminder never lands on a weekend", () => {
  const { id } = addReminder({ at: daysAhead(1, 9).toISOString(), text: "homework" });
  // A Saturday morning.
  const saturday = new Date(2026, 8, 26, 7, 0);
  assert.equal(saturday.getDay(), 6);
  updateReminder(id, { time: "08:00", repeat: "weekdays" }, saturday.getTime());
  const due = new Date(listReminders().find((r) => r.id === id).dueAt);
  assert.ok(![0, 6].includes(due.getDay()), `landed on ${due.toDateString()}`);
  assert.equal(due.getHours(), 8);
  deleteReminder(id);
});

test("stopping it repeating leaves it as a one-off at its next time", () => {
  const { id } = addReminder({ at: "9am", text: "walk", repeat: "daily" });
  const before = listReminders().find((r) => r.id === id).dueAt;
  updateReminder(id, { repeat: "none" });
  const item = listReminders().find((r) => r.id === id);
  assert.equal(item.repeat, null);
  assert.equal(item.dueAt, before);
  deleteReminder(id);
});

test("a timer can only be renamed", () => {
  const { id } = addReminder({ inMinutes: 10, text: "pasta" });
  const due = listReminders().find((r) => r.id === id).dueAt;
  assert.equal(updateReminder(id, { text: "the pasta" }).ok, true);
  assert.match(updateReminder(id, { time: "18:00" }).error, /only its name/);
  assert.match(updateReminder(id, { repeat: "daily" }).error, /only its name/);
  // The dialog sends these for a timer's row when nothing was changed.
  assert.equal(updateReminder(id, { time: "", repeat: "none" }).ok, true);
  assert.equal(listReminders().find((r) => r.id === id).dueAt, due, "still counting down from when it was set");
  deleteReminder(id);
});

test("nonsense is refused and changes nothing", () => {
  const { id } = addReminder({ at: daysAhead(2, 12).toISOString(), text: "lunch" });
  const before = JSON.stringify(listReminders().find((r) => r.id === id));
  assert.match(updateReminder(id, { time: "25:00" }).error, /isn't a time/);
  assert.match(updateReminder(id, { time: "noon" }).error, /isn't a time/);
  assert.match(updateReminder(id, { repeat: "hourly" }).error, /repeats daily/);
  assert.match(updateReminder(id, { text: "  " }).error, /needs something/);
  assert.match(updateReminder(id, { text: "x".repeat(201) }).error, /too long/);
  assert.equal(JSON.stringify(listReminders().find((r) => r.id === id)), before);
  assert.match(updateReminder("r-nope", { text: "x" }).error, /isn't there/);
  deleteReminder(id);
});

test("deleting takes exactly the reminder that was clicked", () => {
  const a = addReminder({ at: daysAhead(4, 10).toISOString(), text: "take medicine" });
  const b = addReminder({ at: daysAhead(4, 20).toISOString(), text: "take medicine again" });
  assert.equal(deleteReminder(a.id).ok, true);
  assert.ok(listReminders().some((r) => r.id === b.id));
  assert.ok(!listReminders().some((r) => r.id === a.id));
  assert.match(deleteReminder(a.id).error, /isn't there/);
  // cancelReminder's word match would take anything containing the text; an
  // id that is not exactly one takes nothing.
  assert.match(deleteReminder("take medicine").error, /isn't there/);
  deleteReminder(b.id);
});

test("the edits are saved to the store's own file", () => {
  const { id } = addReminder({ at: daysAhead(5, 11).toISOString(), text: "before" });
  updateReminder(id, { text: "after" });
  const stored = JSON.parse(fs.readFileSync(path.join(DIR, "reminders.json"), "utf8"));
  assert.equal(stored.items.find((i) => i.id === id).text, "after");
  deleteReminder(id);
});
