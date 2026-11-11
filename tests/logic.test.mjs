import { test } from "node:test";
import assert from "node:assert/strict";
import { weekOf, weekStart, addDays, addMonths, diffDays } from "../ui/js/dates.js";
import { stateOf, setStep, nextRecall, spreadPlan } from "../ui/js/recall.js";
import { parseQuick, nextOccurrence } from "../ui/js/quickadd.js";

const START = "2026-09-14";
const CFG = { recall1: 7, recall2: 14 };
const lecture = (over = {}) => ({ seenAt: null, quizzedAt: null, recall1At: null, recall2At: null, recallDue: null, ...over });

test("weeks count from Monday 14 Sept 2026", () => {
  assert.equal(weekOf("2026-09-14", START), 1);
  assert.equal(weekOf("2026-09-20", START), 1);
  assert.equal(weekOf("2026-09-21", START), 2);
  assert.equal(weekOf("2026-11-11", START), 9);
  assert.equal(weekOf("2026-09-13", START), 0);
  assert.equal(weekStart(9, START), "2026-11-09");
});

test("date maths survives the October clock change and month ends", () => {
  assert.equal(addDays("2026-10-24", 2), "2026-10-26");
  assert.equal(diffDays("2026-10-20", "2026-10-30"), 10);
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
});

test("steps move forward, and clicking the current step goes back one", () => {
  const l = lecture();
  setStep(l, "seen", "2026-11-01");
  assert.equal(stateOf(l), "seen");
  setStep(l, "recall1", "2026-11-08");
  assert.equal(stateOf(l), "recall1");
  assert.equal(l.quizzedAt, null, "quizzed is optional and stays empty when skipped");
  setStep(l, "recall1", "2026-11-09");
  assert.equal(stateOf(l), "seen", "clicking the current step undoes it");
  assert.equal(l.seenAt, "2026-11-01", "the seen date is kept");
});

test("quizzed is a tick that never blocks or resets recalls", () => {
  const l = lecture();
  setStep(l, "quizzed", "2026-11-02");
  assert.equal(stateOf(l), "quizzed");
  assert.equal(l.seenAt, "2026-11-02", "quizzing implies seen");
  setStep(l, "recall1", "2026-11-09");
  setStep(l, "quizzed", "2026-11-10");
  assert.equal(l.quizzedAt, null);
  assert.equal(stateOf(l), "recall1", "un-ticking quizzed keeps the recall");
  setStep(l, "seen", "2026-11-10");
  assert.equal(stateOf(l), "seen");
});

test("jumping straight to recall 2 fills the earlier steps; to do clears everything", () => {
  const l = lecture();
  setStep(l, "recall2", "2026-11-05");
  assert.deepEqual([l.seenAt, l.recall1At, l.recall2At], ["2026-11-05", "2026-11-05", "2026-11-05"]);
  setStep(l, "todo", "2026-11-06");
  assert.equal(stateOf(l), "todo");
});

test("recall 1 is 7 days after seen, recall 2 is 14 days after recall 1 was done", () => {
  const l = lecture({ seenAt: "2026-11-01" });
  assert.deepEqual(nextRecall(l, null, CFG, "2026-11-02"), { n: 1, due: "2026-11-08", adapted: false, manual: false });
  l.recall1At = "2026-11-10"; // done two days late
  assert.deepEqual(nextRecall(l, null, CFG, "2026-11-10"), { n: 2, due: "2026-11-24", adapted: false, manual: false });
  l.recall2At = "2026-11-24";
  assert.equal(nextRecall(l, null, CFG, "2026-11-24"), null);
  assert.equal(nextRecall(lecture(), null, CFG, "2026-11-24"), null);
});

test("a far exam changes nothing; a close exam shrinks both gaps", () => {
  const l = lecture({ seenAt: "2026-11-01" });
  assert.equal(nextRecall(l, "2026-12-20", CFG, "2026-11-02").due, "2026-11-08");

  // exam on the 11th: 9 days of room instead of 21, so recall 1 after 3 days
  const r1 = nextRecall(l, "2026-11-11", CFG, "2026-11-02");
  assert.deepEqual([r1.due, r1.adapted], ["2026-11-04", true]);
  l.recall1At = "2026-11-04";
  const r2 = nextRecall(l, "2026-11-11", CFG, "2026-11-04");
  assert.deepEqual([r2.due, r2.adapted], ["2026-11-10", true], "recall 2 lands on the eve of the exam");
});

