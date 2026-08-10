# Talking to Greg

How a conversation flows, what to say, and how to change who he is.

[← Back to the README](../README.md)

---

## He doesn't have to be Greg

The dials below decide *how* he talks. A **persona** decides *who's talking* —
his name, what he thinks he is, and all six dials at once. Four come with him:

| Say | You get |
| --- | --- |
| "Hey Greg, put the butler on" | **Bramley** — formal, warm, never two words where one will do |
| "Be the flight computer" | **Ship** — terse, precise, no small talk |
| "Switch to Sam" | **Sam** — casual, funny, a bit sweary |
| "Go back to Greg" | the one you started with |

Each of them **sounds** different too, not just talks differently — a persona can
name a voice and a vocoder setting, so the ship's computer is terse *and*
electronic in one move.

**Writing your own is one small file** in `personas/`. Copy `greg.json`, change
the name, the `is` line and the numbers:

```json
{
  "name": "Ada",
  "description": "A lighthouse keeper who took up computing.",
  "is": "a lighthouse keeper who has ended up living in someone's computer",
  "traits": { "humour": 40, "edge": 10, "directness": 80, "warmth": 60, "brevity": 85, "formality": 40 },
  "style": "Mention the weather more than is strictly necessary.",
  "mirror": true,
  "voice": "en_GB-alan-medium",
  "vocoder": { "enabled": false, "amount": 0.5 }
}
```

`voice` and `vocoder` are optional — leave them out and he keeps whatever he is
using. Any `.onnx` model or `.wav` reference clip in `voices/` can be named, and
you can name it loosely: **"alan" finds `en_GB-alan-medium`.** If it matches more
than one, or isn't on your machine, he says so and keeps the voice he had rather
than quietly picking a different one.

A Piper voice swaps in about a second. A cloned voice takes roughly forty-five,
and he keeps talking in the old one until it's ready.

Drop it in the folder and he can become it by name — no code, no restart of
anything but him. It also appears in **Settings → Personality**, where there's a
**Character** dropdown; picking one there sets his name and all six dials at
once. The list is read from the folder each time you open the dialog.

**One rule worth knowing before you write one.** Anything you put in `style` has
to be *countable*, not atmospheric. "One short sentence" works. "Be more
mysterious" does nothing at all — the model can count sentences and cannot
calibrate a vibe. That single lesson cost this project six rounds of tuning.

His **voice doesn't change** with the persona — that's `localVoice` in
`config.json`, and he'll tell you so rather than pretend otherwise.


## His personality is yours to set

Greg has six dials rather than a fixed character. **Change them out loud**, or in
Settings, and they stick across restarts:

> "Hey Greg, turn your humour up to eighty."
> "Be blunter."
> "Turn your edge up to ninety."
> "From now on, call me boss."
> "What are your settings?"

| Dial | 0 | 100 |
| --- | --- | --- |
| **Humour** | never jokes | jokes constantly |
| **Edge** | clean, no profanity | foul-mouthed and irreverent |
| **Directness** | gentle, diplomatic | brutally frank |
| **Warmth** | clinical | openly affectionate |
| **Brevity** | expansive, four-plus sentences | one short sentence |
| **Formality** | slang and contractions | close to written prose |

Humour and Edge are independent: Humour is how *often* he's funny, Edge is how
close to the bone. Edge starts at 15 — clean — so it does nothing until you ask.

**Turning a dial down takes a turn or two.** He copies his own recent replies, so
after a stretch of foul-mouthed answers there are several in the history to
imitate. Press **⟲** for a clean start if you want it immediately.

Plus two extras:

**`style`** — free text for anything the dials don't cover. A catchphrase, how to
address you, something never to say. Set it by voice or in the file.

**`mirror`** — on by default. He matches your own register: terse question, terse
answer; casual question, casual answer. This is the part that makes him reflect
*you* rather than a preset.

Starting values live in `config.json`; anything you change by voice is saved to
`personality.json` and wins from then on. Delete that file to go back to your
config.

```jsonc
"personality": {
  "humour": 45,
  "directness": 60,
  "warmth": 55,
  "brevity": 70,
  "formality": 30,
  "mirror": true,
  "style": ""
}
```

The console shows where he's set at startup:

```
Manner:   humour 45, directness 60, warmth 55, brevity 70
```

**None of it touches accuracy.** The settings describe how he says things, never
whether they're true — the prompt says so explicitly, so no amount of humour
talks him into inventing a headline or skipping a tool call.


## How the conversation flows

Three things stop it feeling like operating a machine.

**He starts talking before he's finished writing.** The reply is split into sentences as it arrives, and each one is synthesized while the previous one is still playing. Measured on a two-sentence weather answer, the wait before he makes any sound dropped from **4526 ms to 2566 ms — 43%**. On a one-sentence answer it changes nothing, because there's nothing to overlap; the gain is real but it isn't universal.

