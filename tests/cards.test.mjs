import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cardsPrompt, parseCards, mergeCards, deckOf, pickCards, withGrade, deckStats, DECK_MAX, GEN_COUNTS,
} from "../ui/js/cards-core.js";
import { PDF_TOKEN } from "../ui/js/notebook-core.js";

const card = (over = {}) => ({ front: "What causes phase 0?", back: "Fast sodium influx.", page: 1, ...over });
const reply = cards => JSON.stringify({ cards });

test("cardsPrompt carries the PDF placeholder, the title, the count and the reply shape", () => {
  const p = cardsPrompt('Heart "rhythm"', { count: 20 });
  assert.ok(p.includes(PDF_TOKEN));
  assert.ok(p.includes('"Heart \\"rhythm\\""'));
  assert.ok(p.includes("Write 20 flashcards"));
  assert.ok(p.includes('"front"') && p.includes('"back"') && p.includes('"page"'));
  assert.ok(p.includes("same language") && p.includes("exactly one fact") && p.includes("whole lecture") && p.includes("JSON only"));
  assert.ok(!p.includes("already has"));
  assert.deepEqual(GEN_COUNTS, [10, 20, 30]);
});

test("cardsPrompt lists the cards to avoid, one per line", () => {
  const p = cardsPrompt("Heart", { count: 10, avoid: ["What causes\nphase 0?", "  Define plateau  "] });
  assert.ok(p.includes("do not repeat or reword"));
  assert.ok(p.includes("- What causes phase 0?") && p.includes("- Define plateau"));
});

test("parseCards reads plain, fenced and wrapped JSON, trims text and reads pages", () => {
  const want = [card(), card({ front: "Plateau", back: "Phase 2.", page: 2 })];
  const raw = [card({ front: "  What causes phase 0?  " }), card({ front: "Plateau", back: "Phase 2.", page: "2" })];
  assert.deepEqual(parseCards(reply(raw)), { cards: want, skipped: [] });
  assert.deepEqual(parseCards("```json\n" + reply(raw) + "\n```").cards, want);
  assert.deepEqual(parseCards("Here are your cards:\n" + reply(raw) + "\nGood luck!").cards, want);
  assert.equal(parseCards(reply([card({ page: null }), card({ front: "B", page: undefined })])).cards[1].page, null);
});

test("parseCards rejects what is not a deck, with a readable message", () => {
  assert.throws(() => parseCards(""), /empty/);
  assert.throws(() => parseCards("I could not read the file."), /could not be read/);
  assert.throws(() => parseCards(JSON.stringify({ questions: [] })), /cards are missing/);
  assert.throws(() => parseCards(reply([])), /cards are missing/);
  assert.throws(() => parseCards(reply([card({ back: "" })])), /back of card 1 is missing/);
  assert.throws(() => parseCards(reply([card({ front: 3 })])), /front of card 1 is missing/);
  assert.throws(() => parseCards(reply([card({ page: 0 })])), /page number/);
  assert.throws(() => parseCards(reply([card({ page: "two" })])), /page number/);
  assert.throws(() => parseCards(reply(["just text"])), /Card 1 is not in the expected form/);
  assert.throws(() => parseCards(reply([card({ front: "?!", back: "x" })])), /has no words/);
  assert.throws(() => parseCards(reply([card({ front: "Plateau", back: "plateau." })])), /same text on both sides/);
});

