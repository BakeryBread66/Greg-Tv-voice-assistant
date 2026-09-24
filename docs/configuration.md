# Configuration

Every setting, where it lives, and which ones need a restart.

[← Back to the README](../README.md)

---

## How the brain works

Greg's conversation runs on **Ollama**, which hosts a language model locally on your GPU. It's already installed and configured. Greg picks a brain automatically at startup:

1. **Local model via Ollama** — the default. No key, no account, works offline.
2. **Claude** — only if you choose it: **Settings → Brain**, or `"provider": "anthropic"` in `config.json` with an `ANTHROPIC_API_KEY` in `.env`. Optional; you don't need one. The default, `"auto"`, never picks it.
3. **Basic mode** — if Ollama isn't running, he still does weather, news, and time by phrase matching.

If Ollama ever isn't running, start it from the Start Menu (or run `ollama serve`) and restart Greg.


## How the ears work

Greg hears you with **Whisper**, running locally on your GPU. Nothing you say is sent anywhere.

At startup he launches **whisper.cpp** (`engines/whisper/whisper-server.exe`), which keeps the model loaded so each transcription is fast — no Python needed. The setup screen installs it: the graphics-card build if you have a recent NVIDIA driver, the processor build otherwise. If it isn't installed he uses the Python `whisper_server.py` instead, as he always did. The console shows which is active:

```
Ears:     base.en on NVIDIA GeForce RTX 4090, whisper.cpp (on this PC)
```

The two were measured on the same 768 clips before switching: the same accuracy (3.8% word errors against 3.6%, and better with background noise), in half the time — 29 ms a clip on the GPU, 348 ms on the processor. The full comparison is in [bench/speech](../bench/speech/README.md).

The browser holds a rolling buffer of microphone audio and watches the signal level to spot when you start and stop talking, then sends just that slice for transcription. The buffer matters: speech is only detected a fraction of a second *after* it begins, so without a bit of history the word "Hey" gets clipped off the front.

Measured on an RTX 4090: **111–515 ms** per utterance, 4/4 phrases transcribed exactly.

If Python or Whisper isn't available he falls back to the browser's speech recognition automatically, which works but needs an internet connection and only runs in Chrome or Edge.


## How the voice works

Greg speaks with **Piper**, a small neural text-to-speech model running locally on your CPU. Nothing he says leaves the machine either.

At startup he launches `piper_server.py`, which keeps the voice model loaded — loading it costs about a second, which you'd otherwise pay on every single reply. The console shows what's active:

```
Voice:    en_US-ryan-high (offline)
```

Measured on this machine, end to end, all three saying the same sentence (7.5 seconds of speech):

| Voice | Where | Time |
| --- | --- | --- |
| `en_US-ryan-high` | local | **~850 ms** — the default, about 9x realtime |
| `en_GB-alan-medium` | local | **~150 ms** — about 40x realtime |
| `en-GB-RyanNeural` | cloud | ~660–910 ms — the voice this replaced |

So the honest summary: **the default is roughly a wash with the cloud voice on speed.** What you gain is that it's private, offline, and can't be rate-limited or taken away. If you want it genuinely fast as well, `en_GB-alan-medium` is 5x quicker than either — see the voice list below.

It runs on the CPU on purpose; the GPU would save milliseconds Greg isn't waiting on while competing with Whisper for memory.

The first run downloads the voice — 60–140 MB depending on quality, once — into a `voices/` folder. The console says so while it happens.

Each synthesis samples a little randomly, so saying the same sentence twice gives very slightly different audio. That's the model, not a bug.

If Python or Piper isn't available, Greg falls back to **Windows' own speech** — still on your machine, still offline, no install. Only if Windows has no voices at all does he reach for Microsoft's neural voices over the internet, and if *that's* unreachable, the browser's built-in voice. Each step down is automatic and he says which in the console.

That middle step matters more than it looks: without it, a hiccup in the local voice would send what he is about to say to a server. The plainest voice of the four, and the point of it is to still be local rather than to sound good.

