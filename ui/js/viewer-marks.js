// Her annotations in Bloom's PDF viewer (viewer.js), when the PDF has a quiz source: highlighter
// on the text layer, pen, eraser, text boxes, undo, "Clear this page" and the export of a copy of
// the PDF with the marks burned in and the notes added (pdf-export.js).
// The marks live in D.pdfMarks (shape and pure logic in marks-core.js) and never change the PDF:
// each page gets two SVG layers (highlights, multiplied with the page, then ink), whose viewBox is
// the page in PDF points so they follow the zoom, and a layer of text boxes sized in points too.
import { D, save, uid } from "./store.js";
import { today } from "./dates.js";
import { esc, icon, toast } from "./ui.js";
import { urlBytes } from "./files.js";
import { isFicheSrc } from "./sources.js";
import { exportAnnotated, annotationCounts } from "./pdf-export.js";
import * as M from "./marks-core.js";

const tauri = window.__TAURI__;
const NS = "http://www.w3.org/2000/svg";
const MAC = /Mac|iP/.test(navigator.platform || navigator.userAgent);
const svg = (d, size = 17) => `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const TOOLS = [
  ["select", "Select and read", "V", "M6 3.5l12 7.2-5.3 1.4 3.3 5.9-2.4 1.4-3.4-5.9L6 17.5z"],
  ["highlight", "Highlight text", "H", "M14.5 4.5l5 5-7.5 7.5H7v-5zM12 7l5 5M7 17l-3 3h6M4 21h16"],
  ["pen", "Draw", "P", "M4 20l1.2-4.6L15.5 5.1a2 2 0 012.8 0l.6.6a2 2 0 010 2.8L8.6 18.8zM13.5 7l3.5 3.5"],
  ["eraser", "Eraser: rub out a mark", "E", "M9 20h11M5.6 14.4l8.3-8.3a2 2 0 012.8 0l2.2 2.2a2 2 0 010 2.8L11 19.1H8.9l-3.3-3.3a1 1 0 010-1.4zM9.6 10.4l5 5"],
  ["text", "Text box", "T", "M5 7V5h14v2M12 5v14M9 19h6"],
];
const UNDO = "M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 010 11H11";
const SAVE = "M12 4v11M7 10l5 5 5-5M5 20h14";
const NAMES = { yellow: "Yellow", pink: "Pink", green: "Green", blue: "Blue", red: "Red", ink: "Dark" };

// remembered while Bloom runs
let tool = "select";
const colors = { highlight: "yellow", pen: "ink", text: "ink" };
let thick = false;

const all = () => (D.pdfMarks ??= {});
const pageOf = p => Number(p.el.dataset.page);
const r4 = n => Math.round(n * 1e4) / 1e4;
const clamp = (n, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
const word = v => (isFicheSrc(v.src) ? "page" : "slide");

/** The annotation toolbar for the viewer's header ("" without a source). */
export function inkBar(v) {
  if (!v.src) return "";
  return `<div class="pv-tools" role="toolbar" aria-label="Annotate">
    <div class="pv-tgroup" role="group" aria-label="Tool">${TOOLS.map(([k, label, key, d]) =>
      `<button type="button" class="pv-tool" data-tool="${k}" aria-pressed="false" title="${label} (${key})" aria-label="${label}">${svg(d)}</button>`).join("")}</div>
    <div class="pv-opts" data-ink="opts" hidden></div>
    <div class="pv-tgroup">
      <button type="button" class="pv-tool" data-ink="undo" title="Undo (${MAC ? "⌘" : "Ctrl+"}Z)" aria-label="Undo" disabled>${svg(UNDO)}</button>
      <span class="pv-pop"><button type="button" class="pv-tool" data-ink="clear" title="Clear this ${word(v)}" aria-label="Clear this ${word(v)}">${icon("trash", 17)}</button></span>
      <button type="button" class="pv-tool" data-ink="export" title="Export a copy of the PDF with your marks and notes" aria-label="Export annotated PDF">${svg(SAVE)}</button>
    </div>
  </div>`;
}

/** Wires the toolbar, the keys and the pointer once the viewer is in the page. */
export function inkSetup(v) {
  if (!v.src) return;
  v.ink = { undo: [], timer: 0, stroke: null, erase: null, drag: null, edit: null, busy: false };
  setTool(v, tool);
  v.root.addEventListener("click", e => {
    const t = e.target.closest("[data-tool]");
    if (t) { setTool(v, t.dataset.tool); return; }
    const c = e.target.closest("[data-color]");
    if (c) { colors[toolKind()] = c.dataset.color; setTool(v, tool); return; }
    const w = e.target.closest("[data-width]");
    if (w) { thick = w.dataset.width === "thick"; setTool(v, tool); return; }
    const act = e.target.closest("[data-ink]")?.dataset.ink;
    if (act !== "clear" && act !== "yes" && act !== "no" && !e.target.closest(".pv-confirm")) closeConfirm(v);
    if (act === "undo") doUndo(v);
    else if (act === "clear") v.root.querySelector(".pv-confirm") ? closeConfirm(v) : askClear(v);
    else if (act === "no") closeConfirm(v);
    else if (act === "yes") clearPage(v);
    else if (act === "export") exportPdf(v, e.target.closest("button"));
    else if (act === "tdel") {
      const box = e.target.closest(".pv-tbox"), p = pageAt(v, box);
      if (p) change(v, p, () => M.removeMark(all(), v.src, pageOf(p), box.dataset.id));
    }
  });

  const onKey = e => {
    if (v.closed) return;
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
    if (e.key === "Escape") {
      // before ui.js closes the viewer: first leave what she is doing
      if (v.root.querySelector(".pv-confirm")) { stop(); closeConfirm(v); }
      else if (v.ink.edit) { stop(); commitEdit(v); }
      else if (tool !== "select" && !typing) { stop(); setTool(v, "select"); }
      return;
    }
    if (v.ink.edit && e.target === v.ink.edit.span && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitEdit(v); return; }
    if (typing || e.altKey) return;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") { stop(); doUndo(v); return; }
    if (e.metaKey || e.ctrlKey) return;
    const t = TOOLS.find(x => x[2] === e.key.toUpperCase());
    if (t && !e.shiftKey) { e.preventDefault(); setTool(v, t[0]); }
  };
  window.addEventListener("keydown", onKey, true);

  v.pagesEl.addEventListener("pointerdown", e => down(v, e));
  v.pagesEl.addEventListener("pointermove", e => { if (tool === "eraser" && !v.ink.erase) hover(v, e); });
  v.pagesEl.addEventListener("pointerleave", () => hover(v, null));
  const onUp = () => { if (tool === "highlight") setTimeout(() => highlight(v), 0); };
  document.addEventListener("pointerup", onUp);
  // no scrolling under the pen (a two-finger swipe while the trackpad is pressed)
  const onWheel = e => { if (v.ink.stroke || v.ink.erase || v.ink.drag) e.preventDefault(); };
  v.scroll.addEventListener("wheel", onWheel, { passive: false });
  v.cleanup.push(() => {
    window.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerup", onUp);
  });
}

// Text boxes are written in Fira Sans on screen as in the export (pdf-export.js), so they keep
// their size; the screen loads Bloom's own copy (ui/fonts), the browser fills in missing symbols.
const FACE = "Bloom Marks Fira";
let faceAdded = false;
function addFace() {
  if (faceAdded || typeof FontFace === "undefined") return;
  faceAdded = true;
  try {
    const face = new FontFace(FACE, `url("${new URL("../fonts/FiraSans-Regular.woff2", import.meta.url).href}") format("woff2")`);
    document.fonts.add(face);
    face.load().catch(() => {});
  } catch { /* the fallback fonts of the box do */ }
}

/** Adds the layers of marks to every page (after the pages are made) and draws the marks. */
export function inkPages(v) {
  if (!v.ink) return;
  addFace();
  for (const p of v.pages) {
    p.hl = document.createElementNS(NS, "svg");
    p.hl.setAttribute("class", "pv-hl");
    p.ink = document.createElementNS(NS, "svg");
    p.ink.setAttribute("class", "pv-ink");
    for (const s of [p.hl, p.ink]) { s.setAttribute("preserveAspectRatio", "none"); s.setAttribute("aria-hidden", "true"); }
    p.boxes = document.createElement("div");
    p.boxes.className = "pv-boxes";
    p.el.append(p.hl, p.ink, p.boxes);
    paint(v, p);
  }
}

/** Draws the marks again (the sizes of some pages were corrected). */
export const inkRepaint = v => { if (v.ink) for (const p of v.pages) paint(v, p); };

/** Ends what she was doing and saves now. Called when the viewer closes. */
export function inkClose(v) {
  if (!v.ink) return;
  commitEdit(v);
  if (v.ink.timer) { clearTimeout(v.ink.timer); v.ink.timer = 0; save(); }
}

// ---- tools

const toolKind = () => (tool === "highlight" || tool === "pen" || tool === "text" ? tool : null);

function setTool(v, t) {
  if (v.ink.edit && t !== tool) commitEdit(v);
  if (t !== "highlight") window.getSelection()?.removeAllRanges();
  tool = t;
  v.root.dataset.inkTool = t;
  v.root.style.setProperty("--hl-sel", M.hexOf("highlight", colors.highlight) + "88");
  for (const b of v.root.querySelectorAll("[data-tool]")) b.setAttribute("aria-pressed", b.dataset.tool === t);
  const box = v.root.querySelector('[data-ink="opts"]');
  const kind = toolKind();
  box.hidden = !kind;
  box.innerHTML = !kind ? "" : M.PALETTE[kind].map(c =>
    `<button type="button" class="pv-sw" data-color="${c}" style="--sw:${M.hexOf(kind, c)}" aria-pressed="${colors[kind] === c}" title="${NAMES[c]}" aria-label="${NAMES[c]}"></button>`).join("")
    + (kind !== "pen" ? "" : `<span class="pv-sep"></span>` + [false, true].map(t =>
      `<button type="button" class="pv-wd" data-width="${t ? "thick" : "thin"}" aria-pressed="${thick === t}" title="${t ? "Thick" : "Thin"} line" aria-label="${t ? "Thick" : "Thin"} line"><svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 15c4-7 9 3 16-4" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="${t ? 4.2 : 1.6}"/></svg></button>`).join(""));
  hover(v, null);
}

