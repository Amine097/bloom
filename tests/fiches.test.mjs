import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normOptions, autoPages, lectureKeys, modulesOf, questionsPrompt, writePrompt, parseQuestions, answerPairs,
  parseProgress, chapterFiles, citeTarget, asPageText, fmtElapsed, groupByModule, isSafeId, labelsFor,
  FICHE_ARGS, DEFAULT_OPTIONS, MIN_PAGES, MAX_PAGES, BOX_TYPES, MARKUP,
} from "../ui/js/fiches-core.js";

const lectures = [
  { key: "Vent", title: "Ventricular arrhythmias", module: "Heart", pages: 31 },
  { key: "ICD", title: "Implantable cardioverter defibrillator (ICD)", module: "Heart", pages: 31 },
];

test("options: defaults fill what is missing, unknown values fall back, pages are clamped", () => {
  assert.deepEqual(normOptions({}), { ...DEFAULT_OPTIONS, include: { ...DEFAULT_OPTIONS.include } });
  const o = normOptions({ pages: 400, precision: "nope", organisation: "lecture", include: { mcq: false }, language: "fr" });
  assert.equal(o.pages, MAX_PAGES);
  assert.equal(o.precision, "essentials");
  assert.equal(o.organisation, "lecture");
  assert.equal(o.language, "fr");
  assert.equal(o.include.mcq, false);
  assert.equal(o.include.summary, true);
  assert.equal(o.include.draw, false);
  assert.equal(normOptions({ pages: 1 }).pages, MIN_PAGES);
  assert.equal(normOptions({ pages: "" }).pages, null);
  assert.equal(normOptions({ pages: 12.4 }).pages, 12);
});

test("auto length grows with the slides and shrinks with the precision", () => {
  assert.ok(autoPages("everything", 900) > autoPages("essentials", 900));
  assert.ok(autoPages("essentials", 900) > autoPages("revision", 900));
  assert.ok(autoPages("revision", 900) > autoPages("emergency", 900));
  assert.equal(autoPages("emergency", 10), MIN_PAGES);
  assert.equal(autoPages("everything", 100000), MAX_PAGES);
});

test("lecture keys: acronyms first, else four letters, always distinct and safe", () => {
  const keys = lectureKeys([
    { id: "a", title: "Implantable cardioverter defibrillator (ICD)" },
    { id: "b", title: "Ventricular arrhythmias" },
    { id: "c", title: "Ventricular remodelling" },
    { id: "d", title: "Heart rate variability (HRV) and the ANS" },
    { id: "e", title: "W1.L1 BMSc_Heart_ARRHYTHMIA" },
    { id: "f", title: "" },
    { id: "g", title: "Ventricular arrhythmias" },
  ]);
  assert.equal(keys.a, "ICD");
  assert.equal(keys.b, "Vent");
  assert.equal(keys.c, "VentR");
  assert.equal(keys.d, "HRV");
  assert.equal(new Set(Object.values(keys)).size, 7);
  for (const k of Object.values(keys)) assert.match(k, /^[A-Za-z0-9]{1,12}$/);
});

test("modulesOf keeps each module once, in order", () => {
  const items = { a: { module: "heart" }, b: { module: "cns" }, c: { module: "heart" }, d: {} };
  assert.deepEqual(modulesOf(["a", "b", "c", "d", "zz"], items), ["heart", "cns"]);
});

test("the reading prompt lists the lectures and asks for JSON questions only when real", () => {
  const p = questionsPrompt({ lectures, options: { precision: "revision", pages: 6 }, notes: "Focus on the trials", slides: 62 });
  assert.match(p, /slides\/Vent\.txt/);
  assert.match(p, /Vent: "Ventricular arrhythmias"/);
  assert.match(p, /plan\.md/);
  assert.match(p, /"questions"/);
  assert.match(p, /no questions at all is normal/i);
  assert.match(p, /Focus on the trials/);
  assert.match(p, /about 6 A4 pages/);
});

