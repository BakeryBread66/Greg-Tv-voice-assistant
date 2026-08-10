// Channels somebody added themselves.
//
// The file being on the user's own disk makes it trusted the way config.json
// and a persona are trusted — and no more than that. Once packs get shared, the
// person who wrote the file and the person running it stop being the same, and
// everything here is the difference between those two facts.
//
// The other half of what is tested is the failure wording. A folder somebody
// has just created and which silently does nothing is the most frustrating way
// for a feature like this to fail, so "it did not load" always has to come with
// "and here is why".

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  checkUrl, fillUrl, pick, parseAddon, loadAddons, addonLoader, FIRST_ADDON_NUMBER,
} from "../lib/addons.js";
import { channelDescription } from "../lib/tools/channels.js";

test("a channel may fetch a feed, but not poke the machine it runs on", () => {
  assert.equal(checkUrl("https://api.example.com/thing.json"), null);
  assert.equal(checkUrl("http://192.168.1.50:8123/api/states"), null, "a home server is a fine source");
  assert.equal(checkUrl("http://localhost:8080/feed"), null, "and so is something else on this machine");

  // Greg's own services. A channel fetching from these is not reading a feed,
  // it is prodding the thing it is running inside — and a shared pack has no
  // business doing that.
  for (const own of ["http://127.0.0.1:4747/api/config", "http://localhost:4748/transcribe", "http://127.0.0.1:11434/api/tags"]) {
    assert.match(checkUrl(own), /Greg's own services/, `${own} must be refused`);
  }

  assert.match(checkUrl("file:///C:/Users/me/secrets.json"), /not a protocol/);
  assert.match(checkUrl("ftp://example.com/x"), /not a protocol/);
  assert.match(checkUrl("not a url at all"), /not a valid address/);
});

test("a feed url is filled in from wherever the user is", () => {
  const url = fillUrl("https://x.test/?lat={lat}&lon={lon}&q={city}", {
    latitude: 35.9132, longitude: -79.0558, city: "Chapel Hill",
  });
  assert.match(url, /lat=35\.9132/);
  assert.match(url, /lon=-79\.0558/);
  assert.match(url, /q=Chapel%20Hill/, "the city is escaped, not pasted");

  // Missing values leave empty parameters rather than the literal "{lat}",
  // which would be sent to somebody's server as a nonsense query.
  assert.equal(fillUrl("https://x.test/?lat={lat}", {}), "https://x.test/?lat=");
});

test("a value is picked out of a feed by path, and absence stays absent", () => {
  const data = { current: { temp: 12, nested: { deep: "yes" } }, list: [{ name: "first" }] };
  assert.deepEqual(pick(data, "current"), { temp: 12, nested: { deep: "yes" } });
  assert.equal(pick(data, "current.nested.deep"), "yes");
  assert.equal(pick(data, "list.0.name"), "first");
  assert.equal(pick(data, "current.missing"), null);
  assert.equal(pick(data, "nothing.at.all"), null, "walking off the end is null, not a throw");
  assert.deepEqual(pick(data, null), data, "no path means the whole payload");
});

test("everything in a channel.json is capped, floored or refused", () => {
  const { channel } = parseAddon("tides", {
    name: "A".repeat(200),
    description: "B".repeat(200),
    aliases: [...Array(40)].map((_, i) => `alias ${i}`),
    fetch: { url: "https://x.test/f.json", everySeconds: 0.5 },
  });

  assert.ok(channel.name.length <= 24, "a name cannot take over the dial");
  assert.ok(channel.description.length <= 48);
  // The description is sent to the model on every turn; the alias list is
  // matched against every phrase. Neither is somewhere unbounded text belongs.
  assert.ok(channel.aliases.length <= 10);

  // A poll floor, for the same reason config.alerts.pollMs has one: the cost of
  // a typo lands on somebody else's free service, not on the person who made it.
  assert.equal(channel.fetch.pollMs, 10_000, "half a second is clamped to ten");

  // The folder name and the channel name always work, so a file that lists no
  // aliases is still reachable by voice.
  const { channel: bare } = parseAddon("moon-phase", { name: "Moonlight", fetch: { url: "https://x.test/f" } });
  assert.ok(bare.aliases.includes("moonlight"));
  assert.ok(bare.aliases.includes("moon phase"), "the folder name counts as an alias");
});

test("a channel that cannot work is refused, and says why", () => {
  const bad = parseAddon("evil", { name: "Evil", fetch: { url: "http://127.0.0.1:4747/api/conversations" } });
  assert.equal(bad.channel, null);
  assert.match(bad.problems[0], /Greg's own services/);

  // No feed is not fatal — a channel might draw something computed — but it is
  // worth saying, because it is usually a mistake.
  const noFeed = parseAddon("quiet", { name: "Quiet" });
  assert.ok(noFeed.channel);
  assert.equal(noFeed.channel.feed, null);
  assert.match(noFeed.problems[0], /no fetch.url/);
});

test("the folder is the registration, and a broken one is named out loud", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "greg-addons-"));
  try {
    fs.mkdirSync(path.join(dir, "aaa-good"));
    fs.writeFileSync(path.join(dir, "aaa-good", "channel.json"), JSON.stringify({ name: "Good", fetch: { url: "https://x.test/f" } }));
    fs.mkdirSync(path.join(dir, "bbb-broken"));
    fs.writeFileSync(path.join(dir, "bbb-broken", "channel.json"), "{ not json,");
    fs.mkdirSync(path.join(dir, "ccc-empty")); // no channel.json at all

    const found = loadAddons({ folder: dir });
    assert.equal(found.channels.length, 1, "the good one still loads");
    assert.equal(found.channels[0].name, "Good");
    assert.equal(found.channels[0].number, FIRST_ADDON_NUMBER, "add-ons are numbered past the built-ins");

    // Both failures are reported. A folder that silently does nothing is the
    // worst possible outcome for somebody who has just written one.
    assert.equal(found.problems.length, 2);
    assert.ok(found.problems.some((p) => /not valid JSON/.test(p)));
    assert.ok(found.problems.some((p) => /no channel\.json/.test(p)));

    // Sorted by folder name, so two machines with the same folders agree about
    // which channel is which number.
    fs.mkdirSync(path.join(dir, "aaa-earlier"));
    fs.writeFileSync(path.join(dir, "aaa-earlier", "channel.json"), JSON.stringify({ name: "Earlier", fetch: { url: "https://x.test/f" } }));
    assert.equal(loadAddons({ folder: dir }).channels[0].name, "Earlier");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // No folder at all is the normal state, not an error.
  const none = loadAddons({ folder: path.join(os.tmpdir(), "greg-addons-does-not-exist") });
  assert.deepEqual(none.channels, []);
  assert.deepEqual(none.problems, []);
});

