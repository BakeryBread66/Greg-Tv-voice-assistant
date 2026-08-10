// Sunrise, sunset and the moon — computed, not fetched.
//
// The only channel on the set that needs no network whatsoever. Everything here
// is arithmetic on a date and a coordinate, which means it keeps working with
// the internet unplugged — the property this project claims about itself and
// which every other feed-backed channel quietly breaks.
//
// The solar half is the NOAA sunrise/sunset algorithm. `public/globe-app.js`
// already computes the subsolar point for the day/night terminator, and this is
// the same astronomy asked a harder question: not "where is the sun now" but
// "when does it cross a given altitude here". One function answers sunrise,
// sunset, both twilights and the golden hour, because they are the same
// question with a different angle.
//
// The lunar half is deliberately the simple approximation — mean synodic month
// from a known new moon. It is good to a few hours on the phase, which is
// plenty for "is it worth looking up tonight", and it is honest about being an
// approximation rather than pretending to ephemeris precision.

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

// Altitudes of the sun's centre that mean something to a person, in degrees.
// -0.833 is the standard sunrise: the sun's upper limb touching the horizon,
// with atmospheric refraction bending the image up by about half a degree.
export const ALTITUDES = {
  sunrise: -0.833,
  civil: -6, // civil twilight — bright enough to read outside
  golden: 6, // the light photographers get up for
};

const julianDay = (date) => date.getTime() / 86400000 + 2440587.5;

/** Everything about where the sun is on a given day, before any horizon test. */
function solarPosition(date) {
  const t = (julianDay(date) - 2451545) / 36525; // Julian centuries since J2000

  const meanLong = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const meanAnomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

  const centre =
    Math.sin(meanAnomaly * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * meanAnomaly * RAD) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * meanAnomaly * RAD) * 0.000289;

  const trueLong = meanLong + centre;
  const omega = 125.04 - 1934.136 * t;
  const apparentLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);

  const meanObliquity = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity = meanObliquity + 0.00256 * Math.cos(omega * RAD);

  const declination = Math.asin(Math.sin(obliquity * RAD) * Math.sin(apparentLong * RAD)) * DEG;

  // The equation of time: how far ahead or behind a sundial the clock runs,
  // which is why the earliest sunset and the shortest day are not the same date.
  const y = Math.tan((obliquity / 2) * RAD) ** 2;
  const equationOfTime =
    4 *
    DEG *
    (y * Math.sin(2 * meanLong * RAD) -
      2 * eccentricity * Math.sin(meanAnomaly * RAD) +
      4 * eccentricity * y * Math.sin(meanAnomaly * RAD) * Math.cos(2 * meanLong * RAD) -
      0.5 * y * y * Math.sin(4 * meanLong * RAD) -
      1.25 * eccentricity * eccentricity * Math.sin(2 * meanAnomaly * RAD));

  return { declination, equationOfTime };
}

/** UTC midnight of the local day containing `date`, which is what the day's maths hangs off. */
const startOfDay = (date) => new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));

/**
 * When the sun crosses `altitude` at this place, going up and coming down.
 *
 * Returns nulls with a REASON rather than NaN when it never crosses at all.
 * Above the Arctic circle in December the sun does not rise, and in June it
 * does not set; both are facts about the place, not failures of the
 * calculation. A NaN reaching the renderer would print "Invalid Date" and look
 * like a broken feed — the same class of mistake as an empty alert list meaning
 * two different things.
 */
export function sunTimes(date, latitude, longitude, altitude = ALTITUDES.sunrise) {
  const day = startOfDay(date);
  const { declination, equationOfTime } = solarPosition(day);

  const noonMinutes = 720 - 4 * longitude - equationOfTime; // UTC minutes of solar noon
  const cosHourAngle =
    (Math.sin(altitude * RAD) - Math.sin(latitude * RAD) * Math.sin(declination * RAD)) /
    (Math.cos(latitude * RAD) * Math.cos(declination * RAD));

  const noon = new Date(day.getTime() + noonMinutes * 60000);

  if (cosHourAngle > 1) return { rise: null, set: null, noon, reason: "the sun does not rise here today" };
  if (cosHourAngle < -1) return { rise: null, set: null, noon, reason: "the sun does not set here today" };

  const hourAngle = Math.acos(cosHourAngle) * DEG;
  return {
    rise: new Date(day.getTime() + (noonMinutes - 4 * hourAngle) * 60000),
    set: new Date(day.getTime() + (noonMinutes + 4 * hourAngle) * 60000),
    noon,
    reason: null,
  };
}

// A known new moon: 6 January 2000, 18:14 UTC. Everything lunar here counts
// forward from it.
const KNOWN_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14);
export const SYNODIC_MONTH = 29.530588853; // days, mean

