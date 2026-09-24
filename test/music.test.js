// Asking for music by name: what the model's three fields are taken to mean, and
// when a name asked for as a song is really a band.
//
// Pure decisions only. playSomething itself talks to Spotify with the real
// tokens in spotify-tokens.json, so nothing here calls it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { planPlay, artistInstead } from "../lib/spotify.js";

test("an artist named on their own is a request for the artist, whoever they are", () => {
  // "Play some Prince" arrived exactly like this and failed with "no song name
  // was given". It was never about Prince.
  for (const name of ["Prince", "Steely Dan", "Travis Scott", "The Beatles", "Beyoncé"]) {
    assert.deepEqual(planPlay("", "track", name), { type: "artist", title: name, artist: "" }, name);
    assert.deepEqual(planPlay("", "artist", name), { type: "artist", title: name, artist: "" }, name);
    assert.deepEqual(planPlay(undefined, undefined, name), { type: "artist", title: name, artist: "" }, name);
  }
});

test("an artist search is on the name, however the model filled the fields", () => {
  assert.deepEqual(planPlay("Prince", "artist", ""), { type: "artist", title: "Prince", artist: "" });
  assert.deepEqual(planPlay("Prince", "artist", "Prince"), { type: "artist", title: "Prince", artist: "" });
});

test("a song with its artist is still a song", () => {
  assert.deepEqual(planPlay("Butterfly Effect", "track", "Travis Scott"), {
    type: "track",
    title: "Butterfly Effect",
    artist: "Travis Scott",
  });
  // The connector left in the title is still split out.
  assert.deepEqual(planPlay("The Nightfly by Donald Fagen", "album", ""), {
    type: "album",
    title: "The Nightfly",
    artist: "Donald Fagen",
  });
});

test("nothing named at all is still nothing", () => {
  assert.equal(planPlay("", "track", "").title, "");
  assert.equal(planPlay(null, "track", null).title, "");
});

const track = (name, popularity) => ({ name, popularity });
const artist = (name, popularity) => ({ name, popularity });

test("a bare name that is exactly an artist plays the artist, not a song with those words in it", () => {
  const tracks = [track("Prince Ali", 70), track("Little Red Corvette", 60)];
  const artists = [artist("Prince", 78), artist("Princess Nokia", 60)];
  assert.equal(artistInstead(tracks, artists, "Prince")?.name, "Prince");
  assert.equal(artistInstead([], [artist("Steely Dan", 65)], "steely dan")?.name, "Steely Dan");
});

test("a song called exactly that wins when it is the more popular of the two", () => {
  // "Hello" is Adele's song, not whichever band happens to be called Hello.
  const tracks = [track("Hello", 85)];
  const artists = [artist("Hello", 20)];
  assert.equal(artistInstead(tracks, artists, "Hello"), null);
  // And the other way round: "Adele" is Adele.
  assert.equal(artistInstead([track("Adele", 30)], [artist("Adele", 88)], "Adele")?.name, "Adele");
});

test("only an exact name counts as the artist", () => {
  // "Prince" must not become Princess Nokia because one starts with the other.
  assert.equal(artistInstead([], [artist("Princess Nokia", 60)], "Prince"), null);
  assert.equal(artistInstead([], [], "Prince"), null);
  assert.equal(artistInstead(undefined, undefined, "Prince"), null);
  assert.equal(artistInstead([], [artist("", 50)], ""), null);
});