test("parseCards leaves out bad cards when at least half are good", () => {
  const r = parseCards(reply([card(), card({ front: "B" }), { front: "C" }, null]));
  assert.equal(r.cards.length, 2);
  assert.equal(r.skipped.length, 2);
  assert.match(r.skipped[0], /back of card 3/);
  assert.throws(() => parseCards(reply([card(), {}, {}])), /Only 1 of Claude's 3 cards/);
  assert.throws(() => parseCards(reply([{}, {}])), /None of Claude's 2 cards/);
});

test("mergeCards adds new cards with an empty history, drops duplicates and overflow", () => {
  let n = 0;
  const makeId = () => `c${++n}`;
  const deck = [{ id: "old", front: "What causes phase 0?", back: "Na+", page: 1, seen: 2, right: 1, lastSeen: "2026-10-01", lastRight: true }];
  const incoming = [card({ front: "what causes PHASE 0 ?!" }), card({ front: "Plateau", page: null }), card({ front: "Plateau." }), card({ front: "Déjà vu" })];
  const m = mergeCards(deck, incoming, { date: "2026-11-13", makeId });
  assert.equal(m.duplicates, 2);
  assert.equal(m.overflow, 0);
  assert.deepEqual(m.added.map(x => x.front), ["Plateau", "Déjà vu"]);
  assert.deepEqual(m.added[0], { id: "c1", front: "Plateau", back: "Fast sodium influx.", page: null, addedAt: "2026-11-13", seen: 0, right: 0, lastSeen: null, lastRight: null });
  assert.equal(m.cards.length, 3);
  assert.equal(m.cards[0], deck[0]);
  assert.equal(deck.length, 1, "the deck passed in is not changed");
  // accents do not make a new card
  assert.equal(mergeCards(m.cards, [card({ front: "deja VU" })], { date: "x", makeId }).duplicates, 1);
  // the cap
  const capped = mergeCards(deck, [card({ front: "A" }), card({ front: "B" }), card({ front: "C" })], { date: "x", makeId, max: 3 });
  assert.equal(capped.added.length, 2);
  assert.equal(capped.overflow, 1);
  assert.equal(DECK_MAX, 80);
});

test("deckOf accepts only a deck with a list of cards", () => {
  assert.equal(deckOf(undefined), null);
  assert.equal(deckOf({}), null);
  assert.equal(deckOf({ cards: null }), null);
  assert.equal(deckOf({ cards: { createdAt: "x" } }), null);
  assert.equal(deckOf({ cards: [1, 2] }), null);
  const d = { createdAt: "2026-11-13", cards: [] };
  assert.equal(deckOf({ cards: d }), d);
});

const at = (id, over = {}) => ({ id, front: id, back: "b", page: null, seen: 1, right: 1, lastSeen: "2026-11-01", lastRight: true, ...over });

test("pickCards puts never seen and not-yet cards first, then the longest unseen", () => {
  const cards = [
    at("recent", { lastSeen: "2026-11-12" }),
    at("old", { lastSeen: "2026-10-01" }),
    at("fresh", { seen: 0, right: 0, lastSeen: null, lastRight: null }),
    at("missed", { lastSeen: "2026-11-12", lastRight: false }),
    at("middle", { lastSeen: "2026-11-05" }),
  ];
  for (let s = 0; s < 20; s++) {
    let seed = s + 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const two = pickCards(cards, 2, rand);
    assert.deepEqual([...two].sort(), ["fresh", "missed"]);
    const three = pickCards(cards, 3, rand);
    assert.deepEqual([...three].sort(), ["fresh", "missed", "old"]);
    const four = pickCards(cards, 4, rand);
    assert.deepEqual([...four].sort(), ["fresh", "middle", "missed", "old"]);
  }
  assert.equal(pickCards(cards, "all").length, 5);
  assert.equal(new Set(pickCards(cards, "all")).size, 5);
  assert.equal(pickCards(cards, 50).length, 5);
  assert.deepEqual(pickCards(cards, 0), []);
  assert.deepEqual(pickCards([], "all"), []);
});

test("withGrade updates the history without changing the card passed in", () => {
  const c = at("a", { seen: 0, right: 0, lastSeen: null, lastRight: null });
  const k = withGrade(c, true, "2026-11-13");
  assert.deepEqual([k.seen, k.right, k.lastSeen, k.lastRight], [1, 1, "2026-11-13", true]);
  const n = withGrade(k, false, "2026-11-14");
  assert.deepEqual([n.seen, n.right, n.lastSeen, n.lastRight], [2, 1, "2026-11-14", false]);
  assert.equal(c.seen, 0);
  assert.equal(n.front, "a");
});

test("deckStats counts known, not yet and never seen cards", () => {
  const s = deckStats([at("a"), at("b", { lastRight: false }), at("c", { seen: 0, lastRight: null }), at("d")]);
  assert.deepEqual(s, { total: 4, fresh: 1, known: 2, notYet: 1 });
  assert.deepEqual(deckStats([]), { total: 0, fresh: 0, known: 0, notYet: 0 });
});
