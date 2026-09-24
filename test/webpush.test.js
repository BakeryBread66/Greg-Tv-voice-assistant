// Web Push, checked against the standard rather than against itself.
//
// The first test reproduces RFC 8291 section 5 and Appendix A exactly: the same
// keys, the same salt, the same plaintext, and the same 144-byte message out.
// If any step of the key derivation or the record layout is wrong, the bytes
// differ. Nothing here touches the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { encrypt, fromB64u, b64u, makeVapidKeys, vapidAuthorization, sendPush, validSubscription, isPushService } from "../lib/webpush.js";

// RFC 8291 section 5 and Appendix A.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

test("encryption reproduces RFC 8291's worked example byte for byte", () => {
  const body = encrypt(RFC.plaintext, { p256dh: RFC.uaPublic, auth: RFC.auth }, {
    salt: fromB64u(RFC.salt),
    senderPrivate: fromB64u(RFC.asPrivate),
  });
  assert.equal(b64u(body), RFC.body);
});

/** The receiving browser's half, per RFC 8188, to prove a random message round-trips. */
function decrypt(body, uaPrivate, auth) {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const sealed = body.subarray(21 + idlen);
  const ua = crypto.createECDH("prime256v1");
  ua.setPrivateKey(uaPrivate);
  const hmac = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
  const secret = ua.computeSecret(asPublic);
  const prkKey = hmac(auth, secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01", "latin1")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01", "latin1")).subarray(0, 12);
  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const record = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  assert.equal(record[record.length - 1], 2, "last-record delimiter");
  return record.subarray(0, record.length - 1).toString();
}

test("a fresh message, with its own random salt and key, decrypts on the browser's side", () => {
  const ua = crypto.createECDH("prime256v1");
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const message = JSON.stringify({ title: "Greg", body: "Take your medicine" });
  const a = encrypt(message, { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) });
  const b = encrypt(message, { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) });
  assert.notEqual(b64u(a), b64u(b), "never the same bytes twice");
  assert.equal(decrypt(a, ua.getPrivateKey(), auth), message);
});

test("keys of the wrong shape are refused before anything is encrypted", () => {
  assert.throws(() => encrypt("x", { p256dh: "AAAA", auth: RFC.auth }), /P-256/);
  assert.throws(() => encrypt("x", { p256dh: RFC.uaPublic, auth: "AAAA" }), /16 bytes/);
});

test("the VAPID token is a valid ES256 JWT for that push service, verifiable with the public key", () => {
  const vapid = makeVapidKeys();
  const endpoint = "https://fcm.googleapis.com/fcm/send/abc123";
  const header = vapidAuthorization(endpoint, vapid, { now: Date.UTC(2026, 8, 23) });
  const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.equal(key, vapid.publicKey);

  const [h, c, s] = token.split(".");
  assert.deepEqual(JSON.parse(fromB64u(h)), { typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(fromB64u(c));
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.exp, Date.UTC(2026, 8, 23) / 1000 + 12 * 3600);
  assert.match(claims.sub, /^https:\/\//);

  const pub = fromB64u(vapid.publicKey);
  const verifier = crypto.createPublicKey({
    key: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: "jwk",
  });
  assert.ok(crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key: verifier, dsaEncoding: "ieee-p1363" }, fromB64u(s)));
});

const subscription = () => {
  const ua = crypto.createECDH("prime256v1");
  ua.generateKeys();
  return { endpoint: "https://fcm.googleapis.com/fcm/send/xyz", keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(crypto.randomBytes(16)) } };
};

test("a push is sent encrypted, signed and with a lifetime, and the answer is reported", async () => {
  const vapid = makeVapidKeys();
  const sub = subscription();
  let seen;
  const ok = await sendPush(sub, { body: "hi" }, vapid, {
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return { status: 201 };
    },
  });
  assert.deepEqual(ok, { ok: true });
  assert.equal(seen.url, sub.endpoint);
  assert.equal(seen.init.headers["Content-Encoding"], "aes128gcm");
  assert.match(seen.init.headers.Authorization, /^vapid t=/);
  assert.ok(Number(seen.init.headers.TTL) > 0);
  assert.ok(!seen.init.body.toString("latin1").includes("hi"), "the payload is not in the clear");

  assert.deepEqual(await sendPush(sub, {}, vapid, { fetchImpl: async () => ({ status: 410 }) }), { gone: true });
  assert.deepEqual(await sendPush(sub, {}, vapid, { fetchImpl: async () => ({ status: 404 }) }), { gone: true });
  assert.match((await sendPush(sub, {}, vapid, { fetchImpl: async () => ({ status: 500 }) })).error, /500/);
  assert.match((await sendPush(sub, {}, vapid, { fetchImpl: async () => { throw new Error("offline"); } })).error, /offline/);
});

test("only a real push service can be a subscription's endpoint", () => {
  for (const url of [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://web.push.apple.com/QGuQyavXutnMH",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
  ]) {
    assert.equal(isPushService(url), true, url);
  }
  for (const url of [
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://127.0.0.1:4747/api/chat",
    "https://localhost/x",
    "https://fcm.googleapis.com:8443/x",
    "https://evil.example/web.push.apple.com",
    "https://push.apple.com.evil.example/x",
    "not a url",
  ]) {
    assert.equal(isPushService(url), false, url);
  }
  assert.equal(validSubscription(subscription()), true);
  assert.equal(validSubscription({ ...subscription(), endpoint: "https://127.0.0.1/x" }), false);
  assert.equal(validSubscription({ endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "AAAA", auth: "BBBB" } }), false);
  assert.equal(validSubscription(null), false);
});