const undoButton = v => { const b = v.root.querySelector('[data-ink="undo"]'); if (b) b.disabled = !v.ink.undo.length; };

/** Saves soon (not at every stroke while she draws). */
function dirty(v) {
  undoButton(v);
  clearTimeout(v.ink.timer);
  v.ink.timer = setTimeout(() => { v.ink.timer = 0; save(); }, 800);
}

/** An action on page `p`, that undo can take back. */
function change(v, p, act) {
  M.pushUndo(v.ink.undo, all(), v.src, pageOf(p));
  act();
  paint(v, p);
  dirty(v);
}

function doUndo(v) {
  commitEdit(v);
  const page = M.undo(v.ink.undo, all(), v.src);
  if (!page) return;
  const p = v.pages[page - 1];
  if (p) paint(v, p);
  dirty(v);
}

// ---- drawing the marks of a page

function paint(v, p) {
  if (!p?.ink) return;
  const list = M.marksOn(all(), v.src, pageOf(p));
  const vb = `0 0 ${p.w} ${p.h}`;
  p.hl.setAttribute("viewBox", vb);
  p.ink.setAttribute("viewBox", vb);
  const n = x => Math.round(x * 100) / 100;
  let hl = "", ink = "", boxes = "";
  for (const m of list) {
    const id = esc(m.id), hex = M.hexOf(m.kind, m.color);
    if (m.kind === "highlight") {
      const d = (m.rects || []).map(([x, y, w, h]) => `M${n(x * p.w)} ${n(y * p.h)}h${n(w * p.w)}v${n(h * p.h)}h${n(-w * p.w)}z`).join("");
      hl += `<path data-id="${id}" d="${d}" fill="${hex}" fill-opacity="${M.HIGHLIGHT_OPACITY}"/>`;
    } else if (m.kind === "pen") {
      ink += `<path data-id="${id}" d="${M.smoothPath((m.points || []).map(([x, y]) => [x * p.w, y * p.h]))}" stroke="${hex}" stroke-width="${m.width || 1}"/>`;
    } else if (m.kind === "text") boxes += boxHtml(m);
  }
  p.hl.innerHTML = hl;
  p.ink.innerHTML = ink;
  p.boxes.innerHTML = boxes;
}

