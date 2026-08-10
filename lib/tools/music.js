// Music tools: schema and handler together.
//
// They used to be 400 lines apart in lib/brain.js — one entry in a 23-item
// array, one case in a 23-case switch — with nothing stopping the two
// drifting. `run` receives (input, ctx); ctx carries what a handler needs
// from the brain and cannot import for itself.

import { nudgeVolume, pressMediaKey } from "../media.js";
import { describeNowPlaying, getNowPlaying } from "../nowplaying.js";
import { nowPlaying, playPodcast, playSomething, status as spotifyStatus } from "../spotify.js";

export const music = [
  {
    name: "play_music",
    description:
      "Play a specific song, album, artist or playlist on Spotify. Use for 'play <something>', 'put on <artist>', 'play some <artist>'. Needs Spotify open and a Premium account.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "ONLY the title — the song, album or playlist name on its own. Do NOT include the artist and do NOT include the word 'by'. For 'play The Nightfly by Donald Fagen' this is 'The Nightfly'.",
        },
        artist: {
          type: "string",
          description:
            "The artist, on its own, if the user named one. For 'play The Nightfly by Donald Fagen' this is 'Donald Fagen'. Leave empty if they didn't say.",
        },
        kind: {
          type: "string",
          enum: ["track", "album", "artist", "playlist"],
          description:
            // Second sentence removed: it restated the first in different words.
            // The query/artist rules above are untouched — those encode the
            // measured Spotify search failure and are not decoration.
            "What sort of thing it is. 'track' for a named song, 'artist' when they only name a band, 'album' for a record.",
        },
      },
      required: ["query"],
    },
    async run(input, ctx) {
    const spotify = spotifyStatus();
    // Phrased as flat failures. A softer wording ("I can still pause and
    // skip") got reported to the user as success — the model read it as
    // guidance rather than as the action not happening.
    //
    // The same rule has to hold for a request that gets PAST these checks and
    // then fails at Spotify — see playbackFailure() at the foot of this file.
    if (!spotify.configured) {
      return {
        error: "NOTHING IS PLAYING. Spotify is not set up on this machine, so no music was started.",
        tell_the_user: "Spotify isn't set up yet, so I can't start a song — but I can still pause and skip.",
      };
    }
    if (!spotify.connected) {
      return {
        error: "NOTHING IS PLAYING. Spotify is not connected yet, so no music was started.",
        tell_the_user: "Spotify isn't connected yet. Visit 127.0.0.1:4747/api/spotify/login once and approve it.",
      };
    }
    try {
      return await playSomething(input.query ?? "", input.kind ?? "track", input.artist ?? "");
    } catch (err) {
      return playbackFailure(err.message);
    }
    },
  },
  {
    name: "play_podcast",
    description:
      "Play a random episode of a podcast on Spotify. Use for 'play a podcast', 'put on an episode of <show>', 'play some <podcast>'. Picks an episode at random from the show's whole run, not the newest one.",
    parameters: {
      type: "object",
      properties: {
        show: {
          type: "string",
          description: "The podcast's name on its own, e.g. 'Radiolab'. Leave empty if they didn't name one.",
        },
      },
      required: [],
    },
    async run(input, ctx) {
    const spotify = spotifyStatus();
    if (!spotify.configured || !spotify.connected) {
      return {
        error: "NOTHING IS PLAYING. Spotify is not connected, so no podcast was started.",
        tell_the_user: "Spotify isn't connected yet, so I can't start a podcast.",
      };
    }
    try {
      return await playPodcast(input.show ?? "");
    } catch (err) {
      return { error: `NOTHING IS PLAYING. ${err.message}` };
    }
    },
  },
  {
    name: "whats_playing",
    description:
      "Say what is playing on this machine right now — any app, not just Spotify. Use for 'what's this song', 'what am I listening to', 'who is this'.",
    parameters: { type: "object", properties: {}, required: [] },
    async run(input, ctx) {
    // Windows' own media session first. It covers every app rather than one,
    // it needs no account or token, and it keeps answering when Spotify's
    // refresh token has expired — which is the state this machine is in.
    const windows = await getNowPlaying({ waitMs: 5000 });
    if (windows?.playing) {
      return {
        title: windows.title,
        artist: windows.artist,
        album: windows.kind === "Music" ? windows.album : undefined,
        kind: windows.kind,
        app: windows.source,
        status: windows.status,
        spoken: describeNowPlaying(windows),
      };
    }
  
    // Nothing on this machine. Spotify can still be playing somewhere else
    // entirely — a phone, a speaker — which Windows has no way of knowing.
    try {
      return await nowPlaying();
    } catch (err) {
      if (windows?.error) return { error: `NOTHING IS PLAYING. ${windows.error}` };
      return { error: `NOTHING IS PLAYING on this machine. ${err.message}` };
    }
    },
  },
  {
    name: "control_playback",
    description:
      "Control music that is already playing — pause, resume, skip, go back, or change the volume. Works with Spotify and any other player. Use for 'pause', 'skip this', 'next song', 'turn it up', 'louder', 'mute'. This cannot start a particular song; use play_music for that.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["playpause", "next", "previous", "stop", "volumeup", "volumedown", "mute"],
          description: "What to do. Use playpause for both 'pause' and 'resume'.",
        },
        steps: {
          type: "integer",
          description: "For volume only: 1 to 25. 5 is a noticeable nudge.",
        },
      },
      required: ["action"],
    },
    async run(input, ctx) {
    const action = String(input.action ?? "").toLowerCase();
    if (action === "volumeup" || action === "volumedown") {
      return await nudgeVolume(action === "volumedown" ? "down" : "up", input.steps ?? 5);
    }
    return await pressMediaKey(action);
    },
  },
];

/**
 * A playback request that reached Spotify and was refused.
 *
 * The two pre-flight checks in play_music are worded emphatically for a measured
 * reason: a soft error gets reported to the user as success, because a model
 * reads "I can still pause and skip" as guidance rather than as the action not
 * happening. Greg once announced "I'll put on some music for you" over a tool
 * result that was an error, having started nothing.
 *
 * The runtime path did not get that treatment. It returned the bare message,
 * which is exactly where the two most common real failures land: a free
 * account (403) and no running Spotify (404). Those are the answers to "why
 * can't my friend play music", and they were the ones phrased most weakly.
 *
 * `tell_the_user` carries the remedy so the error itself can stay flat — the
 * split that stopped consolation being mistaken for success.
 */
export function playbackFailure(message) {
  const said = String(message ?? "").trim().replace(/\.$/, "");
  const lower = said.toLowerCase();

  let remedy = null;
  if (lower.includes("premium")) {
    remedy = "Starting a particular song needs Spotify Premium. Pause, skip and volume still work on any account.";
  } else if (lower.includes("no active spotify device") || lower.includes("active device")) {
    remedy = "Spotify needs to be open first. Play anything there for a second, then ask me again.";
  } else if (lower.includes("rate-limit")) {
    remedy = "Spotify is rate-limiting us for a moment. Try again shortly.";
  }

  return {
    error: `NOTHING IS PLAYING. ${said || "Spotify refused the request"}, so no music was started.`,
    ...(remedy ? { tell_the_user: remedy } : {}),
  };
}
