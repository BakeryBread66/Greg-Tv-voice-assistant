# His face and his channels

The television itself, the fourteen channels, and the Global Dashboard.

[← Back to the README](../README.md)

---

## The Global Dashboard

Click the **🌐** button and a second Win98 window opens: a spinning Earth with
every country outlined. Click a country and Greg looks up the weather and the
headlines there and fills in the side panel, while **the main window says the
local time and the weather** — his face reacts while you carry on spinning the
globe.

**He doesn't read the headlines out.** They're in the panel to read if you want
them, but a click on the map is usually just a look, and having two news stories
recited at you every time gets old fast. Ask and he'll read them:

> "Hey Greg, what's the news there?"

It's a second window rather than a mode on purpose. You keep his face in view,
and only one of the two windows ever has a voice: two of them talking over each
other would be a mess, so the globe posts what it found and Greg says it.

**The globe itself works offline.** The library, the blue-marble texture, the
topography and the 176 country outlines are all served out of `node_modules` —
the CDN links you'll see in globe.gl examples are just unpkg serving those same
files. Only the weather and news need a connection, and they fail the same
graceful way they do everywhere else.

Clicking sends the *exact* spot you clicked, not the middle of the country, so
western and eastern Russia give you different weather.

### What's on it

**Search and fly-to.** Type a place name and pick from the matches — it flies
there and looks it up. There's a **⌂** button for home, a marker where you
actually live, and a list of everywhere you've been this session.

**The day/night line.** No API — it's solar geometry, recomputed every minute,
with a marker where the sun is directly overhead. The lit half of the planet
drifts across as you watch.

**Earthquakes.** Everything magnitude 2.5 and up in the past day, straight from
the USGS. Sized by magnitude, coloured by depth — red is shallow, which is the
kind you feel. Click one to look up where it happened.

**Live flights.** Off by default. Tick it and aircraft appear over wherever
you're looking, refreshed every 45 seconds. It's the one layer with a meaningful
limit: OpenSky allows roughly 400 anonymous requests a day, so it only asks about
the area in view, caches on a coarse grid, and dims itself rather than breaking
if the quota runs out.

**Local time** wherever you click, which comes free with the forecast.

### He reads the local press, in the local language

Click somewhere abroad and ask for the news, and he reads **that country's own
Google News front page** rather than English-language coverage of it — then
translates the headlines with the model already running on your machine.

The difference is not subtle. Asked about Seoul, the old behaviour returned World
Youth Day 2027 and a religious-freedom press release; the Korean front page the
same minute led with party primaries, medical-school admission quotas and missile
stockpiles. English coverage of a country is written for foreigners, and there is
a whole domestic press behind it.

Around forty countries are mapped. Anywhere else falls back to international
English and says so rather than pretending it found the local paper. He'll tell
you the headlines are translated, and each story keeps its original wording.

### Talking about where you're looking

This is the part worth knowing. With somewhere selected on the globe, **"here"
means there**:

> "Hey Greg, what's the news here?" → the headlines for whatever you clicked
> "Hey Greg, what time is it here?" → the local time there, not yours

Questions without a pointing word still mean home — "what's the weather" is your
weather, always. Only "here", "there" and "that place" follow the globe, and the
selection expires after half an hour so a country you forgot you clicked doesn't
quietly answer for you.


## The colour behind the window

The teal is the Windows 98 desktop colour and stays the default, but **Settings →
General** has a picker with a few presets — the teal, the blue later versions
used, and a handful of others — plus a colour wheel for anything else.

It repaints as you choose, before you press anything, because picking a colour
you cannot see yet is not picking a colour. Cancel puts it back.


## His face

Greg is a floating CRT television. The cabinet is aged beige plastic with rabbit
ears, tuning knobs and a speaker grille; it drifts on two slow waves so the float
never visibly repeats.

**He looks at your cursor.** Not a lean — an actual turn. The head swings to face
the pointer, so the edge coming toward you grows and the edge going away shrinks,
the same way you see more of someone's right cheek when they look to their left.
He tracks the pointer anywhere in the window, so he keeps watching while you
reach for the controls underneath him, and faces front again when it leaves.

**The picture is the expression.** Everything the screen does is something a real
television does, which is why it needs no explaining:

