// Page 888 — what he is saying, on the screen.
//
// The decisions live here rather than in face-tv.js for the reason wake.js and
// volume.js do: they are testable in Node and the renderer is not.
//
// Subtitles exist here to close an honesty gap rather than for period charm.
// Turn the volume down and Greg carries on talking into silence — the answer is
// spoken, the conversation log records it, and he will follow up as though he
// told you something. He did not. Putting the words on the screen is what makes
// "he answered" true again, and it is exactly what a television does when you
// mute it.

/**
 * Should the subtitles be up?
 *
 *   auto    on when he is muted — the default, and the reason this exists
 *   always  on regardless, for anyone who wants them
 *   off     never, even muted
 *
 * "off" is a real choice and not a missing feature: somebody who mutes him on
 * purpose in a quiet room may not want the picture covered in text either. But
 * it is off-by-choice, which is different from off-by-accident — the state this
 * whole feature exists to remove.
 *
 * An unrecognised mode reads as "auto" rather than as "off". A typo in
 * config.json must not silently take the subtitles away from a muted set,
 * because the failure would be invisible: no error, and no words.
 */
export function subtitlesFor(mode, volume) {
  if (mode === "off") return false;
  if (mode === "always") return true;
  return Number(volume) <= 0;
}

/**
 * Which sentence of a multi-sentence clip is being spoken, as a fraction of the
 * way through it.
 *
 * Sentences 2..N of a reply are synthesized as ONE call so Piper picks its own
 * pauses — see the chunking note in CLAUDE.md. That gives better prosody and
 * takes away the seam the subtitles used to sit on: one clip would mean one
 * subtitle for the whole remainder, which clips at four lines and on a muted set
 * is the only copy of the answer.
 *
 * So the subtitle is advanced through the clip instead, weighted by characters.
 * That is an approximation — it assumes a roughly constant speaking rate, which
 * is true enough of a TTS voice reading one passage and would not be of a person
 * — and it is a far better one than showing a quarter of the answer. Nothing
 * depends on it being exact: being a word late changes nothing, and the words
 * are all on screen either way.
 *
 * Deliberately NOT clock-based. A timer would drift against the audio the moment
 * anything stalled, and would keep running after an interruption.
 */
export function sentenceAt(sentences, progress) {
  const list = (sentences ?? []).filter((s) => String(s ?? "").trim());
  if (!list.length) return null;
  if (list.length === 1) return list[0];

  // Absence before conversion: Number(null) and Number("") are both 0, which is
  // a perfectly valid progress and would silently pin the subtitle to the first
  // sentence for the whole clip. Number(null) has bitten this project seven
  // times; this is the eighth place it could have.
  const fraction = Number.isFinite(Number(progress)) ? Math.min(1, Math.max(0, Number(progress))) : 0;

  const lengths = list.map((s) => s.trim().length);
  const total = lengths.reduce((a, b) => a + b, 0);
  if (!total) return list[0];

  let seen = 0;
  for (let i = 0; i < list.length; i++) {
    seen += lengths[i];
    // Strictly less-than, so a progress of exactly 1 lands on the last sentence
    // rather than falling off the end.
    if (fraction < seen / total) return list[i];
  }
  return list[list.length - 1];
}

/**
 * A sentence as up to `maxLines` lines of at most `maxChars`.
 *
 * Character-counted, not measured in pixels, because the subtitle is drawn in
 * the teletext font and a monospace grid is what it actually sits on — the same
 * reason Ceefax counts characters. It also makes this provable without a canvas.
 *
 * Overlong text loses its END, with an ellipsis, rather than being shrunk to
 * fit. A subtitle that changes size sentence to sentence is unreadable, and a
 * sentence long enough to overflow two lines at these sizes is rare enough that
 * clipping it is better than making every other line smaller.
 */
export function subtitleLines(text, maxChars, maxLines = 2) {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  if (!words.length || maxChars < 1) return [];

  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    // A single word longer than a whole line — a URL, a hyphenated place name —
    // is cut rather than allowed to run off the edge of the picture.
    line = word.length > maxChars ? word.slice(0, maxChars) : word;
    if (lines.length >= maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);

  if (lines.length > maxLines) lines.length = maxLines;

  // Mark the truncation, so a clipped sentence looks clipped rather than
  // looking like Greg stopped mid-thought.
  const spoken = words.join(" ");
  const shown = lines.join(" ");
  if (shown.length < spoken.length && lines.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = `${last.slice(0, Math.max(0, maxChars - 1))}…`;
  }
  return lines;
}