### Voice settings — `config.json`

```jsonc
"localVoice": {
  "enabled": true,                 // false = always use the cloud voice
  "engine": "auto",                // "sherpa" (in Greg, no Python), "python", or
                                   // "auto": sherpa when installed, else Python
  "voice": "en_US-ryan-high",      // see the voice list below
  "speed": 1.0,                    // 1.15 faster, 0.9 slower
  "port": 4749
},
"speech": {
  "engine": "auto",                // "whisper.cpp", "python", or "auto": whisper.cpp
                                   // when installed, else the Python sidecar
  "model": "base.en"
}
```

**His voice runs inside Greg now**, through sherpa-onnx, with no Python and no
separate program. It is the same Piper voice — Greg converts your existing voice
files for it himself, in a fraction of a second — and was measured as fast (276
ms a sentence against 298) and as clear. To go back to the Python engines for
either, set its `engine` to `"python"`.


## Settings

Click **⚙**, or open `http://localhost:4747/?settings`. Eight tabs:

| | |
| --- | --- |
| **General** | What he's called, the wake words that reach him, and °F/°C and mph/km/h |
| **Location** | Follow your IP, or pin a place — search for a town and pick it |
| **Personality** | The six dials, "match my tone", and a free-text instruction |
| **Listening** | When he keeps listening after an answer, the talk key, barge-in sensitivity, and the microphone trigger with a live level bar |
| **Music** | Whether Spotify is set up, and what to do next if it isn't |
| **Memory** | Everything he remembers about you and everything he has scheduled — edit or delete any of it, or add a fact yourself. Changes here happen at once |
| **Brain** | Think on this PC, or with Claude: your API key (checked, then kept in `.env`), the Claude model, and exactly what is sent while Claude is in use. Acts on its own buttons, at once |
| **Phone** | Let a phone reach him through Tailscale, pair and remove phones, and keep him running with his window closed. See [Greg on your phone](phone.md) |

Everything here takes effect on the next thing you say — nothing needs a restart.
That's the rule for what's in the dialog: settings that only apply after a
restart (his voice, the model, ports) stay in `config.json`, because a control
that silently does nothing is worse than no control.

**Pin your location if IP geolocation gets it wrong**, which it often does. It
follows your *connection*, not you — on a managed-housing or campus ISP the
three free services Greg can ask disagreed by several hundred miles about the
same machine. Pinning it is the fix, not a workaround.

**The microphone trigger has a live bar** because 0.012 means nothing in the
abstract. Talk, watch where your voice lands against the red marker, and lower
the trigger if it never reaches it.

Changes made by voice show up here too — ask him to be funnier and the Humour
slider moves, because both go through the same place.


## Settings — `config.json`

