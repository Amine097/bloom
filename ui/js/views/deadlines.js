// Deadlines: everything with a hard date, soonest first.
import { D, save, uid, deadlinesList, modulesSorted, currentWeek } from "../store.js";
import { today, addDays, diffDays, fmtWday, weekStart } from "../dates.js";
import { esc, icon, app, openModal, confirmBox, field, input, select, cvar, toast } from "../ui.js";

const view = { showDone: false };
const TYPES = ["Assignment", "Presentation", "Report", "Quiz", "Exam", "Lab", "Other"];

/** "in 3 days", "today 23:59", "2 days late" plus an urgency class. Also used by the dashboard. */
export function countdown(d, now = today()) {
  const n = diffDays(now, d.due.slice(0, 10));
  const time = d.due.slice(11, 16);
  if (d.done) return { text: "done", cls: "ok" };
  if (n < 0) return { text: n === -1 ? "1 day late" : `${-n} days late`, cls: "late" };
  if (n === 0) return { text: `today${time ? " " + time : ""}`, cls: "late" };
  if (n === 1) return { text: `tomorrow${time ? " " + time : ""}`, cls: "now" };
  return { text: `in ${n} days`, cls: n <= 7 ? "soon" : "" };
}

export function deadlineRow(d) {
  const m = D.modules[d.module];
  const c = countdown(d);
  return `<div class="row deadline ${d.done ? "done" : ""}" ${cvar(m?.color || "plum")}>
    <button class="check ${d.done ? "on" : ""}" data-act="toggleDeadline" data-id="${d.id}" aria-label="Done" aria-pressed="${Boolean(d.done)}">${icon("check", 14)}</button>
    <button class="row-main" data-act="editDeadline" data-id="${d.id}">
      <span class="t">${esc(d.title)}</span>
      <span class="sub">${m ? `<span class="dot"></span>` : ""}<span class="sub-text">${m ? `${esc(m.name)} · ` : ""}${esc(d.type || "Deadline")} · ${fmtWday(d.due)}${d.due.length > 10 ? ", " + d.due.slice(11, 16) : ""}${d.notes ? " · " + esc(d.notes.slice(0, 70)) : ""}</span></span>
    </button>
    <span class="badge ${c.cls}">${c.text}</span>
  </div>`;
}

/** Sunday of the current calendar week. */
const weekEnd = () => addDays(weekStart(currentWeek(), D.settings.semesterStart), 6);

/** Open deadlines from today to Sunday: the "This week" group. Also used by the dashboard. */
export const dueThisWeek = (open, now = today()) =>
  open.filter(d => !d.done && d.due.slice(0, 10) >= now && d.due.slice(0, 10) <= weekEnd());

export function render() {
  const now = today();
  const endOfWeek = weekEnd();
  const all = deadlinesList();
  const open = all.filter(d => !d.done);
  const groups = [
    ["Overdue", open.filter(d => d.due.slice(0, 10) < now)],
    ["This week", dueThisWeek(open, now)],
    ["Next week", open.filter(d => d.due.slice(0, 10) > endOfWeek && d.due.slice(0, 10) <= addDays(endOfWeek, 7))],
    ["Later", open.filter(d => d.due.slice(0, 10) > addDays(endOfWeek, 7))],
  ];
  const done = all.filter(d => d.done).reverse();

  return `<header class="page-h">
      <div><h1>Deadlines</h1><p class="muted">${open.length ? `${open.length} open` : "Nothing due"}${done.length ? ` · ${done.length} done` : ""}</p></div>
      <button class="btn primary" data-act="addDeadline">${icon("plus", 16)} Add deadline</button>
    </header>
    ${groups.filter(([, list]) => list.length).map(([name, list]) => `<section class="card wsec">
      <div class="card-h"><h3>${name}</h3><span class="muted mono">${list.length}</span></div>
      ${list.map(deadlineRow).join("")}
    </section>`).join("")}
    ${open.length ? "" : `<div class="empty">No deadlines waiting. Add one and Bloom will count the days for you.</div>`}
    ${done.length ? `<button class="btn ghost small" data-act="toggleDone">${view.showDone ? "Hide" : "Show"} done (${done.length})</button>
      ${view.showDone ? `<section class="card wsec">${done.map(deadlineRow).join("")}</section>` : ""}` : ""}`;
}

