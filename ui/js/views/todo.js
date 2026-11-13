// To-do: a personal task list (inbox, today, upcoming, projects). Recalls and deadlines are
// deliberately not shown here; they have their own places.
import { D, save, uid, tasksList } from "../store.js";
import { today, fmtLong, fmtWday, dueLabel } from "../dates.js";
import { parseQuick, nextOccurrence, recurLabel } from "../quickadd.js";
import { esc, icon, app, openModal, confirmBox, field, input, select, cvar, toast, COLORS, $ } from "../ui.js";

const view = { sel: "today", showDone: false };

const PRIO = { 1: "Priority 1", 2: "Priority 2", 3: "Priority 3", 4: "No priority" };
const RECUR = [["", "Does not repeat"], ["1day", "Every day"], ["1weekday", "Every weekday"], ["1week", "Every week"], ["2week", "Every 2 weeks"], ["1month", "Every month"]];
const recurKey = r => (r ? r.every + r.unit : "");
const recurFromKey = k => {
  const m = /^(\d+)(\D+)$/.exec(k || "");
  return m ? { every: Number(m[1]), unit: m[2] } : null;
};
/** The Repeat choices, plus the task's own repetition when quick-add set one not in the list. */
const recurOptions = r => (RECUR.some(([k]) => k === recurKey(r)) ? RECUR : [...RECUR, [recurKey(r), recurLabel(r)]]);

const projects = () => Object.entries(D.todo.projects).map(([id, p]) => ({ id, ...p })).sort((a, b) => a.order - b.order);
const currentProject = () => (view.sel.startsWith("p:") ? view.sel.slice(2) : null);
const byOrder = (a, b) => a.order - b.order;
const byPrio = (a, b) => a.prio - b.prio || (a.due || "9").localeCompare(b.due || "9") || a.order - b.order;

/** Open tasks due today or earlier. Also used by the dashboard. */
export const dueTasks = () => tasksList().filter(t => !t.done && t.due && t.due <= today()).sort(byPrio);

export function taskRow(t, { showProject = false, sub = false, drag = false } = {}) {
  const now = today();
  const p = D.todo.projects[t.project];
  const kids = tasksList().filter(k => k.parent === t.id);
  const openKids = kids.filter(k => !k.done).length;
  const due = t.due ? `<span class="meta ${!t.done && t.due < now ? "late" : t.due === now ? "now" : ""}">${icon("cal", 13)} ${dueLabel(t.due, now)}</span>` : "";
  return `<div class="row task p${t.prio} ${t.done ? "done" : ""} ${sub ? "sub" : ""}" data-task="${t.id}" ${drag ? 'draggable="true"' : ""}>
    ${drag ? `<span class="grip" title="Drag to reorder">${icon("grip", 14)}</span>` : ""}
    <button class="check round ${t.done ? "on" : ""}" data-act="toggleTask" data-id="${t.id}" aria-label="Complete" aria-pressed="${Boolean(t.done)}">${icon("check", 13)}</button>
    <button class="row-main" data-act="editTask" data-id="${t.id}">
      <span class="t">${esc(t.title)}</span>
      <span class="sub">${due}${t.recur ? `<span class="meta">${icon("repeat", 13)} ${recurLabel(t.recur)}</span>` : ""}${kids.length ? `<span class="meta">${icon("sub", 13)} ${kids.length - openKids}/${kids.length}</span>` : ""}${showProject && p ? `<span class="meta" ${cvar(p.color)}><span class="dot"></span>${esc(p.name)}</span>` : ""}${t.notes ? `<span class="meta">${esc(t.notes.slice(0, 60))}</span>` : ""}</span>
    </button>
    <span class="row-actions">
      ${sub ? "" : `<button class="iconbtn" data-act="addSub" data-id="${t.id}" title="Add a subtask">${icon("sub", 16)}</button>`}
      <button class="iconbtn" data-act="deleteTask" data-id="${t.id}" title="Delete">${icon("trash", 16)}</button>
    </span>
  </div>`;
}

/** A task followed by its open subtasks. */
function tree(t, opts) {
  const kids = tasksList().filter(k => k.parent === t.id && !k.done).sort(byOrder);
  return taskRow(t, opts) + kids.map(k => taskRow(k, { sub: true })).join("");
}

