# What else he can do

Screen vision, music, reading your files, subtitles and volume.

[← Back to the README](../README.md)

---

## He can see your screen

Ask him what you're looking at and he takes a screenshot, shows it to a local vision model, and answers from what comes back. Nothing leaves the machine, and the screenshot is deleted the moment he's done with it.

> "Hey Greg, what's on my screen?"
> *"You have a code editor open on the left with a file called `server.js`, and a browser on the right showing documentation for the Fetch API. A terminal along the bottom is running a test suite — the last line reads '42 passing'."*

He reads text verbatim, so "read me that last line" works too. Takes about four seconds.

Vision runs on **its own model**, separate from the one he talks with — the best local vision models aren't the best chat models:

```jsonc
"vision": {
  "enabled": true,
  "model": "qwen2.5vl:7b",  // blank = use the conversation model
  "maxWidth": 1280,         // screenshots are downscaled before he looks
  "display": "primary",     // or "all" to span every monitor
  "think": false,
  "keepAlive": ""           // "30m" or "-1" keeps his eyes warm — see below
}
```

### Taking screenshots

Separate from looking. Ask him to take one and he saves a **full-resolution** PNG into a `screenshots` folder next to `start-greg.bat`:

> "Hey Greg, take a screenshot" → *"It's been saved in your screenshots folder."*

Say **"my whole desktop"** and he spans every monitor into one wide image; otherwise he captures just the main screen. Files are named `Screenshot 2026-08-04 143022.png`, which sorts chronologically.

```jsonc
"screenshots": {
  "enabled": true,
  "folder": "screenshots",  // relative to the Greg folder, or an absolute path
  "display": "primary",     // default when you don't say "whole desktop"
  "maxWidth": 0             // 0 = native resolution, don't shrink
}
```

Worth knowing: **the two capture paths are deliberately different.** Looking at your screen downscales hard and deletes the image the moment the model has answered. Taking a screenshot keeps full resolution and leaves the file for you. Greg won't read the path out loud either — a folder path spelled at you by a text-to-speech voice is unbearable.

### He has to prove he can see, every startup

This is the part worth knowing about. **A model that reports a vision capability may not actually have one**, and the way that fails is genuinely dangerous: it doesn't error, it invents.

`gemma4:e4b` — the conversation model — advertises vision, accepts an image without complaint, and then describes a screen it never received. Shown that same Reddit thread on a bright white display, it reported *"a dark or abstract wallpaper, no obvious application windows open, a taskbar at the bottom."* Plausible, fluent, and entirely fictional. Shown a pure red square it answers "Black". Every colour, every format.

So at startup Greg is shown two known colour swatches and must name both. Fail, and **the screen tool is removed from him entirely** — not discouraged, removed — and he says so plainly:

> "I can't see your screen; please describe what you are looking at for me."

The console tells you which way it went:

```
Eyes:     can read your screen
```

A confident wrong answer is worse than no answer. Same lesson as the `think` setting above, arriving from a different direction.

### Choosing a vision model

Measured here, on the three things that actually matter:

| Model | Size | Sees colour | Reads text | Describes a screen | VRAM |
| --- | --- | --- | --- | --- | --- |
| **`qwen2.5vl:7b`** | 6.0 GB | pass | pass | accurate, verbatim titles | 5.9 GB |
| `granite3.2-vision` | 2.4 GB | **fail** | **fail** — read "BANANA 42" as "BANAN" | answered "unanswerable" | 2.4 GB |
| `gemma4:e4b` | 9.6 GB | **fail** — everything is "Black" | **fail** | **fabricates** | 3.4 GB |

The small one isn't a viable trade — it doesn't pass Greg's own eyesight test, so he simply refuses to use it. `qwen2.5vl:7b` is the recommendation, and there isn't really a second choice.

```bash
ollama pull qwen2.5vl:7b
```

### What it costs in memory

Vision only loads while it's being used, and Ollama unloads it after five idle minutes. With both the brain and the eyes resident at once:

| | VRAM |
| --- | --- |
| `gemma4:e4b` (conversation) | 3.4 GB |
| `qwen2.5vl:7b` (vision) | 5.9 GB |
| Both at once | **9.3 GB** |

On a 24 GB card that leaves plenty spare. The first screen question after an idle spell takes about 12 seconds because the vision model has to load; after that it's ~4 seconds.

If that pause bothers you, set `"keepAlive": "30m"` (or `"-1"` for never unload) in the `vision` block. He'll answer in ~4 seconds every time, at the cost of holding 5.9 GB the whole while. It's a straight trade between memory and the occasional wait — the default keeps the memory.


## Music

Two layers, and the first needs no setup at all.

**Transport controls work immediately.** "Pause", "skip this", "go back", "turn
it up" — Greg sends Windows media keys, which land on whichever player owns
playback. No account, no credentials, nothing to configure, and it works on a
free Spotify account or any other player.

**Asking what's playing needs nothing either.** "What's this song?", "who is
this?", "what am I listening to?" — Greg asks Windows, which knows what every app
on the machine is playing: Spotify, a YouTube tab, VLC, a game's soundtrack. No
account, no token, no setup. It works even if you never connect Spotify at all.

**Playing a *named* song needs Spotify set up.** "Play Karma Police", "put on
some Radiohead" — starting a particular thing is the one job that needs the API.

### Setting that up

Three steps, once. **You do these — Greg never handles your password.**

