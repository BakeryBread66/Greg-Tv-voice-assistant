// Gives Greg his voice.
//
// Three backends, same interface, tried in order:
//
//   lib/tts-clone.js   local, offline, a cloned voice, ~1.3x realtime on the GPU
//   lib/tts-piper.js   local, offline, ~40x realtime on the CPU
//   lib/tts-edge.js    Microsoft's neural voices, needs internet
//
// Each one steps down to the next rather than failing, so a missing venv, a dead
// sidecar or a machine without Python all cost character rather than speech. The
// browser's own voice sits under all three, in public/voice.js.
//
// A disk cache sits in front of the lot. It earns its place only because of the
// clone: Piper answers in milliseconds, the clone takes seconds.

import { speakCloned, cloneStatus } from "./tts-clone.js";
import { speakLocally, piperStatus } from "./tts-piper.js";
import { synthesize as synthesizeRemote } from "./tts-edge.js";
import { speakWithSystemVoice, sapiStatus } from "./tts-sapi.js";
import { cacheKey, readCache, writeCache, setCleaner } from "./tts-cache.js";

// Initialisms espeak already says as words. Everything else in capitals gets
// spelled out, so this list is the place to add anything that comes out
// spelled when it shouldn't be.
const SAID_AS_WORDS = new Set([
  "NASA", "NATO", "SCUBA", "LASER", "RADAR", "SONAR", "UNESCO", "UNICEF", "OPEC",
  "AIDS", "SARS", "COVID", "NOAA", "FEMA", "OSHA", "NIMBY", "ASCII", "JPEG",
  "GIF", "PNG", "RAM", "ROM", "SIM", "WIFI", "JSON", "ZIP", "PIN",
  // Ordinary words that would be nonsense spelled out if a model ever shouts.
  "THE", "AND", "NOT", "YES", "ALL", "NEW", "OFF", "OUT", "NOW", "ONE", "TWO",
]);