const boxHtml = m => `<div class="pv-tbox" data-id="${esc(m.id)}" style="left:${m.x * 100}%;top:${m.y * 100}%;color:${M.hexOf("text", m.color)};font-family:'${FACE}',Helvetica,Arial,sans-serif;font-size:calc(var(--scale-factor) * ${m.size}px)"><span class="pv-ttext">${esc(m.text)}</span><button type="button" class="pv-tdel" data-ink="tdel" title="Delete this text" aria-label="Delete this text">${icon("close", 12)}</button></div>`;

const pageAt = (v, el) => { const pe = el?.closest(".pv-page"); return pe ? v.pages[Number(pe.dataset.page) - 1] : null; };

/** The point of a pointer event as fractions of the page `rect`. */
const at = (rect, e) => [(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height];

// ---- pointer

function down(v, e) {
  if (e.button !== 0 || !v.ready || v.closed) return;
  const p = pageAt(v, e.target);
  if (!p?.ink) return;
  if (tool === "pen") stroke(v, p, e);
  else if (tool === "eraser") erase(v, e);
  else if (tool === "text") textDown(v, p, e);
}

/** Follows the pointer captured by `el` until it is released: move(e), end(). */
function follow(el, e, move, end) {
  const id = e.pointerId;
  try { el.setPointerCapture(id); } catch { /* the pointer is gone */ }
  const onMove = ev => { if (ev.pointerId === id) move(ev); };
  const onEnd = ev => {
    if (ev.pointerId !== id) return;
    el.removeEventListener("pointermove", onMove);
    for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) el.removeEventListener(t, onEnd);
    end(ev);
  };
  el.addEventListener("pointermove", onMove);
  for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) el.addEventListener(t, onEnd);
}

