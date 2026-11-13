// The Notebook's "Ask" tab without the screen: the prompt for one question about a lecture PDF
// (with the last exchanges, so follow-up questions work), the reader of Claude's reply, and the
// safe formatter of the answer text. Pure, covered by tests/chat.test.mjs.
//
// D.notebook[itemId].chat = [{ id, q, a: string | null, pages: [n], at: "YYYY-MM-DD" }], oldest
// first; `a` is null while Claude has not answered (or the run failed). The field may be absent.
import { PDF_TOKEN, extractJson } from "./notebook-core.js";

/** Most exchanges kept per lecture: the oldest go first. */
export const CHAT_KEEP = 30;
/** Longest question, in characters. */
export const Q_MAX = 1000;
/** How many earlier exchanges go into the prompt, and at most how many characters of them. */
export const HISTORY_TURNS = 4;
export const HISTORY_CHARS = 6000;
const ANSWER_IN_HISTORY = 1500;
const PAGES_MAX = 8;

/** The fixed suggestions shown while the conversation is empty. */
export const SUGGESTIONS = [
  "Summarise this lecture in 5 points",
  "What are the most likely exam questions?",
  "Explain the hardest concept simply",
];

// her text must never carry the placeholder that is replaced by the path of the PDF
const clean = s => String(s ?? "").split(PDF_TOKEN).join("{PDF}").replace(/\r\n?/g, "\n").trim();
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** A question as it is stored and sent: trimmed, at most Q_MAX characters. "" when empty. */
export const cleanQuestion = s => clean(s).slice(0, Q_MAX).trim();

/** The exchanges of a lecture, whatever was saved: only well-formed ones, never throws. */
export function chatOf(notes) {
  const c = notes?.chat;
  if (!Array.isArray(c)) return [];
  return c.filter(x => x && typeof x === "object" && typeof x.id === "string" && typeof x.q === "string");
}

/** The conversation after adding `ex` at the end, keeping the last `keep`. Does not change `chat`. */
export const addExchange = (chat, ex, keep = CHAT_KEEP) => [...chat, ex].slice(-keep);

/**
 * The earlier exchanges that go into the prompt: answered ones only, the last HISTORY_TURNS, oldest
 * first, long answers shortened, and the oldest dropped until they fit in HISTORY_CHARS.
 */
export function historyFor(chat) {
  const out = chat.filter(x => typeof x?.a === "string" && x.a.trim())
    .slice(-HISTORY_TURNS)
    .map(x => ({ q: cut(cleanQuestion(x.q), Q_MAX), a: cut(clean(x.a), ANSWER_IN_HISTORY) }));
  const size = list => list.reduce((n, x) => n + x.q.length + x.a.length, 0);
  while (out.length && size(out) > HISTORY_CHARS) out.shift();
  return out;
}

/**
 * The prompt for one question about the lecture PDF. `history` is the conversation before it
 * ([{ q, a }], oldest first); only what historyFor() keeps is sent.
 */
export function chatPrompt(title, question, history = []) {
  const past = historyFor(history);
  const convo = past.map((x, i) => `Question ${i + 1}: ${x.q}\nAnswer ${i + 1}: ${x.a}`).join("\n\n");
  return `You are helping a university student revise a lecture.
Use the Read tool to read the lecture PDF at this path: "${PDF_TOKEN}"
The lecture is called ${JSON.stringify(String(title || "Untitled"))}.
Read the whole document. If it is long, read it in parts (at most 20 pages at a time) until you have covered every page.
Then answer the student's question below.

Rules:
- Answer only from this document. Do not add facts from anywhere else, even well-known ones.
- If the document does not cover the question, say so plainly at the start of the answer (for example "The lecture does not cover this."), then give only what the document does say that is related, if anything. Never guess.
- Answer in the language of the student's question, even when the document is in another language. Keep technical terms as the document writes them when that helps.
- Be clear and to the point: a short answer for a simple question, more for a broad one. Use a list when the question asks for several points or steps.
- Formatting: plain text only. Separate paragraphs with a blank line. Start each list line with "- " or "1. ". Put **double asterisks** around a key term to make it bold. No headings, tables, links, code, HTML or other markdown.
- "pages" lists the pages the answer comes from, most important first, at most 5. Page numbers are the page numbers of the PDF file: the first page of the file is page 1. Use [] when the document does not cover the question.
- Reply with JSON only: no introduction, no comments, no code fences.
${convo ? `
The conversation so far, oldest first. The new question may refer to it ("and why?", "explain the second point"):

${convo}
` : ""}
The student's question, between the two lines:
----------
${cleanQuestion(question)}
----------

The reply must be exactly this shape:
{"answer": "...", "pages": [3, 7]}`;
}

const pageNo = v => {
  const n = typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : v;
  return Number.isInteger(n) && n >= 1 ? n : null;
};

/**
 * → { answer, pages: [positive whole numbers, no repeats] }. A missing or unusable answer throws a
 * readable Error; page numbers that are not positive whole numbers are left out (the answer still
 * counts).
 */
export function parseChat(text) {
  const r = extractJson(text);
  const answer = typeof r.answer === "string" ? r.answer.replace(/\r\n?/g, "\n").trim() : "";
  if (!answer) throw new Error("Claude's answer was empty. Try again.");
  const raw = Array.isArray(r.pages) ? r.pages : r.pages == null ? [] : [r.pages];
  const pages = [...new Set(raw.map(pageNo).filter(n => n !== null))].slice(0, PAGES_MAX);
  return { answer, pages };
}

// ---- the answer on screen

const escape = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/** **bold** on text that is already escaped. */
const inline = s => s.replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, "<strong>$1</strong>");

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBER = /^\s*(\d{1,3})[.)]\s+(.*)$/;

/**
 * Claude's plain-text answer as HTML: paragraphs (a blank line between them, single line breaks
 * kept), lists (lines starting with "- ", "* ", "• ", "1. " or "1) "), and **bold**. Everything is
 * escaped first, so no other HTML can ever come through.
 */
export function formatAnswer(text) {
  const lines = escape(String(text ?? "").replace(/\r\n?/g, "\n")).split("\n");
  const out = [];
  let para = [], list = null; // list = { tag, start, items: [string] }
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) {
      const start = list.tag === "ol" && list.start !== 1 ? ` start="${list.start}"` : "";
      out.push(`<${list.tag}${start}>${list.items.map(t => `<li>${inline(t)}</li>`).join("")}</${list.tag}>`);
    }
    list = null;
  };
  for (const line of lines) {
    if (!line.trim()) { flushPara(); flushList(); continue; }
    const b = line.match(BULLET), n = b ? null : line.match(NUMBER);
    if (b || n) {
      const tag = b ? "ul" : "ol";
      flushPara();
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, start: n ? Number(n[1]) : 1, items: [] };
      list.items.push((b ? b[1] : n[2]).trim());
    } else if (list && /^\s/.test(line)) {
      list.items[list.items.length - 1] += `<br>${line.trim()}`; // an indented line goes on with the item
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return out.join("");
}
