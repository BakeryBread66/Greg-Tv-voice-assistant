# Troubleshooting

Checking he is healthy, and what to do when he is not.

[← Back to the README](../README.md)

---

## Checking nothing's broken

```bash
npm test
```

152 checks, about half a second. No network, no microphone, no graphics
card — it covers the decisions Greg makes in plain code rather than by asking
the model: which channel you meant, whether a warning is worth interrupting for,
whether a question is asking for investment advice, how to say a percentage out
loud. Worth running after editing anything in `lib/`.

You can also just close the console window that `start-greg.bat` opened, or press `Ctrl+C` in it — that's the same thing.

> **Whether closing his window shuts him down depends on how you started him.** From Greg.exe — the Start menu or desktop icon — it does, about fifteen seconds after the window closes, so a reload does not count; **Stop Greg** in the tray icon's menu does it at once. From `start-greg.bat` it does not: that only closes the display, and the server keeps running. Use `stop-greg.bat` or close the console window.
>
> Started from Greg.exe there is no console window, but everything it would have shown is one click away: **Show console** in the tray icon's menu. If Greg.exe's Greg stops by himself with an error, that console opens on its own with the reason at the bottom. It is kept in memory only, never written to disk, because it includes what was said to him.

When the server stops, any open face window notices within a few seconds, goes dim, says **"Offline — Greg has been shut down"**, and releases the microphone. Leave it open if you like — when you next run `start-greg.bat`, the page reconnects on its own.

Ollama is a separate background service and keeps running — it's idle at around 80 MB. The model it loaded frees your GPU automatically after roughly five idle minutes. To reclaim that memory immediately, right-click the Ollama icon in your system tray and choose Quit; Greg will fall back to basic mode until you start it again.

The console prints which brain he's using at startup:

```
Brain:    gemma4:e4b (local)
```

---


## When something's off

**"He can't hear me."** Check the microphone icon in the address bar is allowed, and that Windows has the right input device selected under Settings → System → Sound. If the console says `Ears: browser speech recognition`, the offline ears didn't start — see below.

**"Ears: browser speech recognition (needs internet)".** Whisper didn't start. Run `py -3 -c "import faster_whisper"` — if that errors, reinstall with `py -3 -m pip install faster-whisper`. GPU mode additionally needs `nvidia-cublas-cu12`, `nvidia-cudnn-cu12` and `nvidia-cuda-runtime-cu12`; set `"device": "cpu"` in `config.json` to skip CUDA entirely.

**"He mishears me."** Try a bigger Whisper model — `"model": "small.en"` in `config.json`. Also add whatever he *does* hear to `wakeWords`.

**"He hears me but ignores me."** Watch the status text while you talk — the browser may be mishearing "Greg" as something else. Whatever it hears, add it to `wakeWords` in `config.json`.

**"I don't have Chrome."** You don't need it. Greg opens in Edge if Chrome isn't there, which ships with Windows and behaves identically for everything he uses. He only falls back to your default browser if neither is installed — and if that's Firefox, offline ears (Whisper) still work, but the *browser's* speech recognition doesn't exist there, so install Whisper or type to him. The music visualiser is Chromium-only too, since Firefox can't share system audio.

**"Brain: basic mode" at startup.** Ollama isn't running. Start it from the Start Menu, then restart Greg. To check it directly, open http://localhost:11434 in a browser — it should say "Ollama is running".

**"He makes things up."** Check `think` is `"auto"`, not `"off"` — see the warning above. If the model you picked doesn't list `tools` in `ollama show`, switch back to `gemma4:e4b`.

**"First question is slow, the rest are fast."** Normal. The model loads into GPU memory on the first question and stays warm for a few minutes.

**"He kept talking after I shut him down."** Fixed. The cause was that speech recognition runs in the browser, not on the server — so an open face window kept listening after the server stopped, and every failed request got read aloud as an error. Now the page detects the shutdown, goes silent, and releases the mic. If you still see it, you have an old face window open from before the fix: close it and reopen from `start-greg.bat`.

**"He keeps interrupting himself."** He's hearing his own voice through your speakers and reading it as you cutting in. Use headphones, or set `"bargeIn": { "enabled": false }` in `config.json`. After three of these in a row he turns barge-in off himself and says so under his face.

**"Talking over him does nothing."** Barge-in needs the offline ears — if the console says `Ears: browser speech recognition`, the microphone is stopped while he talks and there's nothing to interrupt him with. Otherwise try lowering `bargeIn.sustainMs`; you have to keep talking for that long before he yields. Clicking his face always works.

**"He answers something I didn't ask, just after replying."** The seven-second follow-up window heard something. Speech recognition invents filler out of room tone, and short filler is ignored inside that window, but a noisy room can still produce a real-looking phrase. Shorten it with `"followUp": { "seconds": 3 }`, or set `"enabled": false` to go back to needing the wake word every time.

**"His sentences run into each other."** There's a deliberate 110 ms gap between sentences — `SENTENCE_GAP_MS` in `public/voice.js`. Raise it if they still overlap, lower it if he sounds stilted.

**"No voice, but text appears."** Both the local and cloud voices failed, so he fell back to the browser's built-in voice. Check the console for a `[voice]` line saying why.

**"Voice: en-GB-RyanNeural (needs internet)" at startup.** Piper didn't start, so he's on the cloud voice. Run `py -3 -c "import piper"` — if that errors, install it with `py -3 -m pip install piper-tts`. The console prints the actual reason next to `[voice]`.

**"He's slow to answer."** After every answer the console prints where the time went, in order — for example `(used: get_weather, first sentence 2100ms, total 2600ms, model 1.2s > get_weather 0.1s > model 1.3s)` — and the same numbers go into `conversations.jsonl` as `steps`. A slow `model` step on the **first** question of a session means the brain was still loading: he now starts loading it before his window even opens, so this should be rare, but a PC that has just booted reads a 9.6 GB model off a cold disk. A slow step later in a session is usually `ollama.keepAlive` having unloaded him after 30 idle minutes. A slow tool step names the service that was slow. The weather is fetched at startup and reused for ten minutes, so `get_weather` should be close to `0.0s`; the warning check and the air quality get three seconds at most before he answers without them, and he says so rather than guessing. Thinking stays on even though it adds time to every `model` step: with it off he stops calling his tools a few turns in and starts making answers up — see [DECISIONS.md](../DECISIONS.md) before changing it.

**"Startup hangs the first time."** He's downloading the voice model — 60–140 MB, once. The console says `downloading the … voice` while it happens.

**"Eyes: no screen vision" at startup.** The model failed the colour-swatch test, so Greg won't pretend to see. The console line names what it answered. Pull a real vision model and set `vision.model` — see [He can see your screen](features.md#he-can-see-your-screen).

**"He says he can't see my screen."** That's him being honest rather than broken — see above. He'd otherwise describe a screen he never received.

**"He says an acronym as a word."** He spells out capitalised initialisms — "UNCW" as *U-N-C-W*, not "unk-wuh" — while leaving ones that really are words alone, like NASA and NATO. If he spells something that shouldn't be, add it to `SAID_AS_WORDS` near the top of `lib/tts.js`. Two-letter forms like NC and TV are left alone; they were already right.

**"He reads punctuation out loud."** Shouldn't happen — `lib/tts.js` strips markdown, URLs and emoji before synthesis, because Piper pronounces every one of them literally (`**cold**` becomes "asterisk asterisk cold asterisk asterisk"). If you find a case that slips through, add it there.

**"Port 4747 is already in use."** Change `"port"` in `config.json`.

---

