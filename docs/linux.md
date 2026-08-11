# Greg on Linux

Greg boots and holds a conversation on Linux. Five Windows-only features are
off, he says which at startup, and this page is what each would take.

[← Back to the README](../README.md)

---

## What works

Everything except the five below, which is more than it sounds: the server, the
brain, all 28 tools, all fourteen channels and their data feeds, the face, the
globe, reminders, memory, personalities, settings, and both Python sidecars.

- **Ollama** is cross-platform. The brain works unchanged.
- **Whisper** (`whisper_server.py`) works. It preloads CUDA DLLs on Windows only
  — that block is behind `sys.platform == "win32"`, and on Linux the normal
  loader finds CUDA, which is the correct behaviour there anyway.
- **Piper** (`piper_server.py`) and the **cloned voice** (`clone_server.py`)
  contain no Windows-specific code at all.

```bash
./start-greg.sh      # installs dependencies on a first run, then starts him
./stop-greg.sh       # stops the server and its sidecars
```

Both need `chmod +x` once after cloning, since git does not always preserve the
bit.

## What is off, and what each would take

These five shell out to PowerShell. Each already catches a failed spawn, so
nothing crashes — they simply report themselves unavailable. The banner names
them at startup rather than letting you discover it when a tool silently does
nothing.

| Feature | You lose | It wants |
| --- | --- | --- |
| **Screen vision** | `look_at_screen`, `take_screenshot` | `scrot` or `spectacle` on X11; `xdg-desktop-portal` + PipeWire on Wayland |
| **Cursor tracking** | his head following the pointer outside the window | `xdotool getmouselocation` on X11 |
| **Now playing** | `whats_playing`, the Now Playing channel | MPRIS over D-Bus |
| **Media keys** | `control_playback` — pause, skip, previous | `playerctl` |
| **System voice** | one fallback voice, if Piper ever fails | `spd-say` or `espeak-ng` |

**Three of these are easier on Linux than they were on Windows.** The media
session needed a C# helper compiled at runtime, because PowerShell hands back
`Thumbnail.OpenReadAsync()` as a bare `System.__ComObject` with no way to reach
the real interface — an evening lost to four dead approaches. MPRIS carries
title, artist and artwork over D-Bus with none of that. Media keys and the
system voice are single commands.

### Wayland is the real limit, not Linux

Two of the five behave differently there, and they are not the same kind of
problem:

- **Cursor position is deliberately impossible.** Wayland refuses it as a
  security property of the protocol, not as a missing API. Head tracking
  *outside* the browser window cannot be brought back at any cost. Inside the
  window is untouched — those are ordinary mouse events.
- **Screen capture is possible but consent-gated**, through
  `xdg-desktop-portal`. "What's on my screen" becomes prompted rather than
  instant. That is a different experience, not an absent one.

Wayland is the default on Ubuntu 22.04+, Fedora and modern GNOME and KDE, so
most people land there. X11 can reach full parity; Wayland cannot, and pretending
otherwise would be the kind of claim this project spends its time removing.

## Contributing one of them

This is a good first issue, and deliberately so — each is one module with one
job, and there is a working Windows version beside it to read.

The shape to follow is `lib/screen.js`: it spawns a script, parses what comes
back, and reports itself unavailable if the spawn fails. A Linux version
replaces the spawn and nothing else. Keep the failure handling — Greg saying
"I can't see your screen" is a feature, and a capability that reports itself
working when it is not is the single failure this project is arranged against.

**Please only send one you have actually run.** Greg's own rule, learned when
four defects turned up from one outside install: no amount of local testing
substitutes for a different computer.

## Known untested

**Nobody has run Greg on Linux.** The five modules above degrade by design and
their `ENOENT` handling is tested, the browser choice and the banner wording are
tested, and `npm test` passes — but the whole thing has never started on a Linux
desktop.

If you are the first, the useful things to report are the startup banner and
whether the microphone reaches the page. Those two answer most of it.