function quickAdd(placeholder) {
  return `<form class="quick" data-submit="quickAdd">
      <span class="plus">${icon("plus", 18)}</span>
      <input name="text" placeholder="${placeholder}" autocomplete="off" data-input="preview" aria-label="New task">
      <button class="btn primary small">Add</button>
    </form>
    <div class="quick-hint" id="quick-hint">Try: <code>Email supervisor tomorrow p1</code> · <code>Gym every monday</code> · <code>Buy lab coat 14 nov #Errands</code></div>`;
}

function listBody() {
  const now = today();
  const all = tasksList();
  const open = all.filter(t => !t.done);

  if (view.sel === "today") {
    const late = open.filter(t => t.due && t.due < now).sort(byPrio);
    const due = open.filter(t => t.due === now).sort(byPrio);
    return { title: "Today", sub: fmtLong(now), html:
      (late.length ? `<section class="card wsec"><div class="card-h"><h3>Overdue</h3><span class="muted mono">${late.length}</span></div>${late.map(t => taskRow(t, { showProject: true, sub: false })).join("")}</section>` : "") +
      `<section class="card wsec"><div class="card-h"><h3>Today</h3><span class="muted mono">${due.length}</span></div>${due.map(t => taskRow(t, { showProject: true })).join("") || `<div class="empty small">Nothing planned for today. Enjoy it 🌸</div>`}</section>` };
  }

  if (view.sel === "upcoming") {
    const future = open.filter(t => t.due && t.due > now).sort((a, b) => a.due.localeCompare(b.due) || byPrio(a, b));
    const days = [...new Set(future.map(t => t.due))];
    return { title: "Upcoming", sub: future.length ? `${future.length} planned` : "", html:
      days.map(d => `<section class="card wsec"><div class="card-h"><h3>${fmtWday(d)}</h3><span class="muted">${dueLabel(d, now)}</span></div>${future.filter(t => t.due === d).map(t => taskRow(t, { showProject: true })).join("")}</section>`).join("") ||
      `<div class="empty">Nothing scheduled ahead. Give a task a date and it shows up here.</div>` };
  }

  const pid = currentProject();
  const p = pid && D.todo.projects[pid];
  const mine = t => (pid ? t.project === pid : !t.project);
  const top = open.filter(t => mine(t) && !t.parent).sort(byOrder);
  const done = all.filter(t => mine(t) && t.done).sort((a, b) => (b.doneAt || "").localeCompare(a.doneAt || ""));
  return { title: p ? p.name : "Inbox", sub: p ? "" : "Everything not filed in a project", project: pid, html:
    `<section class="card wsec" id="sortable">${top.map(t => tree(t, { drag: true })).join("") || `<div class="empty small">${p ? "No tasks in this project yet." : "Your inbox is empty."}</div>`}</section>
    ${done.length ? `<button class="btn ghost small" data-act="toggleDone">${view.showDone ? "Hide" : "Show"} completed (${done.length})</button>
      ${view.showDone ? `<section class="card wsec">${done.map(t => taskRow(t, { sub: Boolean(t.parent) })).join("")}</section>` : ""}` : "" }` };
}

export function render() {
  if (currentProject() && !D.todo.projects[currentProject()]) view.sel = "inbox";
  const now = today();
  const open = tasksList().filter(t => !t.done);
  const count = n => (n ? `<span class="count">${n}</span>` : "");
  const nav = (key, label, ic, n, style = "") =>
    `<button class="side-item ${view.sel === key ? "on" : ""}" data-act="select" data-sel="${key}" ${style}>${ic}<span>${esc(label)}</span>${count(n)}</button>`;
  const body = listBody();

  return `<div class="todo">
    <aside class="todo-side">
      ${nav("inbox", "Inbox", icon("inbox"), open.filter(t => !t.project && !t.parent).length)}
      ${nav("today", "Today", icon("sun"), open.filter(t => t.due && t.due <= now).length)}
      ${nav("upcoming", "Upcoming", icon("cal"), open.filter(t => t.due && t.due > now).length)}
      <div class="side-h"><span>Projects</span><button class="iconbtn" data-act="addProject" title="New project">${icon("plus", 16)}</button></div>
      ${projects().map(p => nav("p:" + p.id, p.name, '<span class="dot big"></span>', open.filter(t => t.project === p.id && !t.parent).length, cvar(p.color))).join("") || `<p class="muted small pad">Group tasks into projects, like "Thesis" or "Errands".</p>`}
    </aside>
    <div class="todo-main">
      <header class="page-h">
        <div><h1>${esc(body.title)}</h1>${body.sub ? `<p class="muted">${esc(body.sub)}</p>` : ""}</div>
        ${body.project ? `<button class="btn ghost small" data-act="editProject" data-id="${body.project}">${icon("edit", 15)} Edit project</button>` : ""}
      </header>
      ${quickAdd(view.sel === "today" ? "Add a task for today" : "Add a task")}
      ${body.html}
    </div>
  </div>`;
}