test("a feed that misbehaves fails as a channel, not as a crash", async () => {
  const channel = parseAddon("x", { name: "X", fetch: { url: "https://x.test/f.json", pick: "current" } }).channel;
  const load = (impl) => addonLoader(channel, { fetchImpl: impl, locate: async () => ({}) });

  const ok = await load(async () => ({ ok: true, text: async () => JSON.stringify({ current: { v: 1 } }) }))({});
  assert.deepEqual(ok.data, { v: 1 });

  await assert.rejects(
    load(async () => ({ ok: false, status: 503, text: async () => "" }))({}),
    /returned 503/,
  );
  await assert.rejects(
    load(async () => ({ ok: true, text: async () => "<html>not json</html>" }))({}),
    /did not send JSON/,
  );
  // A feed handing back a megabyte would be held in memory and pushed down the
  // event stream on every poll.
  await assert.rejects(
    load(async () => ({ ok: true, text: async () => "x".repeat(600_000) }))({}),
    /more data than a channel should/,
  );
});

test("add-ons cannot quietly grow the schema sent on every turn", () => {
  const builtIn = [
    { number: 1, name: "Test Card", description: "colour bars" },
    { number: 2, name: "Weather", description: "forecast" },
  ];
  const many = [...Array(40)].map((_, i) => ({
    number: FIRST_ADDON_NUMBER + i, name: `Channel Number ${i}`, description: "x", addon: true,
  }));

  const withNone = channelDescription(builtIn);
  const withMany = channelDescription([...builtIn, ...many]);

  // The cost of forty add-ons is bounded. Without this, installing a folder of
  // channels would tax every unrelated conversation for the rest of time, and
  // the person who installed them would have no way to know.
  assert.ok(withMany.length - withNone.length < 300, `grew by ${withMany.length - withNone.length} characters`);

  // And the model is TOLD the list is partial, so it never says a channel does
  // not exist because it could not see it.
  assert.match(withMany, /more not listed here/);

  // Built-ins keep their keywords — those drive recognition, and cutting them
  // measured 8/10 down to 6/10.
  assert.match(withMany, /1 Test Card \(colour bars\)/);
  // Add-ons are names only.
  assert.match(withMany, /100 Channel Number 0/);
  assert.doesNotMatch(withMany, /Channel Number 0 \(/);

  // A few add-ons are all listed, with no "more" note to explain away.
  const withFew = channelDescription([...builtIn, ...many.slice(0, 3)]);
  assert.doesNotMatch(withFew, /more not listed here/);
});
