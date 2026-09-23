// Where Greg's brain is running, said in the window — the whole time.
//
// The boot screen already lists the brain, but it is on screen for four
// seconds. When the brain is Claude, every word said to him goes to
// Anthropic's servers for as long as the session lasts, so that has to be
// visible for as long as it is true: a badge in the title bar, which nothing
// covers, and a sentence in the status bar saying what it means.
//
// Split the way boot.js and wake.js are: the decision is a pure function Node
// can test, and the few lines that touch the page are kept apart from it.

/**
 * What the window should say about where the brain runs — or null when it is
 * on this PC, which is the normal case and gets no badge.
 *
 * Claude is recognised by its kind as well as by the where-field, so a page
 * talking to a server from before that field existed still shows the badge.
 * This exists to disclose, and hiding it is the wrong way to be wrong.
 *
 * @param {object} info  the /api/config payload
 */
export function brainPlace(info = {}) {
  if (!info || !info.hasBrain) return null;
  const claude = info.brainKind === "anthropic";
  if (!claude && info.brainOnThisMachine !== false) return null;

  const service = String(info.brainService || (claude ? "Anthropic" : "another computer"));
  const who = claude ? "Greg is thinking with Claude, on Anthropic's servers" : `Greg's brain is running on ${service}`;
  const remedy = claude
    ? 'To keep it all on this PC, set "provider" to "ollama" in config.json and restart him.'
    : 'To keep it all on this PC, point "ollama.url" at this machine and use a model without a cloud tag.';

  return {
    claude,
    badge: claude ? "☁ CLAUDE · CLOUD" : "☁ NOT THIS PC",
    detail: claude ? "Brain: Claude, on Anthropic's servers, not this PC" : `Brain: on ${service}, not this PC`,
    tooltip:
      `${who}. What you say, the facts he remembers about you, where you are, and whatever his tools ` +
      `fetch for you are sent there to be answered. ${remedy}`,
  };
}

/**
 * Paint it. Every element is optional — a stripped-down page without the
 * badge must not throw, the same rule setTitle() follows in voice.js.
 */
export function showBrainPlace(info, doc = globalThis.document) {
  if (!doc) return null;
  const place = brainPlace(info);
  const badge = doc.getElementById("cloud-brain");
  const where = doc.getElementById("brain-where");

  if (badge) {
    badge.hidden = !place;
    badge.textContent = place?.badge ?? "";
    badge.title = place?.tooltip ?? "";
  }
  if (where) {
    where.textContent = place?.detail ?? "";
    where.title = place?.tooltip ?? "";
    where.classList.toggle("cloud", Boolean(place));
  }
  return place;
}