function stroke(v, p, e) {
  e.preventDefault();
  const rect = p.el.getBoundingClientRect();
  const width = M.penWidth(p.w, thick);
  const path = document.createElementNS(NS, "path");
  path.setAttribute("stroke", M.hexOf("pen", colors.pen));
  path.setAttribute("stroke-width", width);
  p.ink.append(path);
  const s = v.ink.stroke = { pts: [at(rect, e)], frame: 0 };
  const draw = () => { s.frame = 0; path.setAttribute("d", M.smoothPath(s.pts.map(([x, y]) => [x * p.w, y * p.h]))); };
  draw();
  follow(p.el, e, ev => {
    for (const c of ev.getCoalescedEvents?.() || [ev]) s.pts.push(at(rect, c));
    if (!s.frame) s.frame = requestAnimationFrame(draw);
  }, () => {
    cancelAnimationFrame(s.frame);
    v.ink.stroke = null;
    path.remove();
    if (v.closed) return;
    const points = M.simplify(s.pts.map(([x, y]) => [clamp(x), clamp(y)]), p.w, p.h, 0.35);
    if (points.length) change(v, p, () => M.addMark(all(), v.src, pageOf(p), { id: uid(), kind: "pen", color: colors.pen, at: today(), width, points }));
  });
}

/** The id of the mark under the pointer, and its page. */
function under(v, e) {
  const target = document.elementFromPoint(e.clientX, e.clientY);
  const p = pageAt(v, target);
  if (!p?.ink) return {};
  const box = target.closest(".pv-tbox");
  if (box) return { p, id: box.dataset.id };
  const list = M.marksOn(all(), v.src, pageOf(p)).filter(m => m.kind !== "text");
  const [x, y] = at(p.el.getBoundingClientRect(), e);
  return { p, id: M.hitTest(list, x, y, p.w, p.h, 4 / v.k) };
}

function hover(v, e) {
  const { id } = e ? under(v, e) : {};
  if (v.ink.hot === id) return;
  v.ink.hot = id;
  for (const el of v.pagesEl.querySelectorAll(".hot")) el.classList.remove("hot");
  if (id) for (const el of v.pagesEl.querySelectorAll(`[data-id="${CSS.escape(id)}"]`)) el.classList.add("hot");
}

