// The one data object, where it is stored, and the questions every view asks of it.
import { today, weekOf, addDays } from "./dates.js";
import { nextRecall, stateOf } from "./recall.js";
import { seedData } from "./seed.js";

const KEY = "bloom_data";
const tauri = window.__TAURI__;
export const inApp = Boolean(tauri);

/** The live data. Views read it directly and call save() after changing it. */
export let D = null;

async function read() {
  return tauri ? tauri.core.invoke("load_data") : localStorage.getItem(KEY);
}
async function write(text) {
  if (tauri) await tauri.core.invoke("save_data", { text, day: today() });
  else localStorage.setItem(KEY, text);
}

/** Brings data written by an older version up to the current shape. Never drops fields. */
function migrate(data) {
  const fresh = seedData();
  data.settings = { ...fresh.settings, ...data.settings };
  for (const key of ["modules", "items", "deadlines", "planner", "notebook"]) data[key] ??= {};
  data.todo ??= {};
  data.todo.projects ??= {};
  data.todo.tasks ??= {};
  data.version = 1;
  return data;
}

/** Loads the data. A file that exists but cannot be read is an error: it is never overwritten. */
export async function load() {
  const text = await read();
  D = text ? migrate(JSON.parse(text)) : seedData();
  if (!text) await save();
}

let saving = false, dirty = false;
const listeners = [];
export const onSaveError = fn => listeners.push(fn);

/** Writes the data. Calls made while a write is running are folded into one more write. */
export async function save() {
  if (saving) { dirty = true; return; }
  saving = true;
  try {
    do {
      dirty = false;
      await write(JSON.stringify(D));
    } while (dirty);
  } catch (e) {
    listeners.forEach(fn => fn(e));
  } finally {
    saving = false;
  }
}

export function replaceAll(data) {
  D = migrate(data);
  return save();
}

export async function exportBackup() {
  const text = JSON.stringify(D, null, 1);
  if (tauri) return tauri.core.invoke("export_data", { text, day: today() });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = `Bloom-backup-${today()}.json`;
  a.click();
  return a.download;
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---- questions about the data

export const currentWeek = () => weekOf(today(), D.settings.semesterStart);

/** The week an item belongs to: from its date when it has one, otherwise the week set by hand. */
export const itemWeek = it => (it.date ? weekOf(it.date, D.settings.semesterStart) : it.week);

export const isLecture = it => it.kind !== "task";
export const isDone = it => (isLecture(it) ? stateOf(it) !== "todo" : Boolean(it.doneAt));

export const modulesSorted = () =>
  Object.entries(D.modules).map(([id, m]) => ({ id, ...m })).sort((a, b) => a.order - b.order);

export const moduleOf = it => D.modules[it.module] || { name: "No module", color: "plum", exam: null };

export const itemsList = () => Object.entries(D.items).map(([id, it]) => ({ id, ...it }));

/** Every recall currently waiting, soonest first: [{ id, item, n, due, adapted, manual, latest }] */
export function pendingRecalls() {
  const now = today();
  const out = [];
  for (const [id, it] of Object.entries(D.items)) {
    if (!isLecture(it)) continue;
    const exam = moduleOf(it).exam;
    const r = nextRecall(it, exam, D.settings, now);
    if (r) out.push({ id, item: it, ...r, latest: exam && exam > now ? addDays(exam, -1) : null });
  }
  return out.sort((a, b) => a.due.localeCompare(b.due));
}

export const deadlinesList = () =>
  Object.entries(D.deadlines).map(([id, d]) => ({ id, ...d })).sort((a, b) => a.due.localeCompare(b.due));

export const tasksList = () => Object.entries(D.todo.tasks).map(([id, t]) => ({ id, ...t }));
