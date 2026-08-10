// Splits Greg's reply into speakable chunks, as the text arrives.
//
// This is what lets him start talking before the whole answer exists. Getting the
// boundaries wrong is audible in a way it never is on screen: split too eagerly
// and "seventy-three degrees" becomes "seventy-three. Degrees"; split too late
// and there was no point streaming at all.

// Abbreviations whose full stop does NOT end a sentence.
const ABBREVIATIONS =
  /\b(mr|mrs|ms|dr|prof|sr|jr|st|mt|vs|etc|e\.g|i\.e|approx|dept|est|fig|no|inc|ltd|co|corp|gov|univ|a\.m|p\.m|u\.s|u\.k)\.$/i;

// Below this, a "sentence" is usually a fragment ("Sure." / "Right.") and is
// better glued onto the next one than sent to the synthesizer alone — one-word
// clips sound clipped and cost a round trip each.
const MIN_CHARS = 24;

/**
 * Accumulates streamed text and hands back whole sentences as they complete.
 *
 * Usage:
 *   const splitter = createSentenceSplitter();
 *   splitter.push(delta)  -> string[] of sentences ready to speak
 *   splitter.flush()      -> string[] with whatever is left over
 */
export function createSentenceSplitter({ minChars = MIN_CHARS } = {}) {
  let buffer = "";
  let pending = ""; // a complete-but-too-short sentence waiting for company

  function take(sentence) {
    const combined = (pending ? `${pending} ` : "") + sentence;
    if (combined.length < minChars) {
      pending = combined;
      return null;
    }
    pending = "";
    return combined;
  }

  return {
    push(delta) {
      buffer += delta;
      const out = [];

      // Scan for a terminator that genuinely ends a sentence.
      let index;
      while ((index = findBoundary(buffer)) !== -1) {
        const sentence = buffer.slice(0, index + 1).trim();
        buffer = buffer.slice(index + 1);
        if (!sentence) continue;
        const ready = take(sentence);
        if (ready) out.push(ready);
      }

      return out;
    },

    flush() {
      const out = [];
      const rest = buffer.trim();
      buffer = "";
      // Whatever is left is the end of the reply, so length no longer matters —
      // emit it even if it's short, or the last few words are never spoken.
      const combined = [pending, rest].filter(Boolean).join(" ").trim();
      pending = "";
      if (combined) out.push(combined);
      return out;
    },
  };
}

// Index of the character that ends the first complete sentence, or -1.
function findBoundary(text) {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char !== "." && char !== "!" && char !== "?" && char !== "\n") continue;

    // A newline always ends a chunk — models use them as list separators, and a
    // pause there sounds right.
    if (char === "\n") return i;

    // "3.5" and "1.2 miles" — a digit either side means it's a decimal point.
    if (char === "." && /\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "")) continue;

    // Run the terminator out over "?!" and "..." so they stay together.
    let end = i;
    while (end + 1 < text.length && /[.!?]/.test(text[end + 1])) end++;

    // Needs whitespace after it, or we can't yet tell the sentence has finished
    // — the next delta might turn "Dr" into "Dr." into "Dr. Who".
    const next = text[end + 1];
    if (next === undefined) return -1;
    if (!/\s/.test(next)) continue;

    if (ABBREVIATIONS.test(text.slice(0, end + 1))) continue;

    // A single capital before the dot is an initial: "J. R. R. Tolkien".
    if (char === "." && /(^|\s)[A-Z]$/.test(text.slice(0, i))) continue;

    return end;
  }

  return -1;
}
