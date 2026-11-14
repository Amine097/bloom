import { test } from "node:test";
import assert from "node:assert/strict";
import { backgroundAt, msToNextBlock } from "../ui/js/background.js";

const at = (h, m = 0) => new Date(2026, 10, 14, h, m, 0, 0);

test("fixed choices stay as they are; unknown values fall back to the meadow", () => {
  assert.equal(backgroundAt("nature", at(3)), "nature");
  assert.equal(backgroundAt("blossom", at(0)), "blossom");
  assert.equal(backgroundAt("plain", at(3)), "plain");
  assert.equal(backgroundAt(undefined, at(3)), "nature");
  assert.equal(backgroundAt("sunset", at(3)), "nature");
});

test("alternate: even two-hour blocks are the meadow, odd blocks the blossoms", () => {
  assert.equal(backgroundAt("alternate", at(0)), "nature");
  assert.equal(backgroundAt("alternate", at(1, 59)), "nature");
  assert.equal(backgroundAt("alternate", at(2)), "blossom");
  assert.equal(backgroundAt("alternate", at(3, 59)), "blossom");
  assert.equal(backgroundAt("alternate", at(4)), "nature");
  assert.equal(backgroundAt("alternate", at(14, 30)), "blossom");
  assert.equal(backgroundAt("alternate", at(23, 59)), "blossom");
});

test("the next switch is at the next even hour", () => {
  assert.equal(msToNextBlock(at(0)), 2 * 3600e3);
  assert.equal(msToNextBlock(at(3, 30)), 30 * 60e3);
  assert.equal(msToNextBlock(at(23, 59)), 60e3); // rolls over to midnight
});
