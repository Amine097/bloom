import { test } from "node:test";
import assert from "node:assert/strict";
import {
  marksOn, markedCount, setMarks, addMark, removeMark, updateMark, pushUndo, undo, UNDO_MAX,
  mergeRects, simplify, smoothPath, hitTest, pdfPoint, shownSize, exportOps, winAnsi, annotatedName,
  hexOf, textBox, penWidth, textSize, fontRuns, fontText, placeRuns, noteIconRect, wrapText, notesLayout,
} from "../ui/js/marks-core.js";

const pen = (id, points, width = 2) => ({ id, kind: "pen", color: "ink", at: "2026-11-17", width, points });

test("marks are added, changed and removed page by page, and empty entries go", () => {
  const all = {};
  addMark(all, "lec1", 2, pen("a", [[0.1, 0.1], [0.2, 0.2]]));
  addMark(all, "lec1", "2", { id: "b", kind: "text", color: "red", at: "d", x: 0.5, y: 0.5, size: 12, text: "hi" });
  assert.deepEqual(marksOn(all, "lec1", 2).map(m => m.id), ["a", "b"]);
  assert.equal(markedCount(all, "lec1"), 1);
  assert.equal(updateMark(all, "lec1", 2, "b", { x: 0.3 }).x, 0.3);
  assert.equal(updateMark(all, "lec1", 2, "zz", { x: 0.3 }), null);
  assert.equal(removeMark(all, "lec1", 2, "zz"), false);
  assert.equal(removeMark(all, "lec1", 2, "a"), true);
  assert.equal(removeMark(all, "lec1", 2, "b"), true);
  assert.deepEqual(all, {});
  assert.deepEqual(marksOn(undefined, "x", 1), []);
  setMarks(all, "fiche:f", 1, []);
  assert.deepEqual(all, {});
});

test("undo puts a page back as it was before each action, the last first", () => {
  const all = {}, stack = [];
  pushUndo(stack, all, "s", 1);
  addMark(all, "s", 1, pen("a", [[0, 0]]));
  pushUndo(stack, all, "s", 3);
  addMark(all, "s", 3, pen("b", [[0, 0]]));
  pushUndo(stack, all, "s", 1);
  setMarks(all, "s", 1, []); // "Clear this page"
  assert.equal(undo(stack, all, "s"), 1);
  assert.deepEqual(marksOn(all, "s", 1).map(m => m.id), ["a"]);
  assert.equal(undo(stack, all, "s"), 3);
  assert.deepEqual(marksOn(all, "s", 3), []);
  assert.equal(undo(stack, all, "s"), 1);
  assert.deepEqual(all, {});
  assert.equal(undo(stack, all, "s"), null);
  for (let i = 0; i < UNDO_MAX + 5; i++) pushUndo(stack, all, "s", 1);
  assert.equal(stack.length, UNDO_MAX);
});

test("mergeRects joins the boxes of one line and keeps lines apart", () => {
  const out = mergeRects([
    [0.10, 0.20, 0.10, 0.03], [0.205, 0.201, 0.08, 0.028], // two words of one line
    [0.10, 0.30, 0.30, 0.03],                             // the next line
    [0.5, 0.5, 0.0001, 0.03],                             // an empty box
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], [0.1, 0.2, 0.185, 0.03]);
  assert.deepEqual(out[1], [0.1, 0.3, 0.3, 0.03]);
  // far apart on one line: two rectangles
  assert.equal(mergeRects([[0.1, 0.2, 0.05, 0.03], [0.6, 0.2, 0.05, 0.03]]).length, 2);
});

test("simplify drops points that a straight line already covers and rounds the rest", () => {
  const line = Array.from({ length: 50 }, (_, i) => [i / 100, 0.5 + (i % 2 ? 0.00001 : 0)]);
  assert.deepEqual(simplify(line, 720, 540), [[0, 0.5], [0.49, 0.5]]);
  const corner = [[0, 0], [0.25, 0], [0.5, 0], [0.5, 0.25], [0.5, 0.5]];
  assert.deepEqual(simplify(corner, 100, 100), [[0, 0], [0.5, 0], [0.5, 0.5]]);
  assert.deepEqual(simplify([[0.123456, 0.5]]), [[0.1235, 0.5]]);
  assert.deepEqual(simplify([[0.1, 0.1], [0.1, 0.1], [0.1, 0.1]], 100, 100), [[0.1, 0.1]]);
});

test("smoothPath draws curves through the middles, a dot for one point", () => {
  assert.equal(smoothPath([]), "");
  assert.equal(smoothPath([[1, 2]]), "M1 2L1.01 2");
  assert.equal(smoothPath([[0, 0], [10, 0]]), "M0 0L10 0");
  assert.equal(smoothPath([[0, 0], [10, 0], [10, 10]]), "M0 0Q10 0 10 5L10 10");
});