**Follow-ups don't need the wake word.** For seven seconds after he answers the status reads *"Still listening…"* and anything you say goes straight to him:

> "Hey Greg, what's the weather?" … *"Rain this afternoon, seventy-eight degrees."* … "do I need a jacket?"

**Talking over him stops him.** He cuts off mid-sentence, stops generating the rest, and listens. No need to reach for the mouse — though clicking his face still works, and is the reliable option if barge-in isn't behaving.

```jsonc
"followUp": { "enabled": true, "seconds": 7 },
"bargeIn":  { "enabled": true, "sustainMs": 350 }
```

`sustainMs` is how long you have to keep talking before he yields — it stops a cough or a chair creak from stopping him. Raise it if he's too twitchy, lower it if he ignores you.

### Barge-in wants headphones

Greg listens for you with the same microphone that can hear his own voice coming out of your speakers. On headphones there's no problem at all. **On speakers he may hear himself, decide you're interrupting, and cut himself off the instant he starts talking** — every reply, unusable.

If that happens he notices and stands down: after three interruptions in the first moment of speech he switches barge-in off for the session and says so in the hint line under his face. To turn it off permanently, set `"bargeIn": { "enabled": false }`.

Barge-in also needs the **offline ears** (Whisper). With browser speech recognition the microphone is stopped while he talks, so there's nothing listening to interrupt him with — everything else on this page still works, just not this.

### Speech settings — `config.json`

```jsonc
"speech": {
  "mode": "auto",       // "auto" | "browser" (forces the cloud fallback)
  "model": "base.en",   // tiny.en / base.en / small.en / medium.en
  "device": "auto",     // "auto" | "cuda" | "cpu"
  "python": "py",
  "port": 4748
}
```

Bigger models are more accurate and slower. `base.en` handles voice commands well; try `small.en` if it mishears you often. On this machine CPU (`int8`) took 0.54 s versus 0.30 s on the GPU, so `"device": "cpu"` is a perfectly usable fallback.

### If he feels slow, it's probably the model unloading

Ollama drops a model out of memory after five minutes of silence, and the default
brain is 9.6 GB to read back off the disk. Measured here: **1.7 seconds** to his
first word when he's warm, **10.6 seconds** when he isn't. It feels random,
because it depends on how long since you last spoke to him rather than on
anything you did.

`ollama.keepAlive` is `"30m"` for that reason — he stays loaded between
conversations, at the cost of about 3.3 GB of graphics memory held. Set `"-1"` to
never unload, or a shorter time if you need the memory back sooner.

Speeding up his *voice* is not the answer here — synthesis is about a third of a
second on a normal sentence, a sixth of the wait.

### Choosing a model

Set `ollama.model` in `config.json`. Measured on an RTX 4090, across a **five-turn conversation** checking whether each answer was actually true:

| Model | Correct | Speed | Graphics memory in use | Notes |
| --- | --- | --- | --- | --- |
| **`gemma4:e4b`** | **5/5** | **2110 ms** | **5.2 GB** | The default. |
| `qwen3:4b` | 5/5 | 2127 ms | 7.6 GB | Same speed, 2.4 GB more memory. |

Warm runs at the shipped context size — "warm" matters, because timing a model
that has to load off the disk first measures your disk, not the model.

**Do not pick `qwen3:4b` to save memory.** It looks like the small one — 2.5 GB
against 9.6 GB — but those are *download* sizes. Loaded, qwen3 carries a much
larger context capacity and a fatter cache, and ends up **2.4 GB heavier** than
the model it appears to undercut. An earlier version of this table said it was
five times slower, too; that was measured before a change somewhere in Ollama
and is no longer true.

Both are already downloaded. To try a different one:

```
ollama pull llama3.1:8b
```

then set `"model": "llama3.1:8b"` in `config.json` and restart. **The model must support tool calling**, or Greg can't fetch weather and news — check with `ollama show <model>` and look for `tools` under Capabilities.

### The `think` setting — leave it alone unless you're testing

Some models have a private reasoning mode. This setting is counter-intuitive and worth understanding before you touch it:

- `"auto"` (default) — reasoning stays **on**, and Greg discards it.
- `"off"` — sounds like it should be faster. It is, and it's a trap.

With reasoning switched off, models tested here **stopped calling tools partway through a conversation and started inventing answers** — fabricated news headlines, and a confidently wrong date. `gemma4:e4b` scored 2/5 with it off versus 5/5 with it on. Some models also spill their raw reasoning into the reply, so you hear *"Okay, the user is asking about..."* read aloud.

A fast wrong answer is worse than a slow right one. Leave it on `"auto"`.

---


## Ask him where he got it

> "How do you know that?"

