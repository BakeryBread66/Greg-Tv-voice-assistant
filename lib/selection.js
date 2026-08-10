// What the globe is currently looking at.
//
// One value, shared between the dashboard and the brain, so that spinning to
// Tokyo and then saying "what's the news here?" means Tokyo. Kept in its own
// module rather than passed around because both the HTTP layer and the tool
// layer need it and neither owns the other.
//
// It expires. A selection you made an hour ago is not what "here" means any
// more, and silently answering about somewhere you've forgotten you clicked is
// worse than just answering about home.

const LIFETIME = 30 * 60 * 1000;

let selected = null;
let selectedAt = 0;

/** @param {{city:string, region?:string, latitude:number, longitude:number}|null} place */
export function setSelectedPlace(place) {
  selected = place;
  selectedAt = place ? Date.now() : 0;
}

export function getSelectedPlace() {
  if (!selected) return null;
  if (Date.now() - selectedAt > LIFETIME) {
    selected = null;
    return null;
  }
  return selected;
}

// Words that actually point at something. Deciding this here, in code, rather
// than asking the model to work out whether "here" means the globe or the room.
const POINTING = /\b(here|there|that (place|country|city|spot|one)|this (place|country|city|spot))\b/i;

/**
 * How to describe the selection in the system prompt.
 *
 * Returns "" unless the user actually pointed at something, which is the whole
 * trick. Left in the prompt permanently it poisons the ordinary questions —
 * "what's the weather" started answering for Iceland — and worded softly enough
 * not to do that, it stopped working for "the weather here". Prompt tuning
 * oscillated between those two failures for several rounds because a small
 * model resolves deixis inconsistently.
 *
 * Gating on the user's own words makes it deterministic: no pointing word, no
 * selection, no ambiguity for the model to get wrong.
 *
 * It also has to sit immediately after the line naming their home city, and
 * contradict it in as many words. Further down the prompt it simply loses to
 * "you always know their location".
 */
export function describeSelection(userText = "") {
  if (!POINTING.test(String(userText))) return "";

  const place = getSelectedPlace();
  if (!place) return "";
  const name = [place.city, place.region].filter(Boolean).join(", ");
  return (
    ` RIGHT NOW they have ${name} selected on the globe in their Global Dashboard. ` +
    `While that is selected, "here", "there" and "that place" mean ${name} and NOT their home city — ` +
    `including "the weather here", "the news here" and "what time is it here". Pass "${name}" as the place ` +
    `argument to the tool — get_weather, get_local_news and get_current_time all take one. ` +
    `Only fall back to their home city if they say something like "back home" or "where I am".`
  );
}
