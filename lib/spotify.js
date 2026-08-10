// Spotify, for the things a keyboard can't do — playing a particular song.
//
// Uses the Authorization Code flow with PKCE, which means Greg never stores a
// client secret: only a client ID, which isn't sensitive, plus the refresh token
// Spotify hands back. That token lives in spotify-tokens.json and is the one
// file here worth treating as private.
//
// Playback control is a Premium feature. On a free account Spotify answers 403
// to /me/player/play no matter what you do, so this reports that plainly rather
// than looking broken. lib/media.js still handles pause and skip either way.
//
// Everything needs an *active device* — Spotify's API commands a running player,
// it doesn't play audio itself. If nothing is open, there's nothing to command,
// and the error says so.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOKEN_FILE = path.join(ROOT, "spotify-tokens.json");

const AUTH = "https://accounts.spotify.com/authorize";
const TOKEN = "https://accounts.spotify.com/api/token";
const API = "https://api.spotify.com/v1";

// Only what's actually used. Asking for more than you need makes the consent
// screen scarier and buys nothing.
// user-library-read is only for "play one of my podcasts" — picking from the
// shows you follow. Everything else works without it, and a token issued before
// it was added simply gets a 403 there, which is reported rather than hidden.
const SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-library-read",
].join(" ");

let settings = { enabled: true, redirectUri: "", duckVolume: 25 };
let clientId = "";
let tokens = null;
let pending = null; // the PKCE verifier, between redirect and callback

export function initSpotify(config) {
  settings = { ...settings, ...(config.spotify ?? {}) };
  clientId = process.env.SPOTIFY_CLIENT_ID ?? "";
  settings.redirectUri = settings.redirectUri || `http://127.0.0.1:${config.port ?? 4747}/api/spotify/callback`;

  try {
    tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch {
    tokens = null;
  }

  return status();
}

export function status() {
  return {
    enabled: settings.enabled !== false,
    configured: Boolean(clientId),
    connected: Boolean(tokens?.refresh_token),
    redirectUri: settings.redirectUri,
  };
}

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

const base64url = (buffer) => buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Where to send the browser to authorise. */
export function loginUrl() {
  if (!clientId) throw new Error("no SPOTIFY_CLIENT_ID — see the README");

  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  const state = base64url(crypto.randomBytes(12));
  pending = { verifier, state };

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: settings.redirectUri,
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
    scope: SCOPES,
  });
  return `${AUTH}?${params}`;
}

/** Swap the code Spotify sent back for tokens. */
export async function completeLogin(code, state) {
  if (!pending) throw new Error("there's no sign-in in progress — start again from /api/spotify/login");
  if (state !== pending.state) throw new Error("that response didn't match the request we made");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: settings.redirectUri,
    client_id: clientId,
    code_verifier: pending.verifier,
  });
  pending = null;

  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description ?? `Spotify returned ${res.status}`);

  saveTokens(data);
  return status();
}

function saveTokens(data) {
  tokens = {
    access_token: data.access_token,
    // A refresh response doesn't always include a new refresh token; keep the old.
    refresh_token: data.refresh_token ?? tokens?.refresh_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), "utf8");
  } catch (err) {
    console.warn(`[spotify] couldn't save tokens: ${err.message}`);
  }
}

async function accessToken() {
  if (!tokens?.refresh_token) throw new Error("Spotify isn't connected yet — open /api/spotify/login once");
  // A minute of slack, so a token doesn't expire between the check and the call.
  if (tokens.access_token && Date.now() < tokens.expires_at - 60000) return tokens.access_token;

  const res = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`couldn't refresh the Spotify token: ${data.error_description ?? res.status}`);

  saveTokens(data);
  return tokens.access_token;
}

// ---------------------------------------------------------------------------
// Calling the API
// ---------------------------------------------------------------------------

async function call(endpoint, { method = "GET", body } = {}) {
  const token = await accessToken();
  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });

  // 204 is the usual success for playback commands, and has no body.
  if (res.status === 204) return null;

  if (res.status === 403) {
    throw new Error("Spotify refused that — controlling playback needs a Premium account");
  }
  if (res.status === 404) {
    throw new Error("no active Spotify device — open Spotify and play something for a moment first");
  }
  if (res.status === 429) {
    throw new Error("Spotify is rate-limiting us; try again shortly");
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message ?? `Spotify returned ${res.status}`);
  return data;
}

// ---------------------------------------------------------------------------
// What Greg actually does
// ---------------------------------------------------------------------------

