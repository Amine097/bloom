// Putting a lecture PDF's text straight into a Notebook prompt, so the assistant does not have to
// read the PDF in several slow tool calls first. Pure, covered by tests/pdftext.test.mjs.
//
// The text comes from the native shell (`pdf_text` in src-tauri/src/lib.rs, PDFKit) or the preview
// server (POST /api/pdf-text of scripts/preview.mjs), as one string where "--- Page n ---" starts
// page n. When it is missing, too thin (a scanned PDF) or too long, the prompt is left exactly as
// it was: the assistant then reads the PDF itself, as before.
import { PDF_TOKEN } from "./notebook-core.js";

/** Starts page n in the extracted text, and in the prompt. */
export const pageMark = n => `--- Page ${n} ---`;
const MARK = /^--- Page (\d+) ---$/;

/** Most characters inlined (about 50,000 tokens); a longer text is not inlined at all. */
export const TEXT_MAX = 200_000;
/** Fewest characters (not counting spaces) for the text to be worth inlining. */
export const MIN_CHARS = 300;
/** A page with fewer characters than this counts as empty (a figure, a scan). */
export const PAGE_MIN = 20;
/** At least this share of the pages must have text. */
export const MIN_FILLED = 0.5;

// the opening the Notebook prompts share (notebook-core.js, cards-core.js, chat-core.js)
const READ_LINE = /^Use the Read tool to read the lecture PDF at this path: "\{\{PDF\}\}"$/m;
const WHOLE_LINE = /^Read the whole document\. If it is long, read it in parts \(at most 20 pages at a time\) until you have covered every page\.$/m;

/** What replaces WHOLE_LINE; adaptPrompt() in assistant-core.js rewrites MAY_READ for Codex. */
export const MAY_READ = "you may use the Read tool on that page of the PDF (with its pages parameter)";
const whole = () => `Cover the whole document, from its first page to its last.
The text above was extracted from the PDF file at this path: "${PDF_TOKEN}". It can miss figures, diagrams and the layout of tables: when a page's text is empty or unclear, or a figure on it matters, ${MAY_READ}. Do not read the whole PDF again: the text above is complete.`;
/**
 * With schemas (D.settings.schemas): the text is inlined all the same (its exact words), and the
 * assistant also looks at every page, for the figures. adaptPrompt() rewrites READ_ALL for Codex.
 */
export const READ_ALL = "also use the Read tool to look at every page of that PDF, from its first page to its last (with its pages parameter, at most 20 pages at a time)";
const wholeWithFigures = () => `Cover the whole document, from its first page to its last.
The text above was extracted from the PDF file at this path: "${PDF_TOKEN}". It leaves out what the figures, diagrams, schemas, tables and graphs show, and they matter here: ${READ_ALL}, and study every figure on them. Use the text above for the exact words.`;
/** Marks a prompt whose PDF text was inlined (see adaptPrompt() in assistant-core.js). */
export const INLINED = 'Here is the text of the lecture PDF, page by page ("--- Page n ---" starts page n):';

const clean = s => String(s)
  .replace(/\r\n?/g, "\n")
  .replace(/[\f\v\u0000-\u0008\u000e-\u001f]/g, "")
  .replace(/[ \t ]{2,}/g, "  ")
  .replace(/[ \t]+$/gm, "")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

const chars = s => s.replace(/\s+/g, "").length;

/**
 * The pages of an extracted text: [{ n, text }] in order, `n` being the PDF's own page number.
 * [] when the text has no page marks.
 */
export function pagesOf(raw) {
  const pages = [];
  let cur = null;
  for (const line of String(raw ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const m = line.trim().match(MARK);
    if (m) { cur = { n: Number(m[1]), lines: [] }; pages.push(cur); }
    else if (cur) cur.lines.push(line);
  }
  return pages.map(p => ({ n: p.n, text: clean(p.lines.join("\n")) }));
}

/**
 * The text block to inline, or null when the text is not worth it: no pages, too few characters,
 * most pages empty (a scanned PDF), page numbers not 1, 2, 3… or longer than TEXT_MAX.
 */
export function documentText(raw) {
  const pages = pagesOf(raw);
  if (!pages.length || pages.some((p, i) => p.n !== i + 1)) return null;
  const total = pages.reduce((n, p) => n + chars(p.text), 0);
  const filled = pages.filter(p => chars(p.text) >= PAGE_MIN).length;
  if (total < MIN_CHARS || filled < pages.length * MIN_FILLED) return null;
  // the text must not carry the placeholder replaced by the path, nor close the block early
  const body = pages
    .map(p => `${pageMark(p.n)}\n${p.text.split(PDF_TOKEN).join("{PDF}").replace(/<\/?document>/gi, "")}`)
    .join("\n\n");
  return body.length > TEXT_MAX ? null : body;
}

/**
 * `prompt` with the instruction to read the PDF replaced by the PDF's text (`raw`, as pagesOf()
 * reads it), plus a line saying the PDF may still be read for a figure. With `schemas`, that line
 * asks instead to look at every page of the PDF as well. Unchanged when the prompt has no such
 * instruction or the text is not usable (documentText() is null): the assistant then reads the
 * whole PDF itself, which covers the figures too.
 */
export function inlinePdfText(prompt, raw, { schemas = false } = {}) {
  const text = String(prompt ?? "");
  if (!READ_LINE.test(text)) return text;
  const doc = documentText(raw);
  if (!doc) return text;
  const after = schemas ? wholeWithFigures : whole;
  // functions as replacements: the PDF's text may hold "$&" and the like
  // the instruction lines first, so that nothing in the PDF's text can be taken for one
  const block = `${INLINED}\n<document>\n${doc}\n</document>`;
  return WHOLE_LINE.test(text)
    ? text.replace(WHOLE_LINE, () => after()).replace(READ_LINE, () => block)
    : text.replace(READ_LINE, () => `${block}\n${after()}`);
}
