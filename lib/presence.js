// How long the user has been away from the machine.
//
// Greg already tracks the desktop cursor for the head-turn. This uses the same
// fact differently: if you have been gone an hour, he should know when you come
// back rather than answering as though you never left.
//
// Deliberately NOT a polling loop or a background process. The only moment this
// matters is when you speak to him, so the browser sends how long it has been
// since it saw you along with the message. Nothing runs when nobody is asking —
// the same reasoning that keeps the cursor watcher asleep.
//
// The greeting is produced HERE, in code, and prepended to the reply. It was
// first attempted as an instruction in the system prompt, twice:
//
//   "You may acknowledge it in a few words if it fits naturally"  -> ignored
//   "Open with a SHORT greeting... this overrides brevity"        -> ignored
//
// Verified the paragraph was reaching the model (the prompt grew from 6555 to
// 6948 characters) and that gemma4 simply did not act on it — Brevity 70 tells
// it to be terse and it obeyed the dial over the instruction, at 47 minutes and
// at five hours alike. CLAUDE.md's second habit covers exactly this: reach for a
// code gate before a fourth prompt rewrite. Deixis, plurals, acronyms and place
// resolution all went the same way.

// Below this, a gap is not worth remarking on — you were reading, or making tea.
const NOTABLE_SECONDS = 20 * 60;

// Above this the exact number stops being interesting. Nobody wants "you have
// been away for nine hours and forty minutes".
const LONG_SECONDS = 6 * 60 * 60;

/**
 * A short greeting for someone who has just come back, or null.
 *
 * Returning null for the ordinary case is the whole design — most questions get
 * no greeting at all, and nothing about absence ever enters the prompt.
 *
 * Kept to a few words on purpose. The failure mode of a returning-user greeting
 * is that it grows into a production and buries the answer, which is the same
 * shape as the restaurant Greg described at length without ever naming.
 */
export function greetingFor(awaySeconds) {
  const away = Number(awaySeconds);
  if (!Number.isFinite(away) || away < NOTABLE_SECONDS) return null;

  if (away >= LONG_SECONDS) return "Welcome back.";
  if (away >= 5400) return `Welcome back — it's been a couple of hours.`;
  return "Welcome back.";
}