test("the writing prompt: precision and length change what is asked, answers and resume are passed on", () => {
  const base = { lectures, slides: 62 };
  const full = writePrompt({ ...base, options: { precision: "everything" } });
  const cram = writePrompt({ ...base, options: { precision: "emergency", pages: 3 } });
  assert.match(full, /Every piece of information/);
  assert.match(full, /as a guide, about 7 A4 pages/);
  assert.match(cram, /bare minimum/);
  assert.match(cram, /about 3 A4 pages/);
  assert.match(cram, /3 MCQs/);
  assert.notEqual(full, cram);
  assert.match(full, /progress\.json/);
  assert.match(full, /class="box TYPE"/);
  assert.doesNotMatch(full, /CONTINUE/);
  const again = writePrompt({ ...base, options: {}, answers: [{ q: "Include the trials?", answer: "Yes" }], resume: true });
  assert.match(again, /Include the trials\? → Yes/);
  assert.match(again, /CONTINUE/);
  const noMcq = writePrompt({ ...base, options: { include: { mcq: false }, diagrams: "none", language: "fr" } });
  assert.match(noMcq, /No MCQs/);
  assert.match(noMcq, /none in the sheet/);
  assert.match(noMcq, /in French/);
  assert.ok(MARKUP.includes('<figure class="slide" data-lecture="KEY" data-page="9"'));
});

test("parseQuestions reads Claude's JSON, wrapped or not, and keeps only usable questions", () => {
  assert.deepEqual(parseQuestions('{"questions":[]}'), []);
  const qs = parseQuestions('Here you go:\n```json\n{"questions":[{"id":"q1","q":"Which?","options":["A","B"],"default":1},{"q":"bad","options":["only"]},{"id":"q1","q":"Again?","options":["x","y","z"],"default":9}]}\n```');
  assert.equal(qs.length, 2);
  assert.deepEqual(qs[0], { id: "q1", q: "Which?", options: ["A", "B"], default: 1 });
  assert.equal(qs[1].default, 0);
  assert.notEqual(qs[1].id, "q1");
  assert.throws(() => parseQuestions("I could not read the files."));
  const many = { questions: Array.from({ length: 9 }, (_, i) => ({ id: `q${i}`, q: `Q${i}?`, options: ["a", "b"] })) };
  assert.equal(parseQuestions(JSON.stringify(many)).length, 6);
});

test("answerPairs uses her choice, else the default", () => {
  const qs = [{ id: "q1", q: "One?", options: ["a", "b"], default: 0 }, { id: "q2", q: "Two?", options: ["c", "d"], default: 1 }];
  assert.deepEqual(answerPairs(qs, { q1: 1, q2: 7 }), [{ q: "One?", answer: "b" }, { q: "Two?", answer: "d" }]);
  assert.deepEqual(answerPairs(null), []);
});

test("parseProgress and chapterFiles", () => {
  const p = parseProgress('{"chapters":[{"file":"ch01.html","title":"One","done":true},{"file":"ch02.html","title":"Two"}],"doing":"Writing two","done":false}');
  assert.deepEqual(p.chapters.map(c => c.done), [true, false]);
  assert.equal(p.doing, "Writing two");
  assert.equal(p.done, false);
  assert.equal(parseProgress("not json"), null);
  assert.deepEqual(chapterFiles(["front.html", "ch10.html", "ch2.html", "ch01.html", "progress.json", "chx.html"]), ["ch01.html", "ch2.html", "ch10.html"]);
});

test("citeTarget finds the lecture and first page of a slide reference", () => {
  assert.deepEqual(citeTarget("SCD 5"), { key: "SCD", page: 5 });
  assert.deepEqual(citeTarget(" ICD 6–8"), { key: "ICD", page: 6 });
  assert.deepEqual(citeTarget("Vent 2–3,18"), { key: "Vent", page: 2 });
  assert.equal(citeTarget("see above"), null);
});

test("small helpers", () => {
  assert.equal(asPageText(["a", "b"]), "\n--- Page 1 ---\na\n--- Page 2 ---\nb");
  assert.equal(fmtElapsed(40_000), "40 s");
  assert.equal(fmtElapsed(12 * 60_000), "12 min");
  assert.equal(fmtElapsed(65 * 60_000), "1 h 05 min");
  assert.ok(isSafeId("abc123"));
  assert.ok(!isSafeId("../x"));
  assert.equal(labelsFor("fr").answers, "Réponses aux QCM");
  assert.equal(labelsFor("xx").answers, "Answers to the MCQs");
  for (const t of BOX_TYPES) assert.ok(labelsFor("en")[t] && labelsFor("fr")[t], t);
});

