// The phones allowed to talk to Greg from outside this PC.
//
// A phone is let in by a PAIRING CODE shown in Settings on the PC — so pairing
// needs somebody at the PC — and is then given a long random token it presents
// on every request. Only a hash of the token is stored, so phones.json read by
// anybody else cannot be turned into access. Removing a phone in Settings
// revokes it at once.
//
// Pairing codes are six digits, live for ten minutes, work once, and die after
// five wrong guesses: a million possibilities and five tries is a one in two
// hundred thousand chance, and the code has to have been started at the PC.
//
// phones.json also holds the VAPID key pair — the identity Greg signs his
// notifications with — and each phone's push subscription. It is gitignored.
// Takes a path, like every store here, so the tests never touch the real one.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeVapidKeys, sendPush, validSubscription } from "./webpush.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let file = path.join(ROOT, "phones.json");
let store = null;

const CODE_LIFETIME_MS = 10 * 60 * 1000;
const MAX_WRONG = 5;
let pairing = null; // { code, expiresAt, wrong }

/** Point the store at a different file. Only the tests call it. */
export function usePhonesFile(target) {
  file = path.resolve(String(target));
  store = null;
  pairing = null;
}

function load() {
  if (store) return store;
  try {
    store = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    store = {};
  }
  if (!Array.isArray(store.phones)) store.phones = [];
  if (!store.vapid?.publicKey || !store.vapid?.privateKey) {
    store.vapid = makeVapidKeys();
    save();
  }
  return store;
}

function save() {
  try {
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (err) {
    console.error("[phone] could not save phones.json:", err.message);
  }
}

const hash = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

/** What Settings and the logs may see of a phone. Never the token or its hash. */
const publicView = (phone) => ({
  id: phone.id,
  name: phone.name,
  pairedAt: phone.pairedAt,
  lastSeen: phone.lastSeen ?? null,
  notifications: Boolean(phone.push),
});

/** Start pairing: a fresh code, replacing any earlier one. */
export function startPairing({ now = Date.now() } = {}) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  pairing = { code, expiresAt: now + CODE_LIFETIME_MS, wrong: 0 };
  return { code, expiresAt: pairing.expiresAt };
}

/** The code still waiting to be used, if any — for Settings to keep showing it. */
export function pendingPairing({ now = Date.now() } = {}) {
  if (!pairing || now > pairing.expiresAt) return null;
  return { code: pairing.code, expiresAt: pairing.expiresAt };
}

export function cancelPairing() {
  pairing = null;
}

/**
 * A phone offering the code. Returns { token, phone } or { error }.
 * The token is returned exactly once, here, and never stored in the clear.
 */
export function pair(code, name, { now = Date.now() } = {}) {
  if (!pairing || now > pairing.expiresAt) {
    pairing = null;
    return { error: "There's no pairing code waiting. Start one in Greg's Settings, on the Phone tab." };
  }
  const offered = String(code ?? "").replace(/\s+/g, "");
  const expected = pairing.code;
  const matches = offered.length === expected.length && crypto.timingSafeEqual(Buffer.from(offered), Buffer.from(expected));
  if (!matches) {
    pairing.wrong += 1;
    if (pairing.wrong >= MAX_WRONG) {
      pairing = null;
      return { error: "Too many wrong codes. Start a new one in Settings." };
    }
    return { error: "That code isn't right." };
  }
  pairing = null;

  const token = crypto.randomBytes(32).toString("base64url");
  const phone = {
    id: crypto.randomBytes(6).toString("hex"),
    name: String(name ?? "").trim().slice(0, 40) || "Phone",
    tokenHash: hash(token),
    pairedAt: new Date(now).toISOString(),
    lastSeen: new Date(now).toISOString(),
    push: null,
  };
  const data = load();
  data.phones.push(phone);
  save();
  return { token, phone: publicView(phone) };
}

/**
 * The phone a token belongs to, or null. Compared as hashes in constant time.
 * Marks it seen, at most once a minute, so Settings can say when it was last used
 * without a disk write on every request.
 */
export function phoneFor(token, { now = Date.now() } = {}) {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
  const wanted = Buffer.from(hash(token), "hex");
  const data = load();
  const phone = data.phones.find((p) => {
    const have = Buffer.from(p.tokenHash ?? "", "hex");
    return have.length === wanted.length && crypto.timingSafeEqual(have, wanted);
  });
  if (!phone) return null;
  if (!phone.lastSeen || now - Date.parse(phone.lastSeen) > 60_000) {
    phone.lastSeen = new Date(now).toISOString();
    save();
  }
  return publicView(phone);
}

export function listPhones() {
  return load().phones.map(publicView);
}

export function removePhone(id) {
  const data = load();
  const before = data.phones.length;
  data.phones = data.phones.filter((p) => p.id !== id);
  if (data.phones.length === before) return { error: "That phone isn't paired any more." };
  save();
  return { ok: true };
}

export function vapidPublicKey() {
  return load().vapid.publicKey;
}

/** Keep a phone's push subscription, or clear it with null. */
export function setSubscription(id, subscription) {
  if (subscription !== null && !validSubscription(subscription)) return { error: "That isn't a notification subscription Greg can use." };
  const data = load();
  const phone = data.phones.find((p) => p.id === id);
  if (!phone) return { error: "That phone isn't paired any more." };
  phone.push = subscription ? { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } } : null;
  save();
  return { ok: true };
}

/**
 * Send one notification to every phone that asked for them. A subscription the
 * push service says is gone is dropped, so a phone that removed the app stops
 * being tried. Returns how many were delivered.
 */
export async function notifyPhones(payload, { send = sendPush } = {}) {
  const data = load();
  let delivered = 0;
  let changed = false;
  for (const phone of data.phones) {
    if (!phone.push) continue;
    const result = await send(phone.push, payload, data.vapid);
    if (result.ok) delivered += 1;
    else if (result.gone) {
      phone.push = null;
      changed = true;
    } else console.warn(`[phone] notification to "${phone.name}" failed: ${result.error}`);
  }
  if (changed) save();
  return delivered;
}
