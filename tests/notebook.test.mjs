import { test } from "node:test";
import assert from "node:assert/strict";
import {
  guidePrompt, quizPrompt, parseGuide, parseQuiz, readEnvelope, PDF_TOKEN, normText, mergeQuestions,
  shuffled, pickSession, withAnswer, withSession, migrateQuiz, BANK_MAX, SESSIONS_KEPT,
} from "../ui/js/notebook-core.js";

const GUIDE = {
  summary: "How the cardiac action potential is shaped.",
  points: [{ text: "Phase 0 is the sodium upstroke.", page: 1 }, { text: "IKr block prolongs QT.", page: "2" }],
  terms: [{ term: "Plateau", def: "Phase 2, held by L-type calcium current." }],
};
const question = (over = {}) => ({ q: "What causes phase 0?", options: ["Na+ influx", "K+ efflux", "Ca2+ influx", "Cl- influx"], answer: 0, level: "recall", why: "Fast sodium channels open.", page: 1, ...over });

test("prompts carry the PDF placeholder, the title and the reply shape", () => {
  const g = guidePrompt('Heart "rhythm"');
  assert.ok(g.includes(PDF_TOKEN));
  assert.ok(g.includes('"Heart \\"rhythm\\""'));
  assert.ok(g.includes('"summary"') && g.includes('"terms"'));
  const q = quizPrompt("Heart", { count: 15 });
  assert.ok(q.includes(PDF_TOKEN) && q.includes("Write 15 multiple-choice") && q.includes('"options"') && q.includes('"level"'));
  assert.ok(q.includes("Mix the three levels") && q.includes("all of the above") && q.includes("similar length"));
  assert.ok(!q.includes("already has"));
});

test("quizPrompt asks for one level, and lists the questions to avoid", () => {
  const q = quizPrompt("Heart", { count: 5, level: "application", avoid: ["What causes\nphase 0?", "Which drug blocks IKr?"] });
  assert.ok(q.includes('Every question is at the "application" level.'));
  assert.ok(q.includes("do not repeat or reword") && q.includes("- What causes phase 0?") && q.includes("- Which drug blocks IKr?"));
  assert.ok(quizPrompt("Heart", { level: "anything" }).includes("Mix the three levels"));
});

test("parseGuide reads plain JSON, fenced JSON and JSON inside text", () => {
  const want = { ...GUIDE, points: [GUIDE.points[0], { ...GUIDE.points[1], page: 2 }] };
  assert.deepEqual(parseGuide(JSON.stringify(GUIDE)), want);
  assert.deepEqual(parseGuide("```json\n" + JSON.stringify(GUIDE) + "\n```"), want);
  assert.deepEqual(parseGuide("Here is the guide:\n" + JSON.stringify(GUIDE) + "\nGood luck!"), want);
});

test("parseGuide accepts a missing page and trims text", () => {
  const g = parseGuide(JSON.stringify({ ...GUIDE, summary: "  Hi  ", points: [{ text: " A " }] }));
  assert.equal(g.summary, "Hi");
  assert.deepEqual(g.points, [{ text: "A", page: null }]);
});

test("parseGuide rejects what is not a guide, with a readable message", () => {
  assert.throws(() => parseGuide(""), /empty/);
  assert.throws(() => parseGuide("I could not read the file."), /could not be read/);
  assert.throws(() => parseGuide(JSON.stringify({ ...GUIDE, summary: "" })), /summary is missing/);
  assert.throws(() => parseGuide(JSON.stringify({ ...GUIDE, points: [] })), /key points are missing/);
  assert.throws(() => parseGuide(JSON.stringify({ ...GUIDE, terms: [{ term: "X" }] })), /definition of key term 1/);
  assert.throws(() => parseGuide(JSON.stringify({ ...GUIDE, points: [{ text: "A", page: 0 }] })), /page number/);
  assert.throws(() => parseGuide(JSON.stringify({ ...GUIDE, points: ["just text"] })), /Key point 1/);
});

