// Courses: every lecture and study task, grouped by the week it was taught, then by date.
import { D, save, uid, currentWeek, itemWeek, isLecture, itemsList, modulesSorted, moduleOf, pendingRecalls } from "../store.js";
import { today, fmtDay, fmtWday, weekLabel, relDay, weekOf } from "../dates.js";
import { stateOf, setStep, LABEL } from "../recall.js";
import { esc, icon, app, openModal, openViewer, confirmBox, field, input, select, cvar, toast } from "../ui.js";
import { storePdf, pdfUrl, removePdf, fmtSize } from "../files.js";

const PDF_ACCEPT = 'accept="application/pdf,.pdf"';

const view = { module: "all", hideDone: false };

const STEPS = [["seen", "Seen"], ["quizzed", "Quiz"], ["recall1", "R1"], ["recall2", "R2"]];

/** The four-step control of a lecture. Also used by the dashboard. */
export function stepper(id, it) {
  const done = { seen: it.seenAt, quizzed: it.quizzedAt, recall1: it.recall1At, recall2: it.recall2At };
  return `<div class="steps" role="group" aria-label="Progress">${STEPS.map(([k, short]) =>
    `<button class="step s-${k} ${done[k] ? "on" : ""}" data-act="step" data-id="${id}" data-step="${k}" title="${LABEL[k]}${done[k] ? " — " + fmtWday(done[k]) : ""}" aria-pressed="${Boolean(done[k])}">${short}</button>`).join("")}</div>`;
}

/** "Recall 1 · tomorrow", coloured by urgency. */
export function recallBadge(r) {
  if (!r) return "";
  const now = today();
  const cls = r.due < now ? "late" : r.due === now ? "now" : "";
  const why = r.manual ? "rescheduled by you" : r.adapted ? "brought forward for the exam" : "";
  return `<span class="badge ${cls}" ${why ? `title="${why}"` : ""}>${icon("clock", 13)} Recall ${r.n} · ${relDay(r.due, now)}${r.adapted ? " · exam" : ""}</span>`;
}

function row(it, recalls) {
  const lecture = isLecture(it);
  const m = moduleOf(it);
  const weekOptions = [["", "Week…"], ...Array.from({ length: Math.max(currentWeek() + 6, 18) }, (_, i) => [i + 1, `W${i + 1}`])];
  const control = lecture
    ? stepper(it.id, it)
    : `<button class="check ${it.doneAt ? "on" : ""}" data-act="toggleItem" data-id="${it.id}" aria-label="Done" aria-pressed="${Boolean(it.doneAt)}">${icon("check", 14)}</button>`;
  const pdf = !lecture ? ""
    : it.pdf ? `<button class="iconbtn pdf" data-act="openPdf" data-id="${it.id}" title="Open ${esc(it.pdf.name)}" aria-label="Open the lecture PDF">${icon("file", 17)}</button>`
    : `<label class="iconbtn pdf none" title="Attach the lecture PDF">${icon("clip", 17)}<input type="file" ${PDF_ACCEPT} data-change="attachPdf" data-id="${it.id}" aria-label="Attach the lecture PDF" hidden></label>`;
  return `<div class="row item ${lecture ? "" : "is-task"} ${!lecture && it.doneAt ? "done" : ""}" ${cvar(m.color)}>
    <span class="dot"></span>
    <button class="row-main" data-act="edit" data-id="${it.id}">
      <span class="t">${esc(it.title)}</span>
      <span class="sub">${esc(m.name)}${lecture ? "" : " · task"}${it.notes ? " · " + esc(it.notes.slice(0, 60)) : ""} ${recallBadge(recalls[it.id])}</span>
    </button>
    ${pdf}
    ${it.date ? "" : select("week", weekOptions, it.week, `class="mini" data-change="setWeek" data-id="${it.id}" aria-label="Week"`)}
    <input type="date" class="mini ${it.date ? "" : "empty"}" value="${it.date || ""}" data-change="setDate" data-id="${it.id}" aria-label="Date taught">
    ${control}
  </div>`;
}

