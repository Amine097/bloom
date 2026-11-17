import { test } from "node:test";
import assert from "node:assert/strict";
import { notesOf, noteText, noteCount, setNote, firstLine, noteList, mostVisible, clampPage } from "../ui/js/slidenotes-core.js";

test("setNote writes, updates and removes notes, and drops an empty PDF", () => {
  const all = {};
  assert.equal(setNote(all, "lec1", 3, "Troponin rises after 3 h", "2026-11-17"), true);
  assert.deepEqual(all, { lec1: { 3: { text: "Troponin rises after 3 h", at: "2026-11-17" } } });
  assert.equal(setNote(all, "lec1", 3, "Troponin rises after 3 h", "2026-11-18"), false, "same text, nothing to save");
  setNote(all, "lec1", "12", "QT\nlong", "2026-11-18");
  assert.equal(noteText(all, "lec1", 12), "QT\nlong");
  assert.equal(noteCount(all, "lec1"), 2);
  assert.equal(setNote(all, "lec1", 3, "   \n ", "2026-11-18"), true);
  assert.equal(noteCount(all, "lec1"), 1);
  setNote(all, "lec1", 12, "", "2026-11-18");
  assert.deepEqual(all, {});
  assert.equal(setNote(all, "lec1", 5, "", "2026-11-18"), false);
  setNote(all, "fiche:f1", 1, "x", "2026-11-18");
  assert.equal(noteCount(all, "fiche:f1"), 1);
});

test("reading tolerates missing data", () => {
  assert.deepEqual(notesOf(undefined, "a"), {});
  assert.equal(noteText({}, "a", 1), "");
  assert.equal(noteCount(null, "a"), 0);
  assert.deepEqual(noteList({}, "a"), []);
});

test("noteList is in page order with the first line of each note", () => {
  const all = { a: { 10: { text: "\n  Second slide  \nmore", at: "d2" }, 2: { text: "First", at: "d1" } } };
  assert.deepEqual(noteList(all, "a"), [{ page: 2, first: "First", at: "d1" }, { page: 10, first: "Second slide", at: "d2" }]);
  assert.equal(firstLine("x".repeat(100), 10), "xxxxxxxxx…");
  assert.equal(firstLine(""), "");
});

test("mostVisible picks the page that shows most, the earlier on a tie", () => {
  const boxes = [{ page: 1, top: 0, bottom: 100 }, { page: 2, top: 110, bottom: 210 }, { page: 3, top: 220, bottom: 320 }];
  assert.equal(mostVisible(boxes, 0, 100), 1);
  assert.equal(mostVisible(boxes, 80, 180), 2);
  assert.equal(mostVisible(boxes, 60, 160), 2); // 40 of page 1, 50 of page 2
  assert.equal(mostVisible(boxes, 50, 160), 1); // 50 and 50: the earlier one
  assert.equal(mostVisible(boxes, 400, 500), 3); // nothing visible: the nearest
  assert.equal(mostVisible([], 0, 100), null);
});

test("clampPage keeps a page inside the document", () => {
  assert.equal(clampPage("12", 31), 12);
  assert.equal(clampPage(0, 31), 1);
  assert.equal(clampPage(99, 31), 31);
  assert.equal(clampPage("abc", 31, 4), 4);
  assert.equal(clampPage(2.6, 31), 3);
});