test("parseQuiz reads valid questions", () => {
  const ok = parseQuiz("```\n" + JSON.stringify({ questions: [question(), question({ answer: "3", page: null, level: " Application " })] }) + "\n```");
  assert.equal(ok.questions.length, 2);
  assert.deepEqual(ok.skipped, []);
  assert.deepEqual(ok.questions[0], question());
  assert.equal(ok.questions[1].answer, 3);
  assert.equal(ok.questions[1].page, null);
  assert.equal(ok.questions[1].level, "application");
});

test("parseQuiz says what is wrong with a question", () => {
  // one bad question out of one: the batch fails with that question's problem
  const bad = over => () => parseQuiz(JSON.stringify({ questions: [question(over)] }));
  assert.throws(bad({ options: ["a", "b", "c"] }), /^Error: Question 1 does not have exactly four options\.$/);
  assert.throws(bad({ options: ["a", "b", "c", ""] }), /Option 4 of question 1/);
  assert.throws(bad({ options: ["a", "b", "a", "c"] }), /same option twice/);
  assert.throws(bad({ options: ["Na+ influx", "na+  influx.", "c", "d"] }), /same option twice/);
  assert.throws(bad({ options: ["a", "b", "c", "All of the above"] }), /"all of the above" kind of option/);
  assert.throws(bad({ options: ["a", "b", "None of the above.", "c"] }), /"all of the above" kind of option/);
  assert.throws(bad({ options: ["a", "b", "c", "A and B"] }), /"all of the above" kind of option/);
  assert.throws(bad({ answer: 4 }), /which option is correct/);
  assert.throws(bad({ answer: 1.5 }), /which option is correct/);
  assert.throws(bad({ level: undefined }), /recall, understanding or application/);
  assert.throws(bad({ level: "hard" }), /recall, understanding or application/);
  assert.throws(bad({ why: " " }), /explanation of question 1/);
  assert.throws(bad({ q: 7 }), /text of question 1/);
  assert.throws(() => parseQuiz('{"questions": []}'), /questions are missing/);
  assert.throws(() => parseQuiz("[1, 2]"), /could not be read/);
  // a legitimate option that merely contains "both" is fine
  assert.equal(parseQuiz(JSON.stringify({ questions: [question({ options: ["Both channels open", "b", "c", "d"] })] })).questions.length, 1);
});

