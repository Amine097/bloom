// A copy of a lecture's (or fiche's) PDF with her work in it: the marks of D.pdfMarks burned into the
// pages, each note of D.slideNotes as a sticky note on its page (a PDF text annotation, shown by
// Preview) and a "My notes" list at the end. Saved to Downloads in the app (save_download in the
// native shell), downloaded in a browser. Used by "Export annotated PDF" in the viewer and before a
// PDF is replaced (confirmReplace), which then forgets the old notes and marks (forgetAnnotations).
// pdf-lib, fontkit and the fonts load the first time she exports. Text is written in Fira Sans, with
// DejaVu Sans for the symbols Fira lacks (both cut and wrapped as scripts in ui/vendor/pdf-lib/fonts:
// the app's CSP lets scripts load but not fetch); Helvetica only if those cannot load.
import { D } from "./store.js";
import { openModal, toast, esc } from "./ui.js";
import { pdfBlob } from "./files.js";
import { isFicheSrc, srcFiche } from "./sources.js";
import { notesOf, noteCount } from "./slidenotes-core.js";
import * as M from "./marks-core.js";

const tauri = window.__TAURI__;
const NOTE_RGB = [0.91, 0.35, 0.55];    // the sticky notes, Bloom's pink
const INK = [0.17, 0.13, 0.19], MUTED = [0.45, 0.38, 0.45], ACCENT = [0.79, 0.23, 0.44];

let lib = null, kit = null;
async function pdfLib() {
  // UMD files: run as modules they set globalThis.PDFLib and globalThis.fontkit
  if (!lib) { await import("../vendor/pdf-lib/pdf-lib.min.js"); lib = globalThis.PDFLib; }
  return lib;
}
async function fontkit() {
  if (!kit) { await import("../vendor/pdf-lib/fontkit.umd.min.js"); kit = globalThis.fontkit; }
  return kit;
}
const bytesOf = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

// ---- what a source has

/** The PDF record ({ id, name, … }) of a source, or null. */
export const pdfOf = src => (isFicheSrc(src) ? srcFiche(src)?.pdf : D.items?.[src]?.pdf) || null;
const titleOf = src => (isFicheSrc(src) ? srcFiche(src)?.title : D.items?.[src]?.title) || "";
const word = src => (isFicheSrc(src) ? "Page" : "Slide");

/** How many notes and marks a source has: { notes, marks }. */
export function annotationCounts(src) {
  const pages = Object.values(M.marksOf(D.pdfMarks, src));
  return { notes: noteCount(D.slideNotes, src), marks: pages.reduce((n, list) => n + list.length, 0) };
}

/** Deletes the notes and marks of a source: its PDF was replaced or removed. */
export function forgetAnnotations(src) {
  delete D.slideNotes?.[src];
  delete D.pdfMarks?.[src];
}

// ---- the export

/** The fonts for her text: { draw(page, text, opts), width(text, size), clean(text) }. */
async function textFonts(L, doc, texts) {
  try {
    const [fk, fira] = await Promise.all([fontkit(), import("../vendor/pdf-lib/fonts/fira-sans-regular.js")]);
    doc.registerFontkit(fk);
    const main = await doc.embedFont(bytesOf(fira.default), { subset: true });
    const inMain = new Set(main.getCharacterSet());
    let fallback = null, inFallback = new Set();
    if ([...texts.join("")].some(c => !/\s/.test(c) && !inMain.has(c.codePointAt(0)))) {
      const dejavu = await import("../vendor/pdf-lib/fonts/dejavu-sans-symbols.js");
      fallback = await doc.embedFont(bytesOf(dejavu.default), { subset: true });
      inFallback = new Set(fallback.getCharacterSet());
    }
    const hasMain = n => inMain.has(n), hasFallback = n => inFallback.has(n);
    const fontOf = run => (run.font === "fallback" ? fallback : main);
    const runWidth = (run, size) => fontOf(run).widthOfTextAtSize(run.text, size);
    return {
      clean: text => text, // fontRuns sorts each character when drawing
      width: (text, size) => M.fontRuns(text, hasMain, hasFallback).reduce((w, r) => w + runWidth(r, size), 0),
      draw(page, text, { x, y, size, rotate = 0, color }) {
        for (const r of M.placeRuns(x, y, rotate, M.fontRuns(text, hasMain, hasFallback), run => runWidth(run, size)))
          page.drawText(r.text, { x: r.x, y: r.y, size, font: fontOf(r), color: L.rgb(...color), rotate: L.degrees(rotate) });
      },
    };
  } catch (e) {
    console.warn("Fonts for the export could not load; Helvetica instead.", e);
    const font = await doc.embedFont(L.StandardFonts.Helvetica);
    return {
      clean: M.winAnsi,
      width: (text, size) => font.widthOfTextAtSize(M.winAnsi(text), size),
      draw: (page, text, { x, y, size, rotate = 0, color }) =>
        page.drawText(M.winAnsi(text), { x, y, size, font, color: L.rgb(...color), rotate: L.degrees(rotate) }),
    };
  }
}