He'll tell you what he actually checked — *"I searched the web and read
starnewsonline.com"*, or *"I used my internal clock"*. The useful answer is the
other one: ask after something he knew off the top of his head and he says
**"I don't have a source for that; it was already in my knowledge base."**

That distinction is most of the point of this project. He keeps a record of the
tools each answer came from, so he can tell having-checked from not-having-checked
instead of guessing at it afterwards.

Two related habits, both automatic:

- **He dates old articles.** If a page he read was published a year ago he says
  so unprompted — *"that was published 18 July 2025, about a year ago, so there
  may be something newer."* Reading last year's version of a story and reporting
  it as current is wrong even when every word is faithful to the source.
- **He won't claim to have done something he didn't.** Setting a timer, playing
  music, changing channel, becoming a different character — if the action didn't
  happen, he says so rather than announcing it anyway.


## Things to say

| You say | Greg does |
| --- | --- |
| "Hey Greg, what's the weather?" | Current conditions and forecast |
| "Hey Greg, do I need a jacket?" | Checks the weather, then actually answers the question |
| "Hey Greg, what's the local news?" | Real headlines from your city, summarized in his own words |
| "Hey Greg, what time is it?" | Time and date |
| "Hey Greg, what's on my screen?" | Looks, and tells you |
| "Hey Greg, take a screenshot" | Saves a full-resolution PNG you can keep |
| "Hey Greg, who is the mayor of Wilmington?" | Searches the web rather than guessing |
| "Hey Greg, what's this song?" | Asks Windows what's playing — any app, no account needed |
| "Hey Greg, put the album art up" | Turns his screen over to the Now Playing channel |
| "Hey Greg, change the channel" / "back to the test card" | Turns over, with static in between |
| "Hey Greg, set a timer for 10 minutes for the pasta" | Chimes and speaks up when it's done |
| "Hey Greg, remind me at 3pm to call the dentist" | Same, at a clock time |
| "Hey Greg, remind me to take my medicine every day at 8am" | Every day, until you cancel it |
| "What?" / "Say that again" | Replays the exact audio he just said, rather than answering afresh |
| "How do you know that?" | Names what he actually checked — or admits he checked nothing |
| "Hey Greg, put engineering on" | GPU, memory and temperatures, and which models are loaded |
| "Hey Greg, how hot is the GPU?" | Answers without changing the channel |
| "Hey Greg, put the butler on" | Becomes a different character entirely |
| "Hey Greg, remind me to do my homework every weekday at 4:30" | Monday to Friday only |
| "Hey Greg, what timers do I have?" / "cancel the pasta one" | Lists or cancels them |
| "Hey Greg, remember that my dog is called Rex" | Remembers it **permanently**, across restarts |
| "Hey Greg, forget about my dog" | Deletes it again |
| "Hey Greg" *(then pause)* | Waits, listening, for your actual question |
| *(straight after he answers)* "and tomorrow?" | Follow-up — no wake word needed for seven seconds |
| *(while he's talking)* anything | Cuts him off and listens |
| Anything else | Real conversation — he remembers what you said earlier |

### Memory

Anything Greg remembers about you lives in **`memory.json`** in the Greg folder — plain text you can read, edit, or delete yourself. It survives restarts. The ⟲ button clears the current *conversation*, not this.

Timers and reminders live in **`reminders.json`** and also survive a restart: anything still in the future is re-armed when Greg starts, and anything that came due while he was switched off is announced when he's back, flagged as late.

**Repeating reminders** — "every day at 8am", "every weekday at 4:30" — keep going until you cancel them ("cancel the medicine one"). They stay at the same clock time through daylight saving, and they're never lost by Greg being switched off: he rolls them on to the next occurrence.

If he was off when one was due, he tells you **when it was due** — *"While you were away, at 8:00 AM: take your medicine."* If it's more than twelve hours stale he stays quiet rather than prompting you to take a dose you've probably already had.

> Greg is not a medical device. He's a voice saying a sentence at a time you chose, on a PC that might be switched off, asleep, or updating — so don't let him be the only thing standing between you and a dose that matters.

**Other controls**

- **Talk over him** to cut him off — or **click his face**, which also works while he's thinking
- **Click his face** while he's idle to talk without saying the wake word
- **Type in the box** if you'd rather not speak
- **⚙ button** opens Settings — his name and wake words, your location, the
  personality dials, and how he listens
- **🎙 button** mutes the microphone
- **📺 button**, or the **right-hand knob on the cabinet**, changes the channel
- **🔊 button**, or the **left-hand knob on the cabinet**, sets how loud he is —
  click the right of the knob for louder, the left for quieter, and the level
  comes up on the screen for a second. There's a slider in Settings too
- **⟲ button** starts a fresh conversation (he forgets what you were discussing)

---