function erase(v, e) {
  e.preventDefault();
  const saved = new Set(); // pages whose state before this gesture undo keeps
  const rub = ev => {
    const { p, id } = under(v, ev);
    if (!id) return;
    const page = pageOf(p);
    if (!saved.has(page)) { saved.add(page); M.pushUndo(v.ink.undo, all(), v.src, page); }
    M.removeMark(all(), v.src, page, id);
    paint(v, p);
    dirty(v);
  };
  v.ink.erase = true;
  rub(e);
  follow(e.target.closest(".pv-page"), e, rub, () => { v.ink.erase = null; v.ink.hot = null; });
}

// ---- text boxes

function textDown(v, p, e) {
  if (e.target.closest(".pv-tdel")) return; // its click deletes the box
  let box = e.target.closest(".pv-tbox");
  if (box?.classList.contains("editing")) return; // placing the caret
  e.preventDefault();
  if (v.ink.edit) {
    const id = box?.dataset.id;
    commitEdit(v);
    if (!id) return; // a click beside the box ends the typing
    box = p.boxes.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!box) return;
  }
  const rect = p.el.getBoundingClientRect();
  if (!box) { // a new box, its caret where she clicked
    const size = M.textSize(p.w), pad = size * M.TEXT_PAD;
    const [x, y] = at(rect, e);
    const m = { id: uid(), kind: "text", color: colors.text, at: today(), x: r4(clamp(x - pad / p.w, 0, 0.97)), y: r4(clamp(y - (pad + size * 0.62) / p.h, 0, 0.97)), size, text: "" };
    p.boxes.insertAdjacentHTML("beforeend", boxHtml(m));
    edit(v, p, p.boxes.lastElementChild, m, true);
    return;
  }
  const id = box.dataset.id;
  const m = M.marksOn(all(), v.src, pageOf(p)).find(x => x.id === id);
  if (!m) return;
  const x0 = e.clientX, y0 = e.clientY;
  let moved = false, nx = m.x, ny = m.y;
  v.ink.drag = true;
  follow(p.el, e, ev => {
    if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return;
    moved = true;
    box.classList.add("dragging");
    nx = clamp(m.x + (ev.clientX - x0) / rect.width, 0, 1 - box.offsetWidth / rect.width);
    ny = clamp(m.y + (ev.clientY - y0) / rect.height, 0, 1 - box.offsetHeight / rect.height);
    box.style.left = `${nx * 100}%`;
    box.style.top = `${ny * 100}%`;
  }, () => {
    v.ink.drag = null;
    if (v.closed) return;
    if (!moved) { edit(v, p, box, m, false); return; }
    change(v, p, () => M.updateMark(all(), v.src, pageOf(p), id, { x: r4(nx), y: r4(ny) }));
  });
}

function edit(v, p, el, m, isNew) {
  const span = el.querySelector(".pv-ttext");
  el.classList.add("editing");
  try { span.contentEditable = "plaintext-only"; } catch { span.contentEditable = "true"; }
  if (span.contentEditable !== "plaintext-only") span.contentEditable = "true";
  span.spellcheck = false;
  v.ink.edit = { p, el, span, m, isNew };
  span.addEventListener("blur", () => { if (v.ink.edit?.span === span) commitEdit(v); });
  // focused once the click is over, or the click would take the focus back
  setTimeout(() => {
    if (v.ink.edit?.span !== span) return;
    span.focus({ preventScroll: true });
    const r = document.createRange();
    r.selectNodeContents(span);
    r.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }, 0);
}

function commitEdit(v) {
  const ed = v.ink.edit;
  if (!ed) return;
  v.ink.edit = null;
  const text = ed.span.innerText.replace(/ /g, " ").replace(/\s+$/, "");
  const page = pageOf(ed.p);
  const had = M.marksOn(all(), v.src, page).find(x => x.id === ed.m.id);
  if (!had) {
    if (text.trim()) change(v, ed.p, () => M.addMark(all(), v.src, page, { ...ed.m, text }));
    else ed.el.remove();
  } else if (!text.trim()) change(v, ed.p, () => M.removeMark(all(), v.src, page, ed.m.id));
  else if (had.text !== text) change(v, ed.p, () => M.updateMark(all(), v.src, page, ed.m.id, { text }));
  else paint(v, ed.p);
}

