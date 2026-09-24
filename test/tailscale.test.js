// Reading what Tailscale says, for the Phone tab. The command itself is
// replaced by a stand-in; only the reading of its answers is under test.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseStatus, servesPort, tailscaleState, tailscaleCommand } from "../lib/tailscale.js";

test("this machine's tailnet name comes from the status, without its trailing dot", () => {
  assert.deepEqual(parseStatus({ BackendState: "Running", Self: { DNSName: "thecomputer.tail1234.ts.net." } }), {
    running: true,
    dnsName: "thecomputer.tail1234.ts.net",
  });
  assert.deepEqual(parseStatus('{"BackendState":"Stopped","Self":{}}'), { running: false, dnsName: "" });
});

test("only a forward to the phone server's own loopback port counts as set up", () => {
  const serving = (proxy) => ({ TCP: { 443: { HTTPS: true } }, Web: { "pc.ts.net:443": { Handlers: { "/": { Proxy: proxy } } } } });
  assert.equal(servesPort(serving("http://127.0.0.1:4757"), 4757), true);
  assert.equal(servesPort(serving("http://localhost:4757/"), 4757), true);
  // Greg's OWN port forwarded would bypass the phone's rules. Not "set up".
  assert.equal(servesPort(serving("http://127.0.0.1:4747"), 4757), false);
  assert.equal(servesPort(serving("http://192.168.1.5:4757"), 4757), false);
  assert.equal(servesPort({}, 4757), false);
  assert.equal(servesPort("", 4757), false);
});

test("not installed, installed but down, and working are three different answers", async () => {
  const missing = await tailscaleState(4757, { runner: async () => { throw Object.assign(new Error("spawn"), { code: "ENOENT" }); } });
  assert.deepEqual(missing, { installed: false, serveCommand: "tailscale serve --bg 4757" });

  const down = await tailscaleState(4757, { runner: async () => { throw Object.assign(new Error("not logged in"), { code: 1 }); } });
  assert.equal(down.installed, true);
  assert.equal(down.running, false);

  const up = await tailscaleState(4757, {
    runner: async (cmd, args) =>
      args[0] === "status"
        ? JSON.stringify({ BackendState: "Running", Self: { DNSName: "pc.tail1.ts.net." } })
        : JSON.stringify({ Web: { "pc.tail1.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4757" } } } } }),
  });
  assert.deepEqual(up, {
    installed: true,
    running: true,
    dnsName: "pc.tail1.ts.net",
    serving: true,
    address: "https://pc.tail1.ts.net/phone/",
    serveCommand: "tailscale serve --bg 4757",
  });
});

test("on Windows the standard install is used when PATH does not have it", () => {
  assert.match(tailscaleCommand({ platform: "win32", exists: () => true }), /Program Files\\Tailscale\\tailscale\.exe$/);
  assert.equal(tailscaleCommand({ platform: "win32", exists: () => false }), "tailscale");
  assert.equal(tailscaleCommand({ platform: "linux", exists: () => true }), "tailscale");
});
