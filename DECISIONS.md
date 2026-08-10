# Decisions

Settings in this project that look like obvious improvements and are not, with
the measurement that settled each one.

This is a short file on purpose. It is not a style guide and not an
architecture overview — the README covers what Greg does, and the code is
commented. What is here is the handful of things a reasonable person would
change, benchmark, find an improvement in, and thereby break something that
does not announce itself.

You will find comments in the source that say "see CLAUDE.md". That is a
private engineering log kept during development; it does not ship. Everything
in it that constrains the code is repeated here.

Figures were measured on a 24 GB NVIDIA card. Treat them as relative rather
than absolute — the ratios are the point, not the milliseconds.

---

## 1. `ollama.think` must stay `"auto"`

This is the sharp one, because turning thinking off is genuinely faster and the
damage is invisible in casual testing.

With thinking off, models stopped calling tools partway through a conversation
and started fabricating instead — invented news headlines, a confidently wrong
date. Measured over a five-turn conversation, graded against ground truth
rather than on latency:

| | correct |
| --- | --- |
| thinking off | **2 / 5** |
| thinking on | **5 / 5** |

Single-turn benchmarks hide this completely. The first answer is fine; the
model drops its tools somewhere around turn three and starts answering from
nothing, fluently.

**A fast wrong answer is worse than a slow right one.** If you want to revisit
this, benchmark a multi-turn conversation and check each claim against
something you can verify independently — the actual clock, the actual feed.

## 2. Tool results are stripped from conversation history

`forHistory()` in `lib/brain.js` removes raw tool JSON before the exchange goes
into history. This looks like context being needlessly thrown away.

Carrying it forward made every later turn slower — **7.1 s against 2.1 s** —
because small models over-deliberate on the clutter. The spoken answer retains
the facts, so follow-ups like "do I need a jacket?" still work.

Note this is about clutter, not about running out of room. Raising the context
window does not make restoring it a good idea.

## 3. Download size is not resident size

The obvious way to save video memory is to swap the chat model for a smaller
one. The numbers that matter are not the ones on the model page.

| | on disk | resident | latency |
| --- | --- | --- | --- |
| `gemma4:e4b` | 9.6 GB | **5.2 GB** | 2110 ms |
| `qwen3:4b` | 2.5 GB | **7.6 GB** | 2127 ms |

The smaller download costs **2.4 GB more** video memory, because it carries a
much larger context capacity and a fatter KV cache, and it is not faster.

Two related traps in the same area:

- **Measure warm, never cold.** An unload-then-time benchmark measures your
  disk, not the model. Cold, the same comparison reads 9149 ms against 5086 and
  points the opposite way.
- **The context window is nearly free.** 8192 costs 4861 MiB and 32768 costs
  5206 MiB — 345 MiB for four times the room, with identical latency. Fixed
  overhead per turn is around 4,500 tokens before a word of conversation, so
  8192 leaves very little, and an overflow truncates the system prompt, which
  is where the rules about not fabricating live.

## 4. The local voice is not a speed win

The case for running speech synthesis locally is privacy, offline operation and
no rate limit. It is **not** latency, and the README does not claim it is.

Measured on the same sentence: the local `-high` voice ~850 ms, the cloud voice
661/721/907 ms. Roughly a wash.

**Time the same text through both.** It is easy to compare a long sentence
through one against a short sentence through the other and conclude something
that is not a measurement at all.

## 5. `ollama.keepAlive` is why he is not randomly slow

Set to `"30m"`. Ollama's default unloads the model after five minutes of
silence, and reloading a 9.6 GB model costs the user the whole wait:

| | time to first sentence |
| --- | --- |
| model warm, no tool | 409 ms |
| model warm, one tool | 1.6–1.9 s |
| **model cold** | **10.6 s** |

It presents as Greg being randomly slow, because it depends on how long since
you last spoke to him rather than on anything you did. It costs a few GB of
video memory held between conversations. `"-1"` never unloads.

---

## A known defect: the sentence gap overwrites Piper's own phrasing

This one is unfixed, and it is written down because the fix is known and the
obvious alternative fix is a dead end.

**What reads as robotic in a synthetic voice is phrasing, not timbre.** Counting
pauses over the same three-sentence passage:

| | pauses taken |
| --- | --- |
| `en_US-ryan-high`, one call | **1** |
| a cloned voice, one call | 5, varied |
| a human recording of the same words | **12**, from 70 to 460 ms |

That single number predicted the listening result better than anything else
measured. Piper runs the text through in a breath.

**And the streaming code makes it worse.** Replies are split into sentences so
synthesis of sentence two can overlap playback of sentence one — a real win,
measured 4526 ms to 2566 ms before he makes a sound. But synthesising per
sentence and inserting the fixed `SENTENCE_GAP_MS` produces a pause structure of
`[110, 110]`: identical every time. One Piper call over the same text produces
`[70, 200]`, because it picks a short break at a comma and a long one at a
sentence end. **We overwrite its judgement with a constant.**

The streaming win is *entirely* time-to-first-sound, so both can be kept:
**synthesise sentence one alone, then sentences 2..N as a single call.** Not yet
implemented.

