import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pct, partOf, quizSeries, average, recentAverage, trend, movingAverage, lectureHistory, mastery, addMastery,
  lectureStats, weakSpots, activity, streaks, cardTotals, monday, perWeek, calendar, heat,
} from "../ui/js/progress-core.js";

const inA = id => id.startsWith("a");
const log = [
  { date: "2026-10-05", lectures: ["a1", "b1"], score: 6, total: 10, level: "mixed" },            // before v6: no `by`
  { date: "2026-10-01", lectures: ["a1"], score: 3, total: 5, level: "recall" },                  // before v6, one lecture
  { date: "2026-11-02", lectures: ["a1", "b1"], score: 7, total: 10, level: "mixed", by: { a1: [4, 5], b1: [3, 5] } },
  { date: "2026-11-02", lectures: ["a2"], score: 5, total: 5, level: "mixed", by: { a2: [5, 5] } },
];

test("pct and average weigh by questions and stay null when nothing was asked", () => {
  assert.equal(pct(2, 3), 67);
  assert.equal(pct(0, 0), null);
  assert.equal(average([{ score: 1, total: 2 }, { score: 9, total: 10 }]), 83);
  assert.equal(average([]), null);
});

test("partOf splits a quiz by lecture when it can, and keeps an older one whole only when it fits", () => {
  assert.deepEqual(partOf(log[2], null), { score: 7, total: 10, lectures: ["a1", "b1"] });
  assert.deepEqual(partOf(log[2], inA), { score: 4, total: 5, lectures: ["a1"] });
  assert.equal(partOf(log[3], id => id === "b1"), null);
  assert.equal(partOf(log[0], inA), null); // mixed and not split: left out of one module
  assert.deepEqual(partOf(log[1], inA), { score: 3, total: 5, lectures: ["a1"] });
  assert.deepEqual(partOf(log[0], null), { score: 6, total: 10, lectures: ["a1", "b1"] });
});

test("quizSeries sorts by date, keeping the log order within a day", () => {
  const all = quizSeries(log);
  assert.deepEqual(all.map(r => r.date), ["2026-10-01", "2026-10-05", "2026-11-02", "2026-11-02"]);
  assert.deepEqual(all.map(r => r.pct), [60, 60, 70, 100]);
  assert.deepEqual(quizSeries(log, inA).map(r => [r.score, r.total]), [[3, 5], [4, 5], [5, 5]]);
  assert.deepEqual(quizSeries(undefined), []);
});

test("recentAverage compares the last 30 days with what came before", () => {
  const r = recentAverage(quizSeries(log), "2026-11-14");
  assert.deepEqual(r, { recent: 80, before: 60, delta: 20 });
  assert.deepEqual(recentAverage(quizSeries(log), "2026-12-31"), { recent: null, before: 70, delta: null });
});

test("trend compares the last few scores with the ones just before", () => {
  assert.equal(trend([80]), null);
  assert.deepEqual(trend([50, 70]), { dir: "up", delta: 20 });
  assert.deepEqual(trend([90, 90, 90, 60, 60, 60]), { dir: "down", delta: -30 });
  assert.deepEqual(trend([10, 70, 72, 70, 74]), { dir: "flat", delta: 1 });
  assert.deepEqual(movingAverage([10, 20, 30, 40], 2), [10, 15, 25, 35]);
});

test("lectureHistory takes the log, then the bank sessions the log has no trace of", () => {
  const bank = { sessions: [
    { date: "2026-10-01", score: 3, total: 5 },  // = the one-lecture log entry
    { date: "2026-10-05", score: 4, total: 5 },  // its part of the older mixed quiz: only here
    { date: "2026-09-20", score: 1, total: 5 },  // older than the log
    { date: "2026-11-02", score: 4, total: 5 },  // = by.a1
  ] };
  const h = lectureHistory("a1", log, bank);
  assert.deepEqual(h.map(r => [r.date, r.score, r.src]), [
    ["2026-09-20", 1, "bank"], ["2026-10-01", 3, "log"], ["2026-10-05", 4, "bank"], ["2026-11-02", 4, "log"],
  ]);
  assert.deepEqual(lectureHistory("zz", log, null), []);
});

const q = (over = {}) => ({ seen: 1, right: 1, lastRight: true, streak: 1, lastQuiz: 5, ...over });

