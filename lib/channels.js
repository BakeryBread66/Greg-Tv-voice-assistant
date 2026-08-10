// What is on Greg's screen.
//
// He is a television that has only ever shown a test card. The renderer already
// has five states, an equaliser, roll, snow and four faults, so giving it
// programmes costs far less than it sounds — the work is a switch, a wipe, and
// one channel at a time.
//
// The current channel lives HERE and nowhere else. Voice sets it, the knob on
// the cabinet sets it, and the face paints whatever this last said — the same
// arrangement as lib/power.js, and for the same reason: gaming mode shipped
// briefly with its own stored boolean alongside the two switches it was supposed
// to describe, and the two promptly disagreed. Two sources of truth for one fact
// is one too many.

// Adding a channel is one entry here, one entry in lib/programmes.js if it has
// live data behind it, and one renderer in public/face-tv.js.
//
// `aliases` are what a person might actually say out loud; the number is what
// they turn the knob to. `feed` names the entry in lib/programmes.js, and is
// what tells the browser there is something to poll for — a channel with no
// feed (the test card) is simply never polled for, with nothing needing to say
// so anywhere else.
export const CHANNELS = [
  {
    number: 1,
    id: "testcard",
    name: "Test Card",
    aliases: ["test card", "testcard", "bars", "colour bars", "color bars", "the usual", "your face", "normal"],
    // Descriptions are KEYWORDS, not documentation. The only thing that ever
    // reads them is set_channel's schema, which is sent on every turn — written
    // at documentation length the schema reached ~265 tokens, and every channel
    // added taxed every conversation. Measured: names alone cut it to ~113 but
    // dropped routing from 8/10 to 6/10, because the model stopped RECOGNISING
    // "the rain map" or "the picture of the day" as channel requests at all.
    // A few keywords are what recognition actually needs; resolving the phrase
    // is resolveChannel()'s job and it does it deterministically.
    description: "his own face, colour bars",
  },
  {
    number: 2,
    id: "nowplaying",
    name: "Now Playing",
    // Deliberately NOT "what's playing" — that is the question `whats_playing`
    // answers, and an alias for it here would turn asking into switching.
    aliases: ["now playing", "nowplaying", "music", "the music", "album art", "the album"],
    description: "music, album art",
    // Not "nowplaying": that channel predates lib/programmes.js and keeps its
    // own route, because it owns a live PowerShell process and a few hundred KB
    // of artwork. Left out rather than retrofitted — see voice.js.
  },
  {
    number: 3,
    id: "ceefax",
    name: "Ceefax",
    feed: "ceefax",
    // Deliberately NOT a bare "text" or "news". "News" is what get_local_news
    // answers out loud, and a bare "text" appears inside far too many ordinary
    // sentences — an alias only has to be reachable, not greedy.
    aliases: ["ceefax", "teletext", "news page", "headlines page", "the news channel", "news channel"],
    description: "news headlines, teletext pages",
  },
  {
    number: 4,
    id: "weather",
    name: "Weather",
    feed: "weather",
    aliases: ["weather", "the weather", "forecast", "the forecast", "weather channel"],
    description: "forecast, weather warnings",
  },
  {
    number: 5,
    id: "apod",
    name: "Sky at Night",
    feed: "apod",
    aliases: ["sky at night", "sky", "space", "astronomy", "picture of the day", "nasa", "the photo", "stars"],
    description: "NASA photo of the day, astronomy",
  },
  {
    number: 6,
    id: "spacewx",
    name: "Space Weather",
    feed: "spacewx",
    // "space weather" is longer than channel 5's "space" and than channel 4's
    // "weather", and the matcher takes the longest alias first — which is the
    // whole reason it sorts. A bare "sun" is left out: it is inside "sunny",
    // and "is it sunny" must never be a channel change.
    aliases: ["space weather", "aurora", "northern lights", "solar storm", "solar", "k index", "kp index", "geomagnetic"],
    description: "aurora, northern lights, solar",
  },
  {
    number: 7,
    id: "radar",
    name: "Radar",
    feed: "radar",
    // "rain" is deliberately absent: "is it going to rain" is a question for
    // get_weather, and an alias here would turn asking into switching — the same
    // call made for "what's playing" against channel 2.
    aliases: ["radar", "rain radar", "weather radar", "radar loop", "storm radar"],
    description: "rain map, storm radar",
  },
  {
    number: 8,
    id: "stocks",
    name: "Markets",
    feed: "stocks",
    aliases: ["markets", "the markets", "market", "nasdaq", "stocks", "stock ticker", "shares", "ticker"],
    // Says what it SHOWS and nothing about what any of it means. The description
    // is read by the model every turn, and one word of characterisation here —
    // "how your stocks are doing", "market performance" — is an invitation to
    // editorialise about numbers Greg has no business having an opinion on.
    description: "NASDAQ, stocks, share prices",
  },
  {
    number: 9,
    id: "flights",
    name: "Flights",
    feed: "flights",
    aliases: ["flights", "planes", "aircraft", "air traffic", "flight tracker", "planes overhead", "flying overhead", "what's flying"],
    description: "planes overhead, air traffic",
  },
  {
    number: 10,
    id: "agenda",
    name: "Agenda",
    feed: "agenda",
    // NOT "reminders" or "timers" on their own — "how long left on my timer" is
    // a question list_reminders answers out loud, and an alias here would turn
    // asking into switching. Same call as "what's playing" against channel 2.
    aliases: ["agenda", "my agenda", "schedule", "my schedule", "what's coming up", "diary", "timers and reminders"],
    description: "timers and reminders coming up",
  },
  {
    number: 11,
    id: "engineering",
    name: "Engineering",
    feed: "engineering",
    // Every alias here has to read as "put it on screen" rather than as a
    // question. Aliases are matched as SUBSTRINGS, so a bare "gpu" or "temps"
    // would turn "how hot is my GPU" into a channel change — the identical trap
    // that "what's playing" and "what is the NASDAQ at" both fell into, and the
    // fix both times was to leave the question to its own tool. get_engineering
    // answers; this shows.
    aliases: ["engineering", "system stats", "system status", "diagnostics", "hardware", "vitals", "gpu stats"],
    description: "system vitals, GPU and CPU meters",
  },
  {
    number: 12,
    id: "sunmoon",
    name: "Sun & Moon",
    feed: "sunmoon",
    // NOT "sunset", "sunrise" or "moon" on their own. Those are the words in
    // the QUESTION — "when is sunset?" — and aliases are matched as substrings,
    // so a bare one would change channel instead of answering. Third time this
    // trap has been documented and the first time it has been avoided in
    // advance rather than found afterwards; get_weather carries the times so
    // the question has somewhere to go.
    aliases: ["sun and moon", "sun & moon", "sunmoon", "moon phase", "daylight", "golden hour"],
    description: "sunrise, sunset, moon phase",
  },
  {
    number: 13,
    id: "air",
    name: "Air Quality",
    feed: "air",
    // Called Air Quality and not "Air Quality & Pollen" on purpose: Open-Meteo
    // serves pollen from a European model and every field is null in North
    // America — measured on this machine's own coordinates before it was built.
    // A name that is true in one hemisphere and a lie in the other is the boot
    // screen's "all processing local" all over again.
    // "air" and "pollen" were here and had to go. Aliases are plain substrings,
    // so a bare "air" matches "the air out there", "airport", "on air" — it is
    // not that questions must never match a channel (the Weather channel
    // answers to "weather", and that is accepted, because get_weather exists for
    // the asking), it is that an alias this broad matches sentences that are
    // about nothing of the sort. The question path is get_weather, which now
    // carries the air reading and the sun times for exactly this reason.
    aliases: ["air quality", "pollution", "smog", "aqi", "air quality index"],
    description: "air quality index, pollutants",
  },
];