/**
 * An Exam deadline of module `mid` on `date` was deleted or stopped being that module's exam.
 * The module's exam date follows another Exam deadline of the module if one remains, otherwise
 * it is cleared. An exam date set by hand to a different day is left alone.
 */
export function releaseExam(mid, date) {
  const m = D.modules[mid];
  if (!m || !date || m.exam !== date) return;
  const exams = deadlinesList().filter(d => d.type === "Exam" && d.module === mid);
  const next = exams.find(d => d.due.slice(0, 10) >= today()) || exams[exams.length - 1];
  m.exam = next ? next.due.slice(0, 10) : null;
}

export function openDeadline(id) {
  const d = id ? D.deadlines[id] : { title: "", module: "", type: "Assignment", due: "", notes: "" };
  const mods = [["", "No module"], ...modulesSorted().map(m => [m.id, m.name])];
  openModal({
    title: id ? "Edit deadline" : "New deadline",
    body: `
      ${field("What is due", input("title", d.title, 'required autofocus placeholder="e.g. PK/PD workbook"'))}
      <div class="grid2">
        ${field("Module", select("module", mods, d.module))}
        ${field("Type", select("type", TYPES.map(t => [t, t]), d.type))}
        ${field("Date", input("date", d.due.slice(0, 10), 'type="date" required'))}
        ${field("Time", input("time", d.due.slice(11, 16) || "23:59", 'type="time"'))}
      </div>
      ${field("Notes", `<textarea name="notes" rows="2">${esc(d.notes || "")}</textarea>`)}`,
    danger: id && { label: "Delete", onClick: async () => {
      if (!await confirmBox("Delete this deadline?", `"${d.title}" will be removed.`)) return;
      delete D.deadlines[id];
      if (d.type === "Exam") releaseExam(d.module, d.due.slice(0, 10));
      save(); app.refresh();
    } },
    onSubmit: v => {
      const target = id ? D.deadlines[id] : (D.deadlines[uid()] = { done: false, doneAt: null });
      const was = { type: target.type, module: target.module, date: target.due?.slice(0, 10) };
      Object.assign(target, {
        title: v.title.trim(), module: v.module || null, type: v.type,
        due: v.date + (v.time ? "T" + v.time : ""), notes: v.notes.trim(),
      });
      if (was.type === "Exam" && (target.type !== "Exam" || target.module !== was.module)) releaseExam(was.module, was.date);
      const m = D.modules[v.module];
      if (v.type === "Exam" && m && m.exam !== v.date) {
        // the module's exam date follows its Exam deadlines, but a date set by hand in
        // Settings to another day is hers to keep
        const followsDeadline = !m.exam
          || (was.type === "Exam" && was.module === target.module && was.date === m.exam)
          || Object.values(D.deadlines).some(o => o !== target && o.type === "Exam"
            && o.module === target.module && o.due.slice(0, 10) === m.exam);
        if (followsDeadline) {
          m.exam = v.date;
          toast(`${m.name} exam set to ${fmtWday(v.date)}. Recalls will adapt.`);
        } else {
          toast(`${m.name} keeps the exam date set in Settings, ${fmtWday(m.exam)}.`);
        }
      }
      save(); app.refresh();
    },
  });
}

export const actions = {
  addDeadline: () => openDeadline(null),
  editDeadline: el => openDeadline(el.dataset.id),
  toggleDone: () => { view.showDone = !view.showDone; app.refresh(); },
  toggleDeadline: el => {
    const d = D.deadlines[el.dataset.id];
    d.done = !d.done;
    d.doneAt = d.done ? today() : null;
    save(); app.refresh();
  },
};
