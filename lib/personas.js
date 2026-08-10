// Who he is, as data rather than as a line of code.
//
// The six dials in lib/personality.js decide how he SAYS things. Nothing decided
// who he was: the system prompt opened "You are Greg — ... in the spirit of
// Jarvis from Iron Man", hard-coded, so setting `name` to anything else renamed
// the wake word, the window, the boot screen and the badge while leaving him
// convinced he was still Greg. Anyone cloning this repo met that in the first
// five minutes.
//
// A persona is one small JSON file: a name, a sentence saying what he is, the
// dials, a style line and the mirror switch. Applying one goes through the same
// settings and personality modules a slider does, so there is still exactly one
// place each of those values lives.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FOLDER = path.join(ROOT, "personas");

// The identity clause is interpolated straight into the system prompt, so it is
// capped and flattened to one line. A persona file is as trusted as config.json
// — it is on your disk because you put it there — but "trusted" and "allowed to
// paste four paragraphs into every turn" are different things, and a stray
// newline in a downloaded persona should not be able to restructure the prompt.
const MAX_IS = 240;
const MAX_STYLE = 400;

const clean = (value, max) =>
  String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** One persona file, validated into something safe to apply. */
function parse(id, raw) {
  const name = clean(raw?.name, 30);
  const is = clean(raw?.is, MAX_IS);
  if (!name || !is) return null;

  const traits = {};
  for (const [key, value] of Object.entries(raw?.traits ?? {})) {
    const n = Number(value);
    // Clamped rather than rejected: a persona with humour: 200 should be loud,
    // not broken. setTrait clamps too — this keeps the preview honest.
    if (Number.isFinite(n)) traits[key] = Math.max(0, Math.min(100, Math.round(n)));
  }

  // A voice the machine may or may not have, and a treatment for it. Both
  // optional: a persona is a character first, and one that names no voice keeps
  // whichever is loaded rather than being rejected.
  const voice = clean(raw?.voice, 80);
  const vocoder =
    raw?.vocoder && typeof raw.vocoder === "object"
      ? {
          enabled: raw.vocoder.enabled === true,
          amount: Math.max(0, Math.min(1, Number(raw.vocoder.amount) || 0)),
        }
      : null;

  return {
    id,
    name,
    is,
    traits,
    voice,
    vocoder,
    style: clean(raw?.style, MAX_STYLE),
    mirror: raw?.mirror !== false,
    description: clean(raw?.description, 120),
  };
}

/** Every persona on disk, by id. Read fresh so adding a file needs no restart. */
export function listPersonas() {
  let files = [];
  try {
    files = fs.readdirSync(FOLDER).filter((f) => f.endsWith(".json"));
  } catch {
    return []; // no folder is not an error — he simply keeps the one he has
  }

  return files
    .map((file) => {
      try {
        return parse(path.basename(file, ".json"), JSON.parse(fs.readFileSync(path.join(FOLDER, file), "utf8")));
      } catch {
        // One malformed file must not cost you the rest of them.
        console.warn(`[persona] ignoring ${file} — it is not valid JSON`);
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Find a persona by id or name, however it was said out loud.
 *
 * Resolved in code rather than by the model, for the reason every other lookup
 * in this project is: "put the butler on" and "be the butler" and "butler" all
 * mean one thing, and a regex settles it the same way every time.
 */
export function resolvePersona(wanted) {
  // Hyphens and underscores fold to spaces on BOTH sides: the file is called
  // flight-computer.json and nobody says "flight hyphen computer" out loud.
  // Without this the id was unreachable by voice — caught by running it.
  const flatten = (text) => String(text ?? "").toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();

  const said = flatten(wanted);
  if (!said) return null;

  const all = listPersonas();
  const keys = (p) => [flatten(p.id), flatten(p.name)];

  return (
    all.find((p) => keys(p).includes(said)) ??
    // Longest key first, so a persona called "Ship" cannot beat "flight
    // computer" by sitting inside a longer phrase.
    all
      .flatMap((p) => keys(p).map((key) => ({ p, key })))
      .sort((a, b) => b.key.length - a.key.length)
      .find(({ key }) => said.includes(key))?.p ?? null
  );
}

/** The patch that applySettings() needs to become this persona. */
export function personaPatch(persona) {
  const patch = {
    name: persona.name,
    identity: persona.is,
    personality: { ...persona.traits, style: persona.style, mirror: persona.mirror },
  };
  // Only when the persona actually asks. A character that says nothing about
  // how it sounds should leave the voice and the treatment where they are,
  // rather than resetting them to some default it never expressed.
  if (persona.voice) patch.voice = persona.voice;
  if (persona.vocoder) patch.vocoder = persona.vocoder;
  return patch;
}
