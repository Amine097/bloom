// Dashboard: where the semester stands today.
// Layout: quick stats along the top, a weekly chart beside the deadlines, then the study queue
// as a table, then to-dos and modules.
import { D, save, currentWeek, itemWeek, isLecture, isDone, itemsList, modulesSorted, moduleOf, pendingRecalls, deadlinesList } from "../store.js";
import { today, addDays, fmtLong, fmtWday, fmtDay, weekLabel, relDay } from "../dates.js";
import { stateOf, spreadPlan, STATES, LABEL } from "../recall.js";
import { esc, icon, app, cvar, toast } from "../ui.js";
import * as courses from "./courses.js";
import * as deadlines from "./deadlines.js";
import * as todo from "./todo.js";

const view = { queue: "all" };

function greeting() {
  const h = new Date().getHours();
  const part = h < 5 ? "Still up" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return D.settings.name ? `${part}, ${esc(D.settings.name)}` : part;
}

const more = (label, to) => `<button class="link" data-act="go" data-view="${to}">${label} →</button>`;

/** Lectures taught and lectures seen, week by week (at most the last 12 weeks). */
function weeklyChart(lectures, cw) {
  const last = Math.max(cw, 1);
  const weeks = [];
  for (let w = Math.max(1, last - 11); w <= last; w++) {
    const taught = lectures.filter(l => itemWeek(l) === w);
    weeks.push({ w, taught: taught.length, seen: taught.filter(l => stateOf(l) !== "todo").length });
  }
  const top = Math.max(4, ...weeks.map(x => x.taught));
  const step = Math.ceil(top / 4);
  const max = step * 4;
  const ticks = [4, 3, 2, 1, 0].map(i => i * step);
  if (!weeks.some(x => x.taught)) {
    return `<div class="empty small">Give your lectures a date in Courses and this chart fills in.</div>`;
  }
  const unit = n => `${n} lecture${n === 1 ? "" : "s"}`;
  return `<div class="chart">
      <div class="chart-y" aria-hidden="true">${ticks.map(t => `<span>${t}</span>`).join("")}</div>
      <div class="chart-plot">
        <div class="chart-grid" aria-hidden="true">${ticks.map(() => "<i></i>").join("")}</div>
        ${weeks.map(x => `<div class="grp ${x.w === cw ? "now" : ""}" tabindex="0" aria-label="Week ${x.w}: ${unit(x.taught)} taught, ${x.seen} seen">
          <div class="bars"><i class="b taught" style="height:${100 * x.taught / max}%"></i><i class="b seen" style="height:${100 * x.seen / max}%"></i></div>
          <span class="x">W${x.w}</span>
          <div class="tip"><b>Week ${x.w}</b><span><i class="key taught"></i>${x.taught} taught</span><span><i class="key seen"></i>${x.seen} seen</span></div>
        </div>`).join("")}
      </div>
    </div>`;
}

