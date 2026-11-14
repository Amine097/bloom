// Which backdrop is shown. Pure, so the two-hour rotation can be tested.

export const BACKGROUNDS = [
  ["alternate", "Change every 2 hours"],
  ["nature", "Meadow with butterflies"],
  ["blossom", "Cherry blossoms"],
  ["plain", "Plain"],
];

/** The backdrop for a setting at a moment: "nature", "blossom" or "plain".
 *  "alternate" uses two-hour blocks of the local day: 0:00–1:59 meadow, 2:00–3:59 blossoms, ...
 *  Anything unknown falls back to the meadow, as before. */
export function backgroundAt(setting, date = new Date()) {
  if (setting === "plain" || setting === "blossom") return setting;
  if (setting === "alternate") return Math.floor(date.getHours() / 2) % 2 ? "blossom" : "nature";
  return "nature";
}

/** Milliseconds until the next two-hour block starts (always > 0). */
export function msToNextBlock(date = new Date()) {
  const next = new Date(date);
  next.setHours(Math.floor(date.getHours() / 2) * 2 + 2, 0, 0, 0);
  return next - date;
}
