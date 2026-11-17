// The Notebook's background jobs: the one place that asks the assistant about a lecture PDF.
// Every tab (study guide, quiz, flashcards, questions) starts its work through runJob().
import { D, save } from "../store.js";
import { app, toast, esc, icon } from "../ui.js";
import { askAboutPdf, askAssistant, assistantStatus } from "../assistant.js";
import { ficheText } from "../fiche-run.js";
import { pagesOf } from "../pdftext-core.js";
import { ficheWindow, ficheQuizPrompt } from "../fiches-core.js";
import { srcFiche, ficheIdOf } from "../sources.js";
import { extractJson } from "../notebook-core.js";
import {
  THEMES, THEME_KEYS, DEFAULT_THEMES, themeOf, isClassified, unclassified, classifyPrompt, readClassification, questionText, cardText,
} from "../themes-core.js";

/** "<lectureId>:<kind>" → { schemas } while the assistant is working on it. */
const running = new Map();
/**
 * null, or why no assistant can be used yet: "missing" (neither Claude nor Codex is installed) or
 * "signedout" (at least one is installed, none is signed in).
 */
let setup = null;

export const isRunning = (id, kind) => running.has(`${id}:${kind}`);
/** Whether the job running for lecture `id` and `kind` reads every diagram ("With schemas"). */
export const isRunningWithSchemas = (id, kind) => Boolean(running.get(`${id}:${kind}`)?.schemas);

// ---- "Standard | With schemas": how the study guide, quiz questions and flashcards are made

/** Her choice, remembered in D.settings.schemas (absent = Standard, so no migration is needed). */
export const withSchemas = () => D.settings?.schemas === true;
export function setSchemas(on) {
  D.settings.schemas = Boolean(on);
  save();
}

/**
 * The "Standard | With schemas" control, shown wherever she starts a generation; the action
 * "nbSchemas" (notebook.js) sets it. `hint`: the one line under it saying what the choice does.
 */
export function schemasToggle({ hint = true } = {}) {
  const on = withSchemas();
  const seg = (value, label) => `<button type="button" class="nb-seg-b ${on === value ? "on" : ""}" data-act="nbSchemas" data-on="${value ? 1 : 0}" aria-pressed="${on === value}">${label}</button>`;
  const line = on ? "Slower, reads every diagram" : "Reads the text, glances at a figure when needed";
  return `<span class="nb-schemas">
      <span class="nb-seg" role="group" aria-label="How the slides are read" title="${line}">${seg(false, "Standard")}${seg(true, "With schemas")}</span>
      ${hint ? `<small class="nb-seg-hint">${line}</small>` : ""}
    </span>`;
}

// ---- themes: what she is tested on (themes-core.js), shared by the quiz and the flashcards

/** The ticked themes. View state, never saved: the defaults come back each time Bloom starts. */
const themesOn = new Set(DEFAULT_THEMES);
/** The ticked theme keys, in THEMES order. */
export const checkedThemes = () => THEME_KEYS.filter(k => themesOn.has(k));
/** Ticks or unticks theme `key`. The last ticked theme cannot be unticked: → false then. */
export function toggleTheme(key) {
  if (!themeOf(key)) return false;
  if (themesOn.has(key)) {
    if (themesOn.size === 1) return false;
    themesOn.delete(key);
  } else themesOn.add(key);
  return true;
}

/** The row of theme chips, wherever she generates or starts a quiz or a review; the action "nbTheme" (notebook.js) toggles one. */
export function themeChips() {
  const chip = t => {
    const on = themesOn.has(t.key);
    return `<button type="button" class="nb-theme-b ${on ? "on" : ""}" data-act="nbTheme" data-theme="${t.key}" aria-pressed="${on}" title="${esc(`${t.label}: ${t.about}`)}">${on ? icon("check", 13) : ""}${esc(t.short)}</button>`;
  };
  return `<span class="nb-themes" role="group" aria-label="Themes to be tested on">${THEMES.map(chip).join("")}</span>`;
}

/** A question's or a card's themes as small tags ("" when it has none yet). */
export const themeTags = x => (isClassified(x)
  ? `<span class="nb-tags">${x.themes.map(themeOf).filter(Boolean).map(t => `<span class="nb-tag" title="${esc(t.label)}">${esc(t.short)}</span>`).join("")}</span>` : "");

/**
 * Has the assistant sort by theme the items of source `src` that have none yet, in one quick run,
 * text only (themes-core.js). `items()` returns the bank's questions or the deck's cards as they are
 * now; `what` is "question" or "card". Resolves true when it worked or there was nothing to sort;
 * on failure (a toast says so) the items stay unsorted, count as matching every theme, and the next
 * use tries again.
 */