/**
 * How far through its cycle the moon is, and how much of it is lit.
 *
 * `fraction` runs 0 at new moon to 0.5 at full and back toward 1. Illumination
 * is the visible lit disc, which is what "is it worth looking up" depends on —
 * a quarter moon is HALF lit, which the name gets wrong and the number gets
 * right.
 */
export function moonPhase(date = new Date()) {
  const days = (date.getTime() - KNOWN_NEW_MOON) / 86400000;
  const age = ((days % SYNODIC_MONTH) + SYNODIC_MONTH) % SYNODIC_MONTH;
  const fraction = age / SYNODIC_MONTH;
  const illumination = (1 - Math.cos(2 * Math.PI * fraction)) / 2;

  return { age, fraction, illumination, name: phaseName(fraction), waxing: fraction < 0.5 };
}

/**
 * The name for a point in the cycle.
 *
 * The four principal phases get a narrow band either side — about a day and a
 * half — because "full moon" said on a night that is 97% lit is what anybody
 * would say, and insisting on the instant of fullness would mean the words
 * "full moon" almost never appear.
 */
export function phaseName(fraction) {
  const f = ((fraction % 1) + 1) % 1;
  const near = 0.025; // ±0.7 of a day
  if (f < near || f > 1 - near) return "New Moon";
  if (Math.abs(f - 0.25) < near) return "First Quarter";
  if (Math.abs(f - 0.5) < near) return "Full Moon";
  if (Math.abs(f - 0.75) < near) return "Last Quarter";
  if (f < 0.25) return "Waxing Crescent";
  if (f < 0.5) return "Waxing Gibbous";
  if (f < 0.75) return "Waning Gibbous";
  return "Waning Crescent";
}

/** m:ss-style day length, said the way a person would. */
export function dayLength(rise, set) {
  if (!rise || !set) return null;
  const minutes = Math.round((set - rise) / 60000);
  return { minutes, text: `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m` };
}

/**
 * Everything the channel shows, for one place on one day.
 *
 * No network, no cache, no failure mode worth reporting — which is why this
 * takes a place rather than fetching one. The caller already knows where the
 * user is.
 */
export function sunAndMoon(place = {}, when = new Date()) {
  // Absence tested BEFORE conversion, for the fourth time in this project.
  // `Number(null)` is 0 and 0 is a perfectly finite latitude, so a place with
  // explicitly null coordinates would compute a sunrise — for Null Island, in
  // the Atlantic off the coast of Ghana. That is not hypothetical here:
  // `config.location` holds null for both coordinates whenever the location is
  // set to follow the connection, which is the default. Everyone on auto would
  // have been given the Gulf of Guinea's sunrise, confidently, to the minute.
  const coord = (value) => (value === null || value === undefined || value === "" ? Number.NaN : Number(value));
  const latitude = coord(place.latitude);
  const longitude = coord(place.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { error: "I do not know where you are precisely enough to work out sunrise." };
  }

  const sun = sunTimes(when, latitude, longitude, ALTITUDES.sunrise);
  const civil = sunTimes(when, latitude, longitude, ALTITUDES.civil);
  const golden = sunTimes(when, latitude, longitude, ALTITUDES.golden);
  const moon = moonPhase(when);

  const clock = (date) =>
    date ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;

  // Sun's altitude right now, which is what decides whether it is up — rather
  // than comparing the clock against sunrise and sunset, which goes wrong on
  // the days when one of them does not exist.
  const up = sun.rise && sun.set ? when >= sun.rise && when < sun.set : sun.reason?.includes("not set") === true;

  return {
    place: place.city ?? "here",
    sunrise: clock(sun.rise),
    sunset: clock(sun.set),
    solarNoon: clock(sun.noon),
    dawn: clock(civil.rise),
    dusk: clock(civil.set),
    // The golden hour is the window between the sun being low and the horizon,
    // so morning runs from sunrise to the 6° crossing and evening the reverse.
    goldenMorning: sun.rise && golden.rise ? `${clock(sun.rise)} – ${clock(golden.rise)}` : null,
    goldenEvening: golden.set && sun.set ? `${clock(golden.set)} – ${clock(sun.set)}` : null,
    dayLength: dayLength(sun.rise, sun.set)?.text ?? null,
    isUp: up,
    // Said plainly rather than left as nulls the renderer has to interpret.
    note: sun.reason,
    moon: {
      name: moon.name,
      illumination: Math.round(moon.illumination * 100),
      waxing: moon.waxing,
      age: Math.round(moon.age * 10) / 10,
    },
  };
}
