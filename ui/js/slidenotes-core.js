// Her notes per slide, kept in D.slideNotes (v7, see migrate in store.js):
//   { [src]: { [page]: { text, at: "YYYY-MM-DD" } } }
// `src` is the quiz source of the PDF (a lecture id, or "fiche:<id>" for an uploaded fiche; see
// sources.js), `page` the PDF page, from 1. Pure functions: the PDF viewer (viewer.js) and the
// views call them with D.slideNotes. Notes are only stored and shown; nothing else reads them.

/** The notes of one PDF, `{}` when it has none. */
export const notesOf = (all, src) => (all && src && all[src]) || {};

/** The note of a page, "" when there is none. */
export const noteText = (all, src, page) => notesOf(all, src)[page]?.text ?? "";

/** How many slides of a PDF carry a note. */
export const noteCount = (all, src) => Object.keys(notesOf(all, src)).length;

/**
 * Writes the note of a page into `all` (D.slideNotes). A text with nothing but spaces removes the
 * note, and a PDF left without notes loses its entry. Returns whether anything changed.
 */
export function setNote(all, src, page, text, day) {
  const key = String(page);
  const had = all[src]?.[key];
  if (!String(text ?? "").trim()) {
    if (!had) return false;
    delete all[src][key];
    if (!Object.keys(all[src]).length) delete all[src];
    return true;
  }
  if (had?.text === text) return false;
  (all[src] ??= {})[key] = { text, at: day };
  return true;
}

/** The first line of a note, cut to `max` characters, for lists. */
export function firstLine(text, max = 70) {
  const line = String(text ?? "").split("\n").map(s => s.trim()).find(Boolean) || "";
  return line.length > max ? line.slice(0, max - 1).trimEnd() + "…" : line;
}

/** The notes of one PDF as a list in page order: [{ page, first, at }]. */
export const noteList = (all, src) =>
  Object.entries(notesOf(all, src))
    .map(([page, n]) => ({ page: Number(page), first: firstLine(n.text), at: n.at }))
    .filter(n => n.page > 0)
    .sort((a, b) => a.page - b.page);

/**
 * The page that shows most within the visible band [top, bottom] of a scrolled list of pages.
 * `boxes` are [{ page, top, bottom }] in the same coordinates, in page order. On a tie the
 * earlier page wins; with nothing visible, the page nearest the band.
 */
export function mostVisible(boxes, top, bottom) {
  let best = null, bestSeen = 0, near = null, nearGap = Infinity;
  for (const b of boxes) {
    const seen = Math.min(b.bottom, bottom) - Math.max(b.top, top);
    if (seen > bestSeen) { best = b.page; bestSeen = seen; }
    const gap = Math.min(Math.abs(b.top - bottom), Math.abs(b.bottom - top));
    if (gap < nearGap) { near = b.page; nearGap = gap; }
  }
  return best ?? near;
}

/** Keeps a page number inside 1..count; anything that is not a number gives `fallback`. */
export function clampPage(value, count, fallback = 1) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || !count) return fallback;
  return Math.min(count, Math.max(1, n));
}