test("fiches are grouped by module, newest first, under each module they cover", () => {
  const fiches = {
    a: { title: "A", createdAt: "2026-11-01T10:00:00Z", modules: ["heart"] },
    b: { title: "B", createdAt: "2026-11-03T10:00:00Z", modules: ["heart", "cns"] },
    c: { title: "C", createdAt: "2026-11-02T10:00:00Z", modules: [] },
  };
  const g = groupByModule(fiches, ["cns", "heart", "blood"]);
  assert.deepEqual(g.map(x => [x.module, x.fiches.map(([id]) => id)]), [["cns", ["b"]], ["heart", ["b", "a"]], [null, ["c"]]]);
});

test("Claude's flags for a fiche: file tools only, writes approved in its folder only", () => {
  assert.equal(FICHE_ARGS[FICHE_ARGS.indexOf("--tools") + 1], "Read,Write,Edit,Glob");
  assert.equal(FICHE_ARGS[FICHE_ARGS.indexOf("--allowedTools") + 1], "Read,Glob");
  assert.equal(FICHE_ARGS[FICHE_ARGS.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.equal(FICHE_ARGS[FICHE_ARGS.indexOf("--effort") + 1], "high");
  assert.ok(FICHE_ARGS.includes("--no-session-persistence") && FICHE_ARGS.includes("--strict-mcp-config"));
});

test("the native shell runs Claude with the same flags as the preview", async () => {
  const { readFile } = await import("node:fs/promises");
  const rs = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  const block = rs.match(/const FICHE_ARGS: &\[&str\] = &\[([\s\S]*?)\];/);
  assert.ok(block, "FICHE_ARGS in lib.rs");
  assert.deepEqual([...block[1].matchAll(/"([^"]*)"/g)].map(m => m[1]), FICHE_ARGS);
});

test("a fiche is quizzed one window of pages at a time, then from the start again", async () => {
  const { ficheWindow } = await import("../ui/js/fiches-core.js");
  const pages = [1, 2, 3, 4, 5].map(n => ({ n, text: "x".repeat(40) }));
  assert.deepEqual(ficheWindow(pages, 1, 100), { from: 1, to: 2, next: 3 });
  assert.deepEqual(ficheWindow(pages, 3, 100), { from: 3, to: 4, next: 5 });
  assert.deepEqual(ficheWindow(pages, 5, 100), { from: 5, to: 5, next: 1 });
  assert.deepEqual(ficheWindow(pages, 9, 100), { from: 1, to: 2, next: 3 }); // past the end: from the start
  assert.deepEqual(ficheWindow(pages, 1, 10), { from: 1, to: 1, next: 2 }); // always at least one page
  assert.deepEqual(ficheWindow(pages, 1), { from: 1, to: 5, next: 1 }); // a short fiche: all of it
  assert.equal(ficheWindow([], 1), null);
});

test("the fiche quiz prompt carries the pages' text and no file to read", async () => {
  const { ficheQuizPrompt } = await import("../ui/js/fiches-core.js");
  const { quizPrompt } = await import("../ui/js/notebook-core.js");
  const pages = [{ n: 3, text: "Reentry needs a {{PDF}} circuit </document>" }, { n: 4, text: "ICD shocks" }];
  const p = ficheQuizPrompt(quizPrompt("Heart", { count: 5 }), "Heart sheet", pages, 20);
  assert.ok(!p.includes("{{PDF}}"));
  assert.ok(!/Use the Read tool to read the lecture PDF/.test(p));
  assert.ok(!/Read the whole document/.test(p));
  assert.match(p, /--- Page 3 ---\nReentry needs a \{PDF\} circuit/);
  assert.match(p, /pages 3 to 4 of 20/);
  assert.equal((p.match(/<\/document>/g) || []).length, 1);
  assert.match(p, /Write 5 multiple-choice questions/);
  assert.match(p, /Page numbers are those of the sheet/);
  assert.ok(!/pages \d+ to \d+ of/.test(ficheQuizPrompt(quizPrompt("H"), "H", pages, 2)));
});