test("mastery sorts questions into mastered, learning, missed and fresh", () => {
  const bank = { quizzes: 6, questions: [
    q({ streak: 2, seen: 3, right: 2 }), q(), q({ lastRight: false, streak: 0, right: 0 }), q({ seen: 0, right: 0, lastRight: null, streak: 0, lastQuiz: null }),
    q({ lastQuiz: 1 }), // right once, rested 5 quizzes: due again
  ] };
  assert.deepEqual(mastery(bank), { total: 5, mastered: 1, learning: 2, missed: 1, fresh: 1, review: 2, answers: 6, wrong: 2 });
  assert.deepEqual(mastery(undefined), { total: 0, mastered: 0, learning: 0, missed: 0, fresh: 0, review: 0, answers: 0, wrong: 0 });
  assert.equal(addMastery([mastery(bank), mastery(bank)]).mastered, 2);
});

test("lectureStats and weakSpots find the lectures she misses most", () => {
  const a = lectureStats("a1", log, { sessions: [], questions: [q({ lastRight: false })] });
  assert.equal(a.quizzes, 2);
  assert.equal(a.average, 70);
  assert.equal(a.last, 80);
  assert.equal(a.trend.dir, "up");
  const s = (id, recent, missed, total = 10) => ({ id, quizzes: 1, recent, mastery: { missed, total, fresh: 0 } });
  const list = [s("good", 95, 0), s("bad", 40, 1), s("meh", 70, 0), s("often", 85, 3), s("rarely", 85, 3, 30), s("high", 95, 5), s("none", null, 0)];
  const weak = weakSpots(list.map(x => (x.id === "none" ? { ...x, quizzes: 0 } : x)));
  assert.deepEqual(weak.map(x => x.id), ["bad", "meh", "often"]);
  assert.deepEqual(weakSpots(list.slice(0, 4), 2).map(x => x.id), ["bad", "meh"]);
});

test("activity adds up questions and cards per day; streaks count days in a row", () => {
  const days = activity(log, [{ date: "2026-11-02", lecture: "a1", seen: 10, knew: 7 }, { date: "2026-11-03", seen: 0 }],
    [[{ date: "2026-09-20", total: 5, src: "bank" }, { date: "2026-10-01", total: 5, src: "log" }]]);
  assert.deepEqual(days.get("2026-11-02"), { questions: 15, cards: 10 });
  assert.deepEqual(days.get("2026-09-20"), { questions: 5, cards: 0 });
  assert.equal(days.get("2026-10-01").questions, 5);
  assert.equal(days.has("2026-11-03"), false);

  const set = new Set(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-05", "2026-11-06"]);
  assert.deepEqual(streaks(set, "2026-11-06"), { current: 2, best: 3, today: true });
  assert.deepEqual(streaks(set, "2026-11-07"), { current: 2, best: 3, today: false }); // not studied yet today
  assert.deepEqual(streaks(set, "2026-11-08"), { current: 0, best: 3, today: false });
  assert.deepEqual(streaks(new Set(), "2026-11-08"), { current: 0, best: 0, today: false });
});

test("cardTotals, weeks and the calendar", () => {
  assert.deepEqual(cardTotals([{ seen: 10, knew: 7 }, { seen: 10, knew: 9 }]), { sessions: 2, seen: 20, knew: 16, share: 80 });
  assert.deepEqual(cardTotals([]), { sessions: 0, seen: 0, knew: 0, share: null });
  assert.equal(monday("2026-11-14"), "2026-11-09"); // a Saturday
  assert.equal(monday("2026-11-09"), "2026-11-09");
  assert.equal(monday("2026-11-15"), "2026-11-09"); // a Sunday
  const w = perWeek([{ date: "2026-11-02", seen: 3, knew: 1 }, { date: "2026-11-10", seen: 5, knew: 5 }, { date: "2026-10-01", seen: 9 }],
    "2026-11-14", 2, ["seen", "knew"]);
  assert.deepEqual(w, [{ start: "2026-11-02", seen: 3, knew: 1 }, { start: "2026-11-09", seen: 5, knew: 5 }]);
  const cal = calendar("2026-11-11", 2);
  assert.deepEqual(cal[0], ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"]);
  assert.deepEqual(cal[1], ["2026-11-09", "2026-11-10", "2026-11-11", null, null, null, null]);
  assert.deepEqual([0, 1, 9, 10, 24, 25, 49, 50].map(heat), [0, 1, 1, 2, 2, 3, 3, 4]);
});
