// Who is allowed to talk to Greg's server.
//
// Binding to 127.0.0.1 keeps the network out. It does NOT keep out a web page:
// a browser sends requests to localhost on behalf of whatever site you are
// looking at. Two consequences, and the first is serious.
//
// DNS rebinding. A site re-points its own domain at 127.0.0.1, the browser then
// believes that site and Greg share an origin, and same-origin policy stops
// protecting anything — the page can READ the replies. Measured before the fix:
// a request carrying "Host: evil.example.com" was answered with 200 and
// /api/settings handed back the user's city and coordinates. The same trick
// would drive /api/chat into read_file, look_at_screen and recall_conversation.
//
// CSRF. A cross-origin POST with a "simple" content type needs no preflight, so
// it is delivered even though the reply cannot be read. Blind, but enough to
// make Greg act. Measured before the fix: a POST with text/plain and
// Origin: https://evil.example.com was answered with 200.
//
// Neither is testable by using Greg, and both fail toward being too permissive,
// which is why they are pure functions with a battery rather than a code review.

import { test } from "node:test";
import assert from "node:assert/strict";

import { hostAllowed, originAllowed, refuseReason } from "../lib/guard.js";
import { TOOLS } from "../lib/tools/index.js";

const PORT = 4747;

test("a request addressed to this machine is allowed", () => {
  for (const host of ["localhost:4747", "127.0.0.1:4747", "LOCALHOST:4747", "[::1]:4747", "localhost"]) {
    assert.equal(hostAllowed(host, PORT), true, host);
  }
});

test("a request addressed to somebody else is refused", () => {
  // This is the rebinding signature: the browser still sends the attacker's
  // hostname, which is the one thing the trick cannot hide.
  for (const host of ["evil.example.com", "evil.example.com:4747", "greg.local:4747", "192.168.1.50:4747", "0.0.0.0:4747"]) {
    assert.equal(hostAllowed(host, PORT), false, host);
  }
});

test("a missing Host is refused", () => {
  // HTTP/1.1 requires one. Its absence is a broken client or a probe, and the
  // only cost of refusing is a request nobody legitimately makes.
  assert.equal(hostAllowed(undefined, PORT), false);
  assert.equal(hostAllowed("", PORT), false);
});

test("a local name on the WRONG port is refused", () => {
  // Another service on this machine is not this service.
  assert.equal(hostAllowed("localhost:9999", PORT), false);
  assert.equal(hostAllowed("127.0.0.1:80", PORT), false);
});

test("no Origin at all is allowed, because that is curl", () => {
  // Browsers attach Origin to every cross-origin request, so absence means a
  // non-browser client. Refusing those would break driving Greg from a
  // terminal, which is a documented way to use him.
  assert.equal(originAllowed(undefined, PORT), true);
  assert.equal(originAllowed("", PORT), true);
});

test('the literal string "null" is NOT absence', () => {
  // Browsers send Origin: null for sandboxed iframes and file:// pages, which
  // is exactly the shape an attacker would like treated as "no origin".
  assert.equal(originAllowed("null", PORT), false);
});

test("Greg's own page is allowed, and a foreign page is not", () => {
  for (const ok of ["http://localhost:4747", "http://127.0.0.1:4747"]) {
    assert.equal(originAllowed(ok, PORT), true, ok);
  }
  for (const bad of [
    "https://evil.example.com",
    "http://evil.example.com:4747",
    // A hostname that merely CONTAINS a local name must not pass.
    "http://localhost.evil.example.com",
    "http://127.0.0.1.evil.example.com",
    "not a url at all",
    "file:///C:/x.html",
  ]) {
    assert.equal(originAllowed(bad, PORT), false, bad);
  }
});