1. Create an app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard). Free, instant, no review.
2. Add this exact Redirect URI to it:
   `http://127.0.0.1:4747/api/spotify/callback`
   The literal `127.0.0.1` matters — Spotify rejects `localhost`.
3. Copy the Client ID into `.env` as `SPOTIFY_CLIENT_ID`, restart Greg, then
   visit `http://127.0.0.1:4747/api/spotify/login` once and approve.

There's **no client secret to copy**. Greg uses PKCE, so it never stores one —
only the refresh token, which lands in `spotify-tokens.json`. That file is worth
treating as private.

### Podcasts

> "Hey Greg, play a random episode of Radiolab."
> "Play one of my podcasts."

**Random means random across the whole run** — Radiolab has 600 episodes, so he
picks an offset anywhere in that range rather than serving this month's. Trailers
and promos under five minutes are skipped (`spotify.minEpisodeMinutes`).

Naming a show works straight away. **"One of my podcasts"** — with no show named
— needs one extra permission, `user-library-read`, so if you connected Spotify
before that was added, visit `http://127.0.0.1:4747/api/spotify/login` once more
and re-approve. He'll tell you if it's missing rather than guessing.

### Two things to know

**It needs Premium.** Spotify's playback endpoints answer 403 on free accounts,
whatever you do. Transport controls still work; playing a named song doesn't.

**It needs Spotify open.** The API commands a running player rather than playing
audio itself, so if nothing's open there's nothing to command. Greg says so
plainly rather than pretending it worked.

**Greg ducks the music while he talks** and puts the volume back afterwards —
using the level it was at before, not a guess. That's the problem that got radio
shelved, solved properly.

```jsonc
"spotify": {
  "enabled": true,
  "duckVolume": 25,   // what to drop to while he speaks; false to not duck
  "redirectUri": ""   // blank = the 127.0.0.1 default above
}
```


## Sounding like a television

Settings has a **Vocoder** switch. It band-limits his voice, drives it a little
and ring-modulates it, so he sounds like he is coming through the set rather than
out of a speaker. The slider next to it decides how much.

It runs in the browser on the audio as it plays, so it works on every voice he
has — the cloned one, the offline one, Windows' own, and the cloud fallback. Even
at 100% some of the clean signal is mixed back in, because full ring modulation
sounds tremendous and makes the weather forecast unintelligible.


## Turning him down, and the noises he makes

The **left-hand knob on the cabinet** is the volume. Click the right of it to go
up and the left to go down, ten clicks end to end, and the level comes up over
the picture for a moment — the knob itself is about six pixels across in a small
window, which is not a readable indication of anything. Right down is **MUTE**.
There's a 🔊 button beside the type-here box that does the same thing (shift-click
for quieter), and a **Volume** slider in Settings that you can hear as you drag.

Whichever you use, it moves the same dial, it survives a restart, and it turns
down **everything he makes a sound with** — including the chime before an
announcement, which is the point.

There are two of those chimes and they mean different things:

- a **two-note ident**, falling, before a timer, a reminder, or somewhere read
  off the globe
- a **two-tone attention signal** — 853 and 960 Hz together, the one American
  television has used before a weather warning since the Emergency Broadcast
  System — before a severe weather warning, and only then

Both are synthesised on the spot and put through a filter shaped like the speaker
in a small wooden television, so they sound like they came out of the cabinet.
Nothing is downloaded and there are no audio files to go missing.

**The warm-up makes a noise too.** The tube strikes with a degauss thunk, the
line whine sits under the picture while the set is on — 15,625 Hz, which plenty
of people can't hear at all — and the POST beeps when the device list finishes:
**once if everything loaded, twice if something didn't**, the way a real BIOS
tells you. All of it goes through the volume knob, so a muted Greg starts up in
silence.


## He can read your files

> "Hey Greg, what's in my lease agreement?"
> "Hey Greg, what did that voice memo say?"

He finds the file by words in its name, reads it, and answers. Recordings —
audio *or* video — are transcribed by the same offline Whisper that listens to
you, so a voice memo or a lecture becomes text without anything leaving the
machine. Measured at 97 ms for a short clip.

**He can only read.** There is no code path in Greg that writes, moves, renames
or deletes a file, and that is deliberate rather than cautious: he mishears words
for a living, and "delete the invoice" and "delete the invoices" are one sound
apart.

**Where he's allowed to look** is your Documents, Downloads, Desktop, Pictures,
Videos and Music folders, and nowhere else. Anything outside is refused, and so
is anything shaped like a secret — `.env` files, keys, tokens, dotfiles — wherever
it happens to sit. A shortcut pointing out of an allowed folder doesn't work
either.

Change the list, or switch the whole thing off with an empty one:

```jsonc
"files": { "roots": [] }        // nowhere at all
"files": { "roots": ["D:/Work"] }   // just this
```

He reads plain text, code, and recordings. PDFs and Word documents he'll tell you
he can't open rather than guessing at what's inside them — and if something's on
your screen, ask him to look at the screen instead.


## Page 888 — subtitles

Turn him all the way down and **what he's saying appears on the screen**, in
teletext, with an 888 in the corner. That's the default, and it exists because
the alternative is worse than it sounds: muted, he'd answer into silence, log the
answer, and then follow up as though he'd told you something.

Settings → Sound has the switch — *when he's muted*, *always*, or *never*.
"Always" is worth trying if you keep him quiet in a shared room; "never" is a
real choice rather than a missing feature, but it does mean a muted Greg says
nothing you can see.

It covers announcements too, so a severe weather warning still reaches you with
the sound off.