test("hitTest finds the topmost mark under the eraser", () => {
  const list = [
    { id: "h", kind: "highlight", color: "yellow", rects: [[0.1, 0.1, 0.3, 0.05]] },
    pen("p", [[0, 0.5], [1, 0.5]], 2),
    { id: "t", kind: "text", color: "ink", x: 0.6, y: 0.8, size: 12, text: "Note" },
  ];
  assert.equal(hitTest(list, 0.2, 0.12, 100, 100), "h");
  assert.equal(hitTest(list, 0.5, 0.52, 100, 100), "p", "2 points away, within reach");
  assert.equal(hitTest(list, 0.5, 0.6, 100, 100), null);
  assert.equal(hitTest(list, 0.62, 0.85, 100, 100), "t");
  assert.equal(hitTest([...list, pen("q", [[0.2, 0.12]], 4)], 0.2, 0.12, 100, 100), "q", "the one on top");
});

test("pdfPoint maps page fractions to PDF space for every /Rotate", () => {
  const box = { x: 10, y: 20, width: 600, height: 800 };
  assert.deepEqual(pdfPoint(0, 0, box, 0), [10, 820]);
  assert.deepEqual(pdfPoint(1, 1, box, 0), [610, 20]);
  // 90: the page's bottom-left corner shows at the top-left
  assert.deepEqual(pdfPoint(0, 0, box, 90), [10, 20]);
  assert.deepEqual(pdfPoint(1, 0, box, 90), [10, 820]);
  assert.deepEqual(pdfPoint(0, 0, box, 180), [610, 20]);
  assert.deepEqual(pdfPoint(0, 0, box, 270), [610, 820]);
  assert.deepEqual(pdfPoint(1, 0, box, -90), [610, 20]);
  assert.deepEqual(shownSize(box, 90), { w: 800, h: 600 });
  assert.deepEqual(shownSize(box, 180), { w: 600, h: 800 });
});

test("exportOps turns marks into paths and text lines in PDF space", () => {
  const box = { x: 0, y: 0, width: 200, height: 100 };
  const ops = exportOps([
    { id: "h", kind: "highlight", color: "yellow", rects: [[0.1, 0.1, 0.5, 0.1]] },
    pen("p", [[0, 0], [0.5, 0.5], [1, 1]], 3),
    { id: "t", kind: "text", color: "red", x: 0.5, y: 0.5, size: 10, text: "One\nTwo →" },
    { id: "e", kind: "text", color: "red", x: 0, y: 0, size: 10, text: "  " },
  ], box, 0, (s, size) => s.length * size * 0.5);
  assert.deepEqual(ops.map(o => o.op), ["path", "path", "path", "text", "text"]);
  assert.equal(ops[0].d, "M20.00 -90.00L120.00 -90.00L120.00 -80.00L20.00 -80.00Z");
  assert.equal(ops[0].multiply, true);
  assert.ok(ops[0].opacity < 1);
  assert.equal(ops[1].d, "M0 -100Q100 -50 150 -25L200 0");
  assert.equal(ops[1].width, 3);
  assert.deepEqual(ops[2].fill, [1, 1, 1]);
  assert.equal(ops[3].text, "One");
  assert.equal(ops[4].text, "Two ->");
  assert.equal(ops[3].x, 103);
  assert.ok(Math.abs(ops[3].y - (100 - 50 - 3 - 9.6)) < 1e-9);
  assert.equal(ops[4].y, ops[3].y - 12.5);
  assert.deepEqual(ops[3].color, [224 / 255, 49 / 255, 49 / 255]);
});

test("winAnsi keeps what Helvetica can draw and spells out the rest", () => {
  assert.equal(winAnsi("Café – “ok” µ ±"), "Café – “ok” µ ±");
  assert.equal(winAnsi("β-blockers → HR ≤ 60"), "beta-blockers -> HR <= 60");
  assert.equal(winAnsi("中"), "?");
  assert.equal(winAnsi(null), "");
});

test("small helpers", () => {
  assert.equal(annotatedName("ICD.pdf"), "ICD (annotated).pdf");
  assert.equal(annotatedName("Heart: part 1.PDF"), "Heart part 1 (annotated).pdf");
  assert.equal(annotatedName(""), "Slides (annotated).pdf");
  assert.equal(hexOf("highlight", "nope"), hexOf("highlight", "yellow"));
  assert.notEqual(hexOf("pen", "blue"), hexOf("highlight", "blue"));
  const [, , w, h] = textBox({ x: 0.1, y: 0.1, size: 10, text: "ab\nc" }, 100, 100, s => s.length * 5);
  assert.equal(w, (10 + 6) / 100);
  assert.equal(h, (25 + 6) / 100);
  assert.ok(penWidth(720, true) > penWidth(720, false));
  assert.equal(textSize(720), 13);
  assert.equal(textSize(100), 9);
});

