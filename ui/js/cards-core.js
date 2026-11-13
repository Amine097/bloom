// Flashcards logic that does not touch the screen: the prompt sent to Claude Code, the parser
// that turns its answer into cards, and the review sessions. Pure, covered by tests/cards.test.mjs.
//
// D.notebook[itemId].cards = {
//   createdAt: "YYYY-MM-DD",                    when the deck was first made
//   cards: [{ id, front, back, page: n | null, addedAt: "YYYY-MM-DD",
//             seen: n, right: n, lastSeen: "YYYY-MM-DD" | null, lastRight: true | false | null }],
// }
// "right" counts the times she graded the card "Knew it"; lastRight is her last grade.
import { PDF_TOKEN, extractJson, normText, shuffled, withAnswer } from "./notebook-core.js";

/** Most cards kept in one lecture's deck. */
export const DECK_MAX = 80;
/** How many cards she can ask Claude for at once. */
export const GEN_COUNTS = [10, 20, 30];

// the same opening as the study guide and quiz prompts of notebook-core.js
const READ = title => `You are helping a university student revise a lecture.
Use the Read tool to read the lecture PDF at this path: "${PDF_TOKEN}"
The lecture is called ${JSON.stringify(String(title || "Untitled"))}.
Read the whole document. If it is long, read it in parts (at most 20 pages at a time) until you have covered every page.

Rules:
- Use only what is in this document. Do not add facts from anywhere else.
- Write in the same language as the document.
- Page numbers are the page numbers of the PDF file: the first page of the file is page 1.
- Reply with JSON only: no introduction, no comments, no code fences.`;

/** `count` flashcards. `avoid` lists the fronts of the cards already in the deck, which Claude must not repeat. */
export function cardsPrompt(title, { count = 10, avoid = [] } = {}) {
  const known = avoid.map(t => `- ${String(t).replace(/\s+/g, " ").trim()}`).join("\n");
  return `${READ(title)}

Write ${count} flashcards that help the student learn this lecture for the exam. Test the important ideas (definitions, mechanisms, key numbers, comparisons, causes and effects), not trivia.

Every card:
- has a "front": a short question, a term to define or a prompt to complete, on one line;
- has a "back": the answer, in 1 to 3 short sentences;
- tests exactly one fact or idea: never two questions on one card;
- can be answered from this document alone;
- makes sense on its own: never mention "the lecture", "the document", "the text", "the slides" or "this figure";
- is different from the other cards: no two cards test the same fact.
Together, the cards cover the whole lecture, from its first page to its last, not only the beginning.
"page" is the page the answer comes from.
${known ? `
The student already has the cards below. Write new cards about other facts and ideas of the document; do not repeat or reword any of these:
${known}
` : ""}
The reply must be exactly this shape:
{"cards": [{"front": "...", "back": "...", "page": 1}]}`;
}

// ---- reading the answer

const fail = msg => { throw new Error(msg); };
const str = (v, what) => (typeof v === "string" && v.trim() ? v.trim() : fail(`${what} is missing.`));

/** A page number: a positive whole number (digits in a string are accepted), or null when absent. */
function page(v, what) {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : v;
  return Number.isInteger(n) && n >= 1 ? n : fail(`${what} has an invalid page number.`);
}

function card(x, i) {
  const what = `Card ${i + 1}`;
  if (!x || typeof x !== "object" || Array.isArray(x)) fail(`${what} is not in the expected form.`);
  const front = str(x.front, `The front of card ${i + 1}`);
  const back = str(x.back, `The back of card ${i + 1}`);
  if (!normText(front)) fail(`The front of card ${i + 1} has no words.`);
  if (normText(front) === normText(back)) fail(`${what} has the same text on both sides.`);
  return { front, back, page: page(x.page, what) };
}

/**
 * → { cards: [{ front, back, page }], skipped: [messages] }. Invalid cards are left out as long
 * as at least half of the batch is valid; otherwise it throws a readable Error.
 */
export function parseCards(text) {
  const z = extractJson(text);
  const all = Array.isArray(z.cards) && z.cards.length ? z.cards : fail("The cards are missing.");
  const cards = [], skipped = [];
  all.forEach((x, i) => {
    try { cards.push(card(x, i)); } catch (e) { skipped.push(e.message); }
  });
  if (cards.length * 2 < all.length) {
    fail(cards.length
      ? `Only ${cards.length} of Claude's ${all.length} cards could be used. ${skipped[0]} Try again.`
      : all.length === 1 ? skipped[0] : `None of Claude's ${all.length} cards could be used. ${skipped[0]} Try again.`);
  }
  return { cards, skipped };
}

/**
 * Adds parsed cards to a deck. Drops those whose front (normalised) is already in the deck or
 * earlier in the batch, and those beyond `max`. Does not change its arguments.
 * → { cards: the whole new deck, added: [new cards], duplicates: n, overflow: n }
 */
export function mergeCards(deck, incoming, { date, makeId, max = DECK_MAX }) {
  const seen = new Set(deck.map(x => normText(x.front)));
  const added = [];
  let duplicates = 0, overflow = 0;
  for (const x of incoming) {
    const key = normText(x.front);
    if (seen.has(key)) { duplicates++; continue; }
    if (deck.length + added.length >= max) { overflow++; continue; }
    seen.add(key);
    added.push({
      id: makeId(), front: x.front, back: x.back, page: x.page ?? null, addedAt: date,
      seen: 0, right: 0, lastSeen: null, lastRight: null,
    });
  }
  return { cards: [...deck, ...added], added, duplicates, overflow };
}

// ---- review sessions

/** A saved deck as the tab can use it, or null when there is none. Never throws on odd data. */
export function deckOf(notes) {
  const d = notes?.cards;
  if (!d || typeof d !== "object" || !Array.isArray(d.cards)) return null;
  return d;
}

/**
 * Chooses the cards of a session: first those never seen and those graded "Not yet" last time,
 * then the least recently seen; ties are broken at random. `size` is a number or "all".
 * → [card ids] in the order to show them.
 */
export function pickCards(cards, size, rand = Math.random) {
  const n = size === "all" ? cards.length : Math.max(0, Math.min(Number(size) || 0, cards.length));
  const tier = x => (!x.seen || x.lastRight === false ? 0 : 1);
  const chosen = shuffled(cards.length, rand).map(i => cards[i])
    .map((x, k) => ({ x, k }))
    .sort((a, b) => tier(a.x) - tier(b.x) || (a.x.lastSeen || "").localeCompare(b.x.lastSeen || "") || a.k - b.k)
    .slice(0, n)
    .map(({ x }) => x.id);
  return shuffled(chosen.length, rand).map(i => chosen[i]);
}

/** A card's history after she grades it: `knew` is true for "Knew it". Returns a new card. */
export const withGrade = (x, knew, date) => withAnswer(x, knew, date);

/** Where the deck stands: { total, fresh (never seen), known (last grade "Knew it"), notYet }. */
export function deckStats(cards) {
  const fresh = cards.filter(x => !x.seen).length;
  const known = cards.filter(x => x.seen && x.lastRight === true).length;
  return { total: cards.length, fresh, known, notYet: cards.length - fresh - known };
}