// Piper phonemizes literally: "**cold**" comes out as "asterisk asterisk cold
// asterisk asterisk", an emoji as "sun with face", and a URL spelled character by
// character. Models produce all three often enough to matter, so strip them
// before either backend sees the text.
function speakable(text) {
  return (
    String(text ?? "")
      // Fenced and inline code, before anything else eats the backticks.
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]*)`/g, "$1")
      // Markdown links: keep the words, drop the target.
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, " ")
      // Emphasis and heading marks. Underscores only when they wrap a word, so
      // file_name survives intact.
      .replace(/(\*\*|\*|__)(\S(?:.*?\S)?)\1/g, "$2")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      // Bullets at the start of a line — the marker is layout, not speech.
      .replace(/^\s*[-*+]\s+/gm, "")
      // Symbols that have a name but no sound.
      .replace(/°\s*([CF])\b/g, " degrees")
      .replace(/°/g, " degrees")
      .replace(/&/g, " and ")
      // Anything pictographic, including the invisible pieces — a variation
      // selector left behind by a stripped emoji is still a character espeak
      // has to make a decision about.
      .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}‍️]/gu, " ")
      // Initialisms. espeak spells most of them correctly by itself — BBC, FBI,
      // CPU and NHS all come out right — but it says the ones that happen to
      // look like a pronounceable word AS a word: "UNCW" becomes "UNK-wuh".
      // Separating the letters forces spelling, and changes nothing for the
      // ones it already handled.
      //
      // Spaces rather than dots, decided by running both through Piper's own
      // phonemizer: "U.N.C.W." detaches a possessive into a stray "z", and a
      // dotted form mid-sentence made espeak pronounce the word "dot" out loud.
      //
      // Two-letter forms are left alone — NC, TV, AI and US are already right,
      // and skipping them keeps ordinary short words out of range.
      // A plural "s" needs its own space or it glues to the last letter and is
      // read as a word — "CPUs" became "C P Us", said as "see pee us". A
      // possessive "'s" is the opposite: attached, it correctly voices as a "z".
      .replace(/\b([A-Z]{3,6})('?s)?\b/g, (match, letters, suffix) => {
        if (SAID_AS_WORDS.has(letters)) return match;
        const spelled = letters.split("").join(" ");
        if (!suffix) return spelled;
        return suffix === "s" ? `${spelled} s` : `${spelled}${suffix}`;
      })
      .replace(/\s+/g, " ")
      .trim()
  );
}

// The cache keys phrases through the same cleaner synthesis uses, so a warmed
// phrase and a spoken one land on the same entry.
setCleaner(speakable);

/**
 * Identify the voice precisely enough to key a cache on it.
 *
 * Everything that changes how the audio sounds belongs here. Miss one and a
 * config change would keep serving the previous voice from disk — silently,
 * which is the worst way for it to be wrong.
 */
function currentVoiceId(options) {
  const clone = cloneStatus();
  if (clone.state === "ready") {
    // precision belongs here for the same reason the dials do: fp16 and fp32 are
    // the same voice saying the same words and are NOT the same audio, so a clip
    // cached under one must miss under the other.
    return `clone:${clone.reference}:${clone.exaggeration}:${clone.cfgWeight}:${clone.temperature}:${clone.precision}`;
  }
  const piper = piperStatus();
  if (piper.state === "ready") return `piper:${piper.voice}`;
  const sapi = sapiStatus();
  if (sapi.state === "ready") return `sapi:${sapi.voice}:${sapi.rate}`;
  return `edge:${options.voice ?? ""}:${options.rate ?? ""}:${options.pitch ?? ""}`;
}

/**
 * Turn text into audio.
 *
 * Returns the content type alongside the bytes because the backends don't agree
 * on a format — the clone gives 24kHz WAV, Piper 22kHz WAV, Edge 24kHz MP3. The
 * browser plays any of them, but it has to be told which it got.
 *
 * @returns {Promise<{ audio: Buffer, contentType: string, source: "clone" | "local" | "cloud", cached?: boolean }>}
 */
export async function synthesize(text, options = {}) {
  const clean = speakable(text);
  if (!clean) return { audio: Buffer.alloc(0), contentType: "audio/wav", source: "local" };

  const voiceId = currentVoiceId(options);
  const key = cacheKey(voiceId, clean);

  const cached = readCache(key);
  if (cached) return { ...cached, source: "cache", cached: true };

  if (cloneStatus().state === "ready") {
    try {
      const audio = await speakCloned(clean);
      writeCache(key, audio, "audio/wav");
      return { audio, contentType: "audio/wav", source: "clone" };
    } catch (err) {
      // A dead clone costs Greg his character, not his answer.
      console.warn(`[voice] cloned synthesis failed (${err.message}) — falling back to Piper`);
    }
  }

  if (piperStatus().state === "ready") {
    try {
      const audio = await speakLocally(clean);
      writeCache(key, audio, "audio/wav");
      return { audio, contentType: "audio/wav", source: "local" };
    } catch (err) {
      // Don't go mute over a hiccup in the local voice — say it in the cloud one.
      console.warn(`[voice] local synthesis failed (${err.message}) — using the cloud voice`);
    }
  }

  // Windows' own voice, before the cloud rather than after it.
  //
  // This is the step that keeps the offline promise honest. Without it, a local
  // voice failing sent the text straight to Microsoft's servers — true of the
  // clone failing, of Piper failing, and of both — so the property this project
  // leads with stopped holding at exactly the moment something had gone wrong
  // and nobody was watching. It is the plainest voice of the four and that is
  // fine: the job here is to still be local, not to sound good.
  if (sapiStatus().state === "ready") {
    try {
      const audio = await speakWithSystemVoice(clean);
      writeCache(key, audio, "audio/wav");
      return { audio, contentType: "audio/wav", source: "system" };
    } catch (err) {
      console.warn(`[voice] the system voice failed (${err.message}) — using the cloud voice`);
    }
  }

  const audio = await synthesizeRemote(clean, options);
  writeCache(key, audio, "audio/mpeg");
  return { audio, contentType: "audio/mpeg", source: "cloud" };
}

export { speakable };
