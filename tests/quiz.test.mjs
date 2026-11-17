import { test } from "node:test";
import assert from "node:assert/strict";
import {
  standing, gapFor, share, planQuiz, drawQuiz, answered, standings, migrateBank, examGroups, GEN_MIN, GEN_MAX, SPARE,
} from "../ui/js/quiz-core.js";

const q = (id, over = {}) => ({ id, q: `Q${id}`, options: ["a", "b", "c", "d"], answer: 0, level: "recall", seen: 0, right: 0, lastSeen: null, lastRight: null, streak: 0, lastQuiz: null, ...over });
const fixed = () => 0.42;

test("standing: missed, new, due after 3 / 6 / 12 quizzes, resting before", () => {
  assert.equal(standing(q(1)), "new");
  assert.equal(standing(q(1, { seen: 1, lastRight: false, lastQuiz: 4 }), 4), "missed");
  const right = q(1, { seen: 1, lastRight: true, streak: 1, lastQuiz: 4 });
  assert.equal(standing(right, 6), "resting");
  assert.equal(standing(right, 7), "due");
  assert.equal(standing({ ...right, streak: 2 }, 9), "resting");
  assert.equal(standing({ ...right, streak: 2 }, 10), "due");
  assert.equal(standing({ ...right, streak: 7 }, 15), "resting");
  assert.equal(standing({ ...right, streak: 7 }, 16), "due");
  assert.equal(standing({ ...right, lastQuiz: null }, 0), "due"); // history from before quizzes were counted
  assert.deepEqual([1, 2, 3, 9].map(gapFor), [3, 6, 12, 12]);
});

test("share splits evenly, the first lectures taking the remainder", () => {
  assert.deepEqual(share(10, 3), [4, 3, 3]);
  assert.deepEqual(share(5, 8), [1, 1, 1, 1, 1, 0, 0, 0]);
  assert.deepEqual(share(10, 0), []);
});

test("planQuiz asks Claude only for what is missing, plus a spare, within bounds and room", () => {
  const banks = [
    { lecture: "a", quizzes: 0, questions: Array.from({ length: 8 }, (_, i) => q(i)) },
    { lecture: "b", quizzes: 0, questions: [] },
    { lecture: "c", quizzes: 0, questions: [q(1)] },
  ];
  const plan = planQuiz(banks, 12, "mixed");
  assert.deepEqual(plan.map(p => [p.want, p.ready, p.make]), [[4, 8, 0], [4, 0, Math.max(GEN_MIN, 4 + SPARE)], [4, 1, Math.max(GEN_MIN, 3 + SPARE)]]);
  const big = planQuiz([{ lecture: "a", questions: [] }], 30, "mixed");
  assert.equal(big[0].make, GEN_MAX);
  const full = planQuiz([{ lecture: "a", quizzes: 0, questions: Array.from({ length: 60 }, (_, i) => q(i, { seen: 1, lastRight: true, streak: 1, lastQuiz: 0 })) }], 10, "mixed");
  assert.equal(full[0].make, 0); // no room: resting questions fill in instead
});

test("planQuiz counts only questions of the chosen level", () => {
  const bank = { lecture: "a", quizzes: 0, questions: [q(1, { level: "recall" }), q(2, { level: "application" })] };
  assert.equal(planQuiz([bank], 5, "application")[0].ready, 1);
  assert.equal(planQuiz([bank], 5, "mixed")[0].ready, 2);
});

test("drawQuiz: missed first, then new, then due; resting only to fill", () => {
  const bank = {
    lecture: "a", quizzes: 5, questions: [
      q("rest", { seen: 1, lastRight: true, streak: 1, lastQuiz: 4 }),
      q("due", { seen: 1, lastRight: true, streak: 1, lastQuiz: 1 }),
      q("new"),
      q("miss", { seen: 1, lastRight: false, lastQuiz: 4 }),
    ],
  };
  const ids = n => drawQuiz([bank], n, "mixed", fixed).map(x => x.id).sort();
  assert.deepEqual(ids(1), ["miss"]);
  assert.deepEqual(ids(2), ["miss", "new"]);
  assert.deepEqual(ids(3), ["due", "miss", "new"]);
  assert.deepEqual(ids(4), ["due", "miss", "new", "rest"]);
  assert.deepEqual(ids(9), ["due", "miss", "new", "rest"]); // never more than there is
});

