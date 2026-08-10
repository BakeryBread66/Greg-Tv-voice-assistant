# Your own channels

Drop a folder in here and it's a channel. Nothing to register, nothing to
import, no source file to edit — the folder *is* the registration, the same way
`personas/` and `voices/` already work.

```
channels/tides/
  channel.json     what it's called and where the data comes from
  render.js        optional — only if you want to draw it yourself
```

Restart Greg and it's on the dial. The console says what loaded, and says why if
something didn't.

## The smallest channel that works

```json
{
  "name": "Tides",
  "description": "high and low water",
  "aliases": ["tides", "tide table"],

  "fetch": {
    "url": "https://marine-api.open-meteo.com/v1/marine?latitude={lat}&longitude={lon}&current=wave_height&timezone=auto",
    "pick": "current",
    "everySeconds": 900
  },

  "display": {
    "big": { "path": "wave_height", "suffix": " m", "label": "wave height" }
  }
}
```

`{lat}`, `{lon}` and `{city}` are filled in from wherever you are, so a channel
doesn't need to know anything about locations.

`pick` selects the part of the reply you care about, by dotted path —
`"properties.periods"` reaches into nested JSON, and `"list.0"` takes the first
item of an array. Leave it out to keep the whole payload.

`everySeconds` is how often to ask again. **Be kind to whoever is serving it** —
most feeds change every few minutes at most, and something you poll every ten
seconds is something you'll get blocked from. The floor is 10 seconds whatever
you write.

## Drawing it without writing code

The `display` block covers a big number, a few rows, and a footnote:

```json
"display": {
  "big":  { "path": "temperature", "suffix": "°", "label": "outside" },
  "rows": [
    { "label": "Wind",     "path": "wind.speed", "suffix": " mph" },
    { "label": "Humidity", "path": "humidity",   "suffix": "%" }
  ],
  "foot": { "path": "station" }
}
```

Every field is optional. A value that isn't in the feed shows as `—` rather than
`undefined`, so a feed that changes shape looks like a missing reading instead of
a broken channel. Numbers are rounded for you; `decimals` overrides that.

## Drawing it yourself

Add `render.js` beside `channel.json`:

```js
export function draw(ctx, x, y, w, h, view, channel) {
  const feed = view.feed(channel.id);          // null until the first reply
  if (!feed) return;
  const data = feed.data;

  ctx.fillStyle = "#101018";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#eee";
  ctx.font = `${h * 0.1}px sans-serif`;
  ctx.fillText(String(data.whatever), x + w * 0.06, y + h * 0.3);
}
```

`x, y, w, h` are the picture rectangle — always draw relative to them and size
text as a fraction of `h`, because the picture is about 312px across in a small
window and 856 in a large one. **Check yours at the small size.** Everything the
set does to a picture — the roll, the scanlines, the shadow mask, the static on
a channel change — happens to yours for free.

If your renderer throws, Greg logs it, falls back to the `display` block and
keeps going. It can't take the face down.

## Two things worth knowing

**A channel can't fetch from Greg's own services.** Ports 4747–4750 and 11434
are refused — that's his API, his ears, his voice and Ollama. Anything else,
including your own home server on the network, is allowed.

**A `render.js` is JavaScript that runs in the page.** Your own file is no
different from editing the source. But a channel someone else wrote is *someone
else's code*, with the same reach as any script in the browser tab — read it
before you run it, exactly as you would anything else you download.

## When something doesn't appear

Look at the console. Every reason a folder was skipped is printed by name —
missing `channel.json`, JSON that won't parse, a URL that isn't allowed. A
folder that silently does nothing is the one outcome this is built to avoid.

Channels you add are numbered from 100, so nothing you install ever renumbers
the channels that shipped.
