// Bloom's own PDF viewer, opened by openViewer in ui.js: pdf.js draws the pages lazily as she
// scrolls (ui/vendor/pdfjs, version 3.3.122, the legacy build: the last one whose build targets
// Safari 14, i.e. the WKWebView of macOS 11), with a text layer to select and copy, zoom, a page
// counter and, when the PDF has a quiz source, her notes per slide (D.slideNotes, slidenotes-core.js).
import { D, save } from "./store.js";
import { today } from "./dates.js";
import { esc, icon, app } from "./ui.js";
import { urlBytes, releaseUrl } from "./files.js";
import { isFicheSrc } from "./sources.js";
import { noteText, noteList, setNote, mostVisible, clampPage } from "./slidenotes-core.js";

const PX = 96 / 72;           // CSS pixels per PDF point at 100 %
const PAD = 22;               // space around the pages, in CSS pixels
const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const MAX_PIXELS = 16_000_000; // WebKit refuses larger canvases
const KEEP = 4;               // drawn pages kept on each side of the one on screen

let lib = null;
async function pdfjs() {
  if (!lib) {
    // a UMD file: run as a module it sets globalThis.pdfjsLib
    await import("../vendor/pdfjs/pdf.min.js");
    lib = globalThis.pdfjsLib;
    lib.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.min.js", import.meta.url).href;
  }
  return lib;
}

let notesOpen = true; // remembered while Bloom runs
let V = null;         // the open viewer

/** Fills `host` (#viewer) with the viewer and loads the PDF behind `url` (from pdfUrl in files.js). */
export function show(host, { title, url, page = null, notes = null }) {
  close();
  const v = V = {
    host, url, src: notes || null, zoom: "fit", k: 1, pages: [], cur: clampPage(page, Infinity, 1),
    near: new Set(), busy: false, closed: false, forced: null, saveTimer: 0, frame: 0, doc: null, cleanup: [],
  };
  host.innerHTML = `
    <div class="viewer pv ${v.src ? "" : "no-notes"} ${v.src && notesOpen ? "notes-open" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header class="pv-bar">
        <b class="pv-title" title="${esc(title)}">${esc(title)}</b>
        <div class="pv-nav" role="group" aria-label="Pages">
          <button type="button" class="iconbtn" data-pv="prev" title="Previous page" aria-label="Previous page">${icon("chevL")}</button>
          <label class="pv-count" title="Go to a page"><input data-pv="page" inputmode="numeric" autocomplete="off" aria-label="Page" value="${v.cur}"><span>/ <span data-pv="count">…</span></span><i class="pv-dot" hidden title="This slide has a note"></i></label>
          <button type="button" class="iconbtn" data-pv="next" title="Next page" aria-label="Next page">${icon("chevR")}</button>
        </div>
        <div class="pv-zoom" role="group" aria-label="Zoom">
          <button type="button" class="iconbtn" data-pv="out" title="Zoom out" aria-label="Zoom out">${icon("minus")}</button>
          <button type="button" class="pv-pct" data-pv="fit" title="Fit to the width">Fit</button>
          <button type="button" class="iconbtn" data-pv="in" title="Zoom in" aria-label="Zoom in">${icon("plus")}</button>
        </div>
        ${v.src ? `<button type="button" class="pv-ntoggle" data-pv="notes" aria-pressed="${notesOpen}" title="Your notes on these slides">${icon("note", 16)} Notes<span data-pv="ncount"></span></button>` : ""}
        <button type="button" class="iconbtn" data-viewer="close" aria-label="Close" title="Close (Esc)">${icon("close")}</button>
      </header>
      <div class="pv-body">
        <div class="pv-scroll" tabindex="-1"><div class="pv-pages"><p class="pv-wait">Opening the PDF…</p></div></div>
        ${v.src ? `<aside class="pv-notes" aria-label="Notes">
          <div class="pv-nhead"><b>${isFicheSrc(v.src) ? "Page" : "Slide"} <span data-pv="np">${v.cur}</span></b><span class="pv-saved" data-pv="saved"></span></div>
          <textarea data-pv="note" rows="7" placeholder="A note on this ${isFicheSrc(v.src) ? "page" : "slide"}…" aria-label="Note on this page"></textarea>
          <p class="pv-hint">Saved as you type. Clear the text to delete the note.</p>
          <h3 class="pv-lh">All notes</h3>
          <div class="pv-list" data-pv="list"></div>
        </aside>` : ""}
      </div>
    </div>`;
  v.root = host.querySelector(".pv");
  v.scroll = host.querySelector(".pv-scroll");
  v.pagesEl = host.querySelector(".pv-pages");
  v.input = host.querySelector('[data-pv="page"]');
  v.note = host.querySelector('[data-pv="note"]');
  wire(v);
  v.scroll.focus({ preventScroll: true });
  if (v.src) { showNote(v); drawList(v); }
  load(v).catch(e => {
    if (v.closed) return;
    console.error(e);
    v.pagesEl.innerHTML = `<p class="pv-wait">This PDF could not be read.<br><span class="muted small">${esc(e?.message || e)}</span></p>`;
  });
}

