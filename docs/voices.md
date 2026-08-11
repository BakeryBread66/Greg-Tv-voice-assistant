# Giving Greg a different voice

Greg can speak in a voice cloned from a real person, from about ten seconds of
recording. He can also use any of Piper's downloadable voices. This is how.

[← Back to the README](../README.md)

---

## The two kinds

Everything lives in `voices/`, and **the folder is the registry** — there is no
list to edit and nothing to register. Which kind a file is comes from its
extension:

| File | What it is |
| --- | --- |
| `voices/*.wav` | a **clone reference** — a recording of somebody, cloned on the fly |
| `voices/*.onnx` + `*.onnx.json` | a **Piper model** — a pre-trained voice |

A `.onnx` without its matching `.onnx.json` is **skipped**, deliberately: a
half-finished download offered as a voice fails confusingly at load time instead
of clearly at startup.

## Cloning somebody's voice

### 1. Install the clone environment, once

```powershell
.\setup-greg.ps1 -Clone
```

It is **off by default even under `-All`**. It is about 6 GB, and it needs
**Python 3.12 specifically** — the clone pins `torch==2.6.0`, which has no
wheels for newer Pythons. Run `.\setup-greg.ps1 -DryRun -Clone` first to see the
plan without changing anything.

There is a trap in that install worth knowing about even though the script
handles it: installing `chatterbox-tts` plainly resolves `torch==2.6.0` from
PyPI, and **the Windows PyPI wheel is CPU-only** — it silently replaces a working
CUDA torch and the clone then runs on the processor. Torch must come from the
CUDA index first; `2.6.0+cu126` satisfies the pin, so chatterbox installs on top
without touching it.

### 2. Record about ten seconds

Save it as `voices/whoever.wav`. That is the entire installation step.

**How long the clip may be:**

| | |
| --- | --- |
| **Aim for** | **10–30 seconds** of clear, continuous speech |
| Refused above | 2 minutes, or 100 MB |
| Refused below | 3 seconds |

Ten seconds is as good as thirty — measured — so there is nothing to gain by
going longer, and a great deal to lose. **Cloning re-reads the whole reference
every single time Greg speaks**, including the warm-up before he is ready, so
length is not a one-off cost. Half an hour of 48 kHz stereo is about 700 MB once
decoded, on top of a 4 GB model: the process is killed outright and the only
clue is `exited (null)`.

That is a real report, not a hypothetical. The limits above exist so the clip is
refused with a sentence naming the length and the fix, before anything is
loaded. The 2-minute line is deliberately four times the useful maximum — it is
a net for a file nobody trimmed, not a rule about style.

Mono is preferred and any sample rate is fine; the model resamples anyway.

### 3. Point Greg at it

There is deliberately **no voice command for this** — a swap takes about 45
seconds, which is not something to trigger by accident mid-sentence. Two ways:

**Permanently**, in `config.json`, then restart:

```jsonc
"clonedVoice": {
  "enabled": true,
  "reference": "voices/whoever.wav",
  "exaggeration": 0.5,
  "cfgWeight": 0.5,
  "temperature": 0.8,
  "device": "cuda",
  "port": 4750
}
```

**Per character**, in a file in `personas/`, which then switches at runtime when
you ask for that character by name:

```jsonc
{ "name": "Dad", "identity": "...", "voice": "whoever" }
```

That is how the shipped personas work — the butler is `en_GB-alan-medium`, the
flight computer is `en_US-hfc_male-medium`.

## How names are matched

Loosely, because nobody says "en underscore GB dash alan dash medium" out loud.
A trailing `-reference` is stripped, so `dad-reference.wav` answers to "dad".

**Ambiguity is refused rather than guessed.** On a stock install:

```
resolveVoice("greg")   -> clone:greg-reference
resolveVoice("alan")   -> piper:en_GB-alan-medium
resolveVoice("medium") -> null     ← matches six voices
```

Picking one of six would be guessing which person you meant to sound like.

**A voice this machine does not have is said, never substituted.** A persona
file may have come from somebody else's repository naming a clip that only
exists on their disk. Answering in a different voice with no error anywhere is a
small version of the failure this whole project is arranged against.

## Recording the clip — measured, and mostly counter-intuitive

- **Ten seconds is as good as thirty.** Length past ~10 s buys nothing. A short
  clean clip beats a long ragged one.
- **A codec is not disqualifying.** A Discord call rolls off at 16 kHz, which
  looks alarming — but only **0.014%** of the signal's energy sits above 12 kHz,
  and cloning models resample the reference to about that ceiling anyway.
  Somebody was once steered into re-recording locally on this basis, wrongly.