test("reads are gated on Host, writes on Host AND Origin", () => {
  const local = { host: "localhost:4747", origin: "http://localhost:4747" };

  assert.equal(refuseReason({ ...local, method: "GET" }, PORT), null);
  assert.equal(refuseReason({ ...local, method: "POST" }, PORT), null);

  // The rebinding case, on a plain read — this is the one that leaked coordinates.
  const rebound = refuseReason({ host: "evil.example.com", origin: undefined, method: "GET" }, PORT);
  assert.match(rebound, /only answers to localhost/);
  assert.match(rebound, /rebinding/, "the message should name what it looks like");

  // The CSRF case: right host, foreign page, state-changing method.
  const csrf = refuseReason({ host: "localhost:4747", origin: "https://evil.example.com", method: "POST" }, PORT);
  assert.match(csrf, /not this machine/);

  // ...but a foreign Origin on a GET is not refused on that ground alone: the
  // browser will not show it the reply, and refusing would be theatre.
  assert.equal(refuseReason({ host: "localhost:4747", origin: "https://evil.example.com", method: "GET" }, PORT), null);
});

test("every state-changing method is covered, not just POST", () => {
  // DELETE /api/conversations wipes the verbatim log. It must not be reachable
  // from a page just because nobody thought about verbs beyond POST.
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "delete"]) {
    const said = refuseReason({ host: "localhost:4747", origin: "https://evil.example.com", method }, PORT);
    assert.ok(said, `${method} should be refused from a foreign origin`);
  }
});

// ---------------------------------------------------------------------------
// What a compromised turn could actually reach
//
// Greg reads web pages, search results and files that strangers wrote, so a
// turn can carry an instruction somebody else planted. Measured against the
// live server with three payload shapes over six runs - a plain override, one
// impersonating the system, and one asking for an exfiltrating read_page - and
// obeyed 0/6. But that is a property of a model on one day, not a guarantee.
//
// The guarantees are structural, and these lock them in: even if an injected
// instruction were obeyed, there is no tool that runs a command, and no write
// whose PATH the model chooses. That is the difference between "he said
// something wrong" and "your machine is compromised", and it is worth failing
// loudly if anyone ever erodes it.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIB = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "lib");

test("no tool can execute a command", () => {
  // A shell is the shortest path from "the model was talked into it" to
  // "somebody else's code ran". There is deliberately no such tool.
  const dir = path.join(LIB, "tools");
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const source = fs.readFileSync(path.join(dir, name), "utf8");
    assert.doesNotMatch(
      source,
      /require\(["']child_process|from ["']node:child_process|from ["']child_process/,
      `lib/tools/${name} imports child_process — a tool that can run commands needs a much harder look than this test`
    );
  }
});

test("the file module exposes no way to write, move or delete", () => {
  // Greg mishears words for a living, and "delete the invoice" and "delete the
  // invoices" are one phoneme apart. Reading the wrong file wastes a turn;
  // deleting the wrong one does not. The safety here is that the capability
  // does not exist, rather than that it is guarded.
  const source = fs.readFileSync(path.join(LIB, "files.js"), "utf8");
  const exported = [...source.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map((m) => m[1]);
  assert.ok(exported.length > 5, "expected to find the exports");
  for (const name of exported) {
    assert.doesNotMatch(
      name,
      /^(write|save|delete|remove|move|rename|create|append|mkdir)/i,
      `lib/files.js exports "${name}" — it is read-only by design`
    );
  }
  // And nothing inside it opens a file for writing, whatever the export is called.
  assert.doesNotMatch(source, /writeFile|appendFile|createWriteStream|unlink|rmSync|renameSync|mkdirSync/,
    "lib/files.js should contain no write operation at all");
});

test("no tool takes a filesystem path from the model", () => {
  // Every write in Greg goes to a fixed path - memory.json, reminders.json, the
  // conversation log, the caches. The moment a tool accepts a path, that stops
  // being true, and an injected instruction gains somewhere to put things.
  for (const tool of TOOLS) {
    for (const [param, spec] of Object.entries(tool.parameters?.properties ?? {})) {
      assert.doesNotMatch(
        param,
        /^(path|file|filename|filepath|dir|directory|folder|dest|destination|output)$/i,
        `${tool.name} takes a "${param}" parameter — check it cannot choose where something is written`
      );
    }
  }
});
