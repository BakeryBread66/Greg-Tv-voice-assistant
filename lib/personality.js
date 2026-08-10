// Who Greg is, as settings rather than a script.
//
// Five dials, a free-text note, and a switch for matching however the user
// happens to be talking. The point is that none of it is baked in: Greg is
// supposed to be whoever the person using him wants, and that person can change
// their mind out loud, mid-conversation, without editing a file.
//
// Values live in personality.json so a change made by voice survives a restart.
// config.json holds the starting point, the way it does for everything else.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILE = path.join(ROOT, "personality.json");

/**
 * Each dial runs 0-100 and is described in bands rather than as a number,
 * because "humour: 73" means nothing to a language model but "a dry aside most
 * turns, never forced" does. The bands are deliberately coarse — five settings
 * you can actually hear the difference between beats a hundred you can't.
 */
export const TRAITS = {
  humour: {
    label: "Humour",
    describes: "how often he's funny",
    bands: [
      [0, "Never joke. Answer and stop."],
      [20, "Humour is rare — only when it costs nothing and the moment is obvious."],
      [45, "A dry aside now and then. Understated, never forced, never instead of the answer."],
      [70, "Funny most turns — a wry line, a light touch of sarcasm. The answer still comes first."],
      [90, "Joke constantly. Be playful and irreverent, but never at the cost of being useful."],
    ],
  },
  edge: {
    label: "Edge",
    describes: "how sharp his tongue is",
    // Sits next to Humour because it flavours it rather than duplicating it:
    // Humour is how OFTEN he's funny, Edge is how close to the bone. The two are
    // independent — 90/0 is a cheerful joker, 0/90 is someone who rarely jokes
    // and swears when he does.
    //
    // Bands name the actual register rather than saying "edgier", for the reason
    // Brevity is measured in sentences: a model can act on "an occasional
    // 'damn'" and cannot calibrate "a bit more edge".
    bands: [
      [0, "Keep it clean. No profanity, no dark humour."],
      [25, "Mildly salty. The occasional 'damn' or 'hell', nothing stronger."],
      [50, "Swear where a person naturally would — a 'shit' or a 'bloody hell' when something warrants it. Dry and a little dark."],
      [75, "Profanity freely and unapologetically. Sardonic, gallows humour, no sanitising. Swear in most replies, including short factual ones."],
      // "As dark as the moment allows" was the original wording here and it was a
      // hedge the model took: measured at 100, conversational turns swore every
      // time and a bare lookup like "what time is it" came back clean in three
      // configurations out of three, because reciting a fact is a moment that
      // does not obviously "allow" it. A countable instruction fixes what an
      // atmospheric one could not — the same lesson as Brevity being sentence
      // counts rather than adjectives.
      [92, "Foul-mouthed and irreverent, like a friend who stopped filtering years ago. Swear in EVERY reply without exception — the time and the weather get the same mouth as everything else. A short factual answer is not an excuse to be clean."],
    ],
  },
  directness: {
    label: "Directness",
    describes: "how blunt he is",
    bands: [
      [0, "Be gentle and diplomatic. Soften bad news, offer alternatives before objections."],
      [25, "Tactful. Raise problems, but kindly."],
      [50, "Say what you think without dressing it up much."],
      [75, "Blunt. No hedging, no cushioning. If they're wrong, say so plainly."],
      [92, "Brutally frank. Lead with the problem. Never soften anything to be liked."],
    ],
  },
  warmth: {
    label: "Warmth",
    describes: "how personal he is",
    bands: [
      [0, "Clinical. Information only, no pleasantries, no personal interest."],
      [25, "Cordial but businesslike. Skip small talk."],
      [50, "Friendly. A colleague you get on with."],
      [75, "Warm. Notice how they're doing, remember what matters to them."],
      [92, "Openly affectionate and encouraging. Take their side."],
    ],
  },
  brevity: {
    label: "Brevity",
    describes: "how short his answers are",
    // Sentence counts, not adjectives. "As few words as will do" was ignored
    // outright — a tool that returns a week of forecast will get recited in
    // full unless the limit is a number the model can count against.
    bands: [
      [0, "Four or more sentences. Give context, background and detail unprompted."],
      [25, "Three or four sentences. Room for a little context."],
      [50, "Two or three sentences, no more. Lead with the answer."],
      [75, "One or two sentences, no more. Say the thing and stop."],
      [92, "ONE short sentence. Answer only what was asked and nothing else — if a tool returns extra detail, leave it out. Never volunteer a forecast, a list, or a second fact."],
    ],
  },
  formality: {
    label: "Formality",
    describes: "how proper he sounds",
    bands: [
      [0, "Very casual. Contractions, slang, the way a friend actually talks."],
      [25, "Relaxed and conversational."],
      [50, "Neutral. Plain, unfussy English."],
      [75, "Polished and precise. Full sentences, careful word choice."],
      [92, "Formal and measured, close to written prose. No slang at all."],
    ],
  },
};

// Edge defaults into the lowest band on purpose. A new dial appearing partway up
// would change how Greg talks for someone who never asked for it, and "he
// started swearing after an update" is not a good surprise. Everything else
// keeps the value it has always had.
const DEFAULTS = { humour: 45, edge: 15, directness: 60, warmth: 55, brevity: 70, formality: 30 };

let state = null;
let target = FILE;

function clamp(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(100, Math.round(number)));
}

