// Planner logic that does not touch the screen: the facts about her week sent to Claude Code,
// the prompt, the parser of the plan it writes back, and the done state of each goal.
// Pure, covered by tests/planner.test.mjs.
//
// D.planner = {
//   week: "YYYY-MM-DD",        Monday of the week the plan is for (absent: no plan yet)
//   createdAt: "YYYY-MM-DD",   when Claude wrote it
//   note: "...",               what she told Claude for this plan ("" when nothing)
//   summary: "...",            Claude's 2–3 sentences about the week
//   goals: [{ id, ref, text, why, priority: "must" | "should" | "could", done }],
//                              `ref` links a goal to her data ("lecture:<id>", "recall:<id>:<n>",
//                              "deadline:<id>", "task:<id>", "study:<id>") or is null; a linked
//                              goal reads its done state from the data, `done` only counts for an
//                              unlinked goal (and a repeating task ticked from the plan)
//   lastTry: "YYYY-MM-DD",     day of the last automatic attempt (at most one a day)
//   error: { message, date, note } | absent,   the last attempt that failed
// }
import { addDays, diffDays, parse, weekOf } from "./dates.js";
import { stateOf, nextRecall } from "./recall.js";
import { recurLabel } from "./quickadd.js";
import { extractJson, normText } from "./notebook-core.js";

export const PRIORITIES = ["must", "should", "could"];
/** Most goals kept from one plan. */
export const GOALS_MAX = 25;
/** How many of each kind of fact are sent to Claude at most; the rest is counted. */
export const CAPS = { thisWeek: 20, backlog: 20, recalls: 30, deadlines: 15, tasks: 25 };
/** Deadlines this far ahead are offered as worth starting now. */
export const DEADLINE_AHEAD_DAYS = 42;

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Monday of the calendar week holding `date` ("YYYY-MM-DD"). */
export function mondayOf(date) {
  const day = parse(date).getDay(); // 0 = Sunday
  return addDays(date, -((day + 6) % 7));
}

/** "9–15 Nov", or "30 Nov – 6 Dec" across two months. */
export function weekRange(monday) {
  const sunday = addDays(monday, 6);
  const f = (s, opts) => new Intl.DateTimeFormat("en-GB", opts).format(parse(s));
  const sameMonth = monday.slice(0, 7) === sunday.slice(0, 7);
  return sameMonth
    ? `${f(monday, { day: "numeric" })}–${f(sunday, { day: "numeric", month: "short" })}`
    : `${f(monday, { day: "numeric", month: "short" })} – ${f(sunday, { day: "numeric", month: "short" })}`;
}

const isLecture = it => it.kind !== "task";
const clip = (s, n = 120) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
const itemWeekOf = (it, start) => (it.date ? weekOf(it.date, start) : Number.isInteger(it.week) ? it.week : null);

/**
 * The compact facts about her week that Claude plans from. `data` has the shape of D.
 * Every thing she could tick carries a `ref`; parsePlan only accepts those refs.
 */
