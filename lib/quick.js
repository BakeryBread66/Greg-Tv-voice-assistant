// The questions he is asked most, recognised in code.
//
// In his log, "what time is it" and "what's the weather" are 58 of 213 turns —
// over a quarter of everything he has ever been asked. Both went through a
// model round just to decide to call the obvious tool, and the time went
// through a second round to read the answer back:
//
// - The time is answered here outright. There is nothing for a model to add to a
//   clock, and asking one was how he said "two thirty-nine" at 1:36 on Aug 11 —
//   no tool call, a confident wrong answer, and nothing to catch it.
// - The weather is fetched here, and the model only phrases it. That drops the
//   round that did nothing but pick get_weather, and he still words it, so the
//   personality dials and "do I need a jacket?" afterwards work as before.
//
// The patterns are whole-utterance on purpose. "what time is it in Tokyo", "the
// weather here" (the globe) and "will it rain tomorrow" each need the model to
// read an argument out of them, and fall through to it untouched. Being too
// narrow costs one ordinary model round; being too broad answers the wrong
// question, so every form below was a real phrasing from his log or its
// obvious twin.

// Said around a question without changing it: his name, "hey", "please".
const PADDING = /^(?:(?:hey|hi|okay|ok|so|um|uh|greg|please|can you tell me|could you tell me|tell me)\s+)*|(?:\s+(?:greg|please|then|now|right now|currently|at the moment))*$/g;

const flatten = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .replace(/\bwhats\b/g, "what's")
    .replace(/\bhows\b/g, "how's")
    .replace(/\btodays\b/g, "today's")
    .replace(/\s+/g, " ")
    .trim()
    .replace(PADDING, "")
    .trim();

const TIME = new Set([
  "what time is it", "what's the time", "what is the time", "the time", "time",
  "do you know what time it is", "do you have the time", "what time have you got",
  "what time do you have", "time check",
]);

const DATE = new Set([
  "what day is it", "what day is it today", "what day is today", "what's the date",
  "what is the date", "what's the date today", "what is the date today",
  "what's today's date", "what is today's date", "today's date", "the date",
  "what date is it", "what date is it today", "what's today", "what is today",
]);

const WEATHER = new Set([
  "what's the weather", "what is the weather", "how's the weather", "how is the weather",
  "the weather", "weather", "what's the weather like", "what is the weather like",
  "how's the weather today", "how is the weather today", "what's the weather today",
  "what is the weather today", "what's the weather like today", "what is the weather like today",
  "what's the weather like outside", "what is the weather like outside", "how's the weather outside",
  "how is it outside", "what's it like outside", "what is it like outside", "weather report",
  "give me the weather", "what's the forecast", "what is the forecast", "the forecast", "forecast",
  "what's the weather forecast", "what is the weather forecast",
]);

/**
 * Which of the everyday questions this is, if any.
 * @returns {"time"|"date"|"weather"|null}
 */
export function quickIntent(userText) {
  const said = flatten(userText);
  if (!said) return null;
  if (TIME.has(said)) return "time";
  if (DATE.has(said)) return "date";
  if (WEATHER.has(said)) return "weather";
  return null;
}

const ONES = [
  "", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty"];

/** 1-59 in words: "seven", "twenty-eight". */
function words(n) {
  if (n < 20) return ONES[n];
  const ten = TENS[Math.floor(n / 10)];
  return n % 10 ? `${ten}-${ONES[n % 10]}` : ten;
}

const ORDINALS = [
  "", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
  "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth",
  "eighteenth", "nineteenth", "twentieth", "twenty-first", "twenty-second", "twenty-third",
  "twenty-fourth", "twenty-fifth", "twenty-sixth", "twenty-seventh", "twenty-eighth",
  "twenty-ninth", "thirtieth", "thirty-first",
];

/**
 * The clock the way a person says it, for a voice to read.
 *
 * Words rather than "2:09 PM" because every voice he has reads digits and
 * letters differently, and the system prompt has always asked the model for
 * words for the same reason. "In the afternoon" rather than "PM", which one voice
 * reads as a word and the sentence splitter would cut at "p.m.".
 */
export function spokenTime(date = new Date()) {
  const hour = date.getHours();
  const minute = date.getMinutes();
  if (minute === 0 && hour === 12) return "It's twelve noon.";
  if (minute === 0 && hour === 0) return "It's midnight.";

  const h12 = hour % 12 || 12;
  const mins = minute === 0 ? "o'clock" : minute < 10 ? `oh ${ONES[minute]}` : words(minute);
  const part = hour < 12 ? "in the morning" : hour < 18 ? "in the afternoon" : hour < 21 ? "in the evening" : "at night";
  return `It's ${ONES[h12]} ${mins} ${part}.`;
}

/** Today, said: "It's Thursday, August sixth." */
export function spokenDate(date = new Date()) {
  const weekday = date.toLocaleDateString("en-US", { weekday: "long" });
  const month = date.toLocaleDateString("en-US", { month: "long" });
  return `It's ${weekday}, ${month} ${ORDINALS[date.getDate()]}.`;
}

// ---------------------------------------------------------------------------
// From the phone: a question about the PC's screen, answered in code.
//
// The phone is never given the screen tools (PHONE_BLOCKED in lib/brain.js) and
// its prompt says so — and asked "what is on my screen right now" from the phone,
// gemma4:e4b still answered, describing Greg's own television as if that were
// the user's screen. Nothing was captured, but it was a confident answer to a
// question he cannot answer from there. So it is not asked.
//
// "MY screen" and its kin, not "the screen": "put the weather on the screen" is
// about Greg's own set, which the phone may change.
// ---------------------------------------------------------------------------

const ABOUT_THE_SCREEN = /\bmy\s+(?:screen|monitor|monitors|display|desktop)\b|\bscreenshot\b|\bscreen\s*shot\b|\bwhat am i looking at\b|\bwhat(?:'s| is) on (?:the |my )?(?:pc|computer)\b/i;

/** Is this a question about what is on the PC's screen? */
export function asksAboutScreen(userText) {
  return ABOUT_THE_SCREEN.test(String(userText ?? ""));
}

export const SCREEN_FROM_PHONE = "I can't see your PC's screen from your phone. That only works when you're at the PC.";
