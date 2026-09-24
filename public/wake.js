// Deciding whether something said in the room was meant for Greg.
//
// Four pure functions, kept out of voice.js for one reason: voice.js reaches for
// `document` on its eleventh line and does a top-level `await createFace(...)` on
// its thirty-second, so Node cannot import it at all. These lived in there and
// were therefore untestable — which matters more than it sounds, because they are
// the front door. Everything downstream of a wake match is wasted work if the
// match itself is wrong, and a wake matcher that is too eager is indistinguishable
// from a haunted microphone.
//
// Nothing here touches the DOM, the network or the microphone. If you add another
// judgement about what a transcript MEANS, add it here and add its battery to
// test/pure.test.js — a code gate with no test is a prompt instruction with extra
// steps.

/**
 * Flatten a transcript to comparable words.
 *
 * Punctuation goes to a space rather than to nothing, so "greg, what time" and
 * "greg what time" normalize the same. The apostrophe is kept because dropping it
 * turns "what's" into "what s" and splits one word into two, which the filler
 * guard counts.
 */
export const normalize = (text) =>
  text
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Whatever was said after the wake word, or null if it isn't there.
 *
 * Takes the wake words rather than reading them from config, so it can be proven
 * against a list the test chooses.
 *
 * The LAST occurrence wins, and where several wake words match, the one ending
 * furthest along wins. Both fall out of the same intent: a false start like
 * "hey greg — no, hey greg, what time is it" should ask the question, not ask
 * "no hey greg what time is it".
 */
export function afterWakeWord(transcript, wakeWords) {
  const said = normalize(transcript);
  let best = null;

  for (const raw of wakeWords ?? []) {
    const wake = normalize(raw);
    if (!wake) continue; // an empty entry would match at position 0 and swallow everything
    const at = said.lastIndexOf(wake);
    if (at === -1) continue;
    const end = at + wake.length;
    if (best === null || end > best.end) best = { end, remainder: said.slice(end).trim() };
  }

  return best ? best.remainder : null;
}

// Speech recognition invents filler out of near-silence — Whisper is famous for
// "Thank you." and "you" over room tone. That was harmless while every question
// had to start with the wake word, but the follow-up window opens after every
// single answer, so the same filler would fire off spurious questions.
//
// Exported as a list rather than written straight into the regex so the test can
// walk it. That is not tidiness: "thank you very much" sat in this pattern for
// three sessions and could never match, because the word cap below was 3 and the
// phrase is 4 words long. The most specific entry in the list was dead, silently,
// and the only way to see it was to check every entry against the function.
export const FILLER_PHRASES = [
  "you", "thank you", "thanks", "thank you very much", "bye", "okay", "ok",
  "uh", "um+", "hm+", "mm+", "ah", "oh", "yeah", "yep", "so", "well", "right",
  "the", "a", "and",
];

const FILLER = new RegExp(`^(${FILLER_PHRASES.join("|")})$`);

// The longest phrase above, in words. Derived rather than written down, so
// adding a longer entry cannot orphan it the way it did last time.
const FILLER_MAX_WORDS = Math.max(...FILLER_PHRASES.map((p) => p.split(" ").length));

/**
 * Does this look like room tone rather than a question?
 *
 * The pattern is anchored, so the word cap is belt and braces — but it is cheap
 * insurance against a future entry being written unanchored, and it makes the
 * intent ("this is a short noise, not a sentence") explicit.
 */
export function isFiller(said) {
  const words = said.split(" ").filter(Boolean);
  return words.length === 0 || (words.length <= FILLER_MAX_WORDS && FILLER.test(said));
}

// A dismissal is rarely said as one clean word. The log has "okay okay okay shut
// up greg shut up" answered twice over, and "need to make it faster oh shit shut
// up shut up greg" answered with a promise to be brief — each one a person
// telling him to be quiet and getting more of him. So the words that carry no
// meaning here (his name, "okay", "oh", "please") are dropped first, and then:
//
// - the whole of what is left is a dismissal, said once or several times; or
// - it ENDS with one of the few phrases that only ever mean "stop talking".
//
// Still anchored in both directions that matter. "never mind the weather" and
// "stop the timer" are questions, because something follows the word; and "play
// shut up and dance" is a request, because the phrase is not at the end. The
// weak words — "stop", "nothing", "forget it" — only count on their own, since
// "what time does the bus stop" and "don't forget it" end with them too.
const DISMISSALS = [
  "never mind", "nevermind", "stop", "cancel", "forget it", "nothing",
  "shut up", "shut it", "be quiet", "quiet", "hush", "stop talking", "stop speaking",
  "stop it", "that's enough", "enough", "wait", "hold on", "hang on",
];
const ENDS_A_DISMISSAL = ["shut up", "shut it", "be quiet", "stop talking", "stop speaking"];

