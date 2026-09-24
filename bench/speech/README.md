# The speech benchmark

What decided that Greg's hearing and voice could leave Python: the same audio
through each engine, scored the same way. Run it again before changing either.

## Hearing — `ears-bench.mjs`

768 clips of 48 real requests from Greg's conversation log, in eight voices (six
Piper, two Windows), clean and with room noise added, plus 10 clips of room noise
alone. Scored on word error rate, whole-sentence exact match, and whether
anything was invented from the noise-only clips — with one normaliser for every
engine, so "8am" and "8 a.m." are the same answer.

```
py -3 make_corpus.py                                        # six Piper voices
powershell -NoProfile -ExecutionPolicy Bypass -File make_sapi.ps1   # two Windows voices
node add_noise.mjs                                          # noisy copies + noise-only clips
node ears-bench.mjs greg                                    # Greg's own lib/stt.js
```

Measured on 2026-09-24, RTX 4090, `base.en`:

| | Word errors, clean | noisy | Exact, clean / noisy | Invented from noise | Per clip |
| --- | ---: | ---: | --- | --- | ---: |
| faster-whisper (Python), GPU | 3.62% | 4.65% | 87.2% / 84.4% | none | 55 ms |
| **whisper.cpp, GPU** | 3.81% | **4.18%** | 86.5% / **85.2%** | none | **29 ms** |
| faster-whisper (Python), CPU | 4.04% | 4.83% | 86.2% / 84.1% | none | 436 ms |
| **whisper.cpp, CPU** | 3.81% | **4.18%** | 86.5% / **85.2%** | none | **348 ms** |

**The VAD settings are the whole result.** With whisper.cpp's own defaults it
scored 4.41% / 5.72% and clipped the first word off about one clip in ten —
"play some Steely Dan" came back "some steely Dan". Its speech padding is 30 ms;
faster-whisper's is 400. Given faster-whisper's exact VAD settings
(`whisperArgs` in `lib/engines.js`), the gap closed.

## Voice — `voice-bench.mjs`

24 typical Greg sentences, timed, then transcribed by one fixed judge (the Python
Whisper on the GPU) to score how clearly each came out.

```
set GREG_WHISPER_PORT=4758 && py -3 ..\..\whisper_server.py     # the judge
node voice-bench.mjs greg                                       # Greg's own lib/tts-piper.js
```

Measured the same day, `en_US-ryan-high`:

| | Per sentence (median / slow 10%) | Judged word difference |
| --- | --- | ---: |
| piper-tts (Python) | 298 / 461 ms | ~12.0% (4 runs) |
| **sherpa-onnx, 16 threads** | **276 / 449 ms** | ~11.3% (5 runs) |
| piper.exe, 2023 standalone | 529 / 739 ms | 11.7% |

**Rejected: piper.exe.** The 2023 Windows build's inference is about 40% slower
(815 ms against 474 ms for the same sentence, its own timing log), and swapping in
a newer ONNX Runtime did not change it. **Thread count matters for sherpa-onnx**:
8 threads was slower than the Python voice, 12 and 16 matched or beat it —
`voiceThreads()` uses half the logical cores, capped at 16.

The judged score moves by a point or so between runs of the same engine, because
Piper samples a little noise on purpose. Compare averages, not single runs. And
the speed is best compared interleaved, sentence by sentence, so a busy moment on
the PC lands on both engines rather than one.
