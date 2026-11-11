// Settings: semester, recall timings, modules and exam dates, backups, updates.
import { D, save, uid, modulesSorted, itemsList, exportBackup, replaceAll } from "../store.js";
import { fmtWday, relDay, parse } from "../dates.js";
import { esc, icon, app, openModal, confirmBox, field, input, cvar, toast, COLORS } from "../ui.js";

export function render() {
  const s = D.settings;
  const items = itemsList();
  const mods = modulesSorted().map(m => {
    const n = items.filter(it => it.module === m.id).length;
    return `<div class="row" ${cvar(m.color)}>
      <span class="dot big"></span>
      <button class="row-main" data-act="editModule" data-id="${m.id}">
        <span class="t">${esc(m.name)}</span>
        <span class="sub">${n} item${n === 1 ? "" : "s"}${m.exam ? ` · exam ${fmtWday(m.exam)} (${relDay(m.exam)})` : ""}</span>
      </button>
      <span class="inline">Exam</span>
      <input type="date" class="mini ${m.exam ? "" : "empty"}" value="${m.exam || ""}" data-change="setExam" data-id="${m.id}" aria-label="Exam date for ${esc(m.name)}">
    </div>`;
  }).join("");

  return `<header class="page-h"><div><h1>Settings</h1></div></header>
    <div class="grid">
      <div class="col">
        <section class="card"><div class="card-h"><h3>You</h3></div>
          <div class="card-b">
            ${field("Your name", input("name", s.name, 'data-change="setText" placeholder="Shown on the dashboard"'))}
            ${field("Appearance", `<select data-change="setText" name="theme">${[["auto", "Follow the Mac"], ["light", "Light"], ["dark", "Dark"]].map(([v, l]) => `<option value="${v}" ${s.theme === v ? "selected" : ""}>${l}</option>`).join("")}</select>`)}
          </div>
        </section>
        <section class="card"><div class="card-h"><h3>Semester and recalls</h3></div>
          <div class="card-b">
            ${field("Week 1 starts on", input("semesterStart", s.semesterStart, 'type="date" data-change="setStart"'), "Use the Monday of the first study week.")}
            <div class="grid3">
              ${field("Recall 1 after", input("recall1", s.recall1, 'type="number" min="1" max="60" data-change="setNumber"'), "days after seen")}
              ${field("Recall 2 after", input("recall2", s.recall2, 'type="number" min="1" max="120" data-change="setNumber"'), "days after recall 1")}
              ${field("At most", input("maxRecallsPerDay", s.maxRecallsPerDay, 'type="number" min="1" max="30" data-change="setNumber"'), "recalls a day")}
            </div>
            <p class="muted small">When a module has an exam date, its recalls are brought forward so the last one falls before the exam.</p>
          </div>
        </section>
        <section class="card"><div class="card-h"><h3>Assistant</h3><span class="grow"></span><span class="pill">not set up</span></div>
          <div class="card-b"><p class="muted">The Planner and the Notebook will use your own Claude account. Nothing to do here yet.</p></div>
        </section>
      </div>
      <div class="col">
        <section class="card"><div class="card-h"><h3>Modules and exams</h3><span class="grow"></span><button class="btn ghost small" data-act="addModule">${icon("plus", 15)} Module</button></div>
          ${mods || `<div class="empty small">No modules yet.</div>`}
        </section>
        <section class="card"><div class="card-h"><h3>Your data</h3></div>
          <div class="card-b">
            <p class="muted">Everything stays on this Mac. Bloom keeps a backup for each of the last 14 days it was used, and updates never touch your data.</p>
            <div class="btns">
              <button class="btn soft" data-act="export">Save a backup copy</button>
              <label class="btn ghost">Restore from a backup<input type="file" accept=".json,application/json" data-change="import" hidden></label>
            </div>
          </div>
        </section>
        <section class="card"><div class="card-h"><h3>About</h3></div>
          <div class="card-b">
            <p>Bloom <span class="mono" id="version">${esc(app.version || "preview")}</span></p>
            <div class="btns"><button class="btn soft" data-act="checkUpdate">Check for updates</button></div>
          </div>
        </section>
      </div>
    </div>`;
}

function openModule(id) {
  const m = id ? D.modules[id] : { name: "", color: COLORS[modulesSorted().length % COLORS.length], exam: null };
  openModal({
    title: id ? "Edit module" : "New module",
    body: `${field("Name", input("name", m.name, 'required autofocus placeholder="e.g. Immunology"'))}
      ${field("Colour", `<div class="swatches">${COLORS.map(c => `<label ${cvar(c)}><input type="radio" name="color" value="${c}" ${m.color === c ? "checked" : ""}><span></span></label>`).join("")}</div>`)}
      ${field("Exam date", input("exam", m.exam, 'type="date"'), "Optional. Recalls adapt to it.")}`,
    danger: id && { label: "Delete module", onClick: async () => {
      const n = Object.values(D.items).filter(it => it.module === id).length;
      if (!await confirmBox("Delete this module?", n ? `Its ${n} item${n > 1 ? "s" : ""} will be kept, without a module.` : `"${m.name}" will be removed.`)) return;
      for (const it of Object.values(D.items)) if (it.module === id) it.module = null;
      for (const d of Object.values(D.deadlines)) if (d.module === id) d.module = null;
      delete D.modules[id];
      save(); app.refresh();
    } },
    onSubmit: v => {
      const fields = { name: v.name.trim(), color: v.color, exam: v.exam || null };
      if (id) Object.assign(D.modules[id], fields);
      else D.modules[uid()] = { ...fields, order: Date.now() };
      save(); app.refresh();
    },
  });
}

export const actions = {
  addModule: () => openModule(null),
  editModule: el => openModule(el.dataset.id),
  checkUpdate: () => app.checkUpdate(true),

  setText: el => { D.settings[el.name] = el.value.trim(); save(); app.refresh(); },
  setNumber: el => {
    const n = Math.round(Number(el.value));
    if (n >= Number(el.min) && n <= Number(el.max)) D.settings[el.name] = n;
    save(); app.refresh();
  },
  setStart: el => {
    if (!el.value) return;
    D.settings.semesterStart = el.value;
    save(); app.refresh();
    if (parse(el.value).getDay() !== 1) toast("That day is not a Monday, so weeks will not start on Mondays.");
  },
  setExam: el => { D.modules[el.dataset.id].exam = el.value || null; save(); app.refresh(); },

  export: async () => {
    try { toast(`Backup saved: ${await exportBackup()}`); }
    catch (e) { toast("Could not save the backup: " + e, "error"); }
  },
  import: async el => {
    const file = el.files[0];
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
      if (!data || typeof data !== "object" || !data.items || !data.settings) throw new Error("not a Bloom backup");
    } catch (e) { toast("That file is not a Bloom backup.", "error"); return; }
    if (!await confirmBox("Restore this backup?", "Everything currently in Bloom will be replaced by the contents of this file.", "Restore")) return;
    await replaceAll(data);
    app.refresh();
    toast("Backup restored");
  },
};