// Where the shipped channels end. Captured at module load, before anything can
// be appended, so addChannels() always knows what is built in.
const BUILT_IN_COUNT = CHANNELS.length;

/**
 * Take on the channels somebody has dropped into `channels/`.
 *
 * Appended rather than merged: the built-ins keep their numbers whatever anyone
 * installs, because a channel number is a position on a dial and people learn
 * them. Called once at startup, and safe to call again — the list is truncated
 * back to the built-ins first, so a reload cannot leave two copies of the same
 * add-on behind.
 */
export function addChannels(addons = []) {
  CHANNELS.length = BUILT_IN_COUNT;
  for (const channel of addons) CHANNELS.push(channel);
  return CHANNELS.length - BUILT_IN_COUNT;
}

const DEFAULT = 1;

let current = DEFAULT;
const listeners = new Set();

export function channelState() {
  return {
    channel: current,
    id: byNumber(current).id,
    name: byNumber(current).name,
    // `addon` and `hasRenderer` are what tell the page a channel is not one it
    // was shipped with: it has no entry in the static renderer map and must go
    // and fetch one, or fall back to the declarative renderer. Sent for every
    // channel rather than only add-ons, so the page never has to infer it.
    channels: CHANNELS.map(({ number, id, name, description, feed, addon, hasRenderer, display }) => ({
      number, id, name, description, feed,
      addon: Boolean(addon),
      hasRenderer: Boolean(hasRenderer),
      display: display ?? null,
    })),
    // The current channel's feed, if it has one. The browser polls this and
    // nothing else, so switching away is what stops the polling — the same
    // arrangement that already releases the media watcher.
    feed: byNumber(current).feed ?? null,
  };
}

