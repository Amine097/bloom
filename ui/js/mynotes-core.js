// "Use my notes": her own notes and marks on a PDF, given to the assistant as extra material when it
// writes quiz questions or flashcards. Pure, covered by tests/mynotes.test.mjs.
//
// What is read (never changed here):
// - her notes per slide, D.slideNotes[src][page] = { text, at } (slidenotes-core.js);
// - her marks, D.pdfMarks[src][page] = [mark] (marks-core.js): highlights, pen strokes, text boxes.
//   A highlight made since "Use my notes" exists also keeps the words she selected, `text` (a
//   string, written by viewer-marks.js when she highlights); older highlights have only their
//   rectangles, and are given as "a passage highlighted on page n".
// `src` is the quiz source (a lecture id, or "fiche:<id>"; sources.js).
//
// The choice is D.settings.useNotes (absent = off, so no migration). When it is off, or the source
// has nothing, the prompts are exactly what they were without it.

/** Most characters of the list of her notes in a prompt; what does not fit is left out politely. */
export const NOTES_MAX = 12_000;
/** Most characters kept of one note, one highlighted passage, one text box. */
export const NOTE_MAX = 1_500, HIGHLIGHT_MAX = 500, TEXTBOX_MAX = 600;

// the token the caller replaces with the PDF's path (PDF_TOKEN of notebook-core.js), and the tags
// around the block: her text must not carry the one or close the other
const TOKEN = "{{PDF}}";
const OPEN = "<her-notes>", CLOSE = "</her-notes>";

/** Her text made safe and tidy: no token, no closing tag, no trailing spaces, at most `max` characters. */
function tidy(text, max, oneLine = false) {
  let s = String(text ?? "").replace(/\r\n?/g, "\n").split(TOKEN).join("{PDF}").replace(/<\/?her-notes>/gi, "");
  s = oneLine ? s.replace(/\s+/g, " ").trim() : s.split("\n").map(l => l.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

const pageNumbers = (...objs) => [...new Set(objs.flatMap(o => Object.keys(o || {})))]
  .map(Number).filter(n => Number.isInteger(n) && n > 0).sort((a, b) => a - b);

/**
 * Her notes and marks on one PDF, page by page, in page order: [{ page, note, highlights, texts,
 * drawn }] where `note` is her slide note ("" when none), `highlights` the passages she highlighted
 * (a string, or null for an older highlight whose words were not kept), `texts` her text boxes and
 * `drawn` whether she drew with the pen. Pages with nothing are left out. `notes` and `marks` are
 * the source's entries of D.slideNotes and D.pdfMarks; `from`/`to` keep only those pages.
 */
export function notesPages(notes, marks, { from = 1, to = Infinity } = {}) {
  const out = [];
  for (const page of pageNumbers(notes, marks)) {
    if (page < from || page > to) continue;
    const note = tidy(notes?.[page]?.text, NOTE_MAX);
    const list = Array.isArray(marks?.[page]) ? marks[page].filter(m => m && typeof m === "object") : [];
    const highlights = list.filter(m => m.kind === "highlight").map(m => tidy(m.text, HIGHLIGHT_MAX, true) || null);
    const texts = list.filter(m => m.kind === "text").map(m => tidy(m.text, TEXTBOX_MAX)).filter(Boolean);
    const drawn = list.some(m => m.kind === "pen");
    if (note || highlights.length || texts.length || drawn) out.push({ page, note, highlights, texts, drawn });
  }
  return out;
}

/** How much she wrote and marked on the sources `srcs`: { notes, highlights, texts, drawings (pages drawn on) }. */
export function notesStats(allNotes, allMarks, srcs) {
  const s = { notes: 0, highlights: 0, texts: 0, drawings: 0 };
  for (const src of new Set(srcs || [])) {
    for (const p of notesPages(allNotes?.[src], allMarks?.[src])) {
      s.notes += p.note ? 1 : 0;
      s.highlights += p.highlights.length;
      s.texts += p.texts.length;
      s.drawings += p.drawn ? 1 : 0;
    }
  }
  return s;
}

/** Whether there is anything to give. */
export const hasNotes = s => Boolean(s && (s.notes || s.highlights || s.texts || s.drawings));

/** "12 notes · 5 highlights · 1 text box", or "No notes yet". */
export function notesSummary(s) {
  if (!hasNotes(s)) return "No notes yet";
  const n = (k, one, many = one + "s") => (k ? `${k} ${k === 1 ? one : many}` : "");
  return [n(s.notes, "note"), n(s.highlights, "highlight"), n(s.texts, "text box", "text boxes"),
    n(s.drawings, "drawn page")].filter(Boolean).join(" · ");
}

/** One page of the list. */
function pageText(p) {
  const lines = [`Page ${p.page}:`];
  const indent = s => s.replace(/\n/g, "\n    ");
  if (p.note) lines.push(`- Her note: ${indent(p.note)}`);
  for (const h of p.highlights) lines.push(h ? `- She highlighted: "${h}"` : `- She highlighted a passage on page ${p.page} (its words were not kept).`);
  for (const t of p.texts) lines.push(`- She wrote on the slide: ${indent(t)}`);
  if (p.drawn && lines.length === 1) lines.push("- She drew on this page.");
  return lines.join("\n");
}

/**
 * The block of her notes for a prompt that writes `what`s ("question" or "card"), or "" when
 * `pages` (from notesPages) is empty or missing. `themes`: the prompt asks for themes, so the block
 * reminds to keep to them. The list stops before NOTES_MAX characters and says how many pages it
 * left out.
 */
export function myNotesBlock(pages, { what = "question", themes = false } = {}) {
  if (!Array.isArray(pages) || !pages.length) return "";
  const parts = [];
  let size = 0;
  for (const p of pages) {
    const t = pageText(p);
    if (parts.length && size + t.length + 2 > NOTES_MAX) break;
    parts.push(t.length > NOTES_MAX ? t.slice(0, NOTES_MAX - 1) + "…" : t);
    size += t.length + 2;
  }
  const left = pages.length - parts.length;
  if (left) parts.push(`(${left} more page${left === 1 ? "" : "s"} with her notes ${left === 1 ? "is" : "are"} left out here, for length.)`);
  return `The student's own notes and marks on these slides, page by page (she wrote them while studying):
${OPEN}
${parts.join("\n\n")}
${CLOSE}
How to use them:
- Weigh more heavily what she marked or wrote about: more of the ${what}s are about those passages and pages.
- Her notes may add what the slides do not say (for example what the professor said in class). They count as part of the document: you may write ${what}s on what they add, with "page" the page of the note.
- When a note contradicts a slide, follow her note: it is her correction.
- Otherwise write from the whole document as usual${themes ? ", and keep to the chosen themes" : ""}.
- Never mention her notes, her highlights or "the student" in the ${what}s.`;
}

/** The line every Notebook generation prompt ends with, before the JSON shape. */
const SHAPE = "\nThe reply must be exactly this shape:";

/** `prompt` with `block` put just before its reply shape (at the end when it has none); unchanged when `block` is "". */
export function withMyNotes(prompt, block) {
  const s = String(prompt);
  if (!block) return s;
  const at = s.lastIndexOf(SHAPE);
  return at === -1 ? `${s}\n\n${block}` : `${s.slice(0, at)}\n${block}\n${s.slice(at)}`;
}