| | |
| --- | --- |
| idle | SMPTE colour bars, steady, **PLEASE STAND BY** |
| listening | the picture pulses with your voice, **LISTENING** |
| thinking | vertical hold slips and the picture rolls, **PLEASE WAIT** |
| speaking | the seven colour bars become an equaliser driven by his voice |
| error | snow, **NO SIGNAL** |

The test card is the real SMPTE ECR 1-1978 pattern at 75%: seven bars, the
reversed castellation strip, and a bottom row carrying the −I and +Q chroma
patches and the three PLUGE bars. Those exact values are the difference between a
test card and a rainbow.

Broadcast test cards carried a clock, and this one does too — but it counts up,
showing **how long Greg has been awake**. It's the server's uptime, so reloading
the window doesn't reset it, and it disappears while he's speaking so the
equaliser has the screen to itself.

The set is never quite still. A **hum bar** — a soft band from the mains and the
refresh not agreeing — crawls up the picture on an eleven-second cycle, and every
few seconds the tuning slips in one of four ways: a torn band, a moment of lost
vertical hold, a spit of static, or the colour drifting off the picture. Picking
at random is the point; one repeating fault reads as a loop rather than a set
that's alive.

### He has channels

A television that only ever shows a test card is missing the point, so Greg has
programmes. Turn over by saying so, by clicking 📺, or by turning the right-hand
knob on the cabinet itself. There's a burst of static in between, the way there
should be.

**The knob turns both ways.** Click the right-hand side of it to go forward and
the left-hand side to go back, the way a dial works — with eleven channels you
don't want ten clicks to undo one. Shift-click the 📺 button does the same thing, and
you can just say "go back a channel". Nothing ever changes channel on its own
except a severe weather warning; whatever you put on stays on.

| | |
| --- | --- |
| **1 — Test Card** | the colour bars, the clock and his own expression, exactly as before |
| **2 — Now Playing** | whatever is playing on the machine, with the album art |
| **3 — Ceefax** | teletext headlines, three pages on a slow cycle |
| **4 — Weather** | the forecast in the weather service's own words, and any warning in force |
| **5 — Sky at Night** | NASA's astronomy picture of the day, full screen |
| **6 — Space Weather** | how disturbed Earth's magnetic field is, and whether that means aurora |
| **7 — Radar** | weather radar for your area, looping over the last twenty minutes |
| **8 — Markets** | the NASDAQ Composite and a few share prices, with the session state |
| **9 — Flights** | aircraft overhead right now, with their heading and height |
| **10 — Agenda** | your timers and reminders, counting down |
| **11 — Engineering** | GPU load, memory and temperatures — and which AI models are loaded |
| **12 — Sun & Moon** | sunrise, sunset, daylight left and tonight's moon, drawn as it actually looks |
| **13 — Air Quality** | the air quality index for where you are, and what the number means |

Sun & Moon is the only channel that needs **no internet at all** — it's
astronomy, worked out from the date and your coordinates, so it keeps working
when nothing else does. Above the Arctic circle it will tell you the sun isn't
coming up today rather than showing you a blank.

Air Quality shows pollen too, but only where it's published: the data comes from
a European model, so in North America it says so instead of implying the count
is zero.

**Asking doesn't change the channel.** "When does it get dark?", "is it a full
moon?" and "how's the air out there?" are all answered by the weather tool,
which now carries the sun times, the moon and the air reading. The channels are
for *showing*.

### Add your own

**A folder in `channels/` is a channel.** No code to edit, nothing to register:

```jsonc
// channels/tides/channel.json
{
  "name": "Tides",
  "aliases": ["tides", "tide table"],
  "fetch": { "url": "https://…?latitude={lat}&longitude={lon}", "pick": "current" },
  "display": { "big": { "path": "wave_height", "suffix": " m", "label": "waves" } }
}
```

Restart, and it's on the dial — with caching, a sensible poll interval and the
same scanlines, roll and static as every other channel. `{lat}` and `{lon}` are
filled in from wherever you are. Add a `render.js` beside it if you'd rather draw
it yourself. There's a worked example in `channels/tides/`, and the full guide is
in [channels/README.md](../channels/README.md).

**Voices and personas work the same way** and always have: drop a `.wav` or a
Piper `.onnx` into `voices/`, or a `.json` into `personas/`, and it's there.

Engineering is the one that earns its place if you ever wonder why he's slow:
graphics memory is what everything here competes for, and that channel is the
only way to see it without opening a terminal.

