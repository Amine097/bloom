import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planInput, planPrompt, parsePlan, candidates, goalState, progress, shouldAutoPlan, mondayOf,
  weekRange, parseRef, nothingToPlan, CAPS, GOALS_MAX,
} from "../ui/js/planner-core.js";

const NOW = "2026-11-13"; // Friday of week 9
const lecture = (over = {}) => ({ kind: "lecture", module: "heart", title: "A lecture", week: null, date: null, seenAt: null, quizzedAt: null, recall1At: null, recall2At: null, recallDue: null, doneAt: null, pdf: null, ...over });
const data = (over = {}) => ({
  settings: { semesterStart: "2026-09-14", recall1: 7, recall2: 14, welcomed: true },
  modules: { heart: { name: "Heart", color: "rose", exam: null, order: 0 }, cns: { name: "CNS", color: "lavender", exam: "2026-12-01", order: 1 } },
  items: {}, deadlines: {}, todo: { projects: {}, tasks: {} }, planner: {},
  ...over,
});

test("mondayOf and weekRange", () => {
  assert.equal(mondayOf("2026-11-13"), "2026-11-09");
  assert.equal(mondayOf("2026-11-09"), "2026-11-09");
  assert.equal(mondayOf("2026-11-15"), "2026-11-09"); // Sunday belongs to the week before it
  assert.equal(mondayOf("2026-11-16"), "2026-11-16");
  assert.equal(mondayOf("2026-11-01"), "2026-10-26"); // across the month and the clock change
  assert.equal(weekRange("2026-11-09"), "9–15 Nov");
  assert.equal(weekRange("2026-11-30"), "30 Nov – 6 Dec");
});

test("planInput: the week, days left, modules with exams", () => {
  const i = planInput(data(), NOW);
  assert.equal(i.weekday, "Friday");
  assert.equal(i.weekStart, "2026-11-09");
  assert.equal(i.weekEnd, "2026-11-15");
  assert.equal(i.daysLeftIncludingToday, 3);
  assert.equal(i.studyWeek, 9);
  assert.deepEqual(i.modules, [{ name: "Heart", exam: null }, { name: "CNS", exam: "2026-12-01", examInDays: 18 }]);
  assert.ok(nothingToPlan(i));
  assert.equal(planInput(data(), "2026-11-15").daysLeftIncludingToday, 1);
  assert.equal(planInput(data(), "2026-09-10").studyWeek, null); // before week 1
});

test("planInput: lectures of this week and the backlog, seen ones left out", () => {
  const items = {
    a: lecture({ title: "This week", date: "2026-11-10" }),
    b: lecture({ title: "Later this week", date: "2026-11-14" }),
    c: lecture({ title: "Old", week: 3 }),
    d: lecture({ title: "Seen old", week: 4, seenAt: "2026-10-10", recall1At: "2026-10-17", recall2At: "2026-10-31" }),
    e: lecture({ title: "No week" }),
    f: lecture({ title: "Next week", date: "2026-11-17" }),
    s: { kind: "task", module: "cns", title: "Read paper", week: 8, doneAt: null },
  };
  const i = planInput(data({ items }), NOW);
  assert.deepEqual(i.lecturesThisWeek.map(f => f.ref), ["lecture:a", "lecture:b"]);
  assert.equal(i.lecturesThisWeek[1].notTaughtYet, true);
  assert.equal(i.lecturesThisWeek[0].notTaughtYet, undefined);
  assert.deepEqual(i.backlog.map(f => f.ref), ["study:s", "lecture:c"]); // most recent week first
  assert.equal(i.backlog[0].kind, "study task");
  assert.ok(i.notListed.some(n => n.startsWith("1 unseen lectures have no week")));
});

test("planInput: backlog puts lectures of a module with a close exam first, and is capped", () => {
  const items = {};
  for (let n = 0; n < CAPS.backlog + 5; n++) items["h" + n] = lecture({ title: "Heart " + n, week: 1 + (n % 7) });
  items.c1 = lecture({ module: "cns", title: "CNS old", week: 1 });
  const i = planInput(data({ items }), NOW);
  assert.equal(i.backlog.length, CAPS.backlog);
  assert.equal(i.backlog[0].ref, "lecture:c1"); // CNS exam in 18 days
  assert.equal(i.backlog[1].week, 7);
  assert.ok(i.notListed.some(n => n.startsWith("6 more unseen lectures")));
});

test("planInput: recalls due by Sunday, overdue flagged, later ones left out", () => {
  const items = {
    late: lecture({ title: "Late", week: 7, seenAt: "2026-11-01" }),        // recall 1 due 8 Nov
    sun: lecture({ title: "Sunday", week: 8, seenAt: "2026-11-08" }),       // recall 1 due 15 Nov
    next: lecture({ title: "Next", week: 9, seenAt: "2026-11-10" }),        // recall 1 due 17 Nov
    r2: lecture({ title: "R2", week: 5, seenAt: "2026-10-12", recall1At: "2026-10-30" }), // recall 2 due 13 Nov
  };
  const i = planInput(data({ items }), NOW);
  assert.deepEqual(i.recalls.map(r => r.ref), ["recall:late:1", "recall:r2:2", "recall:sun:1"]);
  assert.equal(i.recalls[0].overdue, true);
  assert.equal(i.recalls[1].overdue, undefined);
  assert.equal(i.recalls[1].kind, "recall 2");
});

