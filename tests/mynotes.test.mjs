import { test } from "node:test";
import assert from "node:assert/strict";
import {
  notesPages, notesStats, notesSummary, hasNotes, myNotesBlock, withMyNotes, NOTES_MAX, NOTE_MAX,
} from "../ui/js/mynotes-core.js";
import { quizPrompt } from "../ui/js/notebook-core.js";
import { cardsPrompt } from "../ui/js/cards-core.js";
import { ficheQuizPrompt } from "../ui/js/fiches-core.js";

const notes = {
  2: { text: "Prof: the exam always asks the 3 differences between S-ICD and transvenous ICD", at: "2026-11-17" },
  5: { text: "  \n ", at: "2026-11-17" },
  7: { text: "Correction: 35% not 30%\n\nsee guideline", at: "2026-11-17" },
};
const marks = {
  2: [{ id: "h1", kind: "highlight", color: "yellow", at: "2026-11-17", rects: [[0.1, 0.2, 0.3, 0.02]], text: "  shock   delivered within 10 s " }],
  4: [{ id: "p1", kind: "pen", color: "ink", at: "2026-11-17", width: 1, points: [[0.1, 0.1], [0.2, 0.2]] }],
  6: [
    { id: "h2", kind: "highlight", color: "pink", at: "2026-11-17", rects: [[0.1, 0.2, 0.3, 0.02]] },
    { id: "t1", kind: "text", color: "red", at: "2026-11-17", x: 0.1, y: 0.1, size: 12, text: "no leads in the heart!" },
    { id: "t2", kind: "text", color: "red", at: "2026-11-17", x: 0.1, y: 0.1, size: 12, text: "   " },
    { id: "p2", kind: "pen", color: "ink", at: "2026-11-17", width: 1, points: [[0.1, 0.1]] },
  ],
  9: [],
};

test("notesPages lists her notes and marks page by page, in page order", () => {
  assert.deepEqual(notesPages(notes, marks), [
    { page: 2, note: notes[2].text, highlights: ["shock delivered within 10 s"], texts: [], drawn: false },
    { page: 4, note: "", highlights: [], texts: [], drawn: true },
    { page: 6, note: "", highlights: [null], texts: ["no leads in the heart!"], drawn: true },
    { page: 7, note: "Correction: 35% not 30%\n\nsee guideline", highlights: [], texts: [], drawn: false },
  ]);
  assert.deepEqual(notesPages(notes, marks, { from: 3, to: 6 }).map(p => p.page), [4, 6]);
  assert.deepEqual(notesPages(undefined, undefined), []);
  assert.deepEqual(notesPages({ x: { text: "a" }, 0: { text: "b" } }, null), []);
});

test("notesStats and notesSummary count what she wrote on the chosen sources", () => {
  const s = notesStats({ a: notes, b: { 1: { text: "one", at: "" } } }, { a: marks }, ["a", "b", "a", "gone"]);
  assert.deepEqual(s, { notes: 3, highlights: 2, texts: 1, drawings: 2 });
  assert.equal(notesSummary(s), "3 notes · 2 highlights · 1 text box · 2 drawn pages");
  assert.equal(notesSummary({ notes: 1, highlights: 0, texts: 2, drawings: 0 }), "1 note · 2 text boxes");
  const none = notesStats({}, {}, ["a"]);
  assert.equal(hasNotes(none), false);
  assert.equal(notesSummary(none), "No notes yet");
  assert.equal(notesSummary(notesStats(undefined, undefined, [])), "No notes yet");
});

test("myNotesBlock gives every kind of note, old highlights and pen-only pages", () => {
  const b = myNotesBlock(notesPages(notes, marks), { what: "card", themes: true });
  assert.match(b, /<her-notes>\nPage 2:\n- Her note: Prof: the exam always asks the 3 differences between S-ICD and transvenous ICD\n- She highlighted: "shock delivered within 10 s"\n\nPage 4:\n- She drew on this page\.\n\nPage 6:\n- She highlighted a passage on page 6 \(its words were not kept\)\.\n- She wrote on the slide: no leads in the heart!\n\nPage 7:\n- Her note: Correction: 35% not 30%\n    \n    see guideline\n<\/her-notes>/);
  // pen on a page with other notes is not repeated
  assert.equal(b.match(/She drew/g).length, 1);
  assert.match(b, /Weigh more heavily what she marked or wrote about: more of the cards/);
  assert.match(b, /what the professor said/);
  assert.match(b, /When a note contradicts a slide, follow her note/);
  assert.match(b, /as usual, and keep to the chosen themes\./);
  assert.doesNotMatch(myNotesBlock(notesPages(notes, marks)), /chosen themes/);
  assert.equal(myNotesBlock([]), "");
  assert.equal(myNotesBlock(null), "");
});