function byNumber(number) {
  return CHANNELS.find((c) => c.number === number) ?? CHANNELS[0];
}

/**
 * Find a channel from whatever the user or the model said.
 *
 * Deliberately generous: "channel two", "2", "now playing" and "put the music on"
 * should all land in the same place, and a 4B model will phrase it differently
 * every time. Resolving in code rather than constraining the model is the same
 * call made for deixis, plurals and place names — see CLAUDE.md.
 */
export function resolveChannel(wanted) {
  if (wanted === null || wanted === undefined) return null;

  if (typeof wanted === "number" && Number.isFinite(wanted)) {
    return CHANNELS.find((c) => c.number === Math.round(wanted)) ?? null;
  }

  const said = String(wanted).toLowerCase().trim();
  if (!said) return null;

  // A number counts when it is the WHOLE thing ("2", "ten") or when it follows
  // the word channel ("channel 2", "ch eight").
  //
  // It used to match anywhere in the string, and that was a latent trap rather
  // than a working feature: "set a timer for nine minutes" resolved to channel
  // 9. Nothing had hit it only because set_channel is the sole caller and the
  // model rarely routes a timer there — which is luck, not a guarantee, and the
  // tenth channel is what made it worth fixing rather than noting.
  const NUMBER_WORDS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  };

  const numberFrom = (text) => {
    const bare = /^(\d+)$/.exec(text);
    if (bare) return Number(bare[1]);
    if (NUMBER_WORDS[text] !== undefined) return NUMBER_WORDS[text];

    const prefixed = /\b(?:channel|chan|ch\.?)\s*(\d+|[a-z]+)\b/.exec(text);
    if (!prefixed) return null;
    const token = prefixed[1];
    return /^\d+$/.test(token) ? Number(token) : NUMBER_WORDS[token] ?? null;
  };

  const number = numberFrom(said);
  if (number !== null) {
    const found = CHANNELS.find((c) => c.number === number);
    if (found) return found;
  }

  // Longest alias first, so "now playing" is not beaten by "playing" appearing
  // inside a longer alias belonging to something else.
  const byAlias = CHANNELS.flatMap((c) => [c.name.toLowerCase(), ...c.aliases].map((alias) => ({ c, alias })))
    .sort((a, b) => b.alias.length - a.alias.length)
    .find(({ alias }) => said.includes(alias));

  return byAlias ? byAlias.c : null;
}

/** Switch channels. Returns the new state, or an error naming what exists. */
export function setChannel(wanted) {
  const found = resolveChannel(wanted);
  if (!found) {
    return {
      error: `There is no channel "${wanted}".`,
      available: CHANNELS.map((c) => `${c.number} — ${c.name}`).join(", "),
    };
  }

  const changed = found.number !== current;
  current = found.number;
  if (changed) announce();

  return { ...channelState(), changed };
}

/** The knob on the cabinet: round the dial one step, wrapping. */
export function turnKnob(step = 1) {
  const at = CHANNELS.findIndex((c) => c.number === current);
  const next = CHANNELS[(at + step + CHANNELS.length * 2) % CHANNELS.length];
  return setChannel(next.number);
}

export function onChannelChange(listener) {
  listeners.add(listener);
}

function announce() {
  const state = channelState();
  for (const listener of listeners) {
    try {
      listener(state);
    } catch (err) {
      console.warn("[channel] listener failed:", err.message);
    }
  }
}