**Do not reach for Piper's noise dials instead** — `noiseScale` and `noiseWScale`
in config, `GREG_PIPER_NOISE_SCALE` and `GREG_PIPER_NOISE_W_SCALE` through to the
sidecar. They are the obvious cheap fix and they do nothing for this. Swept
0.5–0.9 and 0.6–1.2 respectively, pitch range moved from 13.99 to 15.63
semitones across the entire sweep, which is noise. They are a speed-and-jitter
dial, not an expressiveness dial.

For the cloned voice the equivalent dial is `exaggeration`, and it is
counter-intuitive in both directions: 0.3 gives the flattest, most level
delivery — **lower is not flatter**, 0.2 goes draggy with half-second gaps
mid-sentence — while 0.7, the "expressive" end, produces *no phrasing pauses at
all*. It buys pitch movement by spending the phrasing, which is precisely the
thing that makes it sound like a machine. Ship 0.5, reach for 0.3 if you want it
drier, and do not go outside that range.

---

## The honesty rule

Greg's system prompt contains a sentence enumerating the things that are
**actions rather than answers** — setting a timer, cancelling one, saving a
fact, changing the channel, and so on. Without a tool having actually been
called, he may not claim any of them happened.

This exists because he once said *"I have canceled the pasta timer"* having
called no tool at all. The timer was still armed.

**Any new tool that changes something in the world must be named in that
sentence.** This is not a style preference. It has caught the same class of bug
four separate times — a personality change that was never saved, music that
never played, a setting that was reported as applied and was not.

`npm test` enforces it. The suite walks the tool registry, picks out the tools
whose names say they write state, and fails unless each is covered by the rule.
**Default-deny**: a new state-changing tool has no entry, so it fails until
somebody puts it in the sentence.

Write the sentence **before** the handler. Three separate occasions here did it
the other way round and shipped the bug first.

A tool result carrying an `error` field means the action did not happen, and
the prompt says so explicitly. Word tool errors so the failure comes first and
any consolation second — a hedged error gets *more* hedged by the time it
reaches the user, never less. "I can't do X, but I can still do Y" was read as
guidance and reported as success; a flat statement of failure was reported as
failure.

---

## Reach for a code gate before a fourth prompt rewrite

The most repeated lesson in this project, arrived at independently about eight
times: when a small model gets something wrong, rewriting the prompt scores
about one in three, and moving the decision into code scores five in five.

Cases where this happened, all of them after prompt tuning had been tried and
had oscillated:

| Problem | Prompt attempts | Code gate |
| --- | --- | --- |
| "here" meaning a place on the map | 4 rewrites, still inconsistent | a regex for pointing words — deterministic |
| Greeting someone who has been away | 2 rewrites, ignored both times | prepend it in code — 3/3 |
| Saying how old an article is | reached the model every time, stated 2/6 | append it in code — 6/6 |
| Claiming a reminder was set | named in the honesty rule, still failed 1 in 3 | check the request, correct in code |
| Empty weather-alert list read as "no alerts" | a note in the tool result, failed 1 in 3 | remove the ambiguity — 5/5 |

The pattern is always the same: **a personality or brevity instruction beats a
prompt instruction**, and a model handed an empty list fills the silence.

Two corollaries worth knowing:

- **Give the model something countable, not something atmospheric.** "As few
  words as will do" produced four sentences; "ONE short sentence" produced one.
  Same lesson for anything you want reliably applied.
- **A code gate with no test is a prompt instruction with extra steps.** Every
  gate here is a pure function that can be proven in milliseconds. Add the test
  with the gate.

---

## Two habits the test suite depends on

**A test that does real work is not thorough, it is slow.** Twice, a test suite
here went from half a second to a minute because a code path genuinely
restarted a speech sidecar or began loading a multi-gigabyte model. Inject the
thing that acts and assert the *decision*. `initSettings` takes a `switcher`
and a `voices` folder for exactly this reason; `loadConfig` takes its paths.

Related: anything that reads the user's own folders must take a path. A module
that can only ever read or write one hard-coded location is untestable by
construction, and testing it means writing to somebody's real settings.

**Check for absence before converting.** `Number(null)` and `Number("")` are
both `0`, and `0` is a perfectly valid latitude, volume or air quality index.
This produced, in separate places: a location pin accepted as Null Island in
the Atlantic, everyone on automatic location being given the sunrise time for
0°N 0°E, and a missing air quality reading rendered as "Good".

It occurred six times across five modules in a single week, so it does not
transfer by being remembered. What caught every one was a test that passes
`null` and `""` explicitly. **Put both in the bad-input list of anything that
reads a setting, a field or a feed.**

---

## And one about measurement itself

When a number disagrees with you, check the instrument first. A pixel diff
reporting 40% of pixels changed turned out to be measuring animated noise; a
scorer reporting 0/3 was looking for `2025` in transcripts where a voice
assistant had correctly written "two thousand twenty-five".

But do not turn that into an excuse. The same habit of looking harder at
something that seems wrong is what found most of the real bugs listed above.