const normalise = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Pull an artist out of a title if one got left in.
 *
 * Prose is actively harmful in a Spotify query: asking for "The Nightfly by
 * Donald Fagen" returns "The Goodbye Look" first, because "by" matches inside
 * "Goodbye" and outranks the exact title. Dropping the connector is not enough
 * on its own — the artist has to move into its own field — so this splits the
 * two apart when the model hands over a whole phrase.
 */
function splitTitleAndArtist(query, artist) {
  const text = String(query ?? "").trim();
  if (artist) return { title: text, artist };

  const match = text.match(/^(.*?)\s+(?:by|from)\s+(.+)$/i);
  if (match) return { title: match[1].trim(), artist: match[2].trim() };
  return { title: text, artist: "" };
}

/** Quoted field filters beat a bag of words every time. */
function buildQuery(type, title, artist) {
  const quote = (value) => `"${String(value).replace(/"/g, "")}"`;
  if (type === "artist") return `artist:${quote(title)}`;
  // Playlists are user-created and the filters don't apply cleanly.
  if (type === "playlist") return title;

  const field = type === "album" ? "album" : "track";
  return [`${field}:${quote(title)}`, artist ? `artist:${quote(artist)}` : ""].filter(Boolean).join(" ");
}

/** Prefer something actually called what was asked for, not merely ranked first. */
function pickBest(items, title) {
  const wanted = normalise(title);
  return (
    items.find((item) => normalise(item.name) === wanted) ??
    items.find((item) => normalise(item.name).startsWith(wanted)) ??
    items[0]
  );
}

export async function setShuffle(on) {
  await call(`/me/player/shuffle?state=${on ? "true" : "false"}`, { method: "PUT" });
  return { shuffle: Boolean(on) };
}

/** Find something and start it playing. */
export async function playSomething(query, kind = "track", artistHint = "") {
  const type = ["track", "album", "artist", "playlist"].includes(kind) ? kind : "track";
  const { title, artist } = splitTitleAndArtist(query, artistHint);
  if (!title) return { error: "NOTHING IS PLAYING. No song name was given." };

  // Ten rather than one, so pickBest has something to choose between.
  let items = [];
  try {
    const found = await call(`/search?q=${encodeURIComponent(buildQuery(type, title, artist))}&type=${type}&limit=10`);
    items = (found?.[`${type}s`]?.items ?? []).filter(Boolean);
  } catch {
    items = [];
  }

  // Field filters are strict; if they match nothing, fall back to a plain search
  // of the words — but with the connector removed, which is what broke it.
  if (!items.length) {
    const plain = [title, artist].filter(Boolean).join(" ");
    const found = await call(`/search?q=${encodeURIComponent(plain)}&type=${type}&limit=10`);
    items = (found?.[`${type}s`]?.items ?? []).filter(Boolean);
  }

  const item = pickBest(items, title);
  if (!item) return { error: `NOTHING IS PLAYING. Nothing on Spotify matched "${title}".` };

  // An album should start at track one. With shuffle left on it starts wherever
  // it likes, which reads as Greg playing the wrong thing.
  if (type === "album") {
    try {
      await setShuffle(false);
    } catch {
      /* not worth failing the play over */
    }
  }

  // A single track goes in `uris`; everything else is a context you play *within*,
  // which is what makes an album play in order rather than one song on repeat.
  const body = type === "track" ? { uris: [item.uri] } : { context_uri: item.uri };
  await call("/me/player/play", { method: "PUT", body });

  return {
    playing: item.name,
    by: (item.artists ?? []).map((a) => a.name).join(", ") || item.owner?.display_name || "",
    kind: type,
    // So Greg can say "from The Nightfly" and you can tell it got the right one.
    from: type === "track" ? item.album?.name ?? "" : "",
  };
}

// ---------------------------------------------------------------------------
// Podcasts
//
// Shows and episodes are separate object types from tracks, and a "random
// episode" has to mean random across the whole run — Radiolab has 600, and only
// ever sampling the first page would mean hearing this month's forever. Spotify
// pages by offset and reports the total, so two requests get a genuinely uniform
// pick: choose an offset anywhere in the run, then one episode from that page.
// ---------------------------------------------------------------------------

const pickRandom = (list) => list[Math.floor(Math.random() * list.length)];