// Said around a dismissal without changing it. Deliberately short: every word
// added here is a word that can no longer stop a question being a question.
const NOISE_WORDS = new Set(["okay", "ok", "alright", "all", "right", "please", "just", "now", "oh", "hey", "no", "shit", "god"]);

const ONLY_DISMISSALS = new RegExp(`^(?:(?:${DISMISSALS.join("|")})\\s*)+$`);
const ENDS_WITH_DISMISSAL = new RegExp(`(?:^|\\s)(?:${ENDS_A_DISMISSAL.join("|")})$`);

/**
 * Was that a dismissal rather than a question?
 *
 * `names` are the words he answers to — "greg", and what the wake words hear
 * him as ("craig", "grey"). Takes them rather than reading config, so the test
 * chooses the list, the same as afterWakeWord.
 */
export function isCancel(said, names = ["greg"]) {
  const drop = new Set([...NOISE_WORDS, ...names.map((name) => normalize(name))]);
  const kept = normalize(said)
    .split(" ")
    .filter((word) => word && !drop.has(word))
    .join(" ");
  if (!kept) return false; // "okay okay" is filler, not a dismissal; isFiller owns it
  return ONLY_DISMISSALS.test(kept) || ENDS_WITH_DISMISSAL.test(kept);
}

/** The words a wake-word list answers to: the last word of each, and the name. */
export function namesFrom(wakeWords = [], name = "") {
  const names = new Set([normalize(name)].filter(Boolean));
  for (const wake of wakeWords ?? []) {
    const last = normalize(wake).split(" ").pop();
    if (last) names.add(last);
  }
  return [...names];
}

// Anchored, like CANCEL and for the same reason: "what" alone is "I missed
// that", and "what time is it" is a question. Only the whole utterance counts.
const REPLAY =
  /^(what|huh|eh|sorry|pardon|pardon me|say that again|say it again|come again|again|repeat|repeat that|what was that|what did you say|i missed that|i didn't catch that|didn't catch that)$/;

/**
 * Did they miss it and want it again?
 *
 * Answering this by re-running the model gets you a DIFFERENT sentence, which is
 * not what "what?" asks for — you wanted the one you missed, not another attempt
 * at it. The caller replays the actual audio instead.
 */
export function isReplay(said) {
  return REPLAY.test(said);
}

// ---------------------------------------------------------------------------
// Whether to keep listening after an answer
//
// The follow-up window is what lets "do I need a jacket?" come after the weather
// without "Hey Greg" in front of it. It is also how he came to answer about one
// heard turn in six that was never meant for him: "yeah", "cooper this is the
// cool thing about greg", a conversation with somebody else in the room, all
// arriving inside the seven seconds after he spoke. Which of those two costs is
// worse depends on the room, so it is the user's choice rather than ours:
//
//   always    after every answer (how he has always behaved)
//   question  only when his answer ended by asking something, which is the one
//             time a reply without his name is clearly meant for him
//   off       never; every question starts with the wake word or a click
// ---------------------------------------------------------------------------

export const FOLLOW_UP_MODES = ["always", "question", "off"];

/**
 * The mode a followUp setting means. `enabled: false` predates the modes and
 * still means off; anything unrecognised means "always", which is what every
 * config written before the modes existed was getting.
 */
export function followUpMode(followUp = {}) {
  if (followUp?.enabled === false) return "off";
  return FOLLOW_UP_MODES.includes(followUp?.mode) ? followUp.mode : "always";
}

/** Did this reply end by asking something? Closing quotes and brackets don't count against it. */
export function endsWithQuestion(reply) {
  return /\?["'”’)\]\s]*$/.test(String(reply ?? ""));
}

/** Should the window stay open after this reply? */
export function keepsListening(reply, followUp = {}) {
  const mode = followUpMode(followUp);
  if (mode === "off") return false;
  if (mode === "question") return endsWithQuestion(reply);
  return true;
}