// ---- highlighter: the text she selected

function highlight(v) {
  if (v.closed || tool !== "highlight") return;
  const sel = window.getSelection();
  if (!sel?.rangeCount || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  let root = range.commonAncestorContainer;
  if (root.nodeType !== 1) root = root.parentNode;
  if (!v.pagesEl.contains(root)) return;
  const byPage = new Map();
  const words = new Map(); // page → the pieces of text selected on it, kept on the mark as `text` ("Use my notes", mynotes-core.js)
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!n.data.trim() || !range.intersectsNode(n) || !n.parentElement?.closest(".textLayer")) continue;
    const p = pageAt(v, n.parentElement);
    if (!p?.ink) continue;
    const sub = document.createRange();
    sub.selectNodeContents(n);
    if (n === range.startContainer) sub.setStart(n, range.startOffset);
    if (n === range.endContainer) sub.setEnd(n, range.endOffset);
    if (sub.collapsed) continue;
    const r = p.el.getBoundingClientRect();
    if (!byPage.has(p)) { byPage.set(p, []); words.set(p, []); }
    // a piece that starts right where the last one ended, on its line, continues its word
    const w = words.get(p), box = sub.getBoundingClientRect(), last = w.box;
    const glued = last && Math.abs(box.top - last.top) < box.height / 2 && box.left - last.right < box.height * 0.15;
    w.push((w.length && !glued ? " " : "") + sub.toString());
    w.box = box;
    for (const c of sub.getClientRects()) byPage.get(p).push([(c.left - r.left) / r.width, (c.top - r.top) / r.height, c.width / r.width, c.height / r.height]);
  }
  sel.removeAllRanges();
  for (const [p, rects] of byPage) {
    const merged = M.mergeRects(rects);
    const text = words.get(p).join("").replace(/\s+/g, " ").trim();
    if (merged.length) change(v, p, () => M.addMark(all(), v.src, pageOf(p), { id: uid(), kind: "highlight", color: colors.highlight, at: today(), rects: merged, ...(text ? { text } : {}) }));
  }
}

// ---- clear this page

function askClear(v) {
  const page = v.cur;
  if (!M.marksOn(all(), v.src, page).length) { toast(`Nothing drawn on ${word(v)} ${page}.`); return; }
  const pop = v.root.querySelector(".pv-pop");
  pop.insertAdjacentHTML("beforeend", `<div class="pv-confirm" role="alertdialog" aria-label="Clear this ${word(v)}">
    <p>Remove your highlights, drawings and text on ${word(v)} ${page}?</p>
    <div><button type="button" class="btn ghost" data-ink="no">Cancel</button><button type="button" class="btn primary" data-ink="yes" data-page="${page}">Clear</button></div>
  </div>`);
  pop.querySelector('[data-ink="yes"]').focus();
}

function closeConfirm(v) { v.root.querySelector(".pv-confirm")?.remove(); }

function clearPage(v) {
  const page = Number(v.root.querySelector('.pv-confirm [data-ink="yes"]')?.dataset.page);
  closeConfirm(v);
  const p = v.pages[page - 1];
  if (!p) return;
  commitEdit(v);
  change(v, p, () => M.setMarks(all(), v.src, page, []));
  toast(`${word(v) === "page" ? "Page" : "Slide"} ${page} cleared. ${MAC ? "⌘" : "Ctrl+"}Z brings it back.`);
}

// ---- export (pdf-export.js: the marks, the notes as sticky notes and a "My notes" list)

async function exportPdf(v, button) {
  if (v.ink.busy) return;
  commitEdit(v);
  const { notes, marks } = annotationCounts(v.src);
  if (!notes && !marks) { toast(`Nothing to export yet: highlight, draw, write or add a note on the ${word(v)}s first.`); return; }
  v.ink.busy = true;
  button?.classList.add("busy");
  try {
    const name = await exportAnnotated(v.src, await urlBytes(v.url));
    if (!v.closed) toast(tauri ? `Saved in Downloads: ${name}` : `Downloaded: ${name}`);
  } catch (e) {
    console.error(e);
    toast(e.message, "error");
  } finally {
    v.ink.busy = false;
    button?.classList.remove("busy");
  }
}