export function planInput(data, now) {
  const settings = data.settings || {};
  const start = settings.semesterStart;
  const monday = mondayOf(now);
  const sunday = addDays(monday, 6);
  const studyWeek = start ? weekOf(now, start) : null;
  const modules = data.modules || {};
  const modName = id => modules[id]?.name || null;
  const examOf = id => modules[id]?.exam || null;
  const omitted = {};
  const cap = (list, key) => {
    if (list.length > CAPS[key]) omitted[key] = list.length - CAPS[key];
    return list.slice(0, CAPS[key]);
  };

  const items = Object.entries(data.items || {}).map(([id, it]) => ({ id, ...it, w: itemWeekOf(it, start) }));
  const open = it => (isLecture(it) ? stateOf(it) === "todo" : !it.doneAt);
  const refOf = it => (isLecture(it) ? `lecture:${it.id}` : `study:${it.id}`);
  const fact = it => {
    const f = { ref: refOf(it), kind: isLecture(it) ? "lecture" : "study task", title: clip(it.title), module: modName(it.module) };
    if (it.w != null) f.week = it.w;
    if (it.date) f.taughtOn = it.date;
    if (it.date && it.date > now) f.notTaughtYet = true;
    return f;
  };

  // lectures (and study tasks from Courses) of this week, then the ones left from earlier weeks
  const thisWeek = items.filter(it => open(it) && studyWeek != null && it.w === studyWeek)
    .sort((a, b) => (a.date || "9").localeCompare(b.date || "9"));
  const examSoon = it => {
    const e = examOf(it.module);
    return e && e >= now && diffDays(now, e) <= 28 ? e : null;
  };
  // the most urgent first: a module whose exam is within four weeks, then the most recent weeks
  const backlog = items.filter(it => open(it) && it.w != null && studyWeek != null && it.w < studyWeek)
    .sort((a, b) => (examSoon(a) || "9").localeCompare(examSoon(b) || "9") || b.w - a.w || (a.date || "").localeCompare(b.date || ""));
  const noWeek = items.filter(it => open(it) && it.w == null).length;

  // recalls due by Sunday (overdue included)
  const recalls = [];
  for (const it of items) {
    if (!isLecture(it)) continue;
    const r = nextRecall(it, examOf(it.module), settings, now);
    if (!r || r.due > sunday) continue;
    recalls.push({ ref: `recall:${it.id}:${r.n}`, kind: `recall ${r.n}`, title: clip(it.title), module: modName(it.module), due: r.due, ...(r.due < now ? { overdue: true } : {}) });
  }
  recalls.sort((a, b) => a.due.localeCompare(b.due));

  // open deadlines: overdue, this week, and the next weeks (worth starting now)
  const horizon = addDays(now, DEADLINE_AHEAD_DAYS);
  const deadlines = Object.entries(data.deadlines || {}).map(([id, d]) => ({ id, ...d }))
    .filter(d => !d.done && typeof d.due === "string" && d.due.slice(0, 10) <= horizon)
    .sort((a, b) => a.due.localeCompare(b.due))
    .map(d => {
      const day = d.due.slice(0, 10);
      const f = { ref: `deadline:${d.id}`, kind: "deadline", title: clip(d.title), type: d.type || "Deadline", module: modName(d.module), due: d.due, inDays: diffDays(now, day) };
      if (day < now) f.overdue = true;
      if (day <= sunday) f.thisWeek = true;
      return f;
    });

  // her own to-dos dated by Sunday (overdue included)
  const tasks = data.todo?.tasks || {};
  const projects = data.todo?.projects || {};
  const todo = Object.entries(tasks).map(([id, t]) => ({ id, ...t }))
    .filter(t => !t.done && typeof t.due === "string" && t.due <= sunday)
    .sort((a, b) => a.due.localeCompare(b.due) || (a.prio ?? 4) - (b.prio ?? 4))
    .map(t => {
      const f = { ref: `task:${t.id}`, kind: "to-do", title: clip(t.title), due: t.due };
      if (t.due < now) f.overdue = true;
      if (t.prio && t.prio < 4) f.priority = `P${t.prio}`;
      if (t.recur) f.repeats = recurLabel(t.recur);
      if (projects[t.project]) f.project = clip(projects[t.project].name, 40);
      if (tasks[t.parent]) f.partOf = clip(tasks[t.parent].title, 60);
      return f;
    });

  const input = {
    today: now,
    weekday: DAYS[parse(now).getDay()],
    weekStart: monday,
    weekEnd: sunday,
    daysLeftIncludingToday: diffDays(now, sunday) + 1,
    studyWeek: studyWeek != null && studyWeek >= 1 ? studyWeek : null,
    modules: Object.values(modules).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map(m => {
      const f = { name: m.name, exam: m.exam || null };
      if (m.exam) f.examInDays = diffDays(now, m.exam);
      return f;
    }),
    lecturesThisWeek: cap(thisWeek, "thisWeek").map(fact),
    backlog: cap(backlog, "backlog").map(fact),
    recalls: cap(recalls, "recalls"),
    deadlines: cap(deadlines, "deadlines"),
    todos: cap(todo, "tasks"),
  };
  const notes = [];
  if (omitted.backlog) notes.push(`${omitted.backlog} more unseen lectures from earlier weeks are not listed (older or less urgent).`);
  if (omitted.thisWeek) notes.push(`${omitted.thisWeek} more lectures of this week are not listed.`);
  if (omitted.recalls) notes.push(`${omitted.recalls} more recalls due this week are not listed.`);
  if (omitted.deadlines) notes.push(`${omitted.deadlines} more later deadlines are not listed.`);
  if (omitted.tasks) notes.push(`${omitted.tasks} more to-dos are not listed.`);
  if (noWeek) notes.push(`${noWeek} unseen lectures have no week or date yet and are not listed.`);
  if (notes.length) input.notListed = notes;
  return input;
}