test("parseQuiz keeps the valid questions when at least half are valid", () => {
  const half = parseQuiz(JSON.stringify({ questions: [question(), question({ answer: 9 }), question({ q: "Other?" }), question({ options: [] })] }));
  assert.deepEqual(half.questions.map(x => x.q), ["What causes phase 0?", "Other?"]);
  assert.deepEqual(half.skipped, ["Question 2 does not say which option is correct.", "Question 4 does not have exactly four options."]);
  assert.throws(() => parseQuiz(JSON.stringify({ questions: [question(), question({ answer: 9 }), question({ why: "" })] })),
    /^Error: Only 1 of Claude's 3 questions could be used\. Question 2 does not say which option is correct\. Try again\.$/);
  assert.throws(() => parseQuiz(JSON.stringify({ questions: [question({ answer: 9 }), "text"] })),
    /^Error: None of Claude's 2 questions could be used\. Question 1 does not say/);
});

test("normText ignores case, accents, punctuation and spacing", () => {
  assert.equal(normText("  Which  ion causes Phase 0 ? "), "which ion causes phase 0");
  assert.equal(normText("Rôle du Ca²⁺ ?"), normText("role du ca2+"));
});

let n = 0;
const makeId = () => `id${++n}`;

test("mergeQuestions adds new questions with an empty history and drops duplicates", () => {
  n = 0;
  const first = mergeQuestions([], [question(), question({ q: "what causes PHASE 0 ?!" }), question({ q: "Which drug blocks IKr?", page: undefined })], { date: "2026-11-12", makeId });
  assert.equal(first.added.length, 2);
  assert.equal(first.duplicates, 1);
  assert.deepEqual(first.questions[0], { ...question(), id: "id1", addedAt: "2026-11-12", seen: 0, right: 0, lastSeen: null, lastRight: null });
  assert.equal(first.questions[1].page, null);
  const again = mergeQuestions(first.questions, [question({ q: "Which drug blocks IKr" }), question({ q: "What is the plateau?" })], { date: "2026-11-13", makeId });
  assert.deepEqual(again.added.map(x => x.q), ["What is the plateau?"]);
  assert.equal(again.duplicates, 1);
  assert.equal(again.questions.length, 3);
  assert.equal(first.questions.length, 2, "the bank given is not changed");
});

test("mergeQuestions stops at the size limit", () => {
  n = 0;
  const many = Array.from({ length: 5 }, (_, i) => question({ q: `Question number ${i}` }));
  const r = mergeQuestions([], many, { date: "2026-11-12", makeId, max: 3 });
  assert.equal(r.questions.length, 3);
  assert.equal(r.overflow, 2);
  assert.equal(BANK_MAX, 60);
});

/** A repeatable random source. */
const seeded = (seed = 1) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const banked = (id, over = {}) => ({ ...question({ q: `Q ${id}` }), id, seen: 1, right: 1, lastSeen: "2026-11-01", lastRight: true, ...over });

test("shuffled returns every index once", () => {
  for (let s = 1; s < 20; s++) assert.deepEqual([...shuffled(4, seeded(s))].sort(), [0, 1, 2, 3]);
  assert.deepEqual(shuffled(0), []);
});

test("pickSession asks never-seen and missed questions first, then the least recently seen", () => {
  const bank = [
    banked("old", { lastSeen: "2026-10-01" }),
    banked("recent", { lastSeen: "2026-11-10" }),
    banked("new", { seen: 0, right: 0, lastSeen: null, lastRight: null }),
    banked("mid", { lastSeen: "2026-10-20" }),
    banked("missed", { lastSeen: "2026-11-11", lastRight: false }),
  ];
  for (let s = 1; s < 30; s++) {
    const two = pickSession(bank, 2, seeded(s)).map(x => x.id).sort();
    assert.deepEqual(two, ["missed", "new"]);
    const three = pickSession(bank, 3, seeded(s)).map(x => x.id).sort();
    assert.deepEqual(three, ["missed", "new", "old"]);
    const four = pickSession(bank, 4, seeded(s)).map(x => x.id).sort();
    assert.deepEqual(four, ["mid", "missed", "new", "old"]);
  }
  const all = pickSession(bank, "all", seeded(3));
  assert.deepEqual(all.map(x => x.id).sort(), ["mid", "missed", "new", "old", "recent"]);
  assert.equal(pickSession(bank, 50, seeded(3)).length, 5);
  assert.deepEqual(pickSession([], 10), []);
});

test("pickSession shuffles the option order per session without changing the stored question", () => {
  const bank = [banked("a"), banked("b"), banked("c")];
  const before = JSON.stringify(bank);
  const orders = new Set();
  for (let s = 1; s < 40; s++) {
    for (const { order } of pickSession(bank, "all", seeded(s))) {
      assert.deepEqual([...order].sort(), [0, 1, 2, 3]);
      orders.add(order.join(""));
    }
  }
  assert.ok(orders.size > 5, "options come in many orders");
  assert.equal(JSON.stringify(bank), before);
  // the right option, as shown, is found through the order
  const [{ id, order }] = pickSession([banked("a", { answer: 2 })], 1, seeded(7));
  assert.equal(id, "a");
  const shown = order.map(k => banked("a").options[k]);
  assert.equal(shown[order.indexOf(2)], "Ca2+ influx");
});

test("pickSession picks at random among equals", () => {
  const bank = Array.from({ length: 10 }, (_, i) => banked(`q${i}`, { seen: 0, lastRight: null, lastSeen: null }));
  const firsts = new Set();
  for (let s = 1; s < 40; s++) firsts.add(pickSession(bank, 3, seeded(s)).map(x => x.id).sort().join());
  assert.ok(firsts.size > 3);
});

test("withAnswer counts the answer; withSession keeps the best and the last sessions", () => {
  const x = withAnswer(banked("a", { seen: 2, right: 1 }), false, "2026-11-12");
  assert.deepEqual([x.seen, x.right, x.lastSeen, x.lastRight], [3, 1, "2026-11-12", false]);
  const y = withAnswer({ ...question(), id: "b" }, true, "2026-11-12");
  assert.deepEqual([y.seen, y.right, y.lastRight], [1, 1, true]);

  let quiz = { best: null, sessions: [] };
  const play = (score, total, date = "2026-11-12") => { quiz = { ...quiz, ...withSession(quiz, { date, score, total }) }; };
  play(6, 10);
  assert.deepEqual(quiz.best, { date: "2026-11-12", score: 6, total: 10 });
  play(3, 5); // same share, fewer questions: not better
  assert.equal(quiz.best.total, 10);
  play(4, 5, "2026-11-13");
  assert.deepEqual(quiz.best, { date: "2026-11-13", score: 4, total: 5 });
  play(8, 10); // same share, more questions: better
  assert.deepEqual(quiz.best, { date: "2026-11-12", score: 8, total: 10 });
  for (let i = 0; i < 12; i++) play(1, 10, `2026-12-${String(i + 1).padStart(2, "0")}`);
  assert.equal(quiz.sessions.length, SESSIONS_KEPT);
  assert.equal(quiz.sessions.at(-1).date, "2026-12-12");
  assert.equal(quiz.best.score, 8);
  // a migrated best (score out of the old quiz length) is compared the same way
  assert.deepEqual(withSession({ best: { score: 7, total: 8, date: null }, sessions: [] }, { date: "d", score: 8, total: 10 }).best, { score: 7, total: 8, date: null });
});

test("migrateQuiz turns a version 2 quiz into a bank without losing anything", () => {
  const old = {
    createdAt: "2026-11-01",
    questions: [question({ answer: 2, level: undefined }), question({ q: "Which drug blocks IKr?", page: null, level: undefined })],
    best: 6,
  };
  for (const x of old.questions) delete x.level;
  const z = migrateQuiz(structuredClone(old));
  assert.equal(z.createdAt, "2026-11-01");
  assert.deepEqual(z.best, { score: 6, total: 2, date: null });
  assert.deepEqual(z.sessions, []);
  assert.equal(z.questions.length, 2);
  assert.deepEqual(z.questions[0], { ...old.questions[0], id: "m1", level: null, addedAt: "2026-11-01", seen: 0, right: 0, lastSeen: null, lastRight: null });
  assert.equal(z.questions[1].id, "m2");
  assert.equal(z.questions[0].options[z.questions[0].answer], "Ca2+ influx", "the stored answer still points at the same option");
  // running it again changes nothing
  assert.deepEqual(migrateQuiz(structuredClone(z)), z);
  // a quiz never played
  assert.equal(migrateQuiz({ ...old, best: null }).best, null);
  // a converted quiz keeps its history
  const played = { ...z, questions: [{ ...z.questions[0], seen: 3, right: 2, lastSeen: "2026-11-10", lastRight: false, level: "recall" }], sessions: [{ date: "2026-11-10", score: 2, total: 3 }] };
  assert.deepEqual(migrateQuiz(structuredClone(played)), played);
  assert.equal(migrateQuiz({ nonsense: true }), null);
  assert.equal(migrateQuiz(null), null);
});

test("readEnvelope returns the result and turns failures into messages", () => {
  const env = over => JSON.stringify({ type: "result", is_error: false, result: "hello", ...over });
  assert.equal(readEnvelope(env()), "hello");
  assert.equal(readEnvelope("some log line\n" + env()), "hello");
  assert.throws(() => readEnvelope(env({ is_error: true, result: "Not logged in" })), /Claude Code: Not logged in/);
  assert.throws(() => readEnvelope(env({ is_error: true, subtype: "error_max_turns", result: undefined })), /more steps/);
  assert.throws(() => readEnvelope(env(), 1), /Claude Code: hello/);
  assert.throws(() => readEnvelope("", 2, "boom"), /did not answer \(exit code 2\)\. boom/);
  assert.throws(() => readEnvelope(env({ result: "  " })), /empty/);
});