/** A random episode from a page around `offset`, skipping trailers. */
async function randomEpisodeOf(show, minMinutes) {
  const total = show.total_episodes ?? 0;
  if (!total) return null;

  const offset = Math.floor(Math.random() * total);
  const page = await call(`/shows/${show.id}/episodes?limit=20&offset=${Math.max(0, Math.min(offset, total - 1))}`);
  const episodes = (page?.items ?? []).filter(Boolean).filter((e) => e.is_playable !== false);
  if (!episodes.length) return null;

  // Shows are padded with trailers and 60-second promos; they're playable, but
  // nobody means them by "play an episode".
  const proper = episodes.filter((e) => (e.duration_ms ?? 0) >= minMinutes * 60000);
  return pickRandom(proper.length ? proper : episodes);
}

/**
 * Play a random episode.
 * @param {string} showName  Leave empty to pick from the shows the user follows.
 */
export async function playPodcast(showName = "") {
  const minMinutes = settings.minEpisodeMinutes ?? 5;
  let show;

  if (showName.trim()) {
    const found = await call(`/search?q=${encodeURIComponent(`show:"${showName.replace(/"/g, "")}"`)}&type=show&limit=10`);
    const shows = (found?.shows?.items ?? []).filter(Boolean);
    show = pickBest(shows, showName);
    if (!show) return { error: `NOTHING IS PLAYING. No podcast called "${showName}" was found on Spotify.` };
  } else {
    let saved;
    try {
      saved = await call("/me/shows?limit=50");
    } catch (err) {
      return {
        error: "NOTHING IS PLAYING. Can't see the user's followed podcasts.",
        tell_the_user:
          "I can't see which podcasts you follow yet — visit 127.0.0.1:4747/api/spotify/login once more to grant that, or just name a podcast.",
      };
    }
    const shows = (saved?.items ?? []).map((entry) => entry.show).filter(Boolean);
    if (!shows.length) {
      return {
        error: "NOTHING IS PLAYING. The user follows no podcasts.",
        tell_the_user: "You don't follow any podcasts on Spotify, so name one and I'll find it.",
      };
    }
    show = pickRandom(shows);
  }

  const episode = await randomEpisodeOf(show, minMinutes);
  if (!episode) return { error: `NOTHING IS PLAYING. No playable episodes came back for ${show.name}.` };

  await call("/me/player/play", { method: "PUT", body: { uris: [episode.uri] } });

  return {
    playing: episode.name,
    show: show.name,
    minutes: Math.round((episode.duration_ms ?? 0) / 60000),
    released: episode.release_date ?? "",
    outOf: show.total_episodes ?? null,
  };
}

export async function nowPlaying() {
  // Without additional_types the endpoint only ever returns *track* objects, so
  // a playing podcast comes back with a null item and reads as "nothing is
  // playing". Podcasts were invisible here until this was added.
  const state = await call("/me/player?additional_types=track,episode");
  if (!state?.item) return { playing: false };

  const common = {
    playing: state.is_playing,
    device: state.device?.name ?? "",
    volume: state.device?.volume_percent ?? null,
  };

  // An episode has a show rather than artists, and no album.
  if (state.currently_playing_type === "episode" || state.item.type === "episode") {
    return {
      ...common,
      kind: "podcast",
      episode: state.item.name,
      show: state.item.show?.name ?? "",
      minutes: Math.round((state.item.duration_ms ?? 0) / 60000),
    };
  }

  return {
    ...common,
    kind: "music",
    track: state.item.name,
    by: (state.item.artists ?? []).map((a) => a.name).join(", "),
    album: state.item.album?.name ?? "",
  };
}

export async function setVolume(percent) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  await call(`/me/player/volume?volume_percent=${value}`, { method: "PUT" });
  return { volume: value };
}

// ---------------------------------------------------------------------------
// Ducking
//
// The reason radio was deferred: music and Greg fighting for the same speakers.
// Here it's solvable — drop the volume while he talks, put it back after. The
// level before ducking is remembered so "put it back" means what it says.
// ---------------------------------------------------------------------------

let volumeBeforeDuck = null;

export async function duck() {
  if (!tokens?.refresh_token || settings.duckVolume === false) return;
  try {
    const state = await nowPlaying();
    if (!state.playing || state.volume === null) return;
    if (state.volume <= settings.duckVolume) return; // already quiet enough
    volumeBeforeDuck = state.volume;
    await setVolume(settings.duckVolume);
  } catch {
    // Ducking is a nicety. Never let it interfere with Greg speaking.
  }
}

export async function unduck() {
  if (volumeBeforeDuck === null) return;
  const restore = volumeBeforeDuck;
  volumeBeforeDuck = null;
  try {
    await setVolume(restore);
  } catch {
    /* as above */
  }
}