/** Every ref Claude may link a goal to, with its fact. */
export function candidates(input) {
  const map = new Map();
  for (const key of ["lecturesThisWeek", "backlog", "recalls", "deadlines", "todos"]) {
    for (const f of input[key] || []) map.set(f.ref, f);
  }
  return map;
}

/**
 * The prompt. `note` is what she typed for Claude (may be empty). `previous` is the plan already
 * made for this same week, as { summary, goals: [{ text, priority, done }] }, when she plans again.
 */
export function planPrompt(input, note = "", previous = null) {
  const said = String(note || "").trim();
  const prev = previous && Array.isArray(previous.goals) && previous.goals.length
    ? JSON.stringify({ summary: previous.summary || "", goals: previous.goals.map(g => ({ text: g.text, priority: g.priority, done: Boolean(g.done) })) })
    : "";
  return `You are helping Sarra, a master's student in Biomedical Sciences, plan her study week. She learns each lecture once ("seen"), then revises it with spaced recalls: recall 1 about a week after seeing it, recall 2 about two weeks after recall 1. Recalls come closer together when the module's exam is near.

Today is ${input.weekday} ${input.today}. The week ends on Sunday ${input.weekEnd}: ${input.daysLeftIncludingToday} day${input.daysLeftIncludingToday === 1 ? "" : "s"} left, today included.

Here are the facts about her week, as JSON. Every thing she could do has a "ref".
- "lecturesThisWeek": lectures taught this week that she has not seen yet ("notTaughtYet": later this week).
- "backlog": lectures from earlier weeks she has not seen yet.
- "recalls": recalls due by Sunday ("overdue": the due date has passed).
- "deadlines": open deadlines, overdue, this week ("thisWeek") or in the next weeks ("inDays" from today), exams included.
- "todos": her own to-dos dated by Sunday.
- "modules": her modules with their exam dates.
- "notListed": things left out of this list to keep it short.

${JSON.stringify(input)}
${said ? `
She wrote this note for you; follow it: ${JSON.stringify(said)}
` : ""}${prev ? `
You already planned this week. Your earlier plan (done = she has ticked it already):
${prev}
Things she has done are no longer in the facts. Make a fresh plan for what is left of the week, keeping what still makes sense.
` : ""}
Write a realistic plan of goals to reach before the end of Sunday, not a day-by-day schedule. Think about how much time is really left this week; a lecture takes her about an hour or two, a recall about half an hour.
- "must": what really has to happen this week: overdue recalls and recalls due this week, deadlines before or on Sunday, overdue to-dos.
- "should": what would keep her on track: this week's lectures, the most useful backlog lectures (close to an exam first), work on a deadline coming soon.
- "could": nice to do if there is time.
Not everything has to be planned: leave out what can wait, especially in a long backlog. Aim for 6 to 15 goals.

Each goal:
- "ref": the ref of the thing it is about, copied exactly from the facts; one goal per ref. Use null only for a goal that is not one of the listed things, like "Start revising Heart for the exam on 1 Dec" or "Draft the outline of the PK/PD report".
- "text": a short, concrete goal she can tick, starting with a verb, naming the lecture, recall, deadline or to-do (titles as they are written in the facts).
- "why": a short reason, at most 12 words.
- "priority": "must", "should" or "could".
"summary": 2 to 3 friendly, plain sentences about the shape of her week, speaking to her as "you".
Write in English. Reply with JSON only: no introduction, no comments, no code fences.

The reply must be exactly this shape:
{"summary": "...", "goals": [{"ref": "lecture:abc", "text": "...", "why": "...", "priority": "must"}]}`;
}

const fail = msg => { throw new Error(msg); };
const text = v => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/**
 * → { summary, goals: [{ id, ref, text, why, priority, done: false }] }, at most GOALS_MAX goals,
 * "must" first. A goal whose ref is not one of the facts is dropped; two goals about the same
 * thing are merged (the higher priority wins). Throws a readable Error when nothing usable is left.
 */