test("exportOps keeps every character when the export's fonts can draw them", () => {
  const box = { x: 0, y: 0, width: 200, height: 100 };
  const text = "β-blocker → ↓HR, Ca²⁺ ≥ 2.5 mmol/L ± 0.1, 37 °C, μm";
  const ops = exportOps([{ id: "t", kind: "text", color: "ink", x: 0, y: 0, size: 10, text }], box, 0, (s, size) => s.length * size / 2, s => s);
  assert.equal(ops[1].text, text);
});

// a main font with Latin and Greek, a fallback with arrows and maths
const inMain = n => n < 0x2000 || n === 0x2192 || n === 0x2193 || n === 0x2265 || n === 0x207A;
const inFallback = n => n === 0x21D2 || n === 0x2261;

test("fontRuns gives each character to the font that has it", () => {
  assert.deepEqual(fontRuns("Ca²⁺ ≥ 2 ⇒ x ≡ y", inMain, inFallback), [
    { text: "Ca²⁺ ≥ 2 ", font: "main" }, { text: "⇒", font: "fallback" }, { text: " x ", font: "main" },
    { text: "≡", font: "fallback" }, { text: " y", font: "main" },
  ]);
  assert.deepEqual(fontRuns("a ↔ 中", inMain, inFallback), [{ text: "a <-> ?", font: "main" }], "spelled out, or ?");
  assert.deepEqual(fontRuns("", inMain), []);
  assert.equal(fontText("⇒ 中\nok", inMain, inFallback), "⇒ ?\nok");
});

test("placeRuns sets the runs one after the other along the line", () => {
  const runs = [{ text: "ab", font: "main" }, { text: "⇒", font: "fallback" }, { text: "c", font: "main" }];
  const w = r => r.text.length * 5;
  assert.deepEqual(placeRuns(10, 20, 0, runs, w).map(r => [r.x, r.y]), [[10, 20], [20, 20], [25, 20]]);
  assert.deepEqual(placeRuns(10, 20, 90, runs, w).map(r => [r.x, r.y]), [[10, 20], [10, 30], [10, 35]]);
});

test("noteIconRect sits at the top-right corner of the page as shown", () => {
  assert.deepEqual(noteIconRect({ x: 0, y: 0, width: 960, height: 540 }, 0, 20), [930, 510, 950, 530]);
  // turned a quarter: the shown top-right corner is the page's top-left one
  const [x1, y1, x2, y2] = noteIconRect({ x: 0, y: 0, width: 540, height: 960 }, 90, 20);
  assert.ok(x2 <= 30 && y1 >= 930 && y2 <= 960 && x1 >= 0);
});

test("wrapText breaks at spaces, keeps paragraphs and cuts words that are too long", () => {
  const m = t => t.length;
  assert.deepEqual(wrapText("one two three four", 9, m), ["one two", "three", "four"]);
  assert.deepEqual(wrapText("a\n\nb", 9, m), ["a", "", "b"]);
  assert.deepEqual(wrapText("abcdefghijkl", 5, m), ["abcde", "fghij", "kl"]);
});

test("notesLayout lists the notes under a title and runs onto more pages", () => {
  const notes = Array.from({ length: 60 }, (_, i) => ({ page: i + 1, text: `Note ${i + 1}\nsecond line` }));
  const pages = notesLayout(notes, { sub: "ICD · ICD.pdf", measure: (t, s) => t.length * s * 0.5 });
  assert.ok(pages.length >= 2);
  assert.deepEqual(pages[0].slice(0, 2).map(x => [x.text, x.kind]), [["My notes", "title"], ["ICD · ICD.pdf", "sub"]]);
  const labels = pages.flat().filter(x => x.kind === "label");
  assert.equal(labels.length, 60);
  assert.equal(labels[0].text, "Slide 1");
  for (const p of pages) for (const x of p) assert.ok(x.y >= 56 && x.y <= 841.89 - 56, "inside the margins");
  const first = pages[0].filter(x => x.kind === "text").slice(0, 2);
  assert.equal(first[0].y, labels[0].y, "the note starts beside its label");
  assert.ok(first[1].y < first[0].y);
  assert.equal(notesLayout([{ page: 2, text: "x" }], { word: "Page" })[0][1].text, "Page 2");
});
