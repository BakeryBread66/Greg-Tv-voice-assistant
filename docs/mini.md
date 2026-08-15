# Mini Greg — running him on a smaller graphics card

Greg's full configuration wants a lot of video memory. Mini Greg is the same
Greg with the two most expensive things dealt with: **the eyes are off, and the
cloned voice runs in half precision.** The voice stays — it is the point.

```
copy config.mini.example.json config.json
```

Or `setup-greg.ps1 -SmallCard`, which does that and skips the vision model
download. If you already have a `config.json` you want to keep, change the
settings listed under [What it actually changes](#what-it-actually-changes)
instead — copying over it would discard your location, wake words and dials.

## What it costs, measured

Every figure below is the **driver-level** cost — what `nvidia-smi` loses when
the thing loads, which is what has to fit on your card. It is not what Ollama
reports. Ollama's `size_vram` counts weights and the KV cache; the driver also
sees the CUDA context and compute buffers, and the gap is not small:

| `gemma4:e4b` at 32768 | Ollama says | driver says |
| --- | ---: | ---: |
| | 3418 MB | **5141 MiB** |

**Budget with the cloned voice, which is 2826 MiB in fp16:**

| | brain | + voice | fits |
| --- | ---: | ---: | --- |
| `gemma4:e4b` @ 32768 | 5141 | **7967 MiB** | 10–12 GB |
| `gemma4:e4b` @ 8192 | 4861 | 7687 MiB | 10–12 GB |

Add whatever your desktop is already using — on this machine that is about
2.9 GB with a browser open, and it comes off the same card.

## The eyes

Off, and on 8 GB that is barely a choice. `qwen2.5vl:7b` wants 5.9 GB, and with
the voice holding 2.8 there is 5.2 left. It does not fit — and Ollama's response
to that is not a clean error, it offloads layers to system RAM, so a screen
question does not fail, it takes a minute and feels broken.

**You keep more than you might think.** `take_screenshot` needs no model at all,
so saving a picture of your desktop still works exactly as before. Only
*interpreting* one goes. Asked what is on screen, Greg says plainly that he
cannot see it and asks you to describe it — he does not guess, and he does not
offer to turn the eyes on, because under this profile that needs a restart.

To get them back, set `vision.enabled` to `true` and restart. The eyesight test
runs then, and it will tell you the truth either way: a model that cannot
actually see loses the tool rather than being trusted with it.

## The voice

Unchanged in character, half the memory. `clonedVoice.precision` is `auto`,
which means fp16 on the GPU: **3801 MiB down to 2826**, no speed cost, output
level within 0.1 dB.

Only the t3 backbone is cast. Casting the vocoder too saves another 400 MiB and
sounds rushed and barely coherent — every metric passed it and only listening
caught it, so it is not offered as a dial. Set `precision` to `fp32` if you ever
want the original back.

## The open question: an 8 GB card

**There is no proven brain for 8 GB yet, and the profile does not pretend
otherwise.** `gemma4:e4b` plus the voice is ~7.8 GB before your desktop, so it
does not fit. A smaller model has to come from somewhere, and the obvious way of
choosing one is wrong twice over.

**Download size tells you nothing.** This project has now measured three models
whose resident cost bears no relation to their size on disk:

| model | on disk | resident @ 32768 |
| --- | ---: | ---: |
| `gemma4:e4b` | 9.6 GB | **5141 MiB** |
| `qwen3:4b` | 2.5 GB | 7596 MiB |
| `llama3.2:3b` | 2.0 GB | **6080 MiB** |

A 3B model costing more than an 8B one is not a mistake in the table. It is the
KV cache, and it is why the second trap follows from the first.

**How much the context window costs depends on the model.** On `gemma4:e4b` the
entire range 8192→32768 is worth ~280 MiB, which is where this project's
"raising it is nearly free" note comes from. That note does not travel:

| | 8192 | 16384 | 32768 |
| --- | ---: | ---: | ---: |
| `gemma4:e4b` | 4861 | 4922 | 5141 |
| `llama3.2:3b` | **3325** | 4281 | 6080 |

So `llama3.2:3b` is only cheaper than `gemma4:e4b` if you also cut its context,
and there is a floor on how far that can go: **the tool schemas are ~3,587
tokens and the system prompt ~1,562, so about 5,150 is spent before a word of
conversation.** At 8192 that leaves ~3,000 for history and the reply, and an
overflow truncates the prompt — which is where the honesty rules live.

### If you want to settle it

Measuring the memory is the easy half and is not the half that matters.

```bash
node bench/routing.mjs
```

That checks the model still picks the right tool out of 28, and runs a control
against competing padding so a perfect score means something rather than proving
the harness cannot register a miss. It reads `ollama.model` from `config.json`,
so point that at the candidate first.

**And routing is still not the whole test.** A model can route perfectly and
fabricate more. The failure this project cares about is not a model that cannot
do something — it is one that cannot, and sounds certain: invented headlines, a
confidently wrong date, a screen it never saw. Check answers against ground
truth over several turns before trusting a new brain. Does the time it states
match the clock? Do the headlines match the feed? Was the timer actually set?

## What it actually changes

Everything else is identical to `config.example.json`.

| setting | full | mini | why |
| --- | --- | --- | --- |
| `vision.enabled` | `true` | `false` | 5.9 GB it cannot fit beside the voice |
| `vision.openAtStartup` | `true` | `false` | belt and braces; no model load at boot |
| `clonedVoice.precision` | `auto` | `auto` | already fp16 on a GPU — listed because it is half the saving |
| `speech.device` | `auto` | `cpu` | frees the CUDA context Whisper holds; `base.en` is quick on a processor |
| `ollama.model` | `gemma4:e4b` | `gemma4:e4b` | unchanged, deliberately — see above |