/** Stops everything and saves a note being typed. Called by closeViewer in ui.js. */
export function close() {
  const v = V;
  if (!v) return;
  V = null;
  v.closed = true;
  if (v.saveTimer) { clearTimeout(v.saveTimer); save(); }
  cancelAnimationFrame(v.frame);
  for (const off of v.cleanup) off();
  for (const p of v.pages) { p.task?.cancel(); p.textTask?.cancel(); if (p.canvas) p.canvas.width = p.canvas.height = 0; }
  v.doc?.destroy();
  releaseUrl(v.url);
  if (v.changed) app.refresh(); // the counts of notes in the views
}

async function load(v) {
  const [pdf, bytes] = await Promise.all([pdfjs(), urlBytes(v.url)]);
  if (v.closed) return;
  const doc = await pdf.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 }).promise;
  if (v.closed) { doc.destroy(); return; }
  v.doc = doc;
  const first = (await doc.getPage(1)).getViewport({ scale: 1 });
  if (v.closed) return;
  const n = doc.numPages;
  v.host.querySelector('[data-pv="count"]').textContent = n;
  v.pagesEl.innerHTML = Array.from({ length: n }, (_, i) =>
    `<div class="pv-page" data-page="${i + 1}" aria-label="Page ${i + 1}"><i class="pv-mark" title="This slide has a note"></i></div>`).join("");
  v.pages = [...v.pagesEl.children].map(el => ({ el, w: first.width, h: first.height, canvas: null, drawn: 0, task: null, text: false }));
  v.cur = clampPage(v.cur, n);
  marks(v);
  layout(v, false);
  go(v, v.cur);
  watch(v);
  v.ready = true;
  // pages of another size than the first: corrected once all are known
  const sizes = [];
  for (let i = 1; i < n && !v.closed; i++) sizes[i] = (await doc.getPage(i + 1)).getViewport({ scale: 1 });
  if (v.closed) return;
  let moved = false;
  for (let i = 1; i < n; i++) {
    const p = v.pages[i], s = sizes[i];
    if (Math.abs(p.w - s.width) > 0.5 || Math.abs(p.h - s.height) > 0.5) { p.w = s.width; p.h = s.height; p.drawn = 0; moved = true; }
  }
  if (moved) layout(v);
}

// ---- sizes and position

function scaleOf(v) {
  if (v.zoom !== "fit") return v.zoom;
  const width = Math.max(...v.pages.map(p => p.w)) * PX;
  return Math.min(4, Math.max(0.25, (v.scroll.clientWidth - 2 * PAD) / width));
}

/** Sizes every page for the zoom, keeping the same spot of the same page on screen. */
function layout(v, keep = true) {
  const at = keep ? anchor(v) : null;
  const s = scaleOf(v);
  v.scale = s;
  v.k = s * PX;
  for (const p of v.pages) {
    p.el.style.width = `${Math.floor(p.w * v.k)}px`;
    p.el.style.height = `${Math.floor(p.h * v.k)}px`;
    p.el.style.setProperty("--scale-factor", v.k);
  }
  const pct = v.host.querySelector('[data-pv="fit"]');
  pct.textContent = `${Math.round(s * 100)}%`;
  pct.classList.toggle("on", v.zoom === "fit");
  pct.title = v.zoom === "fit" ? "Fitted to the width" : "Fit to the width";
  if (at) {
    const el = v.pages[at.i].el;
    v.scroll.scrollTop = el.offsetTop + at.f * el.offsetHeight;
    v.scroll.scrollLeft = at.x * (v.scroll.scrollWidth - v.scroll.clientWidth);
  }
  pump(v);
}

function anchor(v) {
  const p = v.pages[v.cur - 1];
  if (!p) return null;
  const range = v.scroll.scrollWidth - v.scroll.clientWidth;
  return { i: v.cur - 1, f: (v.scroll.scrollTop - p.el.offsetTop) / p.el.offsetHeight, x: range > 0 ? v.scroll.scrollLeft / range : 0.5 };
}

function go(v, page) {
  if (!v.pages.length) { // still loading: it opens there
    v.cur = clampPage(page, Infinity, v.cur);
    v.input.value = v.cur;
    if (v.src) showNote(v);
    return;
  }
  const p = v.pages[clampPage(page, v.pages.length) - 1];
  if (!p) return;
  v.scroll.scrollTop = p.el.offsetTop - PAD / 2;
  // the last pages may not reach the top: they still count as the page on screen
  v.forced = { page: Number(p.el.dataset.page), top: v.scroll.scrollTop };
  current(v);
}

