// The door a phone comes in by — a second, much smaller server.
//
// Greg's own server answers only this PC, and its guard (lib/guard.js) refuses
// anything addressed to another name. That stays exactly as it was. A phone
// reaches Greg through Tailscale, whose `tailscale serve` forwards HTTPS from the
// phone to a port on this machine — and it forwards to THIS server's port, never
// to Greg's. So nothing here has to work out whether a request came from the
// phone: everything arriving on this port did.
//
// What makes that safe:
//
//   - It listens on 127.0.0.1 only. Tailscale is the one thing that can reach
//     it from outside, and only for devices on the user's own tailnet.
//   - Every /api/ route but pairing needs a paired phone's token, sent in an
//     Authorization header — which a web page elsewhere cannot make a browser
//     attach, so there is no cross-site request to forge.
//   - It exposes a short, fixed list of routes. There is no route here to the
//     settings, the memory, the channels or the conversation log; they are not
//     refused, they do not exist. What the brain may do from here is limited in
//     lib/brain.js (PHONE_BLOCKED): no screen, no files.
//   - Its static files are the phone page and the two modules it borrows.
//
// The work itself — answering, hearing, speaking — is passed in by server.js,
// so this file is the routing and the rules, testable without a model.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import * as defaultPhones from "./phones.js";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// Files outside public/phone/ the page may load: its recorder and WAV encoder
// are the desktop's, shared rather than copied.
const SHARED = new Set(["/listen-local.js", "/recorder-worklet.js"]);

const PAIR_LIMIT = 10; // attempts a minute, across all callers
const MAX_AUDIO = 12_000_000;
const MAX_SPEAK = 2000;

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(payload));
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const raw = await readBody(req, 100_000);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw Object.assign(new Error("that wasn't JSON"), { status: 400 });
  }
}

const bearer = (req) => /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""))?.[1] ?? null;

/**
 * @param {object} opts
 * @param {string} opts.publicDir   Greg's public/ folder
 * @param {object} opts.handlers    { hello(phone), transcribe(buffer), answer(req, res, { text, phone }), speak(text) }
 * @param {object} [opts.phones]    lib/phones.js, or a stand-in for tests
 */
export function createPhoneServer({ publicDir, handlers, phones = defaultPhones, log = console }) {
  const phoneDir = path.join(publicDir, "phone");
  let pairAttempts = [];

  function serveFile(res, filePath) {
    fs.readFile(filePath, (err, data) => {
      if (err) return sendJson(res, 404, { error: "not found" });
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      res.end(data);
    });
  }

  function serveStatic(req, res, pathname) {
    if (pathname === "/" || pathname === "/phone") {
      res.writeHead(302, { Location: "/phone/" });
      return res.end();
    }
    if (SHARED.has(pathname)) return serveFile(res, path.join(publicDir, pathname.slice(1)));
    if (!pathname.startsWith("/phone/")) return sendJson(res, 404, { error: "not found" });

    let relative;
    try {
      relative = decodeURIComponent(pathname.slice("/phone/".length)) || "index.html";
    } catch {
      return sendJson(res, 400, { error: "bad path" });
    }
    const filePath = path.join(phoneDir, relative);
    // The separator matters: "phone" must not match a sibling "phone-anything".
    if (filePath !== phoneDir && !filePath.startsWith(phoneDir + path.sep)) return sendJson(res, 403, { error: "outside the phone page" });
    return serveFile(res, filePath);
  }

  const server = http.createServer(async (req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url, "http://phone.invalid").pathname;
    } catch {
      return sendJson(res, 400, { error: "bad request" });
    }

    try {
      if (!pathname.startsWith("/api/")) {
        if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method not allowed" });
        return serveStatic(req, res, pathname);
      }

      // --- Pairing: the one route without a token ---
      if (pathname === "/api/pair" && req.method === "POST") {
        const now = Date.now();
        pairAttempts = pairAttempts.filter((at) => now - at < 60_000);
        if (pairAttempts.length >= PAIR_LIMIT) return sendJson(res, 429, { error: "Too many tries. Wait a minute." });
        pairAttempts.push(now);
        const { code, name } = await readJson(req);
        const result = phones.pair(code, name);
        if (result.error) return sendJson(res, 403, { error: result.error });
        log.log?.(`[phone] paired "${result.phone.name}"`);
        return sendJson(res, 200, result);
      }

      // --- Everything else: a paired phone only ---
      const phone = phones.phoneFor(bearer(req));
      if (!phone) return sendJson(res, 401, { error: "This phone isn't paired with Greg, or was removed. Pair it again." });

      if (pathname === "/api/hello" && req.method === "GET") {
        return sendJson(res, 200, await handlers.hello(phone));
      }

      if (pathname === "/api/transcribe" && req.method === "POST") {
        const audio = await readBody(req, MAX_AUDIO);
        if (!audio.length) return sendJson(res, 400, { error: "no audio" });
        return sendJson(res, 200, await handlers.transcribe(audio));
      }

      if (pathname === "/api/chat/stream" && req.method === "POST") {
        const { text } = await readJson(req);
        if (!text || !String(text).trim()) return sendJson(res, 400, { error: "no text supplied" });
        return handlers.answer(req, res, { text: String(text).trim().slice(0, 2000), phone });
      }

      if (pathname === "/api/tts" && req.method === "POST") {
        const { text } = await readJson(req);
        if (!text || !String(text).trim()) return sendJson(res, 400, { error: "no text supplied" });
        const { audio, contentType } = await handlers.speak(String(text).slice(0, MAX_SPEAK));
        res.writeHead(200, { "Content-Type": contentType, "Content-Length": audio.length, "Cache-Control": "no-store" });
        return res.end(audio);
      }

      if (pathname === "/api/push" && req.method === "POST") {
        const { subscription } = await readJson(req);
        const result = phones.setSubscription(phone.id, subscription ?? null);
        if (result.error) return sendJson(res, 400, result);
        log.log?.(`[phone] notifications ${subscription ? "on" : "off"} for "${phone.name}"`);
        return sendJson(res, 200, result);
      }

      if (pathname === "/api/unpair" && req.method === "POST") {
        const result = phones.removePhone(phone.id);
        log.log?.(`[phone] "${phone.name}" unpaired itself`);
        return sendJson(res, result.error ? 400 : 200, result);
      }

      return sendJson(res, 404, { error: "not something the phone can do" });
    } catch (err) {
      if (err.status) return sendJson(res, err.status, { error: err.message });
      log.error?.("[phone]", err);
      if (!res.headersSent) return sendJson(res, 500, { error: err.message });
      res.end();
    }
  });

  return server;
}