/** Finds a project by the name typed after #, ignoring case and spaces. */
function matchProject(name) {
  if (!name) return null;
  const key = s => s.toLowerCase().replace(/[\s_-]/g, "");
  const list = projects();
  return (list.find(p => key(p.name) === key(name)) || list.find(p => key(p.name).startsWith(key(name))))?.id || null;
}

function newTask(fields) {
  const id = uid();
  D.todo.tasks[id] = { title: "", notes: "", project: null, parent: null, prio: 4, due: null, recur: null, done: false, doneAt: null, order: Date.now(), created: today(), ...fields };
  return id;
}

function openTask(id, preset = {}) {
  const t = id ? D.todo.tasks[id] : { title: "", notes: "", prio: 4, due: view.sel === "today" ? today() : null, project: currentProject(), recur: null, ...preset };
  const parent = t.parent && D.todo.tasks[t.parent];
  openModal({
    title: id ? "Edit task" : parent ? `Subtask of "${parent.title}"` : "New task",
    body: `
      ${field("Task", input("title", t.title, 'required autofocus'))}
      <div class="grid2">
        ${field("Due", input("due", t.due, 'type="date"'))}
        ${field("Priority", select("prio", Object.entries(PRIO), t.prio))}
        ${parent ? "" : field("Project", select("project", [["", "Inbox"], ...projects().map(p => [p.id, p.name])], t.project))}
        ${field("Repeat", select("recur", recurOptions(t.recur), recurKey(t.recur)))}
      </div>
      ${field("Notes", `<textarea name="notes" rows="2">${esc(t.notes || "")}</textarea>`)}`,
    danger: id && { label: "Delete", onClick: () => removeTask(id) },
    onSubmit: v => {
      const fields = {
        title: v.title.trim(), notes: v.notes.trim(), prio: Number(v.prio), due: v.due || null,
        recur: recurFromKey(v.recur), project: parent ? parent.project : v.project || null,
      };
      if (fields.recur && !fields.due) fields.due = today();
      if (id) {
        Object.assign(D.todo.tasks[id], fields);
        for (const k of Object.values(D.todo.tasks)) if (k.parent === id) k.project = fields.project;
      } else newTask({ ...fields, parent: t.parent || null });
      save(); app.refresh();
    },
  });
}

async function removeTask(id) {
  const t = D.todo.tasks[id];
  const kids = Object.entries(D.todo.tasks).filter(([, k]) => k.parent === id);
  if (kids.length && !await confirmBox("Delete this task?", `"${t.title}" and its ${kids.length} subtask${kids.length > 1 ? "s" : ""} will be removed.`)) return;
  kids.forEach(([kid]) => delete D.todo.tasks[kid]);
  delete D.todo.tasks[id];
  save(); app.refresh();
}

function openProject(id) {
  const p = id ? D.todo.projects[id] : { name: "", color: COLORS[projects().length % COLORS.length] };
  openModal({
    title: id ? "Edit project" : "New project",
    body: `${field("Name", input("name", p.name, 'required autofocus placeholder="e.g. Thesis"'))}
      ${field("Colour", `<div class="swatches">${COLORS.map(c => `<label ${cvar(c)}><input type="radio" name="color" value="${c}" ${p.color === c ? "checked" : ""}><span></span></label>`).join("")}</div>`)}`,
    danger: id && { label: "Delete project", onClick: async () => {
      const n = Object.values(D.todo.tasks).filter(t => t.project === id).length;
      if (!await confirmBox("Delete this project?", n ? `Its ${n} task${n > 1 ? "s" : ""} will move to the Inbox.` : `"${p.name}" will be removed.`)) return;
      for (const t of Object.values(D.todo.tasks)) if (t.project === id) t.project = null;
      delete D.todo.projects[id];
      view.sel = "inbox";
      save(); app.refresh();
    } },
    onSubmit: v => {
      if (id) Object.assign(D.todo.projects[id], { name: v.name.trim(), color: v.color });
      else {
        const pid = uid();
        D.todo.projects[pid] = { name: v.name.trim(), color: v.color, order: Date.now() };
        view.sel = "p:" + pid;
      }
      save(); app.refresh();
    },
  });
}

