// Planner: once a week Claude writes a tickable list of goals for the week. Each goal is linked
// to a lecture, a recall, a deadline or a to-do, so ticking it here ticks it everywhere.
// The prompt, the parser and the done states are in planner-core.js.
import { D, save } from "../store.js";
import { today, addDays, weekOf, fmtWday } from "../dates.js";
import { stateOf } from "../recall.js";
import { esc, icon, app, toast, cvar } from "../ui.js";
import { askAssistant, assistantStatus } from "../assistant.js";
import {
  planInput, planPrompt, parsePlan, goalState, progress, shouldAutoPlan, mondayOf, weekRange,
  nothingToPlan, parseRef, PRIORITIES,
} from "../planner-core.js";
import { normText } from "../notebook-core.js";
import * as courses from "./courses.js";
import * as deadlines from "./deadlines.js";
import { toggleTask } from "./todo.js";

const view = { note: "" };
/** True while Claude is writing a plan (one at a time). */
let busy = false;
/** null, or why Claude cannot be used: "missing" (not installed) or "signedout". */
let setup = null;
let checkedAt = 0, checking = false;

const GROUPS = [["must", "Must"], ["should", "Should"], ["could", "If there is time"]];
const KIND = { lecture: "Lecture", recall: "Recall", deadline: "Deadline", task: "To-do", study: "Study task" };
const plan = () => D.planner || (D.planner = {});
const here = () => document.getElementById("main")?.dataset.view === "planner";
const refreshIfHere = () => { if (here()) app.refresh(); };

/** Asks whether Claude is installed and signed in, at most every 30 seconds, for the empty states. */
function checkSetup() {
  if (checking || Date.now() - checkedAt < 30_000) return;
  checking = true;
  assistantStatus()
    .then(s => { const was = setup; setup = s.loggedIn ? null : s.installed ? "signedout" : "missing"; if (was !== setup) refreshIfHere(); })
    .catch(() => { /* unknown: say nothing, a run reports its own errors */ })
    .finally(() => { checking = false; checkedAt = Date.now(); });
}

/** The plan already made for this same week, for Claude to build on when she plans again. */
function previousOf(p, monday) {
  if (p.week !== monday || !p.goals?.length) return null;
  const end = addDays(monday, 6);
  return { summary: p.summary, goals: p.goals.map(g => ({ text: g.text, priority: g.priority, done: goalState(D, g, end).done })) };
}

/**
 * Asks Claude for this week's plan, in the background. `auto` is the quiet weekly run: it gives
 * up silently when Claude is not set up, and records the day so it is tried at most once a day.
 */
async function planWeek({ note = "", auto = false } = {}) {
  if (busy) return;
  busy = true;
  const now = today();
  refreshIfHere();
  try {
    const s = await assistantStatus().catch(() => null);
    if (auto) {
      plan().lastTry = now; // one automatic attempt a day, whatever happens next
      save();
      if (!shouldAutoPlan({ planner: { ...plan(), lastTry: null }, settings: D.settings, today: now, status: s })) {
        if (s) setup = s.loggedIn ? null : s.installed ? "signedout" : "missing";
        return;
      }
    } else if (s && !s.loggedIn) {
      setup = s.installed ? "signedout" : "missing";
      toast(setup === "missing" ? "Claude is not set up on this Mac yet." : "Claude is not signed in.", "error");
      return;
    }
    if (s) setup = null;
    const input = planInput(D, now);
    if (auto && nothingToPlan(input)) return;
    const prev = previousOf(plan(), input.weekStart);
    const reply = await askAssistant(planPrompt(input, note, prev));
    const made = parsePlan(reply, input);
    // a free goal she had already ticked earlier this week stays ticked
    const ticked = new Set((prev?.goals || []).filter(g => g.done).map(g => normText(g.text)));
    for (const g of made.goals) if (!g.ref && ticked.has(normText(g.text))) g.done = true;
    const p = plan();
    delete p.error;
    Object.assign(p, { week: input.weekStart, createdAt: now, note: String(note || "").trim(), summary: made.summary, goals: made.goals });
    save();
    toast("Your plan for the week is ready 🌸");
  } catch (e) {
    if (e?.code === "no-claude") setup = "missing";
    plan().error = { message: e?.message || String(e), date: now, note: String(note || "").trim() };
    save();
    if (!auto) toast(e?.message || String(e), "error");
  } finally {
    busy = false;
    refreshIfHere();
  }
}

/** Starts the weekly plan by itself when it is due. Never waits; never runs twice. */
function maybeAutoPlan() {
  if (!D || !shouldAutoPlan({ planner: plan(), settings: D.settings, today: today(), busy })) return;
  planWeek({ auto: true });
}

