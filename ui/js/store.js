// The one data object, where it is stored, and the questions every view asks of it.
import { today, weekOf, addDays } from "./dates.js";
import { nextRecall, stateOf } from "./recall.js";
import { seedData } from "./seed.js";
import { migrateQuiz } from "./notebook-core.js";
import { migrateBank } from "./quiz-core.js";

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
  // v2: a lecture can carry one PDF, { id, name, size, addedAt }; the file itself is in files.js
  for (const it of Object.values(data.items)) it.pdf ??= null;
  // v3: a lecture's quiz is a bank of questions, each with its own history (see notebook-core.js)
  for (const nb of Object.values(data.notebook)) {
    if (!nb?.quiz) continue;
    const quiz = migrateQuiz(nb.quiz);
    if (quiz) nb.quiz = quiz;
  }
  // v4: a notebook entry may also carry `cards` (flashcards, see cards-core.js) and `chat` (the Ask
  // tab, see chat-core.js), and D.planner holds the week's plan (see planner-core.js). All are
  // optional and read with defaults, so there is nothing to convert.
  // v5: quizzes span one or more lectures and bring questions back after a few quizzes (see
  // quiz-core.js): each bank counts its `quizzes`, each question its `streak` and `lastQuiz`, and
  // D.quizLog keeps the last finished quizzes. Existing questions and scores are all kept.
  for (const nb of Object.values(data.notebook)) if (nb?.quiz) migrateBank(nb.quiz);
  if (!Array.isArray(data.quizLog)) data.quizLog = [];
  // v6: every quiz is kept in D.quizLog (no longer only the last 20), each with `by`, its score per
  // lecture ({ lectureId: [score, total] }; absent on older entries); every flashcard session is
  // kept in D.cardLog as { date, lecture, seen, knew }; D.fiches holds the study sheets Claude
  // writes (shape at the top of ui/js/fiches-core.js). Nothing to convert.
  if (!Array.isArray(data.cardLog)) data.cardLog = [];
  data.fiches ??= {};
  // v7: D.slideNotes holds her notes per slide, by quiz source (a lecture id or "fiche:<id>", see
  // ui/js/sources.js) then PDF page: { [src]: { [page]: { text, at: "YYYY-MM-DD" } } }. Questions
  // and flashcards may carry `themes` (keys of THEMES in ui/js/themes-core.js); absent means not
  // yet classified. Nothing to convert.
  data.slideNotes ??= {};
  // v8: D.pdfMarks holds her annotations drawn on PDFs (highlights, pen strokes, text boxes), by
  // quiz source then PDF page like D.slideNotes: { [src]: { [page]: [mark] } }; mark shape at the
  // top of ui/js/marks-core.js. Nothing to convert.
  data.pdfMarks ??= {};
  data.version = 8;
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