export function parsePlan(reply, input) {
  const p = extractJson(reply);
  const known = candidates(input);
  if (!Array.isArray(p.goals)) fail("Claude's plan has no goals. Try again.");
  const out = [];
  const seen = new Map();
  for (const g of p.goals) {
    if (!g || typeof g !== "object") continue;
    const rawRef = typeof g.ref === "string" ? g.ref.trim() : g.ref;
    const free = rawRef === null || rawRef === undefined || rawRef === "" || rawRef === "null";
    if (!free && !known.has(rawRef)) continue; // not one of her things: Claude made it up
    const ref = free ? null : rawRef;
    const t = text(g.text) || (ref ? known.get(ref).title : "");
    if (!t) continue;
    const level = typeof g.priority === "string" ? g.priority.trim().toLowerCase() : "";
    const priority = PRIORITIES.includes(level) ? level : "should";
    const key = ref || "text:" + normText(t);
    const twin = seen.get(key);
    if (twin) {
      if (PRIORITIES.indexOf(priority) < PRIORITIES.indexOf(twin.priority)) twin.priority = priority;
      continue;
    }
    const goal = { ref, text: clip(t, 200), why: clip(text(g.why), 140), priority, done: false };
    seen.set(key, goal);
    out.push(goal);
  }
  if (!out.length) fail("Claude's plan had no goals Bloom could use. Try again.");
  const goals = out
    .map((g, i) => ({ g, i }))
    .sort((a, b) => PRIORITIES.indexOf(a.g.priority) - PRIORITIES.indexOf(b.g.priority) || a.i - b.i)
    .slice(0, GOALS_MAX)
    .map(({ g }, i) => ({ id: `g${i + 1}`, ...g }));
  return { summary: clip(text(p.summary), 600), goals };
}

/** "lecture" | "recall" | "deadline" | "task" | "study" | null, and the id (and recall number). */
export function parseRef(ref) {
  if (typeof ref !== "string") return { kind: null };
  const [kind, id, n] = ref.split(":");
  if (kind === "recall") return { kind, id, n: Number(n) };
  return ["lecture", "deadline", "task", "study"].includes(kind) ? { kind, id } : { kind: null };
}

/**
 * Where a goal stands in the live data: { kind, done, gone, module, title }.
 * `gone` is true when the linked thing was deleted. `weekEnd` is the Sunday of the plan's week:
 * a repeating to-do counts as done once its next date is after it.
 */
export function goalState(data, goal, weekEnd) {
  const r = parseRef(goal.ref);
  const base = { kind: r.kind, done: Boolean(goal.done), gone: false, module: null, title: goal.text };
  if (!r.kind) return base;
  if (r.kind === "deadline") {
    const d = data.deadlines?.[r.id];
    if (!d) return { ...base, gone: true, done: false };
    return { ...base, done: Boolean(d.done), module: d.module || null, title: d.title };
  }
  if (r.kind === "task") {
    const t = data.todo?.tasks?.[r.id];
    if (!t) return { ...base, gone: true, done: false };
    const moved = Boolean(t.recur && t.due && weekEnd && t.due > weekEnd);
    return { ...base, done: Boolean(t.done) || moved || Boolean(t.recur && goal.done), repeats: Boolean(t.recur), title: t.title };
  }
  const it = data.items?.[r.id];
  if (!it) return { ...base, gone: true, done: false };
  const out = { ...base, module: it.module || null, title: it.title };
  if (r.kind === "study") return { ...out, done: isLecture(it) ? stateOf(it) !== "todo" : Boolean(it.doneAt) };
  if (!isLecture(it)) return { ...out, done: Boolean(it.doneAt) };
  if (r.kind === "lecture") return { ...out, done: stateOf(it) !== "todo" };
  return { ...out, done: Boolean(r.n === 2 ? it.recall2At : it.recall1At) };
}

/** "7 of 12 done": goals whose thing was deleted do not count. */
export function progress(data, plan) {
  const weekEnd = plan?.week ? addDays(plan.week, 6) : null;
  const states = (plan?.goals || []).map(g => goalState(data, g, weekEnd)).filter(s => !s.gone);
  return { done: states.filter(s => s.done).length, total: states.length };
}

/**
 * Whether Bloom should ask Claude for this week's plan by itself: her name is set up, the plan on
 * file is not for this week, no automatic attempt was made today and no plan is being made.
 * `status` is assistantStatus() when known; leave it undefined before checking.
 */
export function shouldAutoPlan({ planner, settings, today, busy = false, status }) {
  if (busy || !settings?.welcomed) return false;
  const p = planner || {};
  if (p.week === mondayOf(today)) return false;
  if (p.lastTry === today) return false;
  if (status !== undefined && !(status && status.installed && status.loggedIn)) return false;
  return true;
}

/** True when the input lists nothing at all to plan. */
export const nothingToPlan = input => candidates(input).size === 0;