- **Noise suppression is the real problem.** Krisp and friends leave frames of
  *true digital silence* (−240 dBFS). Trim to a continuously-voiced stretch and
  it disappears entirely.
- **The reference's delivery becomes Greg's delivery.** Zero-shot cloning copies
  speaking style, not just timbre. Tell whoever records it what register you
  want — it is a far better prosody control than any dial below.

## The dials, and where not to go

`exaggeration` is the only one worth touching, and both ends surprise:

| | |
| --- | --- |
| **0.3** | the flattest, most level delivery |
| **0.2** | **not flatter** — it goes back up *and* draggy, with 490–510 ms gaps mid-sentence |
| **0.5** | shipped default |
| **0.7** | the "expressive" end, and it produces **no phrasing pauses at all** — it buys pitch movement by spending the phrasing, which is the thing that makes a voice sound like a machine |

Ship 0.5, reach for 0.3 if you want it drier, never go outside that range.

`noise_scale` and `noise_w` on the **Piper** side are a dead end — swept across
their whole range, pitch variation moved from 13.99 to 15.63 semitones, which is
noise. They are a speed-and-jitter dial, not an expressiveness one.

## Adding a Piper voice

Drop the `.onnx` **and** its `.onnx.json` into `voices/`, then set
`localVoice.voice` in `config.json` to the model name without the extension.

Greg downloads whichever voice `localVoice.voice` names on first run if it is
missing, so the usual way to get a new one is to name it and restart.

**Nothing ships in `voices/` — the folder is gitignored**, because it is where a
real person's voice recording would sit. A fresh clone starts empty and pulls
down the default (`en_US-ryan-high`) the first time Greg runs. That download is
60–140 MB and prints nothing until it finishes, which is most of why a first
start sits still for several minutes.

Piper is much faster than the clone — about 9x realtime for a `-high` voice and
40x for a `-medium` — and it runs on the **CPU** on purpose, so it never competes
with Whisper or the vision model for the graphics card.

## What happens when a voice changes

- **Piper reloads in about a second** and is awaited, so by the time he answers
  he really does sound different.
- **The clone takes about 45 seconds and is deliberately NOT awaited.** He keeps
  talking in the voice he has while the new one loads. Saying "done" would be
  claiming something that has not happened.
- **Gaming mode blocks the clone.** Loading it would take back the ~4 GB that
  gaming mode exists to free, so the choice is saved and he says plainly that
  nothing has changed yet.
- A failed Piper swap **puts the old voice name back in config** before
  restarting, because the speech cache is keyed on it — disagreeing with reality
  there serves the wrong audio from disk with no error anywhere.

## Speed, and the cache

The clone runs at roughly 1.3x realtime, so it costs about two seconds before
Greg starts speaking, and proportionally worse on short replies where the fixed
overhead dominates — "Timer set." took 1359 ms to make 0.84 s of audio.

`lib/tts-cache.js` makes repeats nearly free: **2407 ms cold against 203 ms
cached**, same bytes. The key is a hash of the text *after* cleaning, plus a
voice id that includes **every dial**:

```
clone:<reference>:<exaggeration>:<cfgWeight>:<temperature>
```

Leaving one out would keep serving the old voice from disk after you changed it
— silently, with no error, which is the worst way for it to be wrong.

## If it does not work

**Greg falls back rather than going silent.** The chain is clone → Piper →
Windows' own voice → the cloud → the browser's own. Each step down is automatic
and the console says which one he landed on, so **read the banner first**: it
reports what actually loaded rather than what was configured.

| Symptom | Likely cause |
| --- | --- |
| Console says the clone is "disabled in config" | the key is `clonedVoice`, **not** `clone` — a whole day was lost to that once |
| Clone never loads, no error | no Python 3.12; check `.venv-clone\Scripts\python.exe` exists |
| It runs but is very slow | CPU-only torch — reinstall from the CUDA index |
| A new `.onnx` is ignored | its `.onnx.json` is missing |
| "that clip is N minutes long" | the reference is untrimmed — see the table above |
| `exited (null)` on an older build | the same thing, before it was checked for. Trim the clip |
| Voice changed in config but he sounds the same | the cache is keyed on the dials; if only the *reference file contents* changed, the key did not |
| Nothing happens on a persona switch | gaming mode is on — it refuses to load the clone |

**Stop before you start.** Both sidecars take their voice from config at spawn,
so a swap is a stop and a restart. This project has already stranded 4.2 GB of
video memory by starting a second clone sidecar without stopping the first.
