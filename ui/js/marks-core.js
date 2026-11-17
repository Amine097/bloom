// Her annotations drawn on PDFs, kept in D.pdfMarks (v8, see migrate in store.js):
//   { [src]: { [page]: [mark] } }
// `src` is the quiz source of the PDF, as for the notes per slide (a lecture id, or "fiche:<id>";
// see sources.js), `page` the PDF page, from 1. A mark is one of:
//   { id, kind: "highlight", color, at: "YYYY-MM-DD", rects: [[x, y, w, h], …] }
//   { id, kind: "pen",       color, at, width, points: [[x, y], …] }
//   { id, kind: "text",      color, at, x, y, size, text }
// x, y, w, h are fractions of the page as shown (0..1 from its top-left corner, after any /Rotate),
// so the marks stay in place at any zoom and in the exported PDF. `width` (pen) and `size` (text,
// the font size) are in PDF points. `color` is a key of HUES. A text box's x, y is its top-left
// corner; its lines are separated by "\n".
// Pure functions: the PDF viewer (viewer.js) draws, edits and exports them. Marks never change the
// PDF file, and nothing else reads them.

/** Colours by key: [highlighter, ink]. Highlights use the first, pen strokes and text the second. */
export const HUES = {
  yellow: ["#ffd84d", "#c99a06"],
  pink: ["#ff8fc0", "#d6336c"],
  green: ["#7ee08a", "#2f9e44"],
  blue: ["#80c8ff", "#1c7ed6"],
  red: ["#ff9a8a", "#e03131"],
  ink: ["#b9adbf", "#2b2130"],
};
/** The colours offered for each tool, the first being the default. */
export const PALETTE = {
  highlight: ["yellow", "pink", "green", "blue"],
  pen: ["ink", "red", "blue", "green", "pink"],
  text: ["ink", "red", "blue", "green", "pink"],
};
/** How see-through a highlight is (it is also multiplied with the page, like a real highlighter). */
export const HIGHLIGHT_OPACITY = 0.42;
/** Text boxes: line height and inner padding, in font sizes; the backing behind the text. */
// TEXT_BASE: the baseline of a line below its top, in font sizes, for Fira Sans (the font of the
// boxes on screen and in the export) with that line height.
export const TEXT_LINE = 1.25, TEXT_PAD = 0.3, TEXT_BASE = 0.96, TEXT_BACK = 0.82;

/** The CSS/hex colour of a mark. */
export const hexOf = (kind, color) => (HUES[color] || HUES[PALETTE[kind]?.[0] || "ink"])[kind === "highlight" ? 0 : 1];

/** The two pen widths and the font size of a text box, in points, for a page `w` points wide. */
export const penWidth = (w, thick) => round1(Math.max(1, w / (thick ? 170 : 420)));
export const textSize = w => Math.round(Math.min(16, Math.max(9, w / 55)));

const r4 = n => Math.round(n * 1e4) / 1e4;
const round1 = n => Math.round(n * 10) / 10;
const clamp01 = n => Math.min(1, Math.max(0, n));

// ---- reading and writing D.pdfMarks

/** The marks of one PDF, `{}` when it has none. */
export const marksOf = (all, src) => (all && src && all[src]) || {};

/** The marks of a page, in drawing order; `[]` when it has none. */
export const marksOn = (all, src, page) => marksOf(all, src)[page] || [];

/** How many pages of a PDF carry marks. */
export const markedCount = (all, src) => Object.keys(marksOf(all, src)).length;

/** Replaces the marks of a page; an empty list removes the page, and an empty PDF its entry. */
export function setMarks(all, src, page, list) {
  const key = String(page);
  if (list?.length) { (all[src] ??= {})[key] = list; return; }
  if (!all[src]) return;
  delete all[src][key];
  if (!Object.keys(all[src]).length) delete all[src];
}

/** Adds a mark on top of the others of its page. */
export const addMark = (all, src, page, mark) => setMarks(all, src, page, [...marksOn(all, src, page), mark]);

