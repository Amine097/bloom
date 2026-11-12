import { test } from "node:test";
import assert from "node:assert/strict";
import { guidePrompt, quizPrompt, parseGuide, parseQuiz, shuffleOptions, readEnvelope, PDF_TOKEN } from "../ui/js/notebook-core.js";

const GUIDE = {
  summary: "How the cardiac action potential is shaped.",
  points: [{ text: "Phase 0 is the sodium upstroke.", page: 1 }, { text: "IKr block prolongs QT.", page: "2" }],
  terms: [{ term: "Plateau", def: "Phase 2, held by L-type calcium current." }],
};
const question = (over = {}) => ({ q: "What causes phase 0?", options: ["Na+ influx", "K+ efflux", "Ca2+ influx", "Cl- influx"], answer: 0, why: "Fast sodium channels open.", page: 1, ...over });

test("prompts carry the PDF placeholder, the title and the reply shape", () => {
  const g = guidePrompt('Heart "rhythm"');
  assert.ok(g.includes(PDF_TOKEN));
  assert.ok(g.includes('"Heart \\"rhythm\\""'));
  assert.ok(g.includes('"summary"') && g.includes('"terms"'));
  const q = quizPrompt("Heart", 8);
  assert.ok(q.includes(PDF_TOKEN) && q.includes("8 multiple-choice") && q.includes('"options"'));
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

test("parseQuiz validates every question", () => {
  const ok = parseQuiz("```\n" + JSON.stringify({ questions: [question(), question({ answer: "3", page: null })] }) + "\n```");
  assert.equal(ok.questions.length, 2);
  assert.equal(ok.questions[1].answer, 3);
  assert.equal(ok.questions[1].page, null);
  const bad = over => () => parseQuiz(JSON.stringify({ questions: [question(), question(over)] }));
  assert.throws(bad({ options: ["a", "b", "c"] }), /Question 2 does not have exactly four options/);
  assert.throws(bad({ options: ["a", "b", "c", ""] }), /Option 4 of question 2/);
  assert.throws(bad({ options: ["a", "b", "a", "c"] }), /same option twice/);
  assert.throws(bad({ answer: 4 }), /which option is correct/);
  assert.throws(bad({ answer: 1.5 }), /which option is correct/);
  assert.throws(bad({ why: " " }), /explanation of question 2/);
  assert.throws(bad({ q: 7 }), /text of question 2/);
  assert.throws(() => parseQuiz('{"questions": []}'), /questions are missing/);
  assert.throws(() => parseQuiz("[1, 2]"), /could not be read/);
});

test("shuffleOptions moves the options but keeps the right answer", () => {
  let k = 0;
  const seq = [0.9, 0.1, 0.5, 0.3, 0.7, 0.2];
  const [x] = shuffleOptions([question()], () => seq[k++ % seq.length]);
  assert.equal(x.options[x.answer], "Na+ influx");
  assert.deepEqual([...x.options].sort(), [...question().options].sort());
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
