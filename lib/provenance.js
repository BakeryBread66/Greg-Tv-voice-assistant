// Where the last answer came from.
//
// `think()` already knows exactly which tools it called and what they returned,
// and has always thrown that away the moment the reply was sent. So Greg could
// tell you the forecast and, asked "how do you know that?", had nothing to go on
// but the reply he had just written — which is the one situation this project
// spends most of its rules preventing.
//
// One record, replaced each turn. Its own module rather than a field on
// brain.js because the tool that reads it lives in lib/tools/, and brain.js
// already imports that — the loop would be circular the other way round.

let last = null;

/** A short, honest line about what one tool call actually did. */
export function summarise(name, args = {}, result = {}) {
  if (result?.error) return `${name} failed: ${result.error}`;

  const published = result?.published ?? result?.topResult?.published;
  const dated = published ? ` (published ${published})` : "";

  switch (name) {
    case "search_web": {
      const source = result?.topResult?.source;
      return `searched the web for "${args.query ?? ""}"` + (source ? `, then read ${source}${dated}` : ", but opened nothing");
    }
    case "read_page":
      return `read ${result?.source ?? args.url ?? "a page"}${dated}`;
    case "get_weather":
      return `checked the forecast for ${result?.place ?? result?.city ?? "here"}`;
    case "get_local_news":
      return "fetched the news headlines";
    case "get_current_time":
      return "checked the clock";
    case "recall_conversation":
      return `searched the conversation log for "${args.query ?? ""}"`;
    case "get_market":
      return "read the market figures";
    case "get_engineering":
      return "read this machine's hardware";
    default:
      return `called ${name}`;
  }
}

/**
 * Keep what this turn did.
 *
 * `steps` is empty when the model answered without calling anything, and that is
 * the single most useful thing this records — "I answered from what I already
 * knew" is exactly what a person asking "how do you know?" needs to hear, and it
 * is the answer Greg could never previously give.
 */
export function record({ question, reply, steps }) {
  last = { question, reply, steps, at: Date.now() };
}

export function lastAnswer() {
  return last;
}

/** Only used by the tests, so one case cannot leak into the next. */
export function forget() {
  last = null;
}