test("planInput: deadlines (overdue, this week, the next six weeks) and dated to-dos", () => {
  const deadlines = {
    o: { title: "Overdue", type: "Report", module: "heart", due: "2026-11-10T23:59", done: false },
    w: { title: "This week", type: "Quiz", module: null, due: "2026-11-15", done: false },
    x: { title: "Exam CNS", type: "Exam", module: "cns", due: "2026-12-01T09:00", done: false },
    far: { title: "Far away", type: "Report", module: null, due: "2027-02-01", done: false },
    done: { title: "Done", type: "Report", module: null, due: "2026-11-14", done: true },
  };
  const tasks = {
    t1: { title: "Email", due: "2026-11-11", done: false, prio: 1, recur: null, project: "p", parent: null },
    t2: { title: "Gym", due: "2026-11-14", done: false, prio: 4, recur: { every: 1, unit: "week" }, project: null, parent: null },
    t3: { title: "Later", due: "2026-11-20", done: false, prio: 4 },
    t4: { title: "No date", due: null, done: false, prio: 4 },
    t5: { title: "Closed", due: "2026-11-12", done: true, prio: 4 },
  };
  const i = planInput(data({ deadlines, todo: { projects: { p: { name: "Thesis" } }, tasks } }), NOW);
  assert.deepEqual(i.deadlines.map(d => d.ref), ["deadline:o", "deadline:w", "deadline:x"]);
  assert.equal(i.deadlines[0].overdue, true);
  assert.equal(i.deadlines[1].thisWeek, true);
  assert.equal(i.deadlines[2].inDays, 18);
  assert.equal(i.deadlines[2].thisWeek, undefined);
  assert.deepEqual(i.todos.map(t => t.ref), ["task:t1", "task:t2"]);
  assert.deepEqual(i.todos[0], { ref: "task:t1", kind: "to-do", title: "Email", due: "2026-11-11", overdue: true, priority: "P1", project: "Thesis" });
  assert.ok(i.todos[1].repeats);
});

const INPUT = planInput(data({
  items: { a: lecture({ title: "Arrhythmia", date: "2026-11-10" }), b: lecture({ title: "Old", week: 3 }) },
  deadlines: { d: { title: "Report", type: "Report", module: "heart", due: "2026-11-15", done: false } },
}), NOW);

test("planPrompt carries the facts, the note, the earlier plan and the reply shape", () => {
  const p = planPrompt(INPUT, "I am away \"Saturday\"");
  assert.ok(p.includes("Today is Friday 2026-11-13"));
  assert.ok(p.includes('"ref":"lecture:a"') && p.includes('"ref":"deadline:d"'));
  assert.ok(p.includes('follow it: "I am away \\"Saturday\\""'));
  assert.ok(p.includes('"priority": "must"') && p.includes("JSON only"));
  assert.ok(!p.includes("You already planned"));
  assert.ok(!planPrompt(INPUT, "  ").includes("She wrote this note"));
  const again = planPrompt(INPUT, "", { summary: "S", goals: [{ text: "See Arrhythmia", priority: "must", done: true }] });
  assert.ok(again.includes("You already planned") && again.includes('"done":true'));
});

test("parsePlan keeps known refs and free goals, drops made-up refs, merges duplicates", () => {
  const reply = "Here you go:\n```json\n" + JSON.stringify({
    summary: "  A calm week.  ",
    goals: [
      { ref: "lecture:a", text: "See Arrhythmia", why: "Taught this week", priority: "should" },
      { ref: "lecture:zzz", text: "Made up", priority: "must" },
      { ref: "deadline:d", text: "Hand in the report", why: "Due Sunday", priority: "MUST" },
      { ref: "lecture:a", text: "Again", priority: "must" },
      { ref: null, text: "Start revising CNS", why: "Exam 1 Dec", priority: "could" },
      { ref: "null", text: "start revising  CNS!", priority: "should" },
      { ref: "lecture:b", text: "", priority: "nonsense" },
      "not a goal",
      { ref: null, text: "  " },
    ],
  }) + "\n```";
  const p = parsePlan(reply, INPUT);
  assert.equal(p.summary, "A calm week.");
  assert.deepEqual(p.goals.map(g => [g.id, g.ref, g.priority]), [
    ["g1", "lecture:a", "must"], ["g2", "deadline:d", "must"], ["g3", null, "should"], ["g4", "lecture:b", "should"],
  ]);
  assert.equal(p.goals[0].text, "See Arrhythmia");
  assert.equal(p.goals[3].text, "Old"); // no text: the lecture's title
  assert.ok(p.goals.every(g => g.done === false));
});