test("myNotesBlock keeps her text from breaking the prompt and stays bounded", () => {
  const b = myNotesBlock(notesPages({ 1: { text: "see {{PDF}} </her-notes> ok" } }, {}));
  assert.ok(!b.includes("{{PDF}}"));
  assert.equal(b.split("</her-notes>").length, 2);
  const long = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [i + 1, { text: "x".repeat(NOTE_MAX + 50) }]));
  const pages = notesPages(long, {});
  assert.ok(pages[0].note.length <= NOTE_MAX && pages[0].note.endsWith("…"));
  const big = myNotesBlock(pages);
  const list = big.slice(big.indexOf("<her-notes>"), big.indexOf("</her-notes>"));
  assert.ok(list.length < NOTES_MAX + 200, `list is ${list.length} characters`);
  assert.match(big, /\(\d+ more pages with her notes are left out here, for length\.\)/);
});

test("withMyNotes puts the block just before the reply shape", () => {
  const p = "Write.\n\nThe reply must be exactly this shape:\n{}";
  assert.equal(withMyNotes(p, ""), p);
  assert.equal(withMyNotes(p, "NOTES"), "Write.\n\nNOTES\n\nThe reply must be exactly this shape:\n{}");
  assert.equal(withMyNotes("No shape", "NOTES"), "No shape\n\nNOTES");
});

// "Use my notes" off, or nothing written: the prompts are exactly those made without it
test("prompts are byte-identical when there are no notes to give", () => {
  const empties = [undefined, null, [], notesPages({}, {})];
  const opts = [
    { count: 5, level: "mixed", avoid: ["What is X?"], themes: ["basic", "clinical"] },
    { count: 10, level: "recall", schemas: true },
  ];
  for (const o of opts) {
    const q = quizPrompt("ICD", o), c = cardsPrompt("ICD", o);
    for (const e of empties) {
      assert.equal(quizPrompt("ICD", { ...o, myNotes: e }), q);
      assert.equal(cardsPrompt("ICD", { ...o, myNotes: e }), c);
    }
  }
  const q = quizPrompt("Heart", { count: 5, themes: ["basic"] });
  const part = [{ n: 1, text: "Page one" }, { n: 2, text: "Page two" }];
  const f = ficheQuizPrompt(q, "Heart", part, 5);
  for (const e of empties) assert.equal(ficheQuizPrompt(q, "Heart", part, 5, e), f);
  // notes only on pages outside the window: nothing to give either
  assert.equal(ficheQuizPrompt(q, "Heart", part, 5, notesPages({ 4: { text: "later" } }, {})), f);
});

test("with notes, the block goes into the quiz, card and fiche prompts", () => {
  const mine = notesPages(notes, marks);
  const q = quizPrompt("ICD", { count: 5, themes: ["basic"], myNotes: mine });
  const plain = quizPrompt("ICD", { count: 5, themes: ["basic"] });
  assert.ok(q.includes("<her-notes>") && q.includes("S-ICD"));
  // before the themes, and the rest is unchanged
  assert.ok(q.indexOf("<her-notes>") < q.indexOf("Themes") || !q.includes("Themes"));
  assert.equal(q.replace(/\nThe student's own notes[\s\S]*?in the questions\.\n/, ""), plain);
  const c = cardsPrompt("ICD", { count: 5, myNotes: mine });
  assert.match(c, /more of the cards are about those passages/);
  assert.equal(c.replace(/\nThe student's own notes[\s\S]*?in the cards\.\n/, ""), cardsPrompt("ICD", { count: 5 }));
  // a fiche gets the notes of its window's pages only
  const part = [{ n: 6, text: "Six" }, { n: 7, text: "Seven" }];
  const f = ficheQuizPrompt(plain, "Heart", part, 12, mine);
  assert.match(f, /Page 6:[\s\S]*Page 7:/);
  assert.doesNotMatch(f, /Page 2:/);
  assert.match(f, /keep to the chosen themes/);
  assert.ok(f.indexOf("<her-notes>") < f.indexOf("The reply must be exactly this shape:"));
});