```jsonc
{
  "localVoice": {                // the offline voice — see above
    "enabled": true,
    "voice": "en_US-ryan-high",
    "speed": 1.0
  },

  "voice": "en-GB-RyanNeural",   // cloud fallback only, if Piper can't start
  "rate": "+5%",                 // "+25%" faster, "-15%" slower
  "pitch": "+0Hz",               // "+30Hz" higher, "-30Hz" lower

  "wakeWords": ["hey greg", ...] // add mishearings you notice here

  "followUp": {                  // see "How the conversation flows"
    "mode": "always",            // "always", "question" (only when he asked you
                                 // something) or "off" (always need his name)
    "seconds": 7                 // how long he stays open after answering
  },
  "phone": {                     // see docs/phone.md
    "enabled": false,            // the phone's own server, on 127.0.0.1 only
    "keepRunning": false,        // stay up when his window closes (Greg.exe)
    "port": 4757                 // what `tailscale serve --bg 4757` forwards to
  },
  "pushToTalk": {
    "key": ""                    // e.g. "Ctrl+Alt+G" or "F9": press it and he listens.
                                 // Started from Greg.exe it works in every program
  },
  "bargeIn": {
    "enabled": true,             // false if you use speakers and he cuts himself off
    "sustainMs": 350             // how long you must talk before he yields
  },

  "location": {
    "auto": true,                // false = use the values below instead
    "city": "", "region": "",
    "latitude": null, "longitude": null
  },

  "alerts": {                    // severe weather warnings — see "He has channels"
    "enabled": true,             // false stops the background check entirely
    "pollMs": 180000             // how often to look; 20s is the floor
  },
  "apod": {
    "key": ""                    // blank = NASA's demo key, no signup, ~50/day
  },
  "stocks": {                    // the Markets channel — prices only, no advice
    "index": "^IXIC",            // the headline instrument
    "symbols": ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "TSLA"]
  },

  "volume": 1,                   // 0 to 1 — the left-hand knob on the cabinet,
                                 // and the Volume slider in Settings. Covers the
                                 // announcement chime as well as his voice.
  "files": {},                   // folders he may READ. No "roots" key = the
                                 // defaults (Documents, Downloads, Desktop,
                                 // Pictures, Videos, Music). An empty roots
                                 // list means nowhere. He never writes.
  "subtitles": "auto",           // "auto" shows them when he's muted, "always"
                                 // shows them regardless, "off" never does
  "units": { "temperature": "fahrenheit", "windSpeed": "mph" },

  "vision": {
    "enabled": true,             // false = no eyes at all, ever. He will say so
                                 // and cannot be talked into it.
    "openAtStartup": true        // false = eyes CLOSED at startup, and the
                                 // 5.9 GB model is not loaded. He can still open
                                 // them on request ("open your eyes"), and the
                                 // eyesight test runs at that moment instead of
                                 // during boot. Worth it on a card under 16 GB,
                                 // where the eyes and the cloned voice cannot
                                 // both be resident.
  },

  "provider": "auto",            // "auto" | "ollama" | "anthropic"
                                 // "auto" = the model on this PC, never the
                                 // cloud. "anthropic" = Claude, which shows a
                                 // CLAUDE · CLOUD badge in the title bar the
                                 // whole time it is in use.
  "ollama": {
    "model": "gemma4:e4b",
    "think": "auto",             // see the warning above
    "contextTokens": 8192
  },

  "port": 4747,
  "openBrowser": true
}
```

Restart Greg after editing.

### Other voices

Set `localVoice.voice` in `config.json` and restart — Greg downloads the new voice on first use. A few good ones:

| Voice | Sounds like |
| --- | --- |
| `en_US-ryan-high` | American man, warm — the default (~121 MB) |
| `en_GB-alan-medium` | British man, most Jarvis-ish (~63 MB, already downloaded) |
| `en_GB-northern_english_male-medium` | British man, northern, more character (~63 MB, already downloaded) |
| `en_GB-cori-high` | British woman, the best quality en_GB model (~114 MB) |
| `en_US-joe-medium` | American man, neutral (~63 MB) |
| `en_US-amy-medium` | American woman (~63 MB) |
| `en_US-lessac-high` | American woman, very clear (~114 MB) |

To print all 171 of them:

```bash
py -3 -c "from piper.download_voices import list_voices; list_voices()"
```

