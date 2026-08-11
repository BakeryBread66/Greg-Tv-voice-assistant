// Space weather from NOAA's Space Weather Prediction Center. Keyless, no signup.
//
// The planetary K index is a 0-9 measure of how disturbed Earth's magnetic field
// is right now. It sits at 0 or 1 almost all the time, which is exactly why it
// is worth a channel: a spike is a genuine "we interrupt this broadcast" moment
// and, unlike most feeds, it means something is happening in the sky *tonight*.
//
// Wilmington and Chapel Hill sit around 35°N, where aurora is effectively never
// visible — so the aurora line has to be honest about latitude rather than
// telling every user that Kp 5 means go outside and look up. That honesty is the
// point: a channel that cries wolf about the northern lights is worse than one
// that says "not from here".

// The 1-minute feed is ~27 KB and updates every minute. Cached for two, which
// is often enough to catch a storm developing and quiet enough to be polite.
const TTL_MS = 2 * 60 * 1000;

let cached = null;
let fetchedAt = 0;
let inFlight = null;

// NOAA's own G-scale, which is what a storm is actually called in a forecast.
// Keyed by the Kp it starts at, so the lookup is "the highest band we've reached".
const STORM_LEVELS = [
  { kp: 9, scale: "G5", name: "Extreme", note: "Once-a-cycle. Power grids and satellites are having a bad day." },
  { kp: 8, scale: "G4", name: "Severe", note: "Aurora possible as far south as Alabama and northern California." },
  { kp: 7, scale: "G3", name: "Strong", note: "Aurora possible down to Illinois and Oregon." },
  { kp: 6, scale: "G2", name: "Moderate", note: "Aurora visible from New York and Idaho on a clear night." },
  { kp: 5, scale: "G1", name: "Minor", note: "Aurora at the top of the country — Maine, Michigan, Washington." },
  { kp: 4, scale: "—", name: "Unsettled", note: "Active, but below storm level." },
  { kp: 0, scale: "—", name: "Quiet", note: "The magnetic field is where it usually sits." },
];

/**
 * The lowest geomagnetic latitude aurora is typically seen from, per Kp.
 *
 * Rounded off NOAA's own aurora viewline guidance rather than computed — the
 * real relationship depends on the magnetic pole's offset from the geographic
 * one, and pretending otherwise would be precision this doesn't have.
 */
const VIEWLINE_LATITUDE = [66, 64, 62, 60, 58, 55, 52, 48, 44, 40];

function bandFor(kp) {
  return STORM_LEVELS.find((level) => kp >= level.kp) ?? STORM_LEVELS[STORM_LEVELS.length - 1];
}

export async function getSpaceWeather({ latitude = null } = {}) {
  if (cached && Date.now() - fetchedAt < TTL_MS) return cached;
  if (inFlight) return inFlight;

  inFlight = load()
    .then((data) => {
      cached = data;
      fetchedAt = Date.now();
      return data;
    })
    .catch((err) => {
      if (cached) return { ...cached, stale: true, warning: err.message };
      throw err;
    })
    .finally(() => {
      inFlight = null;
    });

  const reading = await inFlight;
  return { ...reading, aurora: auroraFor(reading.kp, latitude) };
}

async function load() {
  const res = await fetch("https://services.swpc.noaa.gov/json/planetary_k_index_1m.json", {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`NOAA returned ${res.status}`);

  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error("NOAA sent an empty feed");

  // `estimated_kp` is the continuous value; `kp_index` is it rounded to a whole
  // number. The fraction is what makes a rising trend visible at all, since the
  // integer sits on 0 for hours at a time.
  const latest = rows[rows.length - 1];
  const kp = Number(latest.estimated_kp ?? latest.kp_index ?? 0);

  // Three hours of history for the sparkline, thinned to one point a minute's
  // worth of resolution nobody can see. 180 points is more than a small canvas
  // has pixels, so it is sampled down here rather than in the renderer.
  const window = rows.slice(-180);
  const history = [];
  const step = Math.max(1, Math.floor(window.length / 60));
  for (let i = 0; i < window.length; i += step) {
    history.push(Number(window[i].estimated_kp ?? window[i].kp_index ?? 0));
  }

  const peak = window.reduce((max, row) => Math.max(max, Number(row.estimated_kp ?? row.kp_index ?? 0)), 0);
  const band = bandFor(Math.floor(kp));

  return {
    kp: Math.round(kp * 100) / 100,
    kpWhole: Math.floor(kp),
    at: latest.time_tag ? `${latest.time_tag}Z` : null,
    scale: band.scale,
    condition: band.name,
    note: band.note,
    // Over three hours: enough to say "settling" or "picking up" without
    // pretending to forecast.
    peak3h: Math.round(peak * 100) / 100,
    trend: trendOf(history),
    history,
    stale: false,
  };
}

export function trendOf(history) {
  if (history.length < 6) return "steady";
  const half = Math.floor(history.length / 2);
  const early = history.slice(0, half).reduce((a, b) => a + b, 0) / half;
  const late = history.slice(half).reduce((a, b) => a + b, 0) / (history.length - half);
  // A third of a Kp point over three hours. Below that it is the feed's own
  // jitter, and calling jitter a trend is the knife-edge threshold CLAUDE.md
  // warns about.
  if (late - early > 0.33) return "rising";
  if (early - late > 0.33) return "falling";
  return "steady";
}

/**
 * Whether the northern lights are plausibly visible from where the user is.
 *
 * Deliberately blunt. Without a latitude it says so rather than guessing, and
 * from 35°N it says no even during a G4 storm, because the honest answer is
 * almost always no and a channel that implies otherwise is lying pleasantly.
 */
export function auroraFor(kp, latitude) {
  const whole = Math.max(0, Math.min(9, Math.floor(kp)));
  const viewline = VIEWLINE_LATITUDE[whole];

  if (latitude === null || !Number.isFinite(latitude)) {
    return { visible: null, viewline, text: `Aurora reaches about ${viewline}° north at this level.` };
  }

  const north = Math.abs(latitude);
  const margin = north - viewline;

  if (margin >= 4) return { visible: true, viewline, text: "Overhead tonight, if the sky is clear." };
  if (margin >= 0) return { visible: true, viewline, text: "Possible low on the northern horizon tonight." };
  if (margin >= -6) return { visible: false, viewline, text: `Just short — it would need to reach ${north.toFixed(0)}° north.` };
  return { visible: false, viewline, text: `Not from ${north.toFixed(0)}° north. It would take a much larger storm.` };
}
