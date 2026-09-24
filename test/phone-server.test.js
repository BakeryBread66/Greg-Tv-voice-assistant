// The phone's door: a real HTTP server on a spare port, stub handlers, and a
// scratch phones.json. Everything here is about who gets in and what exists.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createPhoneServer } from "../lib/phone-server.js";
import * as phones from "../lib/phones.js";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "greg-phone-server-"));

// A public/ folder of its own, so the test controls what exists.
const PUBLIC = path.join(DIR, "public");
fs.mkdirSync(path.join(PUBLIC, "phone"), { recursive: true });
fs.writeFileSync(path.join(PUBLIC, "phone", "index.html"), "<!doctype html><title>Greg</title>");
fs.writeFileSync(path.join(PUBLIC, "listen-local.js"), "export {};");
fs.writeFileSync(path.join(PUBLIC, "index.html"), "the desktop page");
fs.writeFileSync(path.join(PUBLIC, "settings.js"), "desktop code");
fs.mkdirSync(path.join(PUBLIC, "phone-other"));
fs.writeFileSync(path.join(PUBLIC, "phone-other", "x.html"), "a sibling folder");

const calls = [];
const handlers = {
  hello: async (phone) => ({ name: "Greg", phone: phone.name }),
  transcribe: async (audio) => {
    calls.push(["transcribe", audio.length]);
    return { text: "what time is it" };
  },
  answer: async (req, res, { text, phone }) => {
    calls.push(["answer", text, phone.name]);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ type: "done", reply: "It's noon." })}\n\n`);
  },
  speak: async (text) => ({ audio: Buffer.from(`audio:${text}`), contentType: "audio/wav" }),
};

let server;
let base;

before(async () => {
  phones.usePhonesFile(path.join(DIR, "phones.json"));
  server = createPhoneServer({ publicDir: PUBLIC, handlers, log: {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(DIR, { recursive: true, force: true });
});

const post = (url, body, token) =>
  fetch(base + url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });

async function pairedToken(name = "Test phone") {
  const { code } = phones.startPairing();
  const res = await post("/api/pair", { code, name });
  assert.equal(res.status, 200);
  return (await res.json()).token;
}

test("the phone page and its one shared module are served, and nothing else of Greg's", async () => {
  assert.equal((await fetch(`${base}/phone/`)).status, 200);
  assert.match(await (await fetch(`${base}/phone/`)).text(), /<title>Greg/);
  assert.equal((await fetch(`${base}/listen-local.js`)).status, 200);
  const home = await fetch(`${base}/`, { redirect: "manual" });
  assert.equal(home.status, 302);
  assert.equal(home.headers.get("location"), "/phone/");
  for (const url of ["/index.html", "/settings.js", "/phone-other/x.html", "/phone/../settings.js", "/phone/%2e%2e/settings.js", "/phone/..%5csettings.js"]) {
    const res = await fetch(base + url);
    assert.ok([403, 404].includes(res.status), `${url} answered ${res.status}`);
    assert.ok(!(await res.text()).includes("desktop"), url);
  }
});

test("without a token, only pairing answers", async () => {
  for (const [method, url] of [["GET", "/api/hello"], ["POST", "/api/chat/stream"], ["POST", "/api/tts"], ["POST", "/api/transcribe"], ["POST", "/api/push"], ["POST", "/api/unpair"]]) {
    const res = await fetch(base + url, { method, body: method === "POST" ? "{}" : undefined });
    assert.equal(res.status, 401, `${method} ${url}`);
  }
  const forged = await fetch(`${base}/api/hello`, { headers: { Authorization: "Bearer not-a-real-token-at-all-000000" } });
  assert.equal(forged.status, 401);
  assert.equal(calls.length, 0, "no handler ran");
});

test("a wrong code does not pair, and the right one does", async () => {
  const { code } = phones.startPairing();
  const wrong = code === "000000" ? "111111" : "000000";
  assert.equal((await post("/api/pair", { code: wrong, name: "x" })).status, 403);
  const res = await post("/api/pair", { code, name: "Sam's phone" });
  assert.equal(res.status, 200);
  const { token, phone } = await res.json();
  assert.equal(phone.name, "Sam's phone");
  const hello = await (await fetch(`${base}/api/hello`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.deepEqual(hello, { name: "Greg", phone: "Sam's phone" });
});

test("a paired phone can talk: hear, answer, speak", async () => {
  const token = await pairedToken("Talker");
  const heard = await (await post("/api/transcribe", Buffer.from("RIFF....WAVE"), token)).json();
  assert.equal(heard.text, "what time is it");

  const answer = await post("/api/chat/stream", { text: "  what time is it  " }, token);
  assert.equal(answer.headers.get("content-type"), "text/event-stream");
  assert.match(await answer.text(), /It's noon/);
  assert.deepEqual(calls.at(-1), ["answer", "what time is it", "Talker"]);

  const audio = await post("/api/tts", { text: "It's noon." }, token);
  assert.equal(audio.headers.get("content-type"), "audio/wav");
  assert.equal(Buffer.from(await audio.arrayBuffer()).toString(), "audio:It's noon.");
});

test("the rest of Greg does not exist here, even with a token", async () => {
  const token = await pairedToken();
  for (const [method, url] of [
    ["GET", "/api/settings"], ["POST", "/api/settings"], ["GET", "/api/memory"], ["POST", "/api/memory"],
    ["GET", "/api/conversations"], ["DELETE", "/api/conversations"], ["POST", "/api/brain"], ["POST", "/api/chat"],
    ["GET", "/api/cursor"], ["POST", "/api/power"], ["POST", "/api/quit"], ["POST", "/api/listen"], ["POST", "/api/hotkey"],
  ]) {
    const res = await fetch(base + url, { method, headers: { Authorization: `Bearer ${token}` }, body: method === "GET" ? undefined : "{}" });
    assert.equal(res.status, 404, `${method} ${url}`);
  }
});

test("empty and oversized requests are refused", async () => {
  const token = await pairedToken();
  assert.equal((await post("/api/chat/stream", { text: "   " }, token)).status, 400);
  assert.equal((await post("/api/tts", {}, token)).status, 400);
  assert.equal((await post("/api/transcribe", Buffer.alloc(0), token)).status, 400);
  assert.equal((await post("/api/chat/stream", "not json", token)).status, 400);
  assert.equal((await post("/api/transcribe", Buffer.alloc(12_000_001), token)).status, 413);
});

test("a phone can turn notifications on with a real subscription, and remove itself", async () => {
  const token = await pairedToken("Leaver");
  assert.equal((await post("/api/push", { subscription: { endpoint: "https://127.0.0.1:4747/api/quit", keys: {} } }, token)).status, 400);
  assert.equal((await post("/api/push", { subscription: null }, token)).status, 200);
  assert.equal((await post("/api/unpair", {}, token)).status, 200);
  assert.equal((await fetch(`${base}/api/hello`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
});

test("pairing is rate-limited, so the code cannot be raced", async () => {
  // Earlier tests used some of the minute's allowance; exhaust the rest.
  let limited = false;
  for (let i = 0; i < 12; i++) {
    const res = await post("/api/pair", { code: "000000", name: "x" });
    if (res.status === 429) {
      limited = true;
      break;
    }
  }
  assert.ok(limited, "never limited");
});

test("the server listens where it is told; server.js binds it to 127.0.0.1", () => {
  assert.equal(server.address().address, "127.0.0.1");
  assert.ok(fs.readFileSync(path.join(ROOT, "lib", "phone-server.js"), "utf8").includes("127.0.0.1"));
});
