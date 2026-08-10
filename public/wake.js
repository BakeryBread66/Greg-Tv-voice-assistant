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

// Anchored, so "never mind the weather" is a question about the weather rather
// than a cancellation — the whole utterance has to be the dismissal.
const CANCEL = /^(never mind|nevermind|stop|cancel|forget it|nothing)$/;

/** Was that a dismissal rather than a question? */
export function isCancel(said) {
  return CANCEL.test(said);
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