export function render() {
  const cw = currentWeek();
  const start = D.settings.semesterStart;
  const recalls = Object.fromEntries(pendingRecalls().map(r => [r.id, r]));
  const modOrder = Object.fromEntries(modulesSorted().map((m, i) => [m.id, i]));

  if (view.module !== "all" && !D.modules[view.module]) view.module = "all"; // the module was deleted
  let items = itemsList();
  if (view.module !== "all") items = items.filter(it => it.module === view.module);
  if (view.hideDone) items = items.filter(it => (isLecture(it) ? stateOf(it) !== "recall2" : !it.doneAt));

  // 0 holds the items with no week; "before" the dated ones that fall before week 1
  const byWeek = new Map();
  for (const it of items) {
    const iw = itemWeek(it);
    const w = iw >= 1 ? iw : it.date ? "before" : 0;
    if (!byWeek.has(w)) byWeek.set(w, []);
    byWeek.get(w).push(it);
  }
  if (!byWeek.has(cw) && cw > 0) byWeek.set(cw, []);
  const sortItems = list => list.sort((a, b) =>
    (a.date || "9").localeCompare(b.date || "9") || (modOrder[a.module] ?? 99) - (modOrder[b.module] ?? 99) || (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title));

  const section = (w, list) => {
    const lectures = list.filter(isLecture);
    const started = lectures.filter(l => stateOf(l) !== "todo").length;
    const head = w === 0
      ? `<h3>No week yet</h3><span class="muted">set a date or a week to file these</span>`
      : w === "before"
      ? `<h3>Before week 1</h3><span class="muted">before ${fmtDay(start)}</span>`
      : `<h3>Week ${w}</h3><span class="muted">${weekLabel(w, start)}</span>${w === cw ? '<span class="pill accent">this week</span>' : ""}`;
    return `<section class="card wsec ${w === cw ? "current" : ""}" ${w === cw ? 'id="current-week"' : ""}>
      <div class="card-h">${head}<span class="grow"></span>${lectures.length ? `<span class="muted mono">${started}/${lectures.length} seen</span>` : ""}</div>
      ${list.length ? sortItems(list).map(it => row(it, recalls)).join("") : `<div class="empty small">Nothing filed in this week.</div>`}
    </section>`;
  };

  const weeks = [...byWeek.keys()].filter(w => w >= 1).sort((a, b) => a - b);
  const chips = [["all", "All"], ...modulesSorted().map(m => [m.id, m.name])].map(([id, name]) =>
    `<button class="chip ${view.module === id ? "on" : ""}" data-act="filter" data-module="${id}" ${id === "all" ? "" : cvar(D.modules[id].color)}>${id === "all" ? "" : '<span class="dot"></span>'}${esc(name)}</button>`).join("");

  return `<header class="page-h">
      <div><h1>Courses</h1><p class="muted">Lectures by the week they were taught. Tick each step as you go.</p></div>
      <button class="btn primary" data-act="add">${icon("plus", 16)} Add</button>
    </header>
    <div class="toolbar">${chips}<span class="grow"></span>
      <label class="switch"><input type="checkbox" data-change="hideDone" ${view.hideDone ? "checked" : ""}> Hide finished</label>
      ${weeks.includes(cw) ? `<button class="btn ghost small" data-act="jump">Go to week ${cw}</button>` : ""}
    </div>
    ${byWeek.has(0) ? section(0, byWeek.get(0)) : ""}
    ${byWeek.has("before") ? section("before", byWeek.get("before")) : ""}
    ${weeks.map(w => section(w, byWeek.get(w))).join("")}
    ${items.length ? "" : `<div class="empty">Nothing here yet. Add your first lecture.</div>`}`;
}

function editForm(it) {
  const lecture = isLecture(it);
  const mods = [["", "No module"], ...modulesSorted().map(m => [m.id, m.name])];
  const dates = lecture && it.id ? `<details class="more"><summary>Progress dates</summary>
      <div class="grid2">
        ${field("Seen on", input("seenAt", it.seenAt, 'type="date"'))}
        ${field("Quizzed on", input("quizzedAt", it.quizzedAt, 'type="date"'))}
        ${field("Recall 1 done on", input("recall1At", it.recall1At, 'type="date"'))}
        ${field("Recall 2 done on", input("recall2At", it.recall2At, 'type="date"'))}
      </div>
      ${field("Move the next recall to", input("recallDue", it.recallDue, 'type="date"'), "Leave empty to let Bloom schedule it.")}
    </details>` : "";
  return `
    ${field("Title", input("title", it.title, 'required autofocus placeholder="e.g. Cardiac arrhythmia mechanisms"'))}
    <div class="grid2">
      ${field("Type", select("kind", [["lecture", "Lecture (seen, quiz, recalls)"], ["task", "Task (just done / not done)"]], it.kind || "lecture"))}
      ${field("Module", select("module", mods, it.module))}
      ${field("Date taught", input("date", it.date, 'type="date"'), "The week follows the date.")}
      ${field("Week", input("week", it.week, 'type="number" min="1" max="60" placeholder="if there is no date"'))}
    </div>
    ${field("Notes", `<textarea name="notes" rows="2">${esc(it.notes || "")}</textarea>`)}
    ${lecture ? field("Lecture PDF", `<input type="file" name="pdfFile" ${PDF_ACCEPT}>`,
      it.pdf ? `Attached: ${it.pdf.name} (${fmtSize(it.pdf.size)}). Choosing a file replaces it.` : "One PDF per lecture. Bloom keeps its own copy.") : ""}
    ${lecture && it.pdf ? `<label class="switch"><input type="checkbox" name="pdfRemove"> Remove the attached PDF</label>` : ""}
    ${dates}`;
}