export async function sortByTheme(src, what, items) {
  const todo = unclassified(items());
  if (!todo.length) return true;
  const prompt = classifyPrompt(todo.map(x => ({ id: x.id, text: what === "card" ? cardText(x) : questionText(x) })), what);
  return track(`${src}:themes-${what}`, false, async () => {
    let got;
    try {
      got = readClassification(extractJson(await askAssistant(prompt)), todo.map(x => x.id));
    } catch (e) {
      if (e?.code) throw e;
      throw new Error(`Bloom could not sort your ${what}s by theme this time (${e?.message || e}). It tries again next time.`);
    }
    for (const x of items()) if (!isClassified(x) && got.has(x.id)) x.themes = got.get(x.id);
    return "";
  });
}
export const isSorting = (src, what) => running.has(`${src}:themes-${what}`);

/** How long a generation takes, for the waiting messages. */
export const takesAbout = schemas => (schemas ? "This takes several minutes: Claude reads every slide, diagrams included." : "This usually takes a minute or two.");
/** null, "missing" or "signedout": the Notebook shows a card that sends her to Settings. */
export const setupNeeded = () => setup;
export const refreshIfHere = () => { if (document.getElementById("main")?.dataset.view === "notebook") app.refresh(); };

/**
 * Runs one job in the background under `key` ("<source>:<kind>"): checks the assistant is set up,
 * then `work()`, which asks it and stores the answer (returning the toast's message, or false when
 * the answer no longer applies). Saves after it. Errors are shown as toasts. → true when stored.
 */
async function track(key, schemas, work) {
  if (running.has(key)) return false;
  running.set(key, { schemas });
  refreshIfHere();
  try {
    // do not start when the assistant is not set up; a failed check does not block (the run reports its own errors)
    const s = await assistantStatus().catch(() => null);
    if (s && !s.loggedIn) {
      setup = s.installed ? "signedout" : "missing";
      return false;
    }
    if (s) setup = null;
    const msg = await work();
    setup = null;
    if (msg === false) return false;
    save();
    if (msg) toast(msg);
    return true;
  } catch (e) {
    if (e?.code === "no-claude" || e?.code === "no-codex") {
      setup = "missing";
      toast(e.code === "no-codex" ? "Codex is not installed on this Mac." : "No assistant (Claude or Codex) is installed on this Mac.", "error");
    } else toast(e?.message || String(e), "error");
    return false;
  } finally {
    running.delete(key);
    refreshIfHere();
  }
}

/**
 * Asks the assistant `prompt` (holding the {{PDF}} token) about the PDF of lecture `id`, in the
 * background: she can change tab or view meanwhile. One job per lecture and `kind` at a time.
 * `done(text, lecture)` receives the answer; it checks it, puts it in D and returns the message
 * for the toast (or nothing). The data is saved after it. An error it throws is shown as a toast.
 * `done` is not called when the lecture or its PDF changed while the assistant was working.
 * `schemas`: the prompt was written "With schemas"; the assistant then looks at every page.
 * Returns true when `done` ran without error.
 */
export async function runJob(id, kind, prompt, done, { schemas = false } = {}) {
  const it = D.items[id];
  if (!it?.pdf) return false;
  const pdfId = it.pdf.id;
  return track(`${id}:${kind}`, schemas, async () => {
    const text = await askAboutPdf(pdfId, prompt, { schemas });
    const now = D.items[id];
    if (!now || now.pdf?.id !== pdfId) return false;
    return (await done(text, now)) ?? "";
  });
}

/**
 * runJob for a fiche (source "fiche:<id>"): `prompt` is a Notebook quiz prompt. The fiche's text
 * replaces its PDF, one window of pages at a time (ficheWindow); the next run takes the pages after
 * them (the bank's `cursor`). An uploaded fiche whose text cannot be extracted (a scanned PDF) is
 * read by the assistant itself, like a lecture. `done(text, fiche)` as in runJob.
 */
export async function runFicheJob(src, kind, prompt, done) {
  const f = srcFiche(src);
  if (!f) return false;
  return track(`${src}:${kind}`, false, async () => {
    const pages = pagesOf(await ficheText(ficheIdOf(src))).filter(p => p.text.trim());
    const chars = pages.reduce((n, p) => n + p.text.length, 0);
    let text, win = null;
    if (chars >= 300) {
      win = ficheWindow(pages, f.quiz?.cursor || 1);
      const part = pages.filter(p => p.n >= win.from && p.n <= win.to);
      text = await askAssistant(ficheQuizPrompt(prompt, f.title, part, pages.at(-1).n));
    } else if (f.source === "uploaded" && f.pdf) {
      text = await askAboutPdf(f.pdf.id, prompt);
    } else {
      throw new Error(`"${f.title}" has no text Bloom can read yet.`);
    }
    const now = srcFiche(src);
    if (!now) return false;
    const msg = await done(text, now);
    if (win && now.quiz) now.quiz.cursor = win.next;
    return msg ?? "";
  });
}
