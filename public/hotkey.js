// The push-to-talk key: one press and he is listening, no wake word needed.
//
// Written the way people write key combinations — "Ctrl+Alt+G", "F9",
// "Pause" — because that one string is read in three places: here in the page,
// by the server that stores it (lib/settings.js imports this file), and by
// Greg.exe, which claims it from Windows so it works whichever program you are
// in. launcher/Greg.cs parses the same format; KEY_NAMES below is the list it
// has to understand, so keep the two in step.
//
// DOM-free, like wake.js, so the rules are proven in Node.

const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Win"];

// Keys that are fine on their own, because nobody types them into anything.
const SOLO = new Set(["Pause", "ScrollLock", "Insert", ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`)]);

/** Every key name this format allows, besides the modifiers. */
export const KEY_NAMES = [
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  ..."0123456789",
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  "Space", "Pause", "ScrollLock", "Insert", "Home", "End", "PageUp", "PageDown",
];

const BY_LOWER = new Map(KEY_NAMES.map((name) => [name.toLowerCase(), name]));
const MODIFIER_ALIASES = {
  ctrl: "Ctrl", control: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  win: "Win", windows: "Win", meta: "Win", super: "Win", cmd: "Win",
};

/**
 * The one spelling of a combination, or "" if it is not one we will claim.
 *
 * Refused: a letter, digit, Space, Home or the like without Ctrl, Alt or Win —
 * claimed from Windows, "G" on its own would stop you typing the letter G in
 * every program on the machine. Shift alone does not make it safe, since
 * Shift+G is how a capital G is typed.
 */
export function normaliseHotkey(text) {
  const parts = String(text ?? "")
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length) return "";

  const mods = new Set();
  let key = null;
  for (const part of parts) {
    if (MODIFIER_ALIASES[part]) {
      mods.add(MODIFIER_ALIASES[part]);
      continue;
    }
    const name = BY_LOWER.get(part);
    if (!name || key) return ""; // unknown, or two ordinary keys
    key = name;
  }
  if (!key) return "";
  const guarded = mods.has("Ctrl") || mods.has("Alt") || mods.has("Win");
  if (!guarded && !SOLO.has(key)) return "";

  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join("+");
}

/** Why a combination was refused, in words for the Settings dialog. */
export function hotkeyProblem(text) {
  if (!String(text ?? "").trim() || normaliseHotkey(text)) return null;
  return `"${String(text).trim()}" can't be the talk key. Use a function key like F9, Pause, or a letter with Ctrl or Alt held, like Ctrl+Alt+G.`;
}

// KeyboardEvent.code, which names the physical key whatever Shift or the
// keyboard layout does to the character, mapped to the names above.
const FROM_CODE = {
  Space: "Space", Pause: "Pause", ScrollLock: "ScrollLock", Insert: "Insert",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
};

/**
 * The combination a keydown is, in the same spelling — or "" while only
 * modifiers are held, which is the moment somebody is still reaching for the key.
 */
export function hotkeyFromEvent(event) {
  const code = String(event?.code ?? "");
  let key = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1\d|2[0-4])$/.test(code)) key = code;
  else key = FROM_CODE[code] ?? null;
  if (!key) return "";

  const mods = [];
  if (event.ctrlKey) mods.push("Ctrl");
  if (event.altKey) mods.push("Alt");
  if (event.shiftKey) mods.push("Shift");
  if (event.metaKey) mods.push("Win");
  return [...mods, key].join("+");
}

/** Is this keydown the push-to-talk key? */
export function isHotkey(event, hotkey) {
  const wanted = normaliseHotkey(hotkey);
  return Boolean(wanted) && hotkeyFromEvent(event) === wanted;
}