/** Removes the mark `id` from a page. Returns whether it was there. */
export function removeMark(all, src, page, id) {
  const list = marksOn(all, src, page);
  const left = list.filter(m => m.id !== id);
  if (left.length === list.length) return false;
  setMarks(all, src, page, left);
  return true;
}

/** Changes some fields of the mark `id` (a moved or retyped text box). Returns the mark. */
export function updateMark(all, src, page, id, fields) {
  const list = marksOn(all, src, page);
  const i = list.findIndex(m => m.id === id);
  if (i < 0) return null;
  const next = list.slice();
  next[i] = { ...list[i], ...fields };
  setMarks(all, src, page, next);
  return next[i];
}

// ---- undo: the state of a page before each action on the open PDF

export const UNDO_MAX = 60;

/** Remembers the marks of `page` as they are now, before an action changes them. */
export function pushUndo(stack, all, src, page) {
  stack.push({ page: Number(page), before: JSON.stringify(marksOn(all, src, page)) });
  if (stack.length > UNDO_MAX) stack.shift();
}

/** Puts back the page of the last action as it was before it. Returns that page, or null. */
export function undo(stack, all, src) {
  const last = stack.pop();
  if (!last) return null;
  setMarks(all, src, last.page, JSON.parse(last.before));
  return last.page;
}

// ---- making marks

/**
 * Highlight rectangles from the boxes of selected text (fractions of the page): tiny boxes are
 * dropped, boxes on the same line that touch or overlap are joined, and all are rounded.
 */
export function mergeRects(rects) {
  const boxes = rects
    .map(([x, y, w, h]) => [clamp01(x), clamp01(y), clamp01(x + w), clamp01(y + h)])
    .filter(([x1, y1, x2, y2]) => x2 - x1 > 0.001 && y2 - y1 > 0.002)
    .sort((a, b) => (a[1] + a[3]) / 2 - (b[1] + b[3]) / 2 || a[0] - b[0]);
  const lines = [];
  for (const b of boxes) {
    const mid = (b[1] + b[3]) / 2, h = b[3] - b[1];
    const line = lines.find(l => Math.abs((l.y1 + l.y2) / 2 - mid) < Math.min(l.y2 - l.y1, h) / 2);
    if (line) { line.y1 = Math.min(line.y1, b[1]); line.y2 = Math.max(line.y2, b[3]); line.boxes.push(b); }
    else lines.push({ y1: b[1], y2: b[3], boxes: [b] });
  }
  const out = [];
  for (const l of lines) {
    l.boxes.sort((a, b) => a[0] - b[0]);
    const gap = (l.y2 - l.y1) * 0.6; // a word space
    let cur = null;
    for (const b of l.boxes) {
      if (cur && b[0] <= cur[2] + gap) cur[2] = Math.max(cur[2], b[2]);
      else { cur = [b[0], l.y1, b[2], l.y2]; out.push(cur); }
    }
  }
  return out.map(([x1, y1, x2, y2]) => [r4(x1), r4(y1), r4(x2 - x1), r4(y2 - y1)]);
}

/**
 * Fewer points for the same stroke (Ramer–Douglas–Peucker), so the data stays small. Points are
 * fractions of a page `w` × `h` points; `tol` is in points. The result is rounded.
 */
export function simplify(points, w = 1, h = 1, tol = 0.6) {
  const pts = points.filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length < 3) return pts.map(([x, y]) => [r4(x), r4(y)]);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const todo = [[0, pts.length - 1]];
  while (todo.length) {
    const [a, b] = todo.pop();
    let far = -1, best = tol;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(pts[i][0] * w, pts[i][1] * h, pts[a][0] * w, pts[a][1] * h, pts[b][0] * w, pts[b][1] * h);
      if (d > best) { best = d; far = i; }
    }
    if (far > 0) { keep[far] = 1; todo.push([a, far], [far, b]); }
  }
  const out = [];
  pts.forEach(([x, y], i) => {
    if (!keep[i]) return;
    const p = [r4(x), r4(y)];
    const prev = out[out.length - 1];
    if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) out.push(p);
  });
  return out;
}