/** The bytes of the PDF `bytes` with the marks and notes of `src` in it. */
export async function annotatedPdf(bytes, src) {
  const L = await pdfLib();
  const doc = await L.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = doc.getPages();
  const marks = Object.entries(M.marksOf(D.pdfMarks, src)).filter(([k, list]) => list?.length && pages[Number(k) - 1]);
  const notes = Object.entries(notesOf(D.slideNotes, src))
    .map(([k, n]) => ({ page: Number(k), text: String(n?.text ?? "").trim() }))
    .filter(n => n.page > 0 && n.text).sort((a, b) => a.page - b.page);
  const texts = [...marks.flatMap(([, list]) => list.filter(m => m.kind === "text").map(m => m.text)), ...notes.map(n => n.text), titleOf(src)];
  const fonts = notes.length || texts.length > 1 ? await textFonts(L, doc, texts) : null;

  for (const [key, list] of marks) {
    const page = pages[Number(key) - 1];
    const rotate = page.getRotation().angle;
    page.pushOperators(L.setLineJoin(L.LineJoinStyle.Round));
    for (const o of M.exportOps(list, page.getCropBox(), rotate, fonts?.width, fonts?.clean)) {
      if (o.op === "text") { fonts.draw(page, o.text, o); continue; }
      const opt = { x: 0, y: 0 };
      if (o.fill) { opt.color = L.rgb(...o.fill); opt.opacity = o.opacity; }
      if (o.stroke) { opt.borderColor = L.rgb(...o.stroke); opt.borderWidth = o.width; opt.borderOpacity = o.opacity; opt.borderLineCap = L.LineCapStyle.Round; }
      if (o.multiply) opt.blendMode = L.BlendMode.Multiply;
      page.drawSvgPath(o.d, opt);
    }
  }

  // each note as a sticky note on its page
  const ctx = doc.context, now = L.PDFString.fromDate(new Date());
  for (const n of notes) {
    const page = pages[n.page - 1];
    if (!page) continue;
    const annot = ctx.obj({
      Type: "Annot", Subtype: "Text", Name: "Comment", F: 4, Open: false,
      Rect: M.noteIconRect(page.getCropBox(), page.getRotation().angle),
      C: NOTE_RGB, Contents: L.PDFHexString.fromText(n.text), T: L.PDFHexString.fromText("My note"), M: now,
    });
    page.node.addAnnot(ctx.register(annot));
  }

  // and all of them at the end
  if (notes.length) {
    const pdfName = pdfOf(src)?.name || "";
    const sub = [titleOf(src), pdfName].filter(Boolean).join(" · ");
    const layout = M.notesLayout(notes, { word: word(src), sub, measure: fonts.width });
    for (const items of layout) {
      const page = doc.addPage([595.28, 841.89]);
      for (const it of items) {
        const color = it.kind === "label" ? ACCENT : it.kind === "sub" ? MUTED : INK;
        fonts.draw(page, it.text, { x: it.x, y: it.y, size: it.size, color });
      }
    }
  }
  return doc.save();
}