test("no recall once the exam has passed, or when there is no day left before it", () => {
  const l = lecture({ seenAt: "2026-11-01", recall1At: "2026-11-10" });
  assert.equal(nextRecall(l, "2026-11-11", CFG, "2026-11-10"), null, "recall 1 done on the eve");
  assert.equal(nextRecall(l, "2026-11-05", CFG, "2026-11-12"), null, "exam already passed");
});

test("a manual reschedule wins, and is dropped when the step changes", () => {
  const l = lecture({ seenAt: "2026-11-01", recallDue: "2026-11-20" });
  assert.deepEqual(nextRecall(l, null, CFG, "2026-11-02"), { n: 1, due: "2026-11-20", adapted: false, manual: true });
  setStep(l, "recall1", "2026-11-20");
  assert.equal(l.recallDue, null);
});

test("spreading caps the recalls per day, never moves one earlier, and respects the exam eve", () => {
  const pending = [
    { id: "a", due: "2026-11-01" }, { id: "b", due: "2026-11-05" }, { id: "c", due: "2026-11-11" },
    { id: "d", due: "2026-11-11" }, { id: "e", due: "2026-11-11", latest: "2026-11-11" }, { id: "f", due: "2026-11-13" },
  ];
  const moves = Object.fromEntries(spreadPlan(pending, 2, "2026-11-11").map(m => [m.id, m.due]));
  // a and b are overdue and take today's two places; c and d move on; e may not go past its exam eve
  // and f already sits on a free day
  assert.deepEqual(moves, { a: "2026-11-11", b: "2026-11-11", c: "2026-11-12", d: "2026-11-12" });
});

test("quick add reads priority, date, project and repetition out of the text", () => {
  const now = "2026-11-11"; // a Wednesday
  assert.deepEqual(parseQuick("Email supervisor tomorrow p1", now),
    { title: "Email supervisor", prio: 1, due: "2026-11-12", recur: null, projectName: null });
  assert.deepEqual(parseQuick("Buy lab coat 14 nov #Errands", now),
    { title: "Buy lab coat", prio: 4, due: "2026-11-14", recur: null, projectName: "Errands" });
  assert.equal(parseQuick("Call mum fri", now).due, "2026-11-13");
  assert.equal(parseQuick("Report next week", now).due, "2026-11-16");
  assert.equal(parseQuick("Renew card in 3 days", now).due, "2026-11-14");
  assert.equal(parseQuick("Dentist 12/1", now).due, "2027-01-12", "a past day/month means next year");
  assert.equal(parseQuick("Pay rent Nov 30th", now).due, "2026-11-30");
  assert.equal(parseQuick("Read chapter 3.5 p2", now).due, null, "decimals are not dates");
  assert.equal(parseQuick("Just a plain task", now).title, "Just a plain task");
});

test("quick add: repeating tasks", () => {
  const now = "2026-11-11";
  assert.deepEqual(parseQuick("Gym every monday", now),
    { title: "Gym", prio: 4, due: "2026-11-16", recur: { every: 1, unit: "week" }, projectName: null });
  assert.deepEqual(parseQuick("Water plants every 2 days", now).recur, { every: 2, unit: "day" });
  assert.equal(parseQuick("Water plants every 2 days", now).due, now, "a repeating task with no date starts today");
  assert.deepEqual(parseQuick("Stand-up every weekday", now).recur, { every: 1, unit: "weekday" });
});

test("a repeating task always moves to a future date", () => {
  const now = "2026-11-11"; // Wednesday
  assert.equal(nextOccurrence("2026-11-11", { every: 1, unit: "day" }, now), "2026-11-12");
  assert.equal(nextOccurrence("2026-11-02", { every: 1, unit: "week" }, now), "2026-11-16", "overdue weekly skips to the next future one");
  assert.equal(nextOccurrence("2026-11-13", { every: 1, unit: "weekday" }, now), "2026-11-16", "Friday to Monday");
  assert.equal(nextOccurrence("2026-11-20", { every: 1, unit: "week" }, now), "2026-11-27", "done early: one step");
  assert.equal(nextOccurrence(null, { every: 1, unit: "month" }, now), "2026-12-11");
});