/** Distance from (px, py) to the segment (ax, ay)–(bx, by). */
export function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * A smooth SVG path through `points` (already in the units to draw in): quadratic curves through
 * the middles of the segments. A single point becomes a dot.
 */
export function smoothPath(points) {
  const f = n => String(Math.round(n * 100) / 100);
  if (!points.length) return "";
  const [x0, y0] = points[0];
  if (points.length === 1) return `M${f(x0)} ${f(y0)}L${f(x0 + 0.01)} ${f(y0)}`;
  if (points.length === 2) return `M${f(x0)} ${f(y0)}L${f(points[1][0])} ${f(points[1][1])}`;
  let d = `M${f(x0)} ${f(y0)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i], [nx, ny] = points[i + 1];
    d += `Q${f(x)} ${f(y)} ${f((x + nx) / 2)} ${f((y + ny) / 2)}`;
  }
  const [lx, ly] = points[points.length - 1];
  return d + `L${f(lx)} ${f(ly)}`;
}

// ---- text boxes

/** The lines of a text box. */
export const textLines = text => String(text ?? "").replace(/\r/g, "").split("\n");

/** A rough width of a text in Helvetica, in points (the viewer measures the real one on screen). */
export const roughWidth = (text, size) => [...String(text)].reduce((s, c) => s + (/[ il.,:;'|!]/.test(c) ? 0.28 : /[mwMW]/.test(c) ? 0.85 : /[A-Z]/.test(c) ? 0.67 : 0.53), 0) * size;

/** The box of a text mark as fractions [x, y, w, h] of a page `w` × `h` points. */
export function textBox(mark, w, h, measure = roughWidth) {
  const lines = textLines(mark.text);
  const pad = mark.size * TEXT_PAD;
  const bw = Math.max(...lines.map(l => measure(l, mark.size))) + 2 * pad;
  const bh = lines.length * mark.size * TEXT_LINE + 2 * pad;
  return [mark.x, mark.y, bw / w, bh / h];
}

// ---- the eraser

/**
 * The topmost mark under the point (x, y) (fractions of a page `w` × `h` points), within `tol`
 * points: its id, or null.
 */
export function hitTest(list, x, y, w, h, tol = 5) {
  const px = x * w, py = y * h;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.kind === "pen") {
      const pts = m.points.map(([a, b]) => [a * w, b * h]);
      const reach = (m.width || 1) / 2 + tol;
      if (pts.length === 1 && Math.hypot(px - pts[0][0], py - pts[0][1]) <= reach) return m.id;
      for (let j = 1; j < pts.length; j++) if (segDist(px, py, ...pts[j - 1], ...pts[j]) <= reach) return m.id;
    } else {
      const rects = m.kind === "text" ? [textBox(m, w, h)] : m.rects || [];
      const t = tol / 2;
      if (rects.some(([rx, ry, rw, rh]) => px >= rx * w - t && px <= (rx + rw) * w + t && py >= ry * h - t && py <= (ry + rh) * h + t)) return m.id;
    }
  }
  return null;
}

// ---- export: drawing the marks into the PDF

/**
 * The PDF user-space point of a point given as fractions of the page as shown. `box` is the page's
 * crop box { x, y, width, height } in points and `rotate` its /Rotate (0, 90, 180, 270), which
 * pdf.js applied when the page was shown.
 */
export function pdfPoint(fx, fy, box, rotate = 0) {
  const r = ((Math.round(rotate / 90) * 90) % 360 + 360) % 360;
  const { x, y, width: w, height: h } = box;
  if (r === 90) return [x + fy * w, y + fx * h];
  if (r === 180) return [x + (1 - fx) * w, y + fy * h];
  if (r === 270) return [x + (1 - fy) * w, y + (1 - fx) * h];
  return [x + fx * w, y + (1 - fy) * h];
}

/** The size of the page as shown, in points: its crop box, turned by /Rotate. */
export const shownSize = (box, rotate = 0) => (Math.abs(Math.round(rotate / 90)) % 2 ? { w: box.height, h: box.width } : { w: box.width, h: box.height });

/** Hex "#rrggbb" → [r, g, b] in 0..1. */
export const rgbOf = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);

/**
 * What to draw on one page of the exported PDF, in order: a list of
 *   { op: "path", d, fill?: [r,g,b], stroke?: [r,g,b], width?, opacity, multiply? }
 *   { op: "text", x, y, size, rotate, text, color: [r,g,b] }
 * Paths are SVG paths in PDF user space with y negated (pdf-lib's drawSvgPath at x 0, y 0 turns it
 * back up). Text lines start at their baseline. `measure(text, size)` is the width of a text in the
 * export's fonts; `clean(text)` keeps only what they can draw (winAnsi when only Helvetica is left).
 */
export function exportOps(list, box, rotate = 0, measure = roughWidth, clean = winAnsi) {
  const { w, h } = shownSize(box, rotate);
  const at = (fx, fy) => { const [x, y] = pdfPoint(fx, fy, box, rotate); return [x, -y]; };
  const poly = corners => corners.map(([fx, fy], i) => { const [x, y] = at(fx, fy); return `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`; }).join("") + "Z";
  const rect = ([x, y, rw, rh]) => poly([[x, y], [x + rw, y], [x + rw, y + rh], [x, y + rh]]);
  const ops = [];
  for (const m of list) {
    const color = rgbOf(hexOf(m.kind, m.color));
    if (m.kind === "highlight") {
      if (m.rects?.length) ops.push({ op: "path", d: m.rects.map(rect).join(""), fill: color, opacity: HIGHLIGHT_OPACITY, multiply: true });
    } else if (m.kind === "pen") {
      if (m.points?.length) ops.push({ op: "path", d: smoothPath(m.points.map(([x, y]) => at(x, y))), stroke: color, width: m.width || 1, opacity: 1 });
    } else if (m.kind === "text") {
      const lines = textLines(clean(m.text));
      if (!lines.some(l => l.trim())) continue;
      ops.push({ op: "path", d: rect(textBox({ ...m, text: lines.join("\n") }, w, h, measure)), fill: [1, 1, 1], opacity: TEXT_BACK });
      const pad = m.size * TEXT_PAD;
      lines.forEach((line, i) => {
        if (!line) return;
        const [x, y] = pdfPoint(m.x + pad / w, m.y + (pad + (i * TEXT_LINE + TEXT_BASE) * m.size) / h, box, rotate);
        ops.push({ op: "text", x, y, size: m.size, rotate: ((Math.round(rotate / 90) * 90) % 360 + 360) % 360, text: line, color });
      });
    }
  }
  return ops;
}

// ---- fonts of the export: Fira Sans, then DejaVu Sans for the symbols it lacks

/**
 * A line cut into runs by font: `font` is "main" for characters the main font has (`hasMain(code)`),
 * "fallback" for those only the fallback has. Characters neither has are spelled out (→ "->") or
 * become "?", in the main font.
 */
export function fontRuns(text, hasMain, hasFallback = () => false) {
  const runs = [];
  const push = (t, font) => {
    const last = runs[runs.length - 1];
    if (last?.font === font) last.text += t; else runs.push({ text: t, font });
  };
  for (const c of String(text ?? "")) {
    const n = c.codePointAt(0);
    if (hasMain(n)) push(c, "main");
    else if (hasFallback(n)) push(c, "fallback");
    else push([...(SPELL[c] ?? "?")].map(d => (hasMain(d.codePointAt(0)) ? d : "?")).join(""), "main");
  }
  return runs;
}

/** The text as `fontRuns` draws it (for measuring and for the text boxes' backing). */
export const fontText = (text, hasMain, hasFallback) =>
  textLines(text).map(l => fontRuns(l, hasMain, hasFallback).map(r => r.text).join("")).join("\n");

/**
 * Where each run of a line starts: [{ text, font, x, y }], from the line's start (x, y) along its
 * direction (`rotate` degrees, counter-clockwise). `widthOf(run)` is the run's width in points.
 */
export function placeRuns(x, y, rotate, runs, widthOf) {
  const a = rotate * Math.PI / 180, dx = Math.round(Math.cos(a) * 1e6) / 1e6, dy = Math.round(Math.sin(a) * 1e6) / 1e6;
  let along = 0;
  return runs.map(r => {
    const out = { ...r, x: x + along * dx, y: y + along * dy };
    along += widthOf(r);
    return out;
  });
}

// ---- her notes in the export

/**
 * The rectangle [x1, y1, x2, y2] (PDF user space) of a sticky note at the top-right corner of a page
 * as shown, `size` points wide.
 */
export function noteIconRect(box, rotate = 0, size = 22) {
  const { w, h } = shownSize(box, rotate);
  const fx = 1 - (size + 10) / w, fy = 10 / h;
  const [ax, ay] = pdfPoint(fx, fy, box, rotate), [bx, by] = pdfPoint(fx + size / w, fy + size / h, box, rotate);
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)].map(n => Math.round(n * 100) / 100);
}

/** A text cut into lines no wider than `max` points (`measure(text)`); long words are cut too. */
export function wrapText(text, max, measure) {
  const out = [];
  for (const para of textLines(text)) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      const next = line + word;
      if (!line || measure(next) <= max) { line = next; }
      else { out.push(line.trimEnd()); line = word.trimStart(); }
      while (measure(line) > max && line.length > 1) { // a word longer than the line
        let cut = line.length - 1;
        while (cut > 1 && measure(line.slice(0, cut)) > max) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

/**
 * The "My notes" pages at the end of the export: a list of pages, each a list of
 *   { text, x, y, size, kind: "title" | "sub" | "label" | "text" }   (y is the baseline, from the bottom)
 * `notes` are [{ page, text }] in page order, `word` is "Slide" or "Page", `measure(text, size)`.
 */
export function notesLayout(notes, { title = "My notes", sub = "", word = "Slide", width = 595.28, height = 841.89, margin = 56, measure = roughWidth } = {}) {
  const pages = [];
  const labelW = 62, lh = 11 * 1.45;
  let page = null, y = 0;
  const start = () => { page = []; pages.push(page); y = height - margin; };
  const put = (text, x, size, kind) => page.push({ text, x, y: Math.round(y * 100) / 100, size, kind });
  start();
  y -= 22; put(title, margin, 22, "title");
  if (sub) { y -= 18; put(sub, margin, 10.5, "sub"); }
  y -= 16;
  for (const n of notes) {
    const lines = wrapText(n.text, width - 2 * margin - labelW, t => measure(t, 11));
    if (y - lh * Math.min(lines.length, 3) < margin) start(); // a note does not start at the very bottom
    y -= lh;
    put(`${word} ${n.page}`, margin, 10.5, "label");
    lines.forEach((l, i) => {
      if (i) { if (y - lh < margin) start(); y -= lh; }
      if (l) put(l, margin + labelW, 11, "text");
    });
    y -= 9;
  }
  return pages;
}

// The standard fonts of a PDF only know the WinAnsi characters: the others are spelled out.
const WIN = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
const SPELL = { "→": "->", "←": "<-", "↔": "<->", "⇒": "=>", "↑": "^", "↓": "v", "≥": ">=", "≤": "<=", "≠": "!=", "≈": "~", "−": "-", "×": "x", "α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta", "Δ": "Delta", "κ": "kappa", "λ": "lambda", "μ": "µ", "π": "pi", "σ": "sigma", "τ": "tau", "ω": "omega", "\t": " " };

/** The text with only characters Helvetica (WinAnsi) can draw. */
export function winAnsi(text) {
  let out = "";
  for (const c of String(text ?? "")) {
    const n = c.codePointAt(0);
    if (c === "\n" || n >= 32 && n < 127 || n >= 160 && n <= 255 || WIN.includes(c)) out += c;
    else out += SPELL[c] ?? "?";
  }
  return out;
}

/** The file name of the exported copy: "<original name> (annotated).pdf". */
export function annotatedName(name) {
  const base = String(name || "Slides").replace(/\.pdf$/i, "").replace(/[\/\\:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim() || "Slides";
  return `${base} (annotated).pdf`;
}