/** Works out the page on screen (the most visible one) and follows it. */
function current(v) {
  if (!v.pages.length) return;
  const top = v.scroll.scrollTop;
  let page;
  if (v.forced && Math.abs(top - v.forced.top) < 2) page = v.forced.page;
  else {
    v.forced = null;
    page = mostVisible(v.pages.map(p => ({ page: Number(p.el.dataset.page), top: p.el.offsetTop, bottom: p.el.offsetTop + p.el.offsetHeight })), top, top + v.scroll.clientHeight);
  }
  if (!page || page === v.cur && v.input.value === String(page)) return;
  v.cur = page;
  if (document.activeElement !== v.input) v.input.value = page;
  dot(v);
  if (v.src) showNote(v);
  pump(v);
}

// ---- drawing

function watch(v) {
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      const i = Number(e.target.dataset.page) - 1;
      if (e.isIntersecting) v.near.add(i); else v.near.delete(i);
    }
    pump(v);
  }, { root: v.scroll, rootMargin: "100% 0px" });
  for (const p of v.pages) io.observe(p.el);
  let width = v.scroll.clientWidth;
  const ro = new ResizeObserver(() => {
    if (v.scroll.clientWidth === width) return;
    width = v.scroll.clientWidth;
    if (v.zoom === "fit") layout(v);
  });
  ro.observe(v.scroll);
  v.cleanup.push(() => io.disconnect(), () => ro.disconnect());
}

/** Draws the nearby pages one at a time, the one on screen first, and frees the far ones. */
function pump(v) {
  if (v.busy || v.closed || !v.doc) return;
  const next = [...v.near].filter(i => v.pages[i].drawn !== v.k).sort((a, b) => Math.abs(a - v.cur + 1) - Math.abs(b - v.cur + 1))[0];
  if (next === undefined) return;
  v.busy = true;
  draw(v, next).catch(e => { if (e?.name !== "RenderingCancelledException") console.warn(e); })
    .finally(() => { v.busy = false; if (!v.closed) { trim(v); pump(v); } });
}

async function draw(v, i) {
  const p = v.pages[i];
  const k = v.k;
  const page = await v.doc.getPage(i + 1);
  if (v.closed) return;
  let scale = k * Math.min(window.devicePixelRatio || 1, 3);
  const base = page.getViewport({ scale: 1 });
  const area = base.width * base.height * scale * scale;
  if (area > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / area);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  p.task = page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport });
  try { await p.task.promise; }
  finally { p.task = null; }
  if (v.closed) { canvas.width = canvas.height = 0; return; }
  // the old drawing stays (stretched) until the new one is ready: no blank flash on zoom
  if (p.canvas) { p.canvas.width = p.canvas.height = 0; p.canvas.replaceWith(canvas); }
  else p.el.prepend(canvas);
  p.canvas = canvas;
  p.drawn = k;
  if (!p.text) {
    p.text = true;
    const layer = document.createElement("div");
    layer.className = "textLayer";
    p.el.append(layer);
    p.textTask = lib.renderTextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport: base, textDivs: [] });
    p.textTask.promise.catch(() => {}).finally(() => { p.textTask = null; });
  }
}

function trim(v) {
  v.pages.forEach((p, i) => {
    if (!p.canvas || v.near.has(i) || Math.abs(i - v.cur + 1) <= KEEP) return;
    p.canvas.width = p.canvas.height = 0;
    p.canvas.remove();
    p.canvas = null;
    p.drawn = 0;
  });
}

// ---- zoom, keys, clicks

function zoomTo(v, z) {
  v.zoom = z === "fit" ? "fit" : Math.min(4, Math.max(0.25, z));
  layout(v);
}
function zoomStep(v, dir) {
  const s = v.scale;
  const next = dir > 0 ? STEPS.find(x => x > s + 0.01) : [...STEPS].reverse().find(x => x < s - 0.01);
  zoomTo(v, next ?? (dir > 0 ? STEPS[STEPS.length - 1] : STEPS[0]));
}

function step(v, dir) {
  const p = v.pages[v.cur - 1];
  // a page taller than the window scrolls a little before moving on
  if (p && p.el.offsetHeight > v.scroll.clientHeight + 4) {
    const top = v.scroll.scrollTop, end = p.el.offsetTop + p.el.offsetHeight - v.scroll.clientHeight;
    if (dir > 0 && top < end - 2) { v.scroll.scrollTop = Math.min(end, top + v.scroll.clientHeight * 0.8); return; }
    if (dir < 0 && top > p.el.offsetTop + 2) { v.scroll.scrollTop = Math.max(p.el.offsetTop - PAD / 2, top - v.scroll.clientHeight * 0.8); return; }
  }
  go(v, v.cur + dir);
}