> "Hey Greg, put the album art up."
> "Hey Greg, put the weather on."
> "Hey Greg, show me the picture of the day."
> "Hey Greg, change the channel."
> "Hey Greg, go back to the test card."

**None of them needs an account, and only one needs a key of any kind.** They're
all free public feeds, and each one keeps its last good picture if the source
blinks — you get a small amber strip saying it might be out of date, rather than
a blank screen.

**Now Playing works for any app.** Windows keeps track of whatever is playing —
Spotify, a YouTube tab, VLC, a game — and Greg reads that directly, cover and
all. There's nothing to connect and nothing to expire.

**Ceefax** is the BBC's teletext, rebuilt: page 101 is local news, 102 national,
103 world, and it turns over every nine seconds by itself. Same blocky palette,
same coloured buttons along the bottom.

**Weather is the one worth having.** It comes from the US National Weather
Service, which writes its forecasts in sentences — *"A chance of showers and
thunderstorms before 3am. Mostly cloudy, with a low around 71"* — rather than
handing you a row of numbers. Outside the US it falls back to numbers and says
so.

**A severe warning puts itself on screen.** If a tornado warning, a flash flood
warning or anything else at that level comes into force where you are, Greg
turns to the weather channel on his own and reads it out. He does this **once**
per warning, and only for the serious ones — on a normal day there are around
190 alerts in force across the country and he'd interrupt for about 44 of them,
almost never one of yours. Heat advisories, air quality alerts and small craft
advisories stay quiet, on purpose: an interruption you learn to ignore is worse
than none. You can also just ask — "are there any weather warnings?" — and turn
it off entirely with `alerts.enabled` in `config.json`.

**Sky at Night** is NASA's picture of the day. It's on a free demo key that
allows about 50 requests a day shared across your whole connection, so Greg
caches the photograph on disk and keeps yesterday's up rather than showing an
error if he's been rate-limited. If you ever want it more reliable, a free key
from api.nasa.gov takes an email address and nothing else — drop it in
`apod.key`.

**Markets** shows the NASDAQ Composite, the day's shape against the previous
close, and the share prices you list in `config.json` — `stocks.symbols`, six by
default. It always says whether the market is **open or closed**, because it's
shut more hours of the week than it's open and a price with nothing next to it
looks live when it's Friday's close. Up is green with a ▲ and down is red with a
▼, so the arrow carries it even if the colours don't work for you.

> "Hey Greg, put the markets on."
> "Hey Greg, what's the NASDAQ at?"

**It reports numbers and won't tell you what to do with them.** Ask what
something is trading at and he'll tell you; ask whether you should buy it and
he'll say plainly that he can't give investment advice, then give you the facts
and say whose opinion is whose. That's deliberate — he's not a financial adviser
and shouldn't sound like one. The prices come from Yahoo's free feed and are
last-traded rather than guaranteed real-time.

**Radar** is the last twenty minutes of rain, moving. Ten sweeps from your
nearest National Weather Service radar station — KRAX for Chapel Hill — played
as a loop with a pause on the newest one, which is what makes it readable: you
can see whether the rain is coming towards you or going away, which a still
picture can't tell you. The images come with the coastline, county lines,
highways and town names already on them, and any active warning polygon drawn
straight onto the map. Ten ticks along the bottom show where you are in the loop;
green means you're looking at the latest sweep.

> "Hey Greg, put the radar on."

**Space Weather** is honest with you, which is the point of it. From North
Carolina the answer to "can I see the northern lights tonight" is essentially
always no, so it says *"Not from 36° north"* rather than quoting a number and
letting you get your hopes up. On the rare night that changes, the whole screen
turns red and the aurora strip turns green.

The set **leans in** on any channel but the test card, pushing the cabinet toward
the edges so the picture is more than twice the size it was. It backs off again
when you come back to channel 1. And it doesn't stop showing the programme while
he talks — his expression moves to a subtitle along the bottom, and the level
meter under it follows his voice, or the music when he's quiet.

The window around it is Windows 98 — teal desktop, navy title bar, beveled
buttons that press inward, sunken text field, status bar. When the server stops,
the title bar goes grey and inactive, the way Windows itself signalled it.

The gold chrome helmet Greg used to wear is still in the box. Add `?face=3d` to
the address for it, `?face=2d` for its hand-drawn stand-in, or `?face=tv` to be
explicit about the television.

Weather, news, the channels, the voice, the ears and the brain all run without any API key or account — and the voice, ears and brain don't need the internet either.

---

