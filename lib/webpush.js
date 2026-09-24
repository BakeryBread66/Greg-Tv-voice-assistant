// Web Push: a reminder arriving on the phone as a notification, even with Greg's
// page closed and the phone locked.
//
// The phone's browser hands over a subscription — an endpoint on its push
// service (Google's for Android Chrome, Apple's for Safari) and two keys. To
// deliver a message, Greg encrypts it for that browser alone (RFC 8291, the
// aes128gcm content coding of RFC 8188) and signs the request so the push
// service knows which server sent it (VAPID, RFC 8292). The push service
// carries the message but cannot read it.
//
// Written here on node:crypto rather than taken from a package: it is about a
// hundred lines of well-specified arithmetic, and test/webpush.test.js checks it
// byte for byte against the worked example in RFC 8291's own appendix. A
// dependency would be a stranger's code holding the key that signs as Greg.

import crypto from "node:crypto";

export const b64u = (buffer) => Buffer.from(buffer).toString("base64url");
export const fromB64u = (text) => Buffer.from(String(text ?? "").replace(/\s+/g, ""), "base64url");

const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

const RECORD_SIZE = 4096;

/**
 * Encrypt one message for one browser (RFC 8291 §3, RFC 8188 §2).
 *
 * `salt` and `senderPrivate` are fresh random values for every message; they
 * are parameters only so the RFC's example can be reproduced exactly.
 *
 * @param {Buffer|string} plaintext
 * @param {{ p256dh: string, auth: string }} keys  from the browser's subscription
 * @returns {Buffer} the request body: header, then one record
 */
export function encrypt(plaintext, keys, { salt = crypto.randomBytes(16), senderPrivate = null } = {}) {
  const uaPublic = fromB64u(keys.p256dh);
  const authSecret = fromB64u(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error("the subscription's p256dh key is not a P-256 public key");
  if (authSecret.length !== 16) throw new Error("the subscription's auth secret is not 16 bytes");

  const sender = crypto.createECDH("prime256v1");
  if (senderPrivate) sender.setPrivateKey(senderPrivate);
  else sender.generateKeys();
  const asPublic = sender.getPublicKey();
  const ecdhSecret = sender.computeSecret(uaPublic);

  // §3.3: combine the ECDH secret with the auth secret, bound to both keys.
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));

  // RFC 8188 §2.2 and §2.3: the content key and the nonce.
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01", "latin1")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01", "latin1")).subarray(0, 12);

  // One record, so the padding delimiter is 0x02 (the last record's).
  const record = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]);
  if (record.length + 16 > RECORD_SIZE) throw new Error("that message is too long for one push");
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const sealed = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, sealed]);
}

/** A new VAPID key pair: the identity Greg signs his pushes with. Kept in phones.json. */
export function makeVapidKeys() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function signingKey({ publicKey, privateKey }) {
  const pub = fromB64u(publicKey);
  return crypto.createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: b64u(fromB64u(privateKey)), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: "jwk",
  });
}

/**
 * The Authorization header for one push service (RFC 8292 §2 and §3).
 *
 * `aud` is the push service's origin, so a token cannot be replayed at another
 * one. `sub` says who to contact about this sender: the project's page, rather
 * than anybody's email address.
 */
export function vapidAuthorization(endpoint, vapid, { now = Date.now(), subject = "https://github.com/BakeryBread66/Greg-Tv-voice-assistant" } = {}) {
  const header = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(
    JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })
  );
  const signature = crypto.sign("sha256", Buffer.from(`${header}.${claims}`), {
    key: signingKey(vapid),
    // JWS wants r||s, not the DER encoding node produces by default.
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${vapid.publicKey}`;
}

/**
 * Deliver one message to one subscription.
 *
 * Returns { ok } or { gone } or { error }. "gone" — a 404 or 410 — means the
 * browser threw the subscription away (the app was removed, notifications were
 * turned off) and the caller should forget it rather than keep trying.
 */
export async function sendPush(subscription, payload, vapid, { fetchImpl = fetch, ttlSeconds = 12 * 3600 } = {}) {
  try {
    const body = encrypt(JSON.stringify(payload), subscription.keys ?? {});
    const res = await fetchImpl(subscription.endpoint, {
      method: "POST",
      headers: {
        Authorization: vapidAuthorization(subscription.endpoint, vapid),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(ttlSeconds),
        Urgency: "high",
      },
      body,
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404 || res.status === 410) return { gone: true };
    if (res.status >= 200 && res.status < 300) return { ok: true };
    return { error: `the push service answered ${res.status}` };
  } catch (err) {
    return { error: err.message };
  }
}

// The push services browsers actually use. The endpoint is where Greg will
// POST, so it is held to these: a subscription is supplied by a phone, and a
// phone token in the wrong hands must not be able to aim Greg's requests at an
// address of its choosing — this PC's own services included.
const PUSH_HOSTS = ["fcm.googleapis.com", "android.googleapis.com", "updates.push.services.mozilla.com"];
const PUSH_SUFFIXES = [".push.apple.com", ".notify.windows.com"];

/** Is this endpoint on a real push service? */
export function isPushService(endpoint) {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.port) return false;
    const host = url.hostname.toLowerCase();
    return PUSH_HOSTS.includes(host) || PUSH_SUFFIXES.some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}

/**
 * Is this a subscription worth keeping? Checked before storing anything a phone
 * sends: the endpoint must be a real push service, and the keys the right shapes.
 */
export function validSubscription(sub) {
  try {
    if (!sub || typeof sub.endpoint !== "string" || sub.endpoint.length > 2000) return false;
    if (!isPushService(sub.endpoint)) return false;
    const p256dh = fromB64u(sub.keys?.p256dh);
    const auth = fromB64u(sub.keys?.auth);
    return p256dh.length === 65 && p256dh[0] === 0x04 && auth.length === 16;
  } catch {
    return false;
  }
}