// ---- the page

function weekTitle(monday) {
  const w = weekOf(monday, D.settings.semesterStart);
  return `${w >= 1 ? `Week ${w}` : "Week of"} · ${weekRange(monday)}`;
}

function goalRow(g, weekEnd) {
  const s = goalState(D, g, weekEnd);
  const kind = parseRef(g.ref).kind;
  const m = s.module ? D.modules[s.module] : null;
  const tag = kind ? `<span class="pill pl-kind">${KIND[kind]}${kind === "recall" ? " " + parseRef(g.ref).n : ""}</span>` : "";
  const label = s.done ? "Mark as not done" : "Mark as done";
  return `<div class="row pl-goal ${s.done ? "done" : ""} ${s.gone ? "pl-gone" : ""}" ${cvar(m?.color || "plum")}>
    <button class="check ${s.done ? "on" : ""}" data-act="tick" data-goal="${esc(g.id)}" aria-label="${label}" aria-pressed="${s.done}" ${s.gone ? "disabled" : ""}>${icon("check", 14)}</button>
    <div class="row-main">
      <span class="t">${esc(g.text)}</span>
      <span class="sub">${m ? `<span class="dot"></span><span>${esc(m.name)}</span>` : ""}${s.gone ? `<span class="late">removed from Bloom</span>` : g.why ? `<span class="sub-text">${esc(g.why)}</span>` : ""}</span>
    </div>
    ${tag}
  </div>`;
}

function noteForm(label, hint) {
  return `<form class="pl-ask" data-submit="plan">
      <label class="field"><span>Anything Claude should know?</span>
        <textarea name="note" rows="2" data-input="note" placeholder="e.g. I am away Thursday and Friday · focus on Pharma">${esc(view.note)}</textarea></label>
      <div class="pl-ask-f"><span class="muted small">${hint}</span><span class="grow"></span>
        <button class="btn primary" ${busy ? "disabled" : ""}>${icon("spark", 16)} ${label}</button></div>
    </form>`;
}

const working = () => `<div class="pl-working" role="status"><span class="nb-spin small" aria-hidden="true"></span>
    <span>Claude is planning your week… This takes a minute or two; you can keep using Bloom.</span></div>`;

function setupCard() {
  if (!setup) return "";
  return `<section class="card pl-warn"><div class="card-b">
      <p><b>${setup === "missing" ? "Claude is not set up yet." : "Claude is not signed in."}</b></p>
      <p class="muted">${setup === "missing"
        ? "The Planner uses Claude, with your own Claude account, to plan your week. Setting it up takes a minute, in Settings."
        : "The Planner uses Claude with your own Claude account. Sign in once in Settings, then plan your week here."}</p>
      <div class="btns"><button class="btn primary small" data-act="goSettings">Set up in Settings</button></div>
    </div></section>`;
}

function errorCard(p) {
  if (!p.error || busy) return "";
  return `<div class="banner pl-error" role="alert">
      <span>${icon("close", 16)} Bloom could not plan your week${p.error.date ? ` (${fmtWday(p.error.date)})` : ""}: ${esc(p.error.message)}</span>
      <button class="btn ghost small" data-act="retry">Try again</button>
    </div>`;
}

