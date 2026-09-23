// What Greg says while he works: "Let me look that up."
//
// A search is ten seconds of silence in his log - the median search_web turn
// took 11.0 s, a look at the screen 11.2 s - and silence from a voice assistant
// reads as "he didn't hear me", which is worse than slow. So when he starts on
// something slow he says so, the way a person would, and then answers.
//
// Two rules keep it honest and keep it from being noise:
//
//   - Some tools are slow EVERY time: they fetch a web page, look at the screen,
//     read or transcribe a file. For those it is said at once, and names what
//     he is doing - "Let me have a look."
//   - Everything else gets it only if it turns out to be slow: "One moment." if
//     no answer has started FILLER_AFTER_MS after the tool calls came back. A
//     "please wait" before a 90 ms answer is its own kind of lie - an earlier
//     session wrote that about the eyes button - and "what time is it" must not
//     be answered "One moment. It's noon."
//
// At most once a turn, never if he has already said something himself this
// round, and never for /api/chat, where nothing is spoken. Said in code rather
// than asked of the model, for the reason this project gives every time: a
// model told to "say you're checking" does it one time in three.
//
// Every phrase here is pre-warmed into the speech cache (lib/tts-cache.js), so
// the cloned voice - which takes seconds to synthesise a new sentence - says it
// at once. A filler that arrives two seconds late is just a slower answer.

export const FILLER_AFTER_MS = 2000;

/** Tools that are slow every time, and what he says as he starts one. */
export const SLOW_TOOLS = Object.freeze({
  search_web: "Let me look that up.",
  read_page: "Let me have a read.",
  look_at_screen: "Let me have a look.",
  read_file: "Let me look for that.",
  get_local_news: "Let me look at the news.",
});

/** For anything else that turns out to take a while. */
export const LATE_FILLER = "One moment.";

/** Every phrase a filler can be, for the speech cache to warm. */
export const FILLER_PHRASES = Object.freeze([...new Set([...Object.values(SLOW_TOOLS), LATE_FILLER])]);

/**
 * One turn's filler.
 *
 * @param {object} opts
 * @param {(text: string) => void} [opts.say]  speaks it; absent means nothing is spoken this turn
 * @param {number} [opts.afterMs]
 * @param {Function} [opts.setTimer]    setTimeout, unless a test says otherwise
 * @param {Function} [opts.clearTimer]  clearTimeout, likewise
 */
export function createFiller({ say = null, afterMs = FILLER_AFTER_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let said = null;
  let timer = null;
  let over = false;

  const cancel = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };
  const speak = (text) => {
    if (said || over || !say) return;
    said = text;
    say(text);
  };

  return {
    /**
     * The model has asked for tools. `names` are the calls about to run;
     * `alreadySpoke` is whether this round already said something out loud.
     */
    toolsStarting(names = [], alreadySpoke = false) {
      if (said || over || !say || alreadySpoke || timer !== null) return;
      const now = (names ?? []).map((name) => SLOW_TOOLS[name]).find(Boolean);
      if (now) return speak(now);
      timer = setTimer(() => {
        timer = null;
        speak(LATE_FILLER);
      }, afterMs);
    },

    /** The answer has started. Nothing more is needed. */
    answering() {
      cancel();
    },

    /** The turn is over, however it ended. */
    done() {
      cancel();
      over = true;
    },

    /** What was said, if anything - it belongs in the transcript too. */
    get said() {
      return said;
    },
  };
}
