// Which backdrop is shown. Pure, so the sun-following rotation can be tested.

export const BACKGROUNDS = [
  ["alternate", "Meadow and cherry blossoms by day, the ocean at night"],
  ["nature", "Meadow with butterflies"],
  ["blossom", "Cherry blossoms"],
  ["ocean", "Ocean at sunset"],
  ["plain", "Plain"],
];

/** What "alternate" swaps between during the day, one two-hour block each (even blocks of the
 *  local day: 0:00 meadow, 2:00 blossoms, 4:00 meadow, ...). Between sunset and sunrise it shows
 *  the ocean instead. */
export const ROTATION = ["nature", "blossom"];
const FIXED = ["nature", "blossom", "ocean"];

/** Where the sun is computed for: Bern. */
export const PLACE = { lat: 46.948, lon: 7.447 };

const RAD = Math.PI / 180;
const DAY = 86400e3;

/** Sunrise and sunset (as Date instants) on a calendar day (month 0-11) at a place: the sunrise
 *  equation (transit from the mean anomaly and the equation of the centre, hour angle for the
 *  sun's upper limb at -0.833 degrees). Within a few minutes. Instants are absolute, so the local
 *  time and summer time come out right wherever the Date is read. */
export function sunEvents(year, month, day, { lat, lon } = PLACE) {
  const jdNoon = Date.UTC(year, month, day, 12) / DAY + 2440587.5;
  const n = Math.round(jdNoon - 2451545);
  const jStar = n + 0.0008 - lon / 360;
  const M = (357.5291 + 0.98560028 * jStar) % 360;
  const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
  const lambda = (M + C + 180 + 102.9372) % 360;
  const transit = 2451545 + jStar + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * lambda * RAD);
  const sinDec = Math.sin(lambda * RAD) * Math.sin(23.4397 * RAD);
  const cosDec = Math.sqrt(1 - sinDec * sinDec);
  const cosW = (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * sinDec) / (Math.cos(lat * RAD) * cosDec);
  const w = Math.acos(Math.max(-1, Math.min(1, cosW))) / RAD; // degrees
  const toDate = jd => new Date((jd - 2440587.5) * DAY);
  return { sunrise: toDate(transit - w / 360), sunset: toDate(transit + w / 360) };
}

/** Sunrise and sunset of the local calendar day of a moment. */
export function sunTimes(date = new Date(), place = PLACE) {
  return sunEvents(date.getFullYear(), date.getMonth(), date.getDate(), place);
}

/** True between sunset and sunrise (local day of the moment). */
export function isNight(date = new Date()) {
  const { sunrise, sunset } = sunTimes(date);
  return date < sunrise || date >= sunset;
}

/** The backdrop for a setting at a moment: "nature", "blossom", "ocean" or "plain".
 *  "alternate": the ocean from sunset to sunrise in Bern; by day the meadow and the cherry
 *  blossoms in two-hour blocks of the local day. Anything unknown falls back to the meadow. */
export function backgroundAt(setting, date = new Date()) {
  if (setting === "plain" || FIXED.includes(setting)) return setting;
  if (setting === "alternate") {
    if (isNight(date)) return "ocean";
    return ROTATION[Math.floor(date.getHours() / 2) % ROTATION.length];
  }
  return "nature";
}

/** Milliseconds until the "alternate" backdrop next changes: sunrise at night; by day the sooner
 *  of sunset and the next two-hour mark (always > 0). */
export function msToNextBlock(date = new Date()) {
  const { sunrise, sunset } = sunTimes(date);
  if (date < sunrise) return sunrise - date;
  if (date >= sunset) {
    const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 12);
    return sunTimes(next).sunrise - date;
  }
  const mark = new Date(date);
  mark.setHours(Math.floor(date.getHours() / 2) * 2 + 2, 0, 0, 0);
  return Math.min(mark, sunset) - date;
}