export function render() {
  if (D) setTimeout(maybeAutoPlan, 0); // a new week since the last plan: start it (never during a render)
  checkSetup();
  const p = plan();
  const now = today();
  const monday = mondayOf(now);
  const current = p.week === monday;
  const has = Array.isArray(p.goals) && p.goals.length > 0;

  const head = `<header class="page-h">
      <div><h1>Planner</h1><p class="muted">${weekTitle(monday)} · goals to reach by Sunday</p></div>
    </header>`;

  if (!has) {
    return `${head}${setupCard()}${errorCard(p)}
      <section class="card pl-empty">
        <div class="card-b">
          <div class="pl-empty-ic">${icon("spark", 30)}</div>
          <h2>No plan for this week yet</h2>
          <p class="muted">Claude looks at this week's lectures, the ones you have not seen yet, your recalls, deadlines and to-dos, and writes a short list of goals to reach by Sunday. Each Monday it does this by itself.</p>
          ${busy ? working() : noteForm("Plan my week", "Runs on your own Claude account.")}
        </div>
      </section>`;
  }

  const weekEnd = addDays(p.week, 6);
  const { done, total } = progress(D, p);
  const pct = total ? Math.round(100 * done / total) : 0;
  const groups = GROUPS.map(([k, name]) => {
    const list = p.goals.filter(g => (PRIORITIES.includes(g.priority) ? g.priority : "should") === k);
    if (!list.length) return "";
    const n = list.filter(g => goalState(D, g, weekEnd).done).length;
    return `<section class="card wsec pl-group pl-${k}">
      <div class="card-h"><h3>${name}</h3><span class="muted mono">${n}/${list.length}</span></div>
      ${list.map(g => goalRow(g, weekEnd)).join("")}
    </section>`;
  }).join("");

  const old = !current ? `<div class="banner pl-old">
      <span>${icon("cal", 16)} This is ${p.week === addDays(monday, -7) ? "last week's plan" : "the plan of an earlier week"} (${weekRange(p.week)}).${busy ? " Claude is planning this week." : ""}</span>
      ${busy ? "" : `<button class="btn primary small" data-act="replan">Plan this week</button>`}
    </div>` : "";

  return `${head}${setupCard()}${old}${errorCard(p)}
    <section class="card pl-top">
      <div class="card-b">
        <div class="pl-top-h"><h2>${current ? "This week" : weekTitle(p.week)}</h2><span class="grow"></span>
          <span class="pl-count"><b>${done}</b> of ${total} done</span></div>
        <div class="pl-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}" aria-label="Goals done"><i style="width:${pct}%"></i></div>
        ${p.summary ? `<p class="pl-summary">${esc(p.summary)}</p>` : ""}
        ${p.note ? `<p class="muted small">Your note: “${esc(p.note)}”</p>` : ""}
        ${p.createdAt ? `<p class="muted small">Planned ${fmtWday(p.createdAt)}</p>` : ""}
      </div>
    </section>
    ${busy ? `<section class="card pl-ask-card"><div class="card-b">${working()}</div></section>` : ""}
    ${groups}
    ${busy ? "" : `<section class="card pl-ask-card"><div class="card-h"><h3>Plan again</h3></div><div class="card-b">
      ${noteForm("Plan again", "Claude makes a fresh plan from what is left of the week.")}
    </div></section>`}`;
}

// ---- ticking: the same actions as Courses, Deadlines and To-do

/** Courses' and Deadlines' actions take the clicked element; this stands in for it. */
const fake = data => ({ dataset: data });

function tick(goal) {
  const p = plan();
  const weekEnd = p.week ? addDays(p.week, 6) : null;
  const s = goalState(D, goal, weekEnd);
  if (s.gone) return;
  const r = parseRef(goal.ref);

  if (!r.kind) { goal.done = !goal.done; save(); app.refresh(); return; }

  if (r.kind === "deadline") return deadlines.actions.toggleDeadline(fake({ id: r.id }));

  if (r.kind === "task") {
    const t = D.todo.tasks[r.id];
    if (!t.recur) return toggleTask(r.id);
    // a repeating to-do moves on to its next date, as in To-do; the plan remembers the tick
    if (!s.done) { goal.done = true; return toggleTask(r.id); }
    if (goal.done) { goal.done = false; save(); app.refresh(); }
    if (goalState(D, goal, weekEnd).done) toast("This repeating to-do has already moved on to its next date.");
    return;
  }

  const it = D.items[r.id];
  if (r.kind === "study" || it.kind === "task") return courses.actions.toggleItem(fake({ id: r.id }));

  const state = stateOf(it);
  if (r.kind === "lecture") {
    if (!s.done) return courses.actions.step(fake({ id: r.id, step: "seen" }));
    // unticking only undoes "seen"; a lecture further along is changed in Courses
    if (state === "seen") return courses.actions.step(fake({ id: r.id, step: "seen" }));
    return toast("This lecture is further along than seen. Change it in Courses.");
  }

  // a recall
  const step = r.n === 2 ? "recall2" : "recall1";
  if (!s.done) return courses.actions.step(fake({ id: r.id, step }));
  if (state === step) return courses.actions.step(fake({ id: r.id, step }));
  toast("A later recall is already done. Change it in Courses.");
}

export const actions = {
  tick: el => {
    const goal = plan().goals?.find(g => g.id === el.dataset.goal);
    if (goal) tick(goal);
  },
  note: el => { view.note = el.value; },
  plan: form => {
    const note = form.elements.note?.value ?? view.note;
    view.note = "";
    planWeek({ note });
  },
  replan: () => { const note = view.note; view.note = ""; planWeek({ note }); },
  retry: () => planWeek({ note: plan().error?.note || "" }),
  goSettings: () => app.go("settings"),
};

/** Called once by main.js when the app has started and the data is loaded. */
export function onStart() {
  maybeAutoPlan();
}
