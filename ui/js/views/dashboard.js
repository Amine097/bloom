// Dashboard: where the semester stands today.
import { D, save, currentWeek, itemWeek, isLecture, isDone, itemsList, modulesSorted, moduleOf, pendingRecalls, deadlinesList } from "../store.js";
import { today, addDays, diffDays, fmtLong, fmtWday, weekLabel, relDay } from "../dates.js";
import { stateOf, setStep, spreadPlan, STATES, LABEL } from "../recall.js";
import { esc, icon, app, cvar, toast, FLOWER } from "../ui.js";
import * as courses from "./courses.js";
import * as deadlines from "./deadlines.js";
import * as todo from "./todo.js";

function greeting() {
  const h = new Date().getHours();
  const part = h < 5 ? "Still up" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return D.settings.name ? `${part}, ${esc(D.settings.name)}` : part;
}

const card = (title, body, extra = "") => `<section class="card"><div class="card-h"><h3>${title}</h3><span class="grow"></span>${extra}</div>${body}</section>`;
const more = (label, view) => `<button class="link" data-act="go" data-view="${view}">${label} →</button>`;

function lectureRow(it, badge = "") {
  const m = moduleOf(it);
  return `<div class="row item" ${cvar(m.color)}>
    <span class="dot"></span>
    <div class="row-main static"><span class="t">${esc(it.title)}</span><span class="sub">${esc(m.name)}${it.date ? " · " + fmtWday(it.date) : ""} ${badge}</span></div>
    ${isLecture(it) ? courses.stepper(it.id, it) : `<button class="check ${it.doneAt ? "on" : ""}" data-act="toggleItem" data-id="${it.id}" aria-label="Done">${icon("check", 14)}</button>`}
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
  const soonRecalls = recalls.filter(r => r.due > now && r.due <= addDays(now, 7));

  const week = items.filter(it => itemWeek(it) === cw);
  const weekDone = week.filter(isDone).length;
  const behind = lectures.filter(l => stateOf(l) === "todo" && itemWeek(l) != null && itemWeek(l) < cw)
    .sort((a, b) => itemWeek(a) - itemWeek(b) || (a.date || "").localeCompare(b.date || ""));
  const unfiled = lectures.filter(l => itemWeek(l) == null).length;

  const open = deadlinesList().filter(d => !d.done);
  const nearDeadlines = open.filter(d => diffDays(now, d.due.slice(0, 10)) <= 7);
  const tasks = todo.dueTasks();

  // a day with more recalls than she wants: offer to even them out
  const load = {};
  for (const r of recalls) { const d = r.due < now ? now : r.due; load[d] = (load[d] || 0) + 1; }
  const [peakDay, peak] = Object.entries(load).sort((a, b) => b[1] - a[1])[0] || [];
  const max = D.settings.maxRecallsPerDay;

  const hero = `<section class="hero">
      <div class="hero-flower">${FLOWER}</div>
      <div class="hero-main">
        <p class="eyebrow">${greeting()} · ${fmtLong(now)}</p>
        <h1>${cw >= 1 ? `Week ${cw}` : "Before week 1"}</h1>
        <p class="hero-sub">${cw >= 1 ? weekLabel(cw, start) : `The semester starts ${fmtWday(start)}`}</p>
      </div>
      <div class="hero-prog">
        <div class="bar"><i style="width:${week.length ? 100 * weekDone / week.length : 0}%"></i></div>
        <span>${week.length ? `${weekDone} of ${week.length} done this week` : "Nothing filed for this week yet"}</span>
      </div>
    </section>`;

  const tile = (n, label, view, cls = "") => `<button class="tile ${cls}" data-act="go" data-view="${view}"><b>${n}</b><span>${label}</span></button>`;
  const tiles = `<div class="tiles">
      ${tile(dueRecalls.length, dueRecalls.length === 1 ? "recall due" : "recalls due", "courses", dueRecalls.length ? "hot" : "")}
      ${tile(nearDeadlines.length, "deadlines within 7 days", "deadlines", nearDeadlines.some(d => d.due.slice(0, 10) <= addDays(now, 1)) ? "hot" : "")}
      ${tile(tasks.length, "to-dos for today", "todo")}
      ${tile(behind.length, behind.length === 1 ? "lecture to catch up" : "lectures to catch up", "courses")}
    </div>`;

  const spread = peak > max ? `<div class="banner">
      <span>${icon("clock")} <b>${peak} recalls</b> land on ${peakDay === now ? "today" : fmtWday(peakDay)}. That is a lot for one day.</span>
      <button class="btn primary small" data-act="spread">Spread them out (max ${max} a day)</button>
    </div>` : "";

  const recallRow = r => {
    const m = moduleOf(r.item);
    return `<div class="row item" ${cvar(m.color)}>
      <span class="dot"></span>
      <div class="row-main static"><span class="t">${esc(r.item.title)}</span><span class="sub">${esc(m.name)} ${courses.recallBadge(r)}</span></div>
      <button class="btn soft small" data-act="recallDone" data-id="${r.id}">${icon("check", 14)} Recall ${r.n} done</button>
    </div>`;
  };
  const recallCard = card("Recalls", `
      ${dueRecalls.map(recallRow).join("") || `<div class="empty small">No recall due today 🌷</div>`}
      ${soonRecalls.length ? `<div class="sep">Coming up</div>${soonRecalls.slice(0, 6).map(r => `<div class="row mini-row" ${cvar(moduleOf(r.item).color)}><span class="dot"></span><span class="t">${esc(r.item.title)}</span><span class="muted">R${r.n} · ${fmtWday(r.due)}</span></div>`).join("")}${soonRecalls.length > 6 ? `<div class="muted pad small">and ${soonRecalls.length - 6} more this week</div>` : ""}` : ""}`,
    dueRecalls.length ? `<span class="pill accent">${dueRecalls.length} due</span>` : "");

  const upcoming = open.slice(0, 5);
  const deadlineCard = card("Deadlines", upcoming.map(deadlines.deadlineRow).join("") ||
    `<div class="empty small">No deadlines yet. <button class="link" data-act="addDeadline">Add one</button></div>`, more("All deadlines", "deadlines"));

  const weekCard = card(`This week`, week.length
    ? week.sort((a, b) => (a.date || "9").localeCompare(b.date || "9")).map(it => lectureRow(it)).join("")
    : `<div class="empty small">No lecture is filed in week ${cw}.${unfiled ? ` ${unfiled} lecture${unfiled > 1 ? "s have" : " has"} no week yet.` : ""}</div>`, more("Courses", "courses"));

  const catchCard = behind.length ? card("Catch-up", behind.slice(0, 5).map(it => lectureRow(it, `<span class="badge">W${itemWeek(it)}</span>`)).join("") +
    (behind.length > 5 ? `<div class="muted pad small">and ${behind.length - 5} more</div>` : ""), `<span class="muted mono">${behind.length}</span>`) : "";

  const todoCard = card("To-do today", tasks.slice(0, 6).map(t => todo.taskRow(t, { showProject: true })).join("") ||
    `<div class="empty small">Nothing on your list for today.</div>`, more("To-do", "todo"));

  const moduleRows = modulesSorted().map(m => {
    const ls = lectures.filter(l => l.module === m.id);
    const counts = Object.fromEntries(STATES.map(s => [s, ls.filter(l => stateOf(l) === s).length]));
    const exam = m.exam ? (m.exam < now ? "exam passed" : `exam ${relDay(m.exam, now)}`) : "no exam date";
    return `<div class="mod" ${cvar(m.color)}>
      <div class="mod-h"><span class="dot"></span><b>${esc(m.name)}</b><span class="muted">${ls.length ? `${ls.length - counts.todo}/${ls.length} seen` : "no lectures yet"} · ${exam}</span></div>
      <div class="stack" title="${STATES.map(s => `${LABEL[s]}: ${counts[s]}`).join(" · ")}">${ls.length ? STATES.slice(1).map(s => `<i class="s-${s}" style="flex:${counts[s]}"></i>`).join("") + `<i class="s-todo" style="flex:${counts.todo}"></i>` : ""}</div>
    </div>`;
  }).join("");
  const moduleCard = card("Modules", `<div class="mods">${moduleRows}</div>
    <div class="legend"><span><i class="s-seen"></i>Seen</span><span><i class="s-quizzed"></i>Quizzed</span><span><i class="s-recall1"></i>Recall 1</span><span><i class="s-recall2"></i>Recall 2</span></div>`, more("Exam dates", "settings"));

  return `${hero}${tiles}${spread}
    <div class="grid">
      <div class="col">${recallCard}${weekCard}${catchCard}</div>
      <div class="col">${deadlineCard}${todoCard}${moduleCard}</div>
    </div>`;
}

export const actions = {
  go: el => app.go(el.dataset.view),
  step: courses.actions.step,
  toggleItem: courses.actions.toggleItem,
  addDeadline: deadlines.actions.addDeadline,
  editDeadline: deadlines.actions.editDeadline,
  toggleDeadline: deadlines.actions.toggleDeadline,
  toggleTask: todo.actions.toggleTask,
  editTask: todo.actions.editTask,
  addSub: todo.actions.addSub,
  deleteTask: todo.actions.deleteTask,

  recallDone: el => {
    const it = D.items[el.dataset.id];
    setStep(it, it.recall1At ? "recall2" : "recall1", today());
    save(); app.refresh();
    toast(stateOf(it) === "recall2" ? "Fully revised. Well done! 🌷" : "Recall 1 done. Recall 2 is planned 🌸");
  },

  spread: () => {
    const moves = spreadPlan(pendingRecalls(), D.settings.maxRecallsPerDay, today());
    for (const m of moves) D.items[m.id].recallDue = m.due;
    save(); app.refresh();
    toast(`${moves.length} recall${moves.length === 1 ? "" : "s"} moved to quieter days`);
  },
};
