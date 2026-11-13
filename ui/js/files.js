// Lecture PDFs. The file itself is kept beside the data file (pdfs/<id>.pdf) in the app, or in
// IndexedDB in a browser. The data object only carries { id, name, size, addedAt } on the lecture.
// Slides (PowerPoint, Keynote) are turned into a PDF first: by Keynote in the app (convert_to_pdf
// in the native shell), by POST /api/convert of scripts/preview.mjs in the browser preview.
import { uid } from "./store.js";
import { today } from "./dates.js";

const tauri = window.__TAURI__;
const MAX_BYTES = 150 * 1024 * 1024;

function idb(mode, run) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("bloom_files", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("pdfs");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const req = run(open.result.transaction("pdfs", mode).objectStore("pdfs"));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}

/** Slides Bloom can turn into a PDF. */
export const SLIDES = /\.(pptx?|key)$/i;
/** The `accept` of every file input that takes a lecture's slides. */
export const FILE_ACCEPT = 'accept="application/pdf,.pdf,.ppt,.pptx,.key"';

/** The file as a PDF: a PDF as it is, slides converted. Throws a message she can read. */
async function asPdf(file) {
  const kind = file.name.match(SLIDES);
  if (!kind) return file;
  if (file.size > MAX_BYTES) throw new Error("Those slides are too large (150 MB at most).");
  const ext = kind[1].toLowerCase();
  const bytes = new Uint8Array(await file.arrayBuffer());
  let pdf;
  try {
    if (tauri) pdf = await tauri.core.invoke("convert_to_pdf", bytes, { headers: { "x-file-ext": ext } });
    else {
      const res = await fetch(`/api/convert?ext=${ext}`, { method: "POST", body: bytes, headers: { "x-bloom-ask": "1" } });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `The slides could not be turned into a PDF (${res.status}).`);
      pdf = await res.arrayBuffer();
    }
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e?.message || String(e));
  }
  return new File([pdf], file.name.replace(SLIDES, ".pdf"), { type: "application/pdf" });
}

/**
 * Copies a chosen file into Bloom (slides become a PDF first) and returns the record to put on
 * the lecture. Throws a message she can read.
 */
export async function storePdf(file) {
  file = await asPdf(file);
  if (file.size > MAX_BYTES) throw new Error("That PDF is too large (150 MB at most).");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const head = String.fromCharCode(...bytes.subarray(0, 1024));
  if (!head.includes("%PDF-")) throw new Error("That file is not a PDF.");
  const id = uid();
  try {
    if (tauri) await tauri.core.invoke("save_pdf", bytes, { headers: { "x-pdf-id": id } });
    else await idb("readwrite", s => s.put(new Blob([bytes], { type: "application/pdf" }), id));
  } catch (e) {
    throw new Error("Could not store the PDF: " + (e?.message || e));
  }
  return { id, name: file.name, size: file.size, addedAt: today() };
}

/** The PDF itself, as a Blob. Throws when the file is gone. */
export async function pdfBlob(id) {
  const data = tauri ? await tauri.core.invoke("read_pdf", { id }) : await idb("readonly", s => s.get(id));
  if (!data) throw new Error("missing file");
  return data instanceof Blob ? data : new Blob([data], { type: "application/pdf" });
}

/** A URL the viewer can show. The caller hands it to openViewer, which releases it on close. */
export async function pdfUrl(id) {
  return URL.createObjectURL(await pdfBlob(id));
}

export async function removePdf(id) {
  try {
    if (tauri) await tauri.core.invoke("delete_pdf", { id });
    else await idb("readwrite", s => s.delete(id));
  } catch { /* a file left behind is harmless */ }
}

export const fmtSize = n => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
