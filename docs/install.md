# Installing Greg, in detail

Other ways to install him, what your hardware needs, and the installer's inner workings.
The README has the short version: download `Greg-Setup.exe` and run it.

[← Back to the README](../README.md)

---

## Greg-Setup.exe

It puts Greg in `%LOCALAPPDATA%\Programs\Greg` with his own copy of Node.js, adds
him to the Start menu (and the desktop, if you like) and to Settings → Apps, and
needs no administrator rights. It downloads nothing. The first time Greg opens,
his setup screen takes over (below).

Running a newer `Greg-Setup.exe` updates him in place. Neither an update nor
uninstalling from Settings → Apps touches your settings, memory, reminders,
conversation log, voices or downloaded engines. The uninstaller deletes those
only if you tick the box that names them.

It is not code-signed, so the first time you run it, Windows SmartScreen says
*Windows protected your PC*: choose **More info → Run anyway**. To build it
yourself, which is also how to be sure what is in it, run this in a clone:

```
powershell -NoProfile -ExecutionPolicy Bypass -File installer\build.ps1
```

It writes `dist\Greg-Setup.exe` and its SHA-256, from Greg's committed files,
`npm ci` and Node's official zip, checked against nodejs.org's published hash.
`installer\check.ps1` then installs, updates and uninstalls it in a scratch
folder and says what it verified.

## The setup screen

On a first run that is missing something, Greg opens a **Setting Greg up**
screen in his own window. It says what your PC has (graphics card, Ollama) and
lists what he still needs with the size of each: his brain (through Ollama),
his hearing (whisper.cpp, the GPU or CPU build to suit your card), and his
voice. Press **Install** and watch the progress bars; when it finishes he is
using them, no restart. Every file is checked against its publisher's SHA-256
before it is used, and **none of it needs Python**. Settings → General →
*Check what's installed…* opens the same screen any time.

It installs Ollama with winget if it isn't there. The one thing it cannot do is
the cloned voice, which still needs Python — see below.

## From a clone

With Node.js 20 or newer installed, double-click **`start-greg.bat`**. The first
run installs his npm dependencies, then the setup screen above takes over.

## setup-greg.bat, the detailed way

Double-click **`setup-greg.bat`**. It looks at what your machine already has,
asks which pieces you want with the download size next to each, installs them,
and then tells you honestly what worked.

Want to see what it would do without it doing anything? Open a terminal here and
run:

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File setup-greg.ps1 -DryRun
```

**None of it is required.** Greg is built to degrade rather than fail: with
nothing but Node.js he still runs, still holds a conversation, still shows you
the weather — he just borrows a cloud voice and the browser's own speech
recognition to do it, and his startup screen says so in amber rather than
pretending. Everything below is about taking pieces off other people's servers
and putting them on your machine.

| What | You get | Download |
|---|---|---|
| **Node.js 20+** | Greg runs at all. The only thing that isn't optional. | 30 MB |
| **Ollama + `gemma4:e4b`** | A real brain, on your own machine. | 9.6 GB |
| **Python 3 + `faster-whisper`** | He hears you offline. | 200 MB |
| **`piper-tts`** | He speaks offline. Voices download themselves on first use. | 100 MB |
| **`qwen2.5vl:7b`** | He can look at your screen. | 5.9 GB |
| **CUDA runtime packages** | The ears run on your NVIDIA card instead of the CPU. Offered only if you have one. | 1 GB |

The setup script drives [winget](https://learn.microsoft.com/windows/package-manager/),
which ships with Windows 11 and recent Windows 10. Without it the script still
runs and still tells you what's missing — it just prints the download links
instead of fetching anything.

**No Greg shortcut?** Greg.exe is built on your machine rather than downloaded,
so an install from before it existed does not have one yet. Double-click
`setup-greg.bat` again — it skips anything already installed and builds
Greg.exe at the end, with the compiler that is part of Windows. From a terminal
in the Greg folder, `setup-greg.bat -Launcher` does only that part, with no
questions and no downloads.

## By hand

If the script fails on a step, or you'd rather do it yourself:

```bash
winget install --id OpenJS.NodeJS.LTS --exact
winget install --id Ollama.Ollama --exact
winget install --id Python.Python.3.12 --exact
```

Then, in a **new** terminal — freshly installed programs aren't on the old one's
PATH:

```bash
ollama pull gemma4:e4b
py -3 -m pip install faster-whisper piper-tts
```

And if you have an NVIDIA card and want the ears on it:

```bash
py -3 -m pip install nvidia-cublas-cu12 nvidia-cudnn-cu12 nvidia-cuda-runtime-cu12
```

## The cloned voice is the one thing setup can't finish

Greg can speak in a cloned voice, and the setup script will install the machinery
for it with `-Clone`. It cannot finish the job, and it says so rather than
appearing to succeed: cloning needs about ten seconds of a real person's
recording saved as `voices/greg-reference.wav`, and nothing ships one — that
would mean publishing somebody's voice. Record your own, or leave it off and keep
Piper. [Giving him a different voice](voices.md) has the rest.

It also needs **Python 3.12 exactly**, because `torch==2.6.0` has no wheels for
anything newer, and the `py` launcher often can't see a 3.12 even when one is
installed. Both are checked before anything is downloaded.

## Linux and macOS

**Linux boots too**, with five Windows-only features off — screen vision, cursor
tracking, now playing, media keys and the system voice. The brain, the ears, the
voice, all fourteen channels and every tool but two work unchanged, and he names
what is missing in the startup banner rather than letting you find out when
something quietly does nothing. Run `./setup-greg.sh` then `./start-greg.sh`.
**Nobody has run him on a Linux desktop yet** — see [linux.md](linux.md),
including what each missing piece would take.

macOS is in the same position and even less tested.

## Hardware in detail

**Chrome or Edge.** Firefox works for most things but has no speech recognition
of its own, so you would need the offline ears.

**An NVIDIA card is optional.** Hearing works on the CPU and is perfectly
usable. A card mainly buys you fast screen vision and the cloned voice.

Measured, resident, on a 24 GB card:

| | |
| --- | ---: |
| Brain (`gemma4:e4b`) | 3.4 GB |
| Ears (Whisper) | ~1 GB, or none on the CPU |
| Eyes (`qwen2.5vl:7b`) | 5.9 GB |
| Cloned voice | **2.8 GB** |

**Those are Ollama's figures, and your card loses more than that.** Ollama's
`size_vram` counts weights and the KV cache; the driver also sees the CUDA
context and compute buffers, and the gap is not small — `gemma4:e4b` reports
3418 MB and costs **5141 MiB** of the card. If you are budgeting a machine
rather than reading a comparison, use the driver-level table in
[mini.md](mini.md).

So **~6 GB** runs the brain and ears comfortably, **~12 GB** adds the eyes, and
**~16 GB** holds all four at once.

**On 8 GB, run [Mini Greg](mini.md).** It is the same Greg with the eyes off
and the cloned voice in half precision — which is measured at 2826 MiB against
the 3801 it used to take, for no audible difference and no speed cost. The voice
stays; it is the point.

```
setup-greg.ps1 -SmallCard
```

Screenshots still work without the eyes, because saving a picture needs no model
— only interpreting one does.

Running the clone itself on the CPU (`clonedVoice.device`) works and is too slow
to talk to — measured at **3.7x realtime**, about twelve seconds before he starts
a one-sentence reply. An NPU does not help either: it has no memory of its own to
lend, and none of the four engines can target one.