/** Completing a repeating task moves it to its next date instead of closing it. */
export function toggleTask(id) {
  const t = D.todo.tasks[id];
  if (!t.done && t.recur) {
    t.due = nextOccurrence(t.due, t.recur, today());
    for (const k of Object.values(D.todo.tasks)) if (k.parent === id) { k.done = false; k.doneAt = null; }
    toast(`Done. Next one ${dueLabel(t.due).toLowerCase()} ↻`);
  } else {
    t.done = !t.done;
    t.doneAt = t.done ? today() : null;
    if (t.done) for (const k of Object.values(D.todo.tasks)) if (k.parent === id && !k.done) { k.done = true; k.doneAt = today(); }
    // a done task cannot keep an open subtask: reopening one reopens its parent (as it was, with
    // no step to a next occurrence, so a repeating parent is not moved on)
    const parent = !t.done && D.todo.tasks[t.parent];
    if (parent?.done) { parent.done = false; parent.doneAt = null; }
  }
  save(); app.refresh();
}

export const actions = {
  select: el => { view.sel = el.dataset.sel; view.showDone = false; app.refresh(); },
  toggleDone: () => { view.showDone = !view.showDone; app.refresh(); },
  toggleTask: el => toggleTask(el.dataset.id),
  editTask: el => openTask(el.dataset.id),
  addSub: el => openTask(null, { parent: el.dataset.id, project: D.todo.tasks[el.dataset.id].project, due: null }),
  deleteTask: el => removeTask(el.dataset.id),
  addProject: () => openProject(null),
  editProject: el => openProject(el.dataset.id),

  quickAdd: form => {
    const text = form.elements.text.value.trim();
    if (!text) return;
    const q = parseQuick(text, today());
    if (!q.title) return;
    newTask({
      title: q.title, prio: q.prio, recur: q.recur,
      due: q.due || (view.sel === "today" ? today() : null),
      project: matchProject(q.projectName) || currentProject(),
    });
    save(); app.refresh();
    $('.quick input[name="text"]')?.focus();
  },

  /** Shows what the typed text will become, without re-rendering (the field keeps focus). */
  preview: el => {
    const hint = $("#quick-hint");
    if (!el.value.trim()) { hint.innerHTML = hint.dataset.idle || hint.innerHTML; return; }
    hint.dataset.idle ??= hint.innerHTML;
    const q = parseQuick(el.value, today());
    const pid = matchProject(q.projectName);
    const bits = [
      q.due && `${icon("cal", 13)} ${dueLabel(q.due)}`,
      q.prio < 4 && `<b class="p${q.prio}">P${q.prio}</b>`,
      q.recur && `${icon("repeat", 13)} ${recurLabel(q.recur)}`,
      q.projectName && (pid ? `# ${esc(D.todo.projects[pid].name)}` : `<span class="late">no project called "${esc(q.projectName)}"</span>`),
    ].filter(Boolean);
    hint.innerHTML = `<b>${esc(q.title || "…")}</b>${bits.map(b => `<span class="meta">${b}</span>`).join("")}`;
  },
};

/** Drag a task onto another to place it just before it (inbox and project lists). */
let dragging = null;
export function bindDrag(root) {
  root.addEventListener("dragstart", e => {
    const row = e.target.closest?.(".task[draggable]");
    if (!row) return;
    dragging = row.dataset.task;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragging);
    row.classList.add("dragging");
  });
  root.addEventListener("dragover", e => {
    const row = e.target.closest?.(".task[draggable]");
    if (!dragging || !row) return;
    e.preventDefault();
    root.querySelectorAll(".drop").forEach(r => r.classList.remove("drop"));
    if (row.dataset.task !== dragging) row.classList.add("drop");
  });
  root.addEventListener("dragend", () => { dragging = null; root.querySelectorAll(".drop, .dragging").forEach(r => r.classList.remove("drop", "dragging")); });
  root.addEventListener("drop", e => {
    const row = e.target.closest?.(".task[draggable]");
    if (!dragging || !row || row.dataset.task === dragging) return;
    e.preventDefault();
    const ids = [...root.querySelectorAll("#sortable .task[draggable]")].map(r => r.dataset.task).filter(id => id !== dragging);
    ids.splice(ids.indexOf(row.dataset.task), 0, dragging);
    ids.forEach((id, i) => { D.todo.tasks[id].order = i; });
    dragging = null;
    save(); app.refresh();
  });
}