test("drawQuiz shares between lectures, and others make up for a small one", () => {
  const a = { lecture: "a", quizzes: 0, questions: Array.from({ length: 10 }, (_, i) => q(`a${i}`)) };
  const b = { lecture: "b", quizzes: 0, questions: [q("b0")] };
  const draw = drawQuiz([a, b], 6, "mixed", fixed);
  assert.equal(draw.length, 6);
  assert.equal(draw.filter(x => x.lecture === "b").length, 1);
  assert.equal(new Set(draw.map(x => `${x.lecture}:${x.id}`)).size, 6);
  for (const x of draw) assert.deepEqual([...x.order].sort(), [0, 1, 2, 3]);
});

test("drawQuiz keeps to the chosen level", () => {
  const bank = { lecture: "a", quizzes: 0, questions: [q(1, { level: "recall" }), q(2, { level: "application" }), q(3, { level: null })] };
  assert.deepEqual(drawQuiz([bank], 5, "application", fixed).map(x => x.id), [2]);
  assert.equal(drawQuiz([bank], 5, "mixed", fixed).length, 3);
});

test("answered keeps the streak and the quiz number", () => {
  let x = answered(q(1), true, "2026-11-14", 1);
  assert.deepEqual([x.seen, x.right, x.streak, x.lastQuiz, x.lastRight], [1, 1, 1, 1, true]);
  x = answered(x, true, "2026-11-15", 5);
  assert.equal(x.streak, 2);
  x = answered(x, false, "2026-11-16", 6);
  assert.deepEqual([x.seen, x.right, x.streak, x.lastRight], [3, 2, 0, false]);
});

test("standings counts a bank", () => {
  const bank = { quizzes: 2, questions: [q(1), q(2, { seen: 1, lastRight: false }), q(3, { seen: 1, lastRight: true, streak: 1, lastQuiz: 2 })] };
  assert.deepEqual(standings(bank), { missed: 1, new: 1, due: 0, resting: 1 });
});

test("migrateBank adds the counters without losing anything", () => {
  const old = { createdAt: "2026-10-01", best: null, sessions: [{}, {}], questions: [{ id: "x", q: "Q", seen: 2, right: 2, lastRight: true }, { id: "y", q: "R", seen: 1, right: 0, lastRight: false }] };
  const m = migrateBank(structuredClone(old));
  assert.equal(m.quizzes, 2);
  assert.deepEqual(m.questions.map(x => [x.streak, x.lastQuiz]), [[1, null], [0, null]]);
  assert.equal(m.questions[0].right, 2);
  assert.deepEqual(migrateBank(structuredClone(m)), m); // running it again changes nothing
});

test("examGroups: modules sharing an exam still to come", () => {
  const modules = { a: { exam: "2026-12-21" }, b: { exam: "2026-12-21" }, c: { exam: "2027-01-08" }, d: { exam: "2026-10-01" }, e: { exam: "2026-10-01" }, f: { exam: null } };
  assert.deepEqual(examGroups(modules, "2026-11-14"), [{ date: "2026-12-21", ids: ["a", "b"] }]);
});

test("planQuiz counts only questions of the ticked themes, so Claude writes more when a theme is thin", () => {
  const bank = {
    lecture: "a", quizzes: 0, questions: [
      ...Array.from({ length: 8 }, (_, i) => q(`b${i}`, { themes: ["basic"] })),
      q("t1", { themes: ["trials", "clinical"] }),
      q("u1"), // not sorted yet: counts for any theme
    ],
  };
  assert.equal(planQuiz([bank], 5, "mixed", ["basic"])[0].ready, 9);
  assert.equal(planQuiz([bank], 5, "mixed", ["basic"])[0].make, 0);
  const trials = planQuiz([bank], 5, "mixed", ["trials"])[0];
  assert.equal(trials.ready, 2);
  assert.equal(trials.make, GEN_MIN + 1); // short by 3, plus the spare
  assert.equal(planQuiz([bank], 5, "mixed")[0].ready, 10); // no themes: everything
});

test("drawQuiz only asks questions with a ticked theme", () => {
  const bank = {
    lecture: "a", quizzes: 0, questions: [
      q(1, { themes: ["basic"] }), q(2, { themes: ["trials"] }), q(3, { themes: ["clinical", "pharmacology"] }), q(4),
    ],
  };
  assert.deepEqual(drawQuiz([bank], 5, "mixed", fixed, ["pharmacology", "basic"]).map(x => x.id).sort(), [1, 3, 4]);
  assert.deepEqual(drawQuiz([bank], 5, "mixed", fixed, ["trials"]).map(x => x.id).sort(), [2, 4]);
  assert.equal(drawQuiz([bank], 5, "mixed", fixed).length, 4);
});
