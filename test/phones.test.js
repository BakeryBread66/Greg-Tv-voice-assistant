// Pairing phones: codes, tokens, removal and notifications. On a scratch
// phones.json; the real one is compared before and after.

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  usePhonesFile, startPairing, pendingPairing, pair, phoneFor, listPhones, removePhone,
  vapidPublicKey, setSubscription, notifyPhones,
} from "../lib/phones.js";
import { b64u } from "../lib/webpush.js";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
const REAL = path.join(ROOT, "phones.json");
const realBefore = fs.existsSync(REAL) ? fs.readFileSync(REAL, "utf8") : null;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "greg-phones-"));
let file;
let n = 0;

beforeEach(() => {
  file = path.join(DIR, `phones-${n++}.json`);
  usePhonesFile(file);
});

after(() => {
  assert.equal(fs.existsSync(REAL) ? fs.readFileSync(REAL, "utf8") : null, realBefore, "the real phones.json is untouched");
  fs.rmSync(DIR, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 8, 23, 12);

test("the right code pairs a phone once, and hands back a token that identifies it", () => {
  const { code } = startPairing({ now: T0 });
  assert.match(code, /^\d{6}$/);
  const result = pair(code, "Sam's iPhone", { now: T0 + 1000 });
  assert.ok(result.token.length >= 40);
  assert.equal(result.phone.name, "Sam's iPhone");
  assert.equal(phoneFor(result.token, { now: T0 + 2000 }).id, result.phone.id);
  // The same code cannot pair a second phone.
  assert.match(pair(code, "another", { now: T0 + 3000 }).error, /no pairing code/);
});

test("the token is never stored, and never shown to Settings", () => {
  const { code } = startPairing({ now: T0 });
  const { token } = pair(code, "Phone", { now: T0 });
  const onDisk = fs.readFileSync(file, "utf8");
  assert.ok(!onDisk.includes(token), "only a hash is kept");
  assert.ok(onDisk.includes(crypto.createHash("sha256").update(token).digest("hex")));
  const listed = JSON.stringify(listPhones());
  assert.ok(!listed.includes(token) && !listed.includes("tokenHash"));
});

test("a code expires after ten minutes", () => {
  const { code } = startPairing({ now: T0 });
  assert.ok(pendingPairing({ now: T0 + 9 * 60_000 }));
  assert.equal(pendingPairing({ now: T0 + 11 * 60_000 }), null);
  assert.match(pair(code, "late", { now: T0 + 11 * 60_000 }).error, /no pairing code/);
});

test("five wrong guesses end the code", () => {
  const { code } = startPairing({ now: T0 });
  const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 4; i++) assert.match(pair(wrong, "x", { now: T0 }).error, /isn't right/);
  assert.match(pair(wrong, "x", { now: T0 }).error, /Too many/);
  assert.match(pair(code, "x", { now: T0 }).error, /no pairing code/, "even the right code is dead now");
});

test("no code, junk codes and junk tokens get nothing", () => {
  assert.match(pair("123456", "x").error, /no pairing code/);
  startPairing({ now: T0 });
  for (const junk of [null, "", "12345", "1234567", "abcdef"]) assert.ok(pair(junk, "x", { now: T0 }).error, String(junk));
  for (const token of [null, undefined, "", "short", "x".repeat(500), crypto.randomBytes(32).toString("base64url")]) {
    assert.equal(phoneFor(token), null, String(token).slice(0, 10));
  }
});

test("removing a phone revokes its token at once", () => {
  const { code } = startPairing({ now: T0 });
  const { token, phone } = pair(code, "Old phone", { now: T0 });
  assert.deepEqual(removePhone(phone.id), { ok: true });
  assert.equal(phoneFor(token), null);
  assert.match(removePhone(phone.id).error, /isn't paired/);
});

test("the notification identity is made once and kept", () => {
  const key = vapidPublicKey();
  assert.equal(Buffer.from(key, "base64url").length, 65);
  usePhonesFile(file); // re-read from disk
  assert.equal(vapidPublicKey(), key);
});

const subscription = () => {
  const ua = crypto.createECDH("prime256v1");
  ua.generateKeys();
  return { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(crypto.randomBytes(16)) } };
};

test("notifications go to subscribed phones, and a gone subscription is forgotten", async () => {
  startPairing({ now: T0 });
  const a = pair(pendingPairing({ now: T0 }).code, "A", { now: T0 });
  startPairing({ now: T0 });
  const b = pair(pendingPairing({ now: T0 }).code, "B", { now: T0 });
  startPairing({ now: T0 });
  pair(pendingPairing({ now: T0 }).code, "C, no notifications", { now: T0 });

  assert.deepEqual(setSubscription(a.phone.id, subscription()), { ok: true });
  assert.deepEqual(setSubscription(b.phone.id, subscription()), { ok: true });
  assert.match(setSubscription(a.phone.id, { endpoint: "https://127.0.0.1/steal", keys: {} }).error, /isn't a notification subscription/);

  const sent = [];
  const delivered = await notifyPhones({ title: "Greg", body: "Medicine" }, {
    send: async (sub, payload) => {
      sent.push(payload);
      return sent.length === 1 ? { ok: true } : { gone: true };
    },
  });
  assert.equal(delivered, 1);
  assert.equal(sent.length, 2, "only the two that asked");
  const phones = Object.fromEntries(listPhones().map((p) => [p.name, p.notifications]));
  assert.deepEqual(phones, { A: true, B: false, "C, no notifications": false });
});
