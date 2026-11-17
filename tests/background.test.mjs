// Bloom's "alternate" backdrop follows the sun over Bern, in the Mac's local time (Europe/Zurich).
// Pin the zone before any Date is made, so the tests do not depend on the machine running them.
process.env.TZ = "Europe/Zurich";

import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUNDS, backgroundAt, msToNextBlock, sunEvents, isNight } from "../ui/js/background.js";

const MIN = 60e3;
const HOUR = 3600e3;
// A local (Zurich) moment; month is 1-12.
const at = (mo, d, h, m = 0) => new Date(2026, mo - 1, d, h, m, 0, 0);
// Minutes since local midnight of an instant, read in Zurich.
const minutes = date => date.getHours() * 60 + date.getMinutes();
const near = (date, h, m, tol = 5) => {
  const diff = Math.abs(minutes(date) - (h * 60 + m));
  assert.ok(diff <= tol, `${date.toString()} should be within ${tol} min of ${h}:${String(m).padStart(2, "0")}`);
};

test("the test zone is Zurich, with summer time", () => {
  assert.equal(at(6, 21, 12).getTimezoneOffset(), -120);
  assert.equal(at(12, 21, 12).getTimezoneOffset(), -60);
});

test("sunrise and sunset in Bern match the known values, in local time", () => {
  const summer = sunEvents(2026, 5, 21);
  near(summer.sunrise, 5, 34);
  near(summer.sunset, 21, 27);
  const winter = sunEvents(2026, 11, 21);
  near(winter.sunrise, 8, 13);
  near(winter.sunset, 16, 46);
  // Summer time is handled: 21 June sunrise is 03:34 UTC, 21 December 07:13 UTC.
  assert.equal(summer.sunrise.getUTCHours(), 3);
  assert.equal(winter.sunrise.getUTCHours(), 7);
});

test("fixed choices stay as they are; unknown values fall back to the meadow", () => {
  assert.equal(backgroundAt("nature", at(11, 14, 3)), "nature");
  assert.equal(backgroundAt("blossom", at(11, 14, 0)), "blossom");
  assert.equal(backgroundAt("ocean", at(11, 14, 12)), "ocean");
  assert.equal(backgroundAt("plain", at(11, 14, 3)), "plain");
  assert.equal(backgroundAt(undefined, at(11, 14, 12)), "nature");
  assert.equal(backgroundAt("sunset", at(11, 14, 3)), "nature");
});

test("alternate: the ocean all night, from sunset to sunrise", () => {
  // 17 November: sun up about 07:37, down about 16:55.
  for (const [h, m] of [[0, 0], [3, 0], [5, 59], [7, 30], [17, 5], [20, 0], [23, 59]]) {
    assert.equal(backgroundAt("alternate", at(11, 17, h, m)), "ocean", `${h}:${m}`);
  }
  // Long summer day: 21 June, up 05:34, down 21:27.
  assert.equal(backgroundAt("alternate", at(6, 21, 5, 0)), "ocean");
  assert.equal(backgroundAt("alternate", at(6, 21, 22, 0)), "ocean");
  assert.equal(backgroundAt("alternate", at(6, 21, 21, 0)), "nature");
});

test("alternate: by day the meadow and the cherry blossoms swap every two hours", () => {
  // 21 June is daylit from 05:40 to 21:20 or so.
  assert.equal(backgroundAt("alternate", at(6, 21, 6, 0)), "blossom"); // block 3 (6-8)
  assert.equal(backgroundAt("alternate", at(6, 21, 7, 59)), "blossom");
  assert.equal(backgroundAt("alternate", at(6, 21, 8, 0)), "nature");
  assert.equal(backgroundAt("alternate", at(6, 21, 10, 0)), "blossom");
  assert.equal(backgroundAt("alternate", at(6, 21, 12, 0)), "nature");
  assert.equal(backgroundAt("alternate", at(6, 21, 14, 30)), "blossom");
  assert.equal(backgroundAt("alternate", at(6, 21, 16, 0)), "nature");
  assert.equal(backgroundAt("alternate", at(6, 21, 18, 0)), "blossom");
  assert.equal(backgroundAt("alternate", at(6, 21, 20, 0)), "nature");
  // Never the ocean while the sun is up.
  for (let h = 6; h < 21; h++) assert.notEqual(backgroundAt("alternate", at(6, 21, h, 30)), "ocean");
});

test("every choice in Settings is one backgroundAt knows", () => {
  for (const [value] of BACKGROUNDS) {
    if (value !== "alternate") assert.equal(backgroundAt(value, at(11, 17, 12)), value);
  }
});

test("isNight flips at sunrise and sunset", () => {
  const { sunrise, sunset } = sunEvents(2026, 10, 17);
  assert.equal(isNight(new Date(sunrise - 1000)), true);
  assert.equal(isNight(sunrise), false);
  assert.equal(isNight(new Date(sunset - 1000)), false);
  assert.equal(isNight(sunset), true);
});

test("the next switch is the sun, or the next even hour by day", () => {
  const { sunrise, sunset } = sunEvents(2026, 10, 17);
  // In the morning dark: wake at sunrise.
  assert.equal(msToNextBlock(at(11, 17, 4, 0)), sunrise - at(11, 17, 4, 0));
  // Just after sunrise (07:37): the next even hour (08:00) is sooner than sunset.
  const justUp = new Date(sunrise.getTime() + MIN);
  assert.equal(msToNextBlock(justUp), at(11, 17, 8, 0) - justUp);
  // By day, a block boundary away: 10:30 -> 12:00.
  assert.equal(msToNextBlock(at(11, 17, 10, 30)), 90 * MIN);
  // Last block of the day: the sunset (about 16:55) comes before 18:00.
  assert.equal(msToNextBlock(at(11, 17, 16, 30)), sunset - at(11, 17, 16, 30));
  assert.ok(msToNextBlock(at(11, 17, 16, 30)) < 30 * MIN);
  // Evening: wake at tomorrow's sunrise.
  const tomorrow = sunEvents(2026, 10, 18).sunrise;
  assert.equal(msToNextBlock(at(11, 17, 22, 0)), tomorrow - at(11, 17, 22, 0));
  assert.equal(msToNextBlock(at(11, 17, 23, 59)), tomorrow - at(11, 17, 23, 59));
  // Always positive, and the backdrop really changes at the moment it says.
  for (const t of [at(11, 17, 4), justUp, at(11, 17, 10, 30), at(11, 17, 16, 30), at(11, 17, 22)]) {
    const wait = msToNextBlock(t);
    assert.ok(wait > 0 && wait < 20 * HOUR);
    assert.notEqual(backgroundAt("alternate", new Date(t.getTime() + wait + 1000)), backgroundAt("alternate", t));
  }
});
