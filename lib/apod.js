// NASA's Astronomy Picture of the Day. One photograph a day, keyless.
//
// Keyless via DEMO_KEY, and that is the whole design constraint here: DEMO_KEY
// is rate limited to **30 requests an hour and 50 a day, per IP** — shared with
// every other keyless caller behind the same address. The first probe from this
// machine came back with 8 remaining. So this caches hard, on disk, and treats
// a 429 as "keep showing yesterday's picture" rather than as an error.
//
// A free personal key from api.nasa.gov lifts that to 1,000/hour and needs
// nothing but an email address. `config.apod.key` takes one if the user ever
// wants it; nothing here requires it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CACHE_DIR = path.join(ROOT, "cache", "apod");

// The picture changes once a day. Asking again inside that is spending one of
// fifty daily requests to be told the same thing.
const METADATA_TTL_MS = 6 * 60 * 60 * 1000;

let cached = null;      // the last good metadata
let fetchedAt = 0;
let inFlight = null;
let image = null;       // { bytes, contentType, forDate }

/**
 * Today's picture, with its title and explanation.
 *
 * `image` is deliberately NOT included — it is a megabyte or more, and the
 * browser gets it from /api/apod/image instead so it can be cached properly.
 */
export async function getApod(config = {}) {
  const fresh = cached && Date.now() - fetchedAt < METADATA_TTL_MS;
  if (fresh) return cached;

  // Two channels asking at once must not spend two of fifty daily requests.
  if (inFlight) return inFlight;

  inFlight = load(config)
    .then((data) => {
      cached = data;
      fetchedAt = Date.now();
      return data;
    })
    .catch((err) => {
      // Never lose a good picture to a bad request. A rate limit or a blip is
      // exactly when the channel most wants to keep showing something.
      if (cached) return { ...cached, stale: true, warning: err.message };
      throw err;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

async function load(config) {
  const key = config.apod?.key || process.env.NASA_API_KEY || "DEMO_KEY";
  const url = `https://api.nasa.gov/planetary/apod?api_key=${encodeURIComponent(key)}&thumbs=true`;

  // Measured at 2.5 s on a good day and a timeout at 15 s on a bad one, so this
  // is generous on purpose: a slow picture is fine, a missing one is not.
  const res = await fetch(url, { signal: AbortSignal.timeout(25000) });

  if (res.status === 429) {
    throw new Error(
      key === "DEMO_KEY"
        ? "NASA's demo key is rate limited for today. A free key at api.nasa.gov lifts it."
        : "NASA rate limited this key."
    );
  }
  // 503 is what api.nasa.gov returns when it is under load, and it is common
  // enough on DEMO_KEY to be a normal condition rather than an incident. The
  // wording matters for the same reason the Spotify errors did: a bare status
  // code on screen reads as a fault in Greg, not as a busy service upstream.
  if (res.status === 503) throw new Error("NASA's picture service is busy. It will try again shortly.");
  if (!res.ok) throw new Error(`NASA returned ${res.status}`);

  const data = await res.json();

  // Roughly one day in ten is a video rather than a photograph. `thumbs=true`
  // asks for a still of it, and without that the channel would show nothing on
  // those days with no indication why.
  const still = data.media_type === "image" ? data.hdurl || data.url : data.thumbnail_url || null;

  return {
    date: data.date,
    title: data.title ?? "Astronomy Picture of the Day",
    explanation: data.explanation ?? "",
    // The copyright line is often a whole credit block with newlines in it —
    // it is a caption, not a paragraph, so it gets flattened here.
    credit: (data.copyright ?? "").replace(/\s+/g, " ").trim() || "Public domain — NASA",
    mediaType: data.media_type,
    isVideo: data.media_type !== "image",
    imageUrl: still,
    // Present so the caller can offer the real thing when it is a video; the
    // face can only draw the still.
    videoUrl: data.media_type === "video" ? data.url : null,
    stale: false,
  };
}

/**
 * The picture itself, fetched once and kept on disk.
 *
 * On disk rather than only in memory because APOD images run to several MB and
 * a Greg restart is a frequent event — re-downloading the same photograph every
 * restart is rude to a service giving it away for free.
 */
export async function getApodImage(config = {}) {
  const meta = await getApod(config);
  if (!meta.imageUrl) return null;

  if (image && image.forDate === meta.date) return image;

  const file = path.join(CACHE_DIR, `${meta.date}.bin`);
  const typeFile = `${file}.type`;

  // On disk from a previous run.
  try {
    const bytes = fs.readFileSync(file);
    const contentType = fs.readFileSync(typeFile, "utf8").trim() || "image/jpeg";
    image = { bytes, contentType, forDate: meta.date };
    return image;
  } catch {
    // Not cached yet — fall through and fetch it.
  }

  const res = await fetch(meta.imageUrl, { signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error(`the picture returned ${res.status}`);

  const bytes = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "image/jpeg";
  image = { bytes, contentType, forDate: meta.date };

  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, bytes);
    fs.writeFileSync(typeFile, contentType);
    pruneCache(meta.date);
  } catch (err) {
    // A picture we cannot save is still a picture we can show.
    console.warn(`[apod] could not cache the image: ${err.message}`);
  }

  return image;
}

/** Keep a week of pictures on disk and no more. They are megabytes each. */
function pruneCache(keepFrom) {
  const cutoff = new Date(`${keepFrom}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - 7);

  for (const name of fs.readdirSync(CACHE_DIR)) {
    const date = /^(\d{4}-\d{2}-\d{2})\./.exec(name)?.[1];
    if (!date) continue;
    if (new Date(`${date}T00:00:00Z`) < cutoff) {
      try {
        fs.unlinkSync(path.join(CACHE_DIR, name));
      } catch {
        // Someone else's problem now.
      }
    }
  }
}