function wire(v) {
  const onKey = e => {
    if (V !== v || e.metaKey && !["=", "+", "-", "0"].includes(e.key) || e.ctrlKey || e.altKey) return;
    const typing = e.target.closest?.("input, textarea, select");
    if (typing) {
      if (e.target === v.input && e.key === "Enter") { e.preventDefault(); go(v, clampPage(v.input.value, v.pages.length, v.cur)); v.input.blur(); }
      return;
    }
    const act = {
      ArrowDown: () => step(v, 1), ArrowRight: () => go(v, v.cur + 1), PageDown: () => go(v, v.cur + 1), " ": () => step(v, e.shiftKey ? -1 : 1),
      ArrowUp: () => step(v, -1), ArrowLeft: () => go(v, v.cur - 1), PageUp: () => go(v, v.cur - 1),
      Home: () => go(v, 1), End: () => go(v, v.pages.length),
      "+": () => zoomStep(v, 1), "=": () => zoomStep(v, 1), "-": () => zoomStep(v, -1), "0": () => zoomTo(v, "fit"),
    }[e.key];
    if (!act || !v.pages.length) return;
    e.preventDefault();
    act();
  };
  document.addEventListener("keydown", onKey);
  v.cleanup.push(() => document.removeEventListener("keydown", onKey));

  const onScroll = () => {
    cancelAnimationFrame(v.frame);
    v.frame = requestAnimationFrame(() => current(v));
  };
  v.scroll.addEventListener("scroll", onScroll, { passive: true });

  v.root.addEventListener("click", e => {
    const jump = e.target.closest("[data-jump]");
    if (jump) { go(v, Number(jump.dataset.jump)); return; }
    const act = e.target.closest("[data-pv]")?.dataset.pv;
    if (!v.pages.length && act !== "notes") return;
    if (act === "prev") go(v, v.cur - 1);
    else if (act === "next") go(v, v.cur + 1);
    else if (act === "in") zoomStep(v, 1);
    else if (act === "out") zoomStep(v, -1);
    else if (act === "fit") zoomTo(v, "fit");
    else if (act === "notes") {
      notesOpen = !notesOpen;
      v.root.classList.toggle("notes-open", notesOpen);
      e.target.closest("[data-pv]").setAttribute("aria-pressed", notesOpen);
      if (notesOpen) v.note.focus();
    }
  });
  v.input.addEventListener("change", () => go(v, clampPage(v.input.value, v.pages.length, v.cur)));
  v.input.addEventListener("focus", () => v.input.select());
  v.input.addEventListener("blur", () => { v.input.value = v.cur; });
  v.note?.addEventListener("input", () => typed(v));
}

// ---- notes

const all = () => (D.slideNotes ??= {});

function showNote(v) {
  v.notePage = v.cur;
  v.note.value = noteText(all(), v.src, v.cur);
  v.host.querySelector('[data-pv="np"]').textContent = v.cur;
  v.host.querySelector('[data-pv="saved"]').textContent = "";
  for (const b of v.host.querySelectorAll("[data-jump]")) b.classList.toggle("on", Number(b.dataset.jump) === v.cur);
}

function typed(v) {
  if (!setNote(all(), v.src, v.notePage, v.note.value, today())) return;
  v.changed = true;
  marks(v);
  drawList(v);
  const status = v.host.querySelector('[data-pv="saved"]');
  status.textContent = "Saving…";
  clearTimeout(v.saveTimer);
  v.saveTimer = setTimeout(async () => {
    v.saveTimer = 0;
    await save();
    if (!v.closed && status.isConnected) status.textContent = "Saved";
  }, 600);
}

function drawList(v) {
  const list = noteList(all(), v.src);
  const n = list.length;
  v.host.querySelector('[data-pv="ncount"]').textContent = n ? ` · ${n}` : "";
  v.host.querySelector('[data-pv="list"]').innerHTML = n
    ? list.map(x => `<button type="button" class="pv-item ${x.page === v.cur ? "on" : ""}" data-jump="${x.page}"><span class="pv-ipage">${x.page}</span><span class="pv-itext">${esc(x.first)}</span></button>`).join("")
    : `<p class="pv-empty">No notes yet. The slides you write about show up here, to jump back to them.</p>`;
}

/** The markers of the pages that have a note, and the dot of the counter. */
function marks(v) {
  if (!v.src) return;
  const notes = all()[v.src] || {};
  for (const p of v.pages) p.el.classList.toggle("noted", Boolean(notes[p.el.dataset.page]));
  dot(v);
}
function dot(v) {
  const d = v.host.querySelector(".pv-dot");
  if (d) d.hidden = !(v.src && noteText(all(), v.src, v.cur));
}