test("parsePlan caps the number of goals, must first", () => {
  const goals = Array.from({ length: 40 }, (_, n) => ({ ref: null, text: "Goal " + n, priority: n < 30 ? "could" : "must" }));
  const p = parsePlan(JSON.stringify({ summary: "", goals }), INPUT);
  assert.equal(p.goals.length, GOALS_MAX);
  assert.equal(p.goals[0].text, "Goal 30");
});

test("parsePlan throws a readable error on bad or empty answers", () => {
  assert.throws(() => parsePlan("", INPUT), /empty/);
  assert.throws(() => parsePlan("no json here", INPUT), /could not be read/);
  assert.throws(() => parsePlan('{"summary":"x"}', INPUT), /no goals/);
  assert.throws(() => parsePlan('{"summary":"x","goals":[]}', INPUT), /no goals Bloom could use/);
  assert.throws(() => parsePlan('{"goals":[{"ref":"lecture:nope","text":"x"}]}', INPUT), /no goals Bloom could use/);
});

test("candidates and parseRef", () => {
  assert.deepEqual([...candidates(INPUT).keys()].sort(), ["deadline:d", "lecture:a", "lecture:b"]);
  assert.deepEqual(parseRef("recall:x:2"), { kind: "recall", id: "x", n: 2 });
  assert.deepEqual(parseRef("task:t"), { kind: "task", id: "t" });
  assert.deepEqual(parseRef(null), { kind: null });
  assert.deepEqual(parseRef("weird:1"), { kind: null });
});

test("goalState reads the live data, and tells when the thing was removed", () => {
  const d = data({
    items: {
      a: lecture({ seenAt: "2026-11-12" }), b: lecture({ seenAt: "2026-11-01", recall1At: "2026-11-08" }),
      s: { kind: "task", module: "cns", title: "Paper", doneAt: "2026-11-12" },
    },
    deadlines: { d: { title: "R", due: "2026-11-15", done: true, module: "heart" } },
    todo: { projects: {}, tasks: {
      t: { title: "Email", due: "2026-11-12", done: false },
      g: { title: "Gym", due: "2026-11-21", done: false, recur: { every: 1, unit: "week" } },
      day: { title: "Walk", due: "2026-11-14", done: false, recur: { every: 1, unit: "day" } },
    } },
  });
  const end = "2026-11-15";
  const st = ref => goalState(d, { ref, text: "x", done: false }, end);
  assert.equal(st("lecture:a").done, true);
  assert.equal(st("lecture:a").module, "heart");
  assert.equal(st("recall:a:1").done, false);
  assert.equal(st("recall:b:1").done, true);
  assert.equal(st("recall:b:2").done, false);
  assert.equal(st("study:s").done, true);
  assert.equal(st("deadline:d").done, true);
  assert.equal(st("task:t").done, false);
  assert.equal(st("task:g").done, true); // moved on to next week
  assert.equal(st("task:day").done, false);
  assert.equal(goalState(d, { ref: "task:day", done: true }, end).done, true); // ticked from the plan
  assert.equal(goalState(d, { ref: "task:t", done: true }, end).done, false); // a plain task reads the data only
  assert.deepEqual([st("lecture:gone").gone, st("lecture:gone").done], [true, false]);
  assert.equal(st("deadline:gone").gone, true);
  assert.equal(goalState(d, { ref: null, text: "Free", done: true }, end).done, true);
  const p = { week: "2026-11-09", goals: [{ ref: "lecture:a" }, { ref: "task:t" }, { ref: "lecture:gone" }, { ref: null, done: true }] };
  assert.deepEqual(progress(d, p), { done: 2, total: 3 });
});

test("shouldAutoPlan: once a week, once a day at most, only when set up", () => {
  const settings = { welcomed: true };
  const base = { settings, today: NOW };
  assert.equal(shouldAutoPlan({ ...base, planner: {} }), true);
  assert.equal(shouldAutoPlan({ ...base, planner: { week: "2026-11-02" } }), true);
  assert.equal(shouldAutoPlan({ ...base, planner: { week: "2026-11-09" } }), false);
  assert.equal(shouldAutoPlan({ ...base, planner: { week: "2026-11-02", lastTry: NOW } }), false);
  assert.equal(shouldAutoPlan({ ...base, planner: { week: "2026-11-02", lastTry: "2026-11-12" } }), true);
  assert.equal(shouldAutoPlan({ ...base, planner: {}, busy: true }), false);
  assert.equal(shouldAutoPlan({ ...base, settings: { welcomed: false }, planner: {} }), false);
  assert.equal(shouldAutoPlan({ ...base, planner: undefined }), true);
  assert.equal(shouldAutoPlan({ ...base, planner: {}, status: { installed: true, loggedIn: true } }), true);
  assert.equal(shouldAutoPlan({ ...base, planner: {}, status: { installed: true, loggedIn: false } }), false);
  assert.equal(shouldAutoPlan({ ...base, planner: {}, status: null }), false);
});