function openEditor(id) {
  const it = id ? D.items[id] : { kind: "lecture", module: view.module === "all" ? modulesSorted()[0]?.id : view.module, title: "" };
  openModal({
    title: id ? "Edit" : "Add to courses",
    body: editForm({ ...it, id }),
    danger: id && { label: "Delete", onClick: async () => {
      if (!await confirmBox("Delete this?", `"${it.title}" and its progress will be removed.`)) return;
      delete D.items[id];
      delete D.notebook[id];
      save(); app.refresh();
      if (it.pdf) removePdf(it.pdf.id);
    } },
    onSubmit: async (v, form) => {
      let pdf = null;
      if (v.pdfFile?.size && v.kind === "lecture") {
        const button = form.querySelector('[type="submit"]');
        button.disabled = true;
        try { pdf = await storePdf(v.pdfFile); }
        catch (e) { toast(e.message, "error"); return false; }
        finally { button.disabled = false; }
      }
      const target = id ? D.items[id] : (D.items[uid()] = { order: Date.now(), seenAt: null, quizzedAt: null, recall1At: null, recall2At: null, recallDue: null, doneAt: null, pdf: null });
      const oldPdf = target.pdf;
      if (pdf) target.pdf = pdf;
      else if (v.pdfRemove) target.pdf = null;
      if (oldPdf && target.pdf !== oldPdf) {
        removePdf(oldPdf.id);
        if (id) delete D.notebook[id]; // its study guide and quiz were written from the old PDF
      }
      Object.assign(target, {
        title: v.title.trim(), kind: v.kind, module: v.module || null,
        date: v.date || null, week: v.week ? Number(v.week) : null, notes: v.notes.trim(),
      });
      if ("seenAt" in v) {
        for (const k of ["seenAt", "quizzedAt", "recall1At", "recall2At", "recallDue"]) target[k] = v[k] || null;
        if (target.recall2At) target.recall1At ??= target.recall2At; // a later step implies the earlier ones
        if (target.recall1At || target.quizzedAt) target.seenAt ??= target.recall1At || target.quizzedAt;
      }
      save(); app.refresh();
    },
  });
}

export const actions = {
  add: () => openEditor(null),
  edit: el => openEditor(el.dataset.id),
  filter: el => { view.module = el.dataset.module; app.refresh(); },
  hideDone: el => { view.hideDone = el.checked; app.refresh(); },
  jump: () => document.getElementById("current-week")?.scrollIntoView({ behavior: "smooth", block: "start" }),
  step: el => {
    const it = D.items[el.dataset.id];
    const before = stateOf(it);
    setStep(it, el.dataset.step, today());
    save(); app.refresh();
    const after = stateOf(it);
    if (after === "seen" && before === "todo") toast(`Recall 1 planned ${relDay(pendingRecalls().find(r => r.id === el.dataset.id)?.due || today())} 🌸`);
    if (after === "recall2" && before !== "recall2") toast("Fully revised. Well done! 🌷");
  },
  toggleItem: el => {
    const it = D.items[el.dataset.id];
    it.doneAt = it.doneAt ? null : today();
    save(); app.refresh();
  },
  attachPdf: async el => {
    const file = el.files[0];
    if (!file) return;
    let pdf;
    try { pdf = await storePdf(file); }
    catch (e) { toast(e.message, "error"); el.value = ""; return; }
    const it = D.items[el.dataset.id];
    if (!it) { removePdf(pdf.id); return; }
    it.pdf = pdf;
    save(); app.refresh();
    toast("PDF attached 📎");
  },
  openPdf: async el => {
    const it = D.items[el.dataset.id];
    try { openViewer(it.title, await pdfUrl(it.pdf.id)); }
    catch { toast("This PDF could not be opened. Attach it again from the lecture.", "error"); }
  },
  setDate: el => {
    const it = D.items[el.dataset.id];
    it.date = el.value || null;
    if (it.date) { const w = weekOf(it.date, D.settings.semesterStart); it.week = w >= 1 ? w : null; }
    save(); app.refresh();
  },
  setWeek: el => {
    D.items[el.dataset.id].week = el.value ? Number(el.value) : null;
    save(); app.refresh();
  },
};