(There's no `--list` flag on the command line — that function exists but was never wired up to one.)

You can also browse them, with samples to listen to, at [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices). Names end in `-low`, `-medium` or `-high` — higher means better quality and a bigger download, and even `-high` synthesizes about 9x faster than realtime here.

The separate `voice` / `rate` / `pitch` settings apply only to the **cloud fallback**, and take Microsoft voice names like `en-GB-RyanNeural` or `en-US-AndrewNeural`.

### Wrong city?

Greg guesses your location from your IP, which a VPN will throw off. To pin it, set `"auto": false` and fill in the city, region, latitude and longitude (search "my latitude longitude" to find yours).

---


## Optional: using Claude instead

Greg doesn't need this — the local model handles everything. If you want Claude anyway, open **Settings → Brain**:

1. Paste an API key from [console.anthropic.com](https://console.anthropic.com) and press **Save key**. It is checked with Anthropic before it is saved, and kept in `.env`; the dialog never shows it again, only its last four characters. A Claude.ai subscription can't be used here: the API is billed separately, per question.
2. Choose **Claude**, pick a model — Opus 5, Sonnet 5 or Haiku 4.5 — and press **Use Claude**. The key is checked again, and the next thing you say goes to Claude. No restart.

**Use this PC** switches back the same way, and **Remove key** takes the key out of `.env` (moving him back to this PC first if Claude was in use).

Or by hand, which is what the tab does for you: put `ANTHROPIC_API_KEY=...` in `.env`, set `"provider": "anthropic"` and `"model"` in `config.json`, and restart.

A key on its own does nothing. `"auto"` used to prefer Claude whenever a key was present, which made a key in `.env` a switch that silently sent every conversation to Anthropic — and because the brain is chosen once at startup, an Ollama that was slow to start could do the same for a whole session. Now leaving the PC is something you ask for by name, and the console says so if a key is set but unused.

**While Claude is the brain, the window says so the whole time**: an amber **☁ CLAUDE · CLOUD** badge in the title bar, and a line in the status bar. Hover either one for what is sent — what you say, the facts he remembers about you, where you are, and whatever his tools fetch. The boot screen marks the brain amber rather than `[ OK ]`, and its tagline reads *Some processing remote*. The same badge appears if an Ollama brain is not on this PC either — `ollama.url` pointing at another machine, or one of Ollama's `-cloud` models.

---


## What's inside

```
Greg/
├── Greg.exe              Double-click to start: no console, tray icon, stops
│                         when his window closes (built by setup, never committed)
├── launcher/             Greg.cs, the icon, and build.ps1 that compiles them
├── start-greg.bat        The other way to start, with his console showing
├── stop-greg.bat         Stops a Greg started from start-greg.bat
├── config.json           Voice, wake words, location, model
├── server.js             Local web server
├── memory.json           What Greg remembers about you (created on first use)
├── reminders.json        Pending timers and reminders
├── whisper_server.py     Local speech-to-text (started automatically)
├── piper_server.py       Local text-to-speech (started automatically)
├── capture-screen.ps1    Screenshot for screen vision (run on demand)
├── media-session.ps1     Asks Windows what's playing, art included (on demand)
├── voices/               Downloaded Piper voice models (created on first run)
├── screenshots/          Screenshots he's taken for you (created on first use)
├── cache/                Speech cache and one small compiled helper
├── lib/
│   ├── stt.js            Manages the Whisper process
│   ├── brain.js          Conversation loop, tools, basic-mode fallback
│   ├── lifetime.js       Greg.exe's Greg stops when his window closes
│   ├── channels.js       Which programme is on his screen
│   ├── nowplaying.js     Manages the media-session watcher
│   ├── memory.js         Long-term memory
│   ├── reminders.js      Timers and reminders
│   ├── search.js         Web search (DuckDuckGo, Wikipedia fallback)
│   ├── sentences.js      Splits a reply into speakable chunks as it streams
│   ├── screen.js         Takes the screenshot
│   ├── vision.js         Makes the model prove it can see before trusting it
│   ├── providers/
│   │   ├── ollama.js     Local model (default)
│   │   └── anthropic.js  Claude (optional)
│   ├── tts.js            Picks a voice backend, cleans the text
│   ├── tts-piper.js      Manages the Piper process (local, default)
│   ├── tts-edge.js       Microsoft neural voices (cloud fallback)
│   ├── weather.js        Open-Meteo
│   ├── news.js           Google News RSS
│   └── location.js       Where "here" is
└── public/
    ├── index.html
    ├── face.js           Picks the renderer, and IS the reduced fallback face
    ├── face-tv.js        The floating TV head (the default)
    ├── globe.html        The Global Dashboard window
    ├── globe-app.js      Globe, country picking, the readout panel
    ├── globe.css         Win98 dressing for the dashboard
    ├── voice.js          Wake word, listening, speech queue, barge-in
    ├── listen-local.js   Offline capture + speech detection
    ├── recorder-worklet.js
    └── style.css
```

