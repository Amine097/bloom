// A generated fiche's folder and its Claude Code run. In the app the native shell does the work
// (fiche_* commands in src-tauri/src/lib.rs: the folder is fiches/<id>/ beside the data file); in the
// browser preview, scripts/preview.mjs does the same under /api/fiche/*. Claude writes its files
// there (chapters, front.html, progress.json); Bloom only reads them back. Also ficheText(), the
// text of any fiche page by page, for features that ask Claude about a fiche.
import { D } from "./store.js";
import { pdfBlob } from "./files.js";
import { asPageText } from "./fiches-core.js";

const tauri = window.__TAURI__;
const NO_SERVER = "Could not reach the preview server. Is `npm run preview` still running?";

function failure(e) {
  const text = typeof e === "string" ? e : e?.message || String(e);
  if (text === "no-claude") return Object.assign(new Error("Claude is not installed on this Mac. Set it up in Settings."), { code: "no-claude" });
  return new Error(text);
}

async function native(cmd, args, opts) {
  try { return await tauri.core.invoke(cmd, args, opts); } catch (e) { throw failure(e); }
}

async function api(path, { method = "GET", body, headers = {}, raw = false } = {}) {
  let res;
  try { res = await fetch(`/api/fiche/${path}`, { method, body, headers: { "X-Bloom-Ask": "1", ...headers } }); }
  catch { throw new Error(NO_SERVER); }
  if (raw) return res;
  const reply = await res.json().catch(() => ({}));
  if (!res.ok) throw failure(reply.error || `HTTP ${res.status}`);
  return reply;
}
const q = o => new URLSearchParams(o).toString();

/**
 * Makes the fiche's folder and copies the lectures' PDFs into it, with their text (slides/KEY.pdf,
 * slides/KEY.txt). `lectures` is [{ key, pdfId }]. → { KEY: page count (0 when unknown) }.
 */
export async function prepareFiche(id, lectures) {
  if (tauri) return native("fiche_prepare", { id, lectures: lectures.map(l => ({ key: l.key, pdf: l.pdfId })) });
  const out = {};
  for (const l of lectures) {
    let blob;
    try { blob = await pdfBlob(l.pdfId); } catch { throw new Error("A lecture PDF is missing. Attach it again from Courses."); }
    const r = await api(`prepare?${q({ id, key: l.key })}`, { method: "POST", body: blob, headers: { "Content-Type": "application/pdf" } });
    out[l.key] = r.pages || 0;
  }
  return out;
}

/** Starts Claude on `prompt` in the fiche's folder, in the background. Throws when it cannot start. */
export const startRun = (id, prompt) => (tauri ? native("fiche_start", { id, prompt })
  : api(`start?${q({ id })}`, { method: "POST", body: prompt, headers: { "Content-Type": "text/plain; charset=utf-8" } }));

/** { running, result, error }: result is Claude's final text once a run ended well; error its failure
 *  ("cancelled" after cancelRun). All null/false when no run is known (e.g. after Bloom restarted). */
export async function runStatus(id) {
  const s = tauri ? await native("fiche_status", { id }) : await api(`status?${q({ id })}`);
  return { running: Boolean(s?.running), result: typeof s?.result === "string" ? s.result : null, error: typeof s?.error === "string" ? s.error : null };
}

export const cancelRun = id => (tauri ? native("fiche_cancel", { id }) : api(`cancel?${q({ id })}`, { method: "POST" }));

/** A file Claude wrote in the folder, as text; null when it does not exist (yet). */
export async function readFicheFile(id, name) {
  if (tauri) return native("fiche_read", { id, name });
  const res = await api(`file?${q({ id, name })}`, { raw: true });
  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) throw new Error(`Could not read ${name} (HTTP ${res.status}).`);
  return res.text();
}

/** The names of the files at the top of the folder. */
export async function listFicheFiles(id) {
  const r = tauri ? await native("fiche_files", { id }) : (await api(`files?${q({ id })}`)).files;
  return Array.isArray(r) ? r : [];
}

/** The image of page `page` of lecture `key`'s PDF in the folder, as a Blob; null when it cannot be made. */
export async function slideImage(id, key, page) {
  try {
    if (tauri) {
      const bytes = await tauri.core.invoke("fiche_slide", { id, key, page });
      return new Blob([bytes], { type: "image/png" });
    }
    const res = await api(`slide?${q({ id, key, page })}`, { raw: true });
    return res.ok ? await res.blob() : null;
  } catch {
    return null;
  }
}

/** Removes the fiche's folder and everything in it. Never fails. */
export async function deleteFicheFiles(id) {
  try {
    if (tauri) await tauri.core.invoke("fiche_delete", { id });
    else await api(`delete?${q({ id })}`, { method: "POST" });
  } catch { /* a folder left behind is harmless */ }
}

/** The print dialog for the page on screen (WKWebView needs the native shell for it). */
export async function printPage() {
  if (tauri) await native("print_page");
  else window.print();
}

/** The text of a PDF stored by files.js, page by page (pdf_text in the shell, /api/pdf-text here); "" when it cannot be had. */
async function storedPdfText(pdfId) {
  try {
    if (tauri) return String(await tauri.core.invoke("pdf_text", { id: pdfId }) || "");
    const res = await fetch("/api/pdf-text", { method: "POST", headers: { "Content-Type": "application/pdf", "X-Bloom-Ask": "1" }, body: await pdfBlob(pdfId) });
    return res.ok ? String((await res.json()).text || "") : "";
  } catch {
    return "";
  }
}

/**
 * The text of fiche `id`, page by page, in the "--- Page n ---" form of pdf_text: an uploaded fiche's
 * PDF text; a generated one laid out in A4 pages exactly as she sees it, one entry per page.
 * "" when there is nothing to read (not written yet, file missing).
 */
export async function ficheText(id) {
  const f = D.fiches?.[id];
  if (!f) return "";
  if (f.source === "uploaded") return f.pdf ? storedPdfText(f.pdf.id) : "";
  try {
    const { renderFiche } = await import("./fiche-render.js");
    const book = await renderFiche(id);
    const pages = book.pages.map(p => p.innerText.replace(/[ \t]+\n/g, "\n").trim());
    book.dispose();
    return asPageText(pages);
  } catch {
    return "";
  }
}
