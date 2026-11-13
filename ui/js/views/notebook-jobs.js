// The Notebook's background jobs: the one place that asks the assistant about a lecture PDF.
// Every tab (study guide, quiz, flashcards, questions) starts its work through runJob().
import { D, save } from "../store.js";
import { app, toast } from "../ui.js";
import { askAboutPdf, assistantStatus } from "../assistant.js";

/** "<lectureId>:<kind>" while the assistant is working on it. */
const running = new Set();
/** null, or why the assistant cannot be used yet: "missing" (not installed) or "signedout". */
let setup = null;

export const isRunning = (id, kind) => running.has(`${id}:${kind}`);
/** null, "missing" or "signedout": the Notebook shows a card that sends her to Settings. */
export const setupNeeded = () => setup;
export const refreshIfHere = () => { if (document.getElementById("main")?.dataset.view === "notebook") app.refresh(); };

/**
 * Asks the assistant `prompt` (holding the {{PDF}} token) about the PDF of lecture `id`, in the
 * background: she can change tab or view meanwhile. One job per lecture and `kind` at a time.
 * `done(text, lecture)` receives the answer; it checks it, puts it in D and returns the message
 * for the toast (or nothing). The data is saved after it. An error it throws is shown as a toast.
 * `done` is not called when the lecture or its PDF changed while the assistant was working.
 * Returns true when `done` ran without error.
 */
export async function runJob(id, kind, prompt, done) {
  const key = `${id}:${kind}`;
  const it = D.items[id];
  if (running.has(key) || !it?.pdf) return false;
  const pdfId = it.pdf.id;
  running.add(key);
  refreshIfHere();
  try {
    // do not start when the assistant is not set up; a failed check does not block (the run reports its own errors)
    const s = await assistantStatus().catch(() => null);
    if (s && !s.loggedIn) {
      setup = s.installed ? "signedout" : "missing";
      return false;
    }
    if (s) setup = null;
    const text = await askAboutPdf(pdfId, prompt);
    setup = null;
    const now = D.items[id];
    if (!now || now.pdf?.id !== pdfId) return false;
    const msg = await done(text, now);
    save();
    if (msg) toast(msg);
    return true;
  } catch (e) {
    if (e?.code === "no-claude") {
      setup = "missing";
      toast("Claude Code is not installed on this Mac.", "error");
    } else toast(e?.message || String(e), "error");
    return false;
  } finally {
    running.delete(key);
    refreshIfHere();
  }
}
