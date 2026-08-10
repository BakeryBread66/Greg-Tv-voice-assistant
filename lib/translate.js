// Turning foreign headlines into English, with the brain that is already here.
//
// No service, no key, no new dependency: the local model reads Korean well
// enough for a headline, and a translation API would be the one part of the news
// path that phoned somebody. It is only ever asked when the edition is genuinely
// not English — lib/editions.js decides that, and an English edition never
// reaches this file at all.

/**
 * Translate a list of headlines, keeping the list the same length.
 *
 * Length is the whole contract. The caller pairs the result back onto the
 * stories by index, so a model that helpfully merges two headlines or adds a
 * preamble would silently attach the wrong translation to the wrong story —
 * which is worse than not translating, because it looks right. A mismatch is
 * rejected and the originals stand.
 */
export async function translateHeadlines(provider, headlines, language) {
  if (!provider?.complete || !headlines?.length) return null;

  const numbered = headlines.map((h, i) => `${i + 1}. ${h}`).join("\n");

  const { text } = await provider.complete({
    system:
      `You translate news headlines from ${language} into English. ` +
      `Reply with the translations only, numbered 1 to ${headlines.length}, one per line, in the same order. ` +
      `Translate the meaning as a British newspaper would write the headline — no explanations, no notes, ` +
      `no transliteration, and do not merge or split any of them. If a line is already English, repeat it unchanged.`,
    messages: [{ role: "user", content: numbered }],
    tools: [],
  });

  return parseNumbered(text, headlines.length);
}

/**
 * Pull an n-line numbered list back out of whatever the model wrote.
 *
 * Exported and pure because this is where it will go wrong: small models add
 * "Here are the translations:", wrap lines, or renumber from zero. Anything that
 * does not yield exactly the expected count returns null, and null means the
 * original headlines are used unchanged.
 */
export function parseNumbered(text, expected) {
  const lines = String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    // Only lines that actually start with a number: it is what drops a
    // "Here are the translations:" preamble without needing to recognise it.
    .filter((line) => /^\d+\s*[.):-]/.test(line))
    .map((line) => line.replace(/^\d+\s*[.)::-]\s*/, "").trim())
    .filter(Boolean);

  return lines.length === expected ? lines : null;
}