/** Read the saved settings, falling back to config.json, then to the defaults. */
// `file` is injectable for the same reason it is in lib/settings.js: this module
// saves to one hard-coded path, so exercising the dials meant writing to the
// user's real personality.json. Defaults to it, so nothing changes in use.
export function initPersonality(config = {}, { file = FILE } = {}) {
  target = file;
  const configured = config.personality ?? {};
  const traits = {};
  for (const name of Object.keys(TRAITS)) {
    traits[name] = clamp(configured[name], DEFAULTS[name]);
  }

  state = {
    ...traits,
    // Free text, appended verbatim. The escape hatch for anything the dials
    // don't cover — an accent, a catchphrase, a thing never to say.
    style: typeof configured.style === "string" ? configured.style : "",
    // Match whoever is talking. This is the "reflect the user" part: terse
    // question, terse answer; formal question, formal answer.
    mirror: configured.mirror !== false,
  };

  // Anything changed by voice previously wins over the config file.
  try {
    const saved = JSON.parse(fs.readFileSync(target, "utf8"));
    for (const name of Object.keys(TRAITS)) {
      if (saved[name] !== undefined) state[name] = clamp(saved[name], state[name]);
    }
    if (typeof saved.style === "string") state.style = saved.style;
    if (typeof saved.mirror === "boolean") state.mirror = saved.mirror;
  } catch {
    // No file yet, or it's unreadable — the config values stand.
  }

  return getPersonality();
}

export function getPersonality() {
  if (!state) initPersonality();
  return { ...state };
}

/**
 * Change one dial. Returns what it became, or an error the model can read out.
 * @param {string} trait
 * @param {number} percent
 */
export function setTrait(trait, percent) {
  if (!state) initPersonality();

  const name = String(trait ?? "").trim().toLowerCase();
  if (!TRAITS[name]) {
    return { error: `there's no "${trait}" setting. The dials are ${Object.keys(TRAITS).join(", ")}.` };
  }

  const value = clamp(percent, null);
  if (value === null) return { error: `"${percent}" isn't a number between 0 and 100.` };

  const was = state[name];
  state[name] = value;
  save();

  const result = { trait: name, was, now: value, meaning: bandFor(name, value) };

  // Turning a dial DOWN is not symmetrical with turning it up, and it took a
  // measurement to notice. Raising it works on the next reply: the instruction
  // is new and nothing contradicts it. Lowering it competes with the
  // conversation history, which now holds several of his own replies in the old
  // register — and a model imitates its own recent turns. Measured on Edge: set
  // back to 15 he still swore on the next answer and was clean by the one after;
  // with the history cleared he was clean immediately, three turns out of three.
  if (was - value >= 30) {
    result.note =
      "Lowering a dial can take a turn or two — you have recent replies in the old style and he copies himself. " +
      "Tell the user they can press the reset button for a clean start if they want it immediately.";
  }

  return result;
}

/** The free-text note, for anything the dials can't express. */
export function setStyle(text) {
  if (!state) initPersonality();
  state.style = String(text ?? "").trim().slice(0, 400);
  save();
  return { style: state.style };
}

export function setMirror(on) {
  if (!state) initPersonality();
  state.mirror = Boolean(on);
  save();
  return { mirror: state.mirror };
}

function save() {
  try {
    fs.writeFileSync(target, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.warn(`[personality] couldn't save: ${err.message}`);
  }
}

function bandFor(trait, value) {
  const bands = TRAITS[trait].bands;
  let chosen = bands[0][1];
  for (const [threshold, text] of bands) if (value >= threshold) chosen = text;
  return chosen;
}

/**
 * The block that goes into the system prompt.
 *
 * Written as instructions the model can act on, not as adjectives. "Warmth 55"
 * is not actionable; "Friendly. A colleague you get on with." is.
 */
export function describePersonality() {
  if (!state) initPersonality();

  const lines = Object.keys(TRAITS).map(
    (name) => `- ${TRAITS[name].label} ${state[name]}%: ${bandFor(name, state[name])}`
  );

  let block =
    `\n\nPersonality. The user chose these settings — follow them, and don't mention them unless asked:\n` +
    lines.join("\n");

  if (state.mirror) {
    block +=
      `\n- Match the user's own register. If they're brief, be brief; if they're casual, be casual; ` +
      `if they're precise, be precise. Their tone sets yours, within the settings above.`;
  }

  if (state.style) block += `\n- Also, from the user: ${state.style}`;

  // Only when it is actually turned up. Added unconditionally this is ~20 tokens
  // on every single turn to guard against a setting that is off by default, and
  // this project already counts the per-turn overhead carefully. Same code gate
  // as the deixis paragraph: no trigger, no paragraph, nothing to get wrong.
  if (state.edge >= 50) {
    block +=
      `\n- Your Edge setting is about your own register — swearing, dark humour, not softening things. ` +
      `It is never aimed AT the user. Be as foul-mouthed as the setting says about the situation, the ` +
      `weather or yourself; do not turn it on the person you are talking to.`;
  }

  block +=
    `\nThese settings describe how you say things, never whether you're accurate. ` +
    `Never let any of them talk you into inventing something or skipping a tool call.`;

  return block;
}

/** A spoken summary, for when the user asks what he's set to. */
export function personalityToSentence() {
  if (!state) initPersonality();
  const parts = Object.keys(TRAITS).map((name) => `${TRAITS[name].label.toLowerCase()} ${state[name]}`);
  const tail = state.style ? ` You also asked me to: ${state.style}` : "";
  return `Right now: ${parts.join(", ")}, all out of a hundred.${tail}`;
}