export function render() {
  const now = today();
  const cw = currentWeek();
  const start = D.settings.semesterStart;
  const items = itemsList();
  const lectures = items.filter(isLecture);

  const recalls = pendingRecalls();
  const dueRecalls = recalls.filter(r => r.due <= now);
  const week = items.filter(it => itemWeek(it) === cw);
  const weekDone = week.filter(isDone).length;
  const behind = lectures.filter(l => stateOf(l) === "todo" && itemWeek(l) != null && itemWeek(l) < cw)
    .sort((a, b) => itemWeek(a) - itemWeek(b) || (a.date || "").localeCompare(b.date || ""));
  const revised = lectures.filter(l => stateOf(l) === "recall2").length;

  const open = deadlinesList().filter(d => !d.done);
  const nearDeadlines = deadlines.dueThisWeek(open, now); // the "This week" group of the Deadlines page
  const tasks = todo.dueTasks();

  // ---- row 1: quick stats
  const tiles = [
    { n: dueRecalls.length, label: dueRecalls.length === 1 ? "Recall due" : "Recalls due", ic: "clock", to: "courses", hot: dueRecalls.length > 0 },
    { n: nearDeadlines.length, label: "Deadlines this week", ic: "flag", to: "deadlines", hot: nearDeadlines.some(d => d.due.slice(0, 10) <= addDays(now, 1)) },
    { n: tasks.length, label: "To-dos today", ic: "todo", to: "todo", hot: false },
    { n: behind.length, label: "To catch up", ic: "book", to: "courses", hot: false },
    { n: week.length ? `${weekDone}/${week.length}` : "0", label: "Done this week", ic: "check", to: "courses", hot: false },
    { n: lectures.length ? `${revised}/${lectures.length}` : "0", label: "Fully revised", ic: "spark", to: "courses", hot: false },
  ];
  const lead = tiles.findIndex(t => t.hot);
  const stats = `<section class="stats">
      <div class="stats-intro">
        <p class="eyebrow">${greeting()}</p>
        <h1>${cw >= 1 ? `Week ${cw}` : "Before week 1"}</h1>
        <p class="muted">${cw >= 1 ? weekLabel(cw, start) : `Starts ${fmtWday(start)}`}<br>${fmtLong(now)}</p>
      </div>
      ${tiles.map((t, i) => `<button class="tile ${i === lead ? "lead" : ""}" data-act="go" data-view="${t.to}">
        <span class="bubble">${icon(t.ic, 18)}</span><b>${t.n}</b><span class="tile-l">${t.label}</span>
        ${i === lead ? `<span class="tile-go">${icon("arrow", 14)}</span>` : ""}
      </button>`).join("")}
    </section>`;

  // ---- a day with more recalls than she wants: offer to even them out
  const load = {};
  for (const r of recalls) { const d = r.due < now ? now : r.due; load[d] = (load[d] || 0) + 1; }
  const [peakDay, peak] = Object.entries(load).sort((a, b) => b[1] - a[1])[0] || [];
  const max = D.settings.maxRecallsPerDay;
  const spread = peak > max ? `<div class="banner">
      <span>${icon("clock")} <b>${peak} recalls</b> land on ${peakDay === now ? "today" : fmtWday(peakDay)}. That is a lot for one day.</span>
      <button class="btn primary small" data-act="spread">Spread them out (max ${max} a day)</button>
    </div>` : "";

  // ---- row 2: chart + deadlines
  const chartCard = `<section class="card">
      <div class="card-h"><h2>Lectures by week</h2><span class="grow"></span>
        <span class="legend-i"><i class="key taught"></i>Taught</span><span class="legend-i"><i class="key seen"></i>Seen</span></div>
      ${weeklyChart(lectures, cw)}
    </section>`;

  const deadlineCard = `<section class="card">
      <div class="card-h"><h2>Deadlines</h2><span class="grow"></span><button class="iconbtn ring" data-act="go" data-view="deadlines" title="All deadlines">${icon("dots", 16)}</button></div>
      ${open.slice(0, 4).map(d => {
        const m = D.modules[d.module];
        const c = deadlines.countdown(d);
        return `<div class="row plain" ${cvar(m?.color || "plum")}>
          <span class="bubble tint">${icon("flag", 17)}</span>
          <button class="row-main" data-act="editDeadline" data-id="${d.id}">
            <span class="t">${esc(d.title)}</span>
            <span class="sub">${fmtWday(d.due)}${d.due.length > 10 ? " · " + d.due.slice(11, 16) : ""}${m ? " · " + esc(m.name) : ""}</span>
          </button>
          <span class="badge ${c.cls}">${c.text}</span>
        </div>`;
      }).join("") || `<div class="empty small">No deadlines yet. <button class="link" data-act="addDeadline">Add one</button></div>`}
      ${open.length > 4 ? `<div class="pad small">${more(`${open.length - 4} more`, "deadlines")}</div>` : ""}
    </section>`;

  // ---- row 3: the study queue, as a table
  const queue = new Map();
  const put = (it, kind, status, cls) => { if (!queue.has(it.id)) queue.set(it.id, { it, kind, status, cls }); };
  for (const r of dueRecalls) put({ id: r.id, ...r.item }, "recalls", `Recall ${r.n} · ${relDay(r.due, now)}`, r.due < now ? "late" : "now");
  for (const it of week.sort((a, b) => (a.date || "9").localeCompare(b.date || "9"))) if (!isDone(it)) put(it, "week", "This week", "soon");
  for (const it of behind) put(it, "catchup", itemWeek(it) >= 1 ? `Catch-up · W${itemWeek(it)}` : "Catch-up · before W1", "");
  const counts = { all: queue.size, recalls: 0, week: 0, catchup: 0 };
  for (const q of queue.values()) counts[q.kind]++;
  if (!counts[view.queue]) view.queue = "all";
  const rows = [...queue.values()].filter(q => view.queue === "all" || q.kind === view.queue);
  const SHOWN = 8;

  const queueCard = `<section class="card">
      <div class="card-h"><h2>Study queue</h2><span class="grow"></span>
        <select class="pill-select" data-change="queueFilter" aria-label="Show">
          ${[["all", "Everything"], ["recalls", "Recalls due"], ["week", "This week"], ["catchup", "Catch-up"]].map(([k, l]) => `<option value="${k}" ${view.queue === k ? "selected" : ""} ${counts[k] || k === "all" ? "" : "disabled"}>${l} (${counts[k]})</option>`).join("")}
        </select>
        <button class="btn dark small" data-act="go" data-view="courses">Courses ${icon("arrow", 14)}</button>
      </div>
      ${rows.length ? `<div class="table">
        <div class="thead"><span>Lecture</span><span>Module</span><span>Taught</span><span>Status</span><span>Progress</span></div>
        ${rows.slice(0, SHOWN).map(({ it, status, cls }) => {
          const m = moduleOf(it);
          return `<div class="trow" ${cvar(m.color)}>
            <span class="t" title="${esc(it.title)}">${esc(it.title)}</span>
            <span class="cell"><span class="dot"></span>${esc(m.name)}</span>
            <span class="cell muted">${it.date ? fmtDay(it.date) : itemWeek(it) >= 1 ? "W" + itemWeek(it) : "—"}</span>
            <span><span class="badge ${cls}">${status}</span></span>
            ${isLecture(it) ? courses.stepper(it.id, it) : `<button class="check ${it.doneAt ? "on" : ""}" data-act="toggleItem" data-id="${it.id}" aria-label="Done">${icon("check", 14)}</button>`}
          </div>`;
        }).join("")}
      </div>${rows.length > SHOWN ? `<div class="pad small">${more(`${rows.length - SHOWN} more in Courses`, "courses")}</div>` : ""}`
      : `<div class="empty small">Nothing waiting: no recall due, nothing left this week, nothing to catch up 🌷</div>`}
    </section>`;

  // ---- row 4: to-dos + modules
  const todoCard = `<section class="card"><div class="card-h"><h2>To-do today</h2><span class="grow"></span>${more("To-do", "todo")}</div>
      ${tasks.slice(0, 6).map(t => todo.taskRow(t, { showProject: true })).join("") || `<div class="empty small">Nothing on your list for today.</div>`}
    </section>`;

  const moduleRows = modulesSorted().map(m => {
    const ls = lectures.filter(l => l.module === m.id);
    const n = Object.fromEntries(STATES.map(s => [s, ls.filter(l => stateOf(l) === s).length]));
    const exam = m.exam ? (m.exam < now ? "exam passed" : `exam ${relDay(m.exam, now)}`) : "no exam date";
    return `<div class="mod" ${cvar(m.color)}>
      <div class="mod-h"><span class="dot"></span><b>${esc(m.name)}</b><span class="muted">${ls.length ? `${ls.length - n.todo}/${ls.length} seen` : "no lectures yet"} · ${exam}</span></div>
      <div class="stack" title="${STATES.map(s => `${LABEL[s]}: ${n[s]}`).join(" · ")}">${ls.length ? STATES.slice(1).map(s => `<i class="s-${s}" style="flex:${n[s]}"></i>`).join("") + `<i class="s-todo" style="flex:${n.todo}"></i>` : ""}</div>
    </div>`;
  }).join("");
  const moduleCard = `<section class="card"><div class="card-h"><h2>Modules</h2><span class="grow"></span>${more("Exam dates", "settings")}</div>
      <div class="mods">${moduleRows}</div>
      <div class="legend"><span><i class="s-seen"></i>Seen</span><span><i class="s-quizzed"></i>Quizzed</span><span><i class="s-recall1"></i>Recall 1</span><span><i class="s-recall2"></i>Recall 2</span></div>
    </section>`;

  return `${stats}${spread}
    <div class="dash-2">${chartCard}${deadlineCard}</div>
    ${queueCard}
    <div class="grid" style="margin-top:20px">${todoCard}${moduleCard}</div>`;
}

export const actions = {
  go: el => app.go(el.dataset.view),
  queueFilter: el => { view.queue = el.value; app.refresh(); },
  step: courses.actions.step,
  toggleItem: courses.actions.toggleItem,
  addDeadline: deadlines.actions.addDeadline,
  editDeadline: deadlines.actions.editDeadline,
  toggleDeadline: deadlines.actions.toggleDeadline,
  toggleTask: todo.actions.toggleTask,
  editTask: todo.actions.editTask,
  addSub: todo.actions.addSub,
  deleteTask: todo.actions.deleteTask,

  spread: () => {
    const moves = spreadPlan(pendingRecalls(), D.settings.maxRecallsPerDay, today());
    for (const m of moves) D.items[m.id].recallDue = m.due;
    save(); app.refresh();
    toast(`${moves.length} recall${moves.length === 1 ? "" : "s"} moved to quieter days`);
  },
};