/** Saves the bytes: in the Downloads folder in the app (its path is returned), a download in a browser. */
async function saveFile(bytes, name) {
  if (tauri) return tauri.core.invoke("save_download", bytes, { headers: { "x-file-name": encodeURIComponent(name) } });
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return null;
}

/**
 * Exports the current PDF of `src` with its marks and notes (`bytes`: the PDF, read from Bloom's
 * copy when absent). Returns the name it was saved under. Throws a message she can read.
 */
export async function exportAnnotated(src, bytes = null) {
  const rec = pdfOf(src);
  try {
    if (!bytes) {
      if (!rec) throw new Error("this PDF is missing");
      bytes = await (await pdfBlob(rec.id)).arrayBuffer();
    }
    const out = await annotatedPdf(bytes, src);
    const name = M.annotatedName(rec?.name || titleOf(src));
    const path = await saveFile(out, name);
    return path ? String(path).split(/[\\/]/).pop() : name;
  } catch (e) {
    throw new Error("The annotated PDF could not be made: " + (typeof e === "string" ? e : e?.message || e));
  }
}

// ---- before a PDF is replaced

const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
const what = ({ notes, marks }) => [notes && plural(notes, "note"), marks && plural(marks, "mark")].filter(Boolean).join(" and ");

/**
 * Asks before the PDFs of `srcs` are replaced (or removed, `removing`) when any of them carries
 * notes or marks, offering to export them first. Resolves "replace" (go on, then call
 * forgetAnnotations) or "cancel" (change nothing; also when the export failed).
 */
export function confirmReplace(srcs, { removing = false } = {}) {
  const hit = [...new Set(srcs)].filter(s => pdfOf(s)).map(src => ({ src, ...annotationCounts(src) })).filter(x => x.notes || x.marks);
  if (!hit.length) return Promise.resolve("replace");
  const one = hit.length === 1;
  const thing = one ? (isFicheSrc(hit[0].src) ? "This fiche" : "This lecture") : "These lectures";
  const lost = removing ? (one ? "when the PDF is removed" : "when the PDFs are removed") : (one ? "when the new PDF replaces it" : "when the new PDFs replace them");
  const body = one
    ? `<p class="lead">${thing} has ${what(hit[0])} on the current PDF. They will be lost forever ${lost}. Export the current PDF with them first?</p>`
    : `<p class="lead">${thing} have notes or marks on their current PDF:</p>
       <ul style="margin: 8px 0 10px 20px; list-style: disc">${hit.map(x => `<li><b>${esc(titleOf(x.src))}</b>: ${what(x)}</li>`).join("")}</ul>
       <p class="lead">They will be lost forever ${lost}. Export the current PDFs with them first?</p>`;
  return new Promise(resolve => {
    let settled = false;
    const done = answer => { if (!settled) { settled = true; watch.disconnect(); resolve(answer); } };
    const verb = removing ? "remove" : "replace";
    openModal({
      title: "Your notes and marks will be lost",
      body: body + `<p class="small muted" data-replace-status></p>`,
      submit: `Export, then ${verb}`,
      cancel: "Cancel",
      wide: true,
      danger: { label: `${verb[0].toUpperCase() + verb.slice(1)} without exporting`, onClick: () => done("replace") },
      onSubmit: async (v, form) => {
        const status = form.querySelector("[data-replace-status]");
        form.querySelectorAll("button").forEach(b => { b.disabled = true; });
        const saved = [];
        try {
          for (const x of hit) {
            status.textContent = `Exporting ${titleOf(x.src)}…`;
            saved.push(await exportAnnotated(x.src));
          }
        } catch (e) {
          console.error(e);
          toast(`${e.message}. Nothing was ${verb}d.`, "error");
          done("cancel");
          return;
        }
        toast(tauri ? `Saved in Downloads: ${saved.join(", ")}` : `Downloaded: ${saved.join(", ")}`);
        done("replace");
      },
    });
    // closed any other way (Cancel, the ×, Escape, a click beside it): nothing changes
    const modal = document.getElementById("modal");
    const watch = new MutationObserver(() => { if (modal.hidden) done("cancel"); });
    watch.observe(modal, { attributes: true, attributeFilter: ["hidden"] });
  });
}
