// Notebook tab "Flashcards": a deck of cards per lecture, written by Claude from the PDF, and
// review sessions where she flips each card and grades herself ("Knew it" / "Not yet").
// A Notebook tab is { id, label, render(lectureId), actions, onKey?(event, lectureId) }; see notebook.js.
import { D, save, uid } from "../store.js";
import { today, relDay } from "../dates.js";
import { esc, icon, app, confirmBox, toast, select } from "../ui.js";
import { runJob, isRunning } from "./notebook-jobs.js";
import {
  cardsPrompt, parseCards, mergeCards, deckOf, pickCards, withGrade, deckStats, DECK_MAX, GEN_COUNTS,
} from "../cards-core.js";
import { shuffled } from "../notebook-core.js";

const KIND = "cards";
const LENS = [10, 20];

/**
 * Survives changes of view and lecture and is never saved: the choices for the next generation
 * and session, and the session being played.
 * play = { lecture, deck, ids: [card ids], i, flipped, grades: [bool], retry, done }
 */
const view = { play: null, len: 10, genCount: 10, showList: false };

/** The lecture shown by the last render: the actions act on it. */
let current = null;
const sel = () => current;
const deckFor = id => deckOf(D.notebook?.[id]);
const findCard = (deck, cid) => deck?.cards.find(x => x.id === cid) || null;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The session on screen for lecture `id`, if any: it belongs to that lecture and its current deck. */
const activePlay = id => {
  const p = view.play;
  return p && p.lecture === id && p.deck === deckFor(id) ? p : null;
};

/** A page number that opens the PDF at that page (the openPage action of notebook.js). */
const pageTag = p => (Number.isInteger(p) && p > 0
  ? `<button type="button" class="pill nb-page" data-act="openPage" data-page="${p}" title="Open the PDF at page ${p}">p. ${p}</button>` : "");

const progressLine = cards => {
  const s = deckStats(cards);
  return [plural(s.total, "card"), s.known && `${s.known} known`, s.notYet && `${s.notYet} not yet`, s.fresh && `${s.fresh} never seen`]
    .filter(Boolean).join(" · ");
};

const head = (deck, extra = "") => `<div class="card-h"><h3>Flashcards</h3>
  <span class="muted small">${progressLine(deck.cards)}</span><span class="grow"></span>${extra}</div>`;

/** How many cards Claude should write next. */
function genControls(label, room) {
  const asked = Math.min(view.genCount, room);
  return `<div class="toolbar nb-gen">
      ${select("count", GEN_COUNTS.map(n => [n, `${n} cards`]), view.genCount, 'class="pill-select" data-change="cardGenCount" aria-label="How many cards"')}
      <button class="btn primary" data-act="cardGenerate">${icon("spark", 16)} ${label}</button>
    </div>
    ${asked < view.genCount ? `<p class="small muted">The deck has room for ${room} more, so Claude writes ${asked}.</p>` : ""}`;
}

const working = lead => `<div class="empty nb-wait" role="status"><span class="nb-spin" aria-hidden="true"></span>
  <p class="lead">${lead}</p>
  <p class="small">This usually takes a minute or two. You can keep using Bloom; the cards will be here when they are done.</p></div>`;

function emptyCard(id) {
  if (isRunning(id, KIND)) return `<section class="card">${working("Claude is reading the PDF and writing your flashcards…")}</section>`;
  return `<section class="card"><div class="empty nb-wait">
    <p class="lead">No flashcards yet.</p>
    <p class="small">Claude reads the PDF and writes cards with a question or a term on the front and a short answer on the back, each with its page. You flip them and say whether you knew the answer; the ones you did not know come back first.</p>
    ${genControls("Generate flashcards", DECK_MAX)}
  </div></section>`;
}

function startCard(deck) {
  const n = deck.cards.length;
  const s = deckStats(deck.cards);
  const lens = [...LENS.filter(k => k < n), "all"];
  const len = view.len === "all" || view.len >= n ? "all" : view.len;
  const chips = lens.map(k => `<button class="chip ${len === k ? "on" : ""}" data-act="cardSetLen" data-len="${k}" aria-pressed="${len === k}">${k === "all" ? `All ${n}` : k}</button>`).join("");
  const status = [s.fresh && `${s.fresh} never seen`, s.notYet && `${s.notYet} not known last time`].filter(Boolean).join(" · ");
  return `<section class="card">${head(deck)}
    <div class="empty nb-wait">
      <p class="lead">${plural(n, "card")} in the deck.</p>
      <p class="small">${status ? `${status}. ` : ""}Each session shows those first, then the ones you have not seen for longest.</p>
      <div class="toolbar nb-len" role="group" aria-label="Cards per session"><span class="small">Cards per session</span>${chips}</div>
      <div class="btns center"><button class="btn primary" data-act="cardStart">Start reviewing</button></div>
    </div>
  </section>`;
}

function sessionCard(deck, p) {
  const x = findCard(deck, p.ids[p.i]);
  const total = p.ids.length;
  const face = p.flipped
    ? `<div class="nbc-card flipped">
        <p class="nbc-front">${esc(x.front)}</p>
        <div class="nbc-back"><p>${esc(x.back)}</p>${pageTag(x.page)}</div>
      </div>`
    : `<div class="nbc-card" data-act="cardFlip" title="Show the answer"><p class="nbc-front">${esc(x.front)}</p></div>`;
  const buttons = p.flipped
    ? `<div class="btns center nbc-grade">
        <button class="btn ghost nbc-no" data-act="cardGrade" data-knew="0">${icon("repeat", 16)} Not yet</button>
        <button class="btn primary nbc-yes" data-act="cardGrade" data-knew="1">${icon("check", 16)} Knew it</button>
      </div>
      <div class="btns end"><button class="btn ghost small" data-act="cardDelete" data-card="${esc(x.id)}" title="Wrong or not useful? Remove it from the deck">${icon("trash", 15)} Delete this card</button></div>
      <p class="small muted nbc-keys">Keys: 1 = Not yet, 2 = Knew it.</p>`
    : `<div class="btns center"><button class="btn primary" data-act="cardFlip">Show answer</button></div>
      <p class="small muted nbc-keys">Keys: Space or Enter shows the answer.</p>`;
  return `<section class="card">${head(deck)}
    <div class="card-b">
      <div class="nb-progress"><span class="muted small">${p.retry ? "Again · " : ""}Card ${p.i + 1} of ${total}</span><span class="grow"></span><button class="btn ghost small" data-act="cardStop">Stop</button></div>
      <div class="nbc-bar" aria-hidden="true"><span style="width:${Math.round((p.i / total) * 100)}%"></span></div>
      ${face}
      ${buttons}
    </div>
  </section>`;
}

function resultCard(deck, p) {
  const total = p.ids.length;
  const known = p.grades.filter(Boolean).length;
  const missed = p.ids.filter((_, k) => !p.grades[k]).map(cid => findCard(deck, cid)).filter(Boolean);
  const msg = total === 0 ? "No cards left in this session."
    : known === total ? "You knew them all! 🌷" : known >= total * 0.75 ? "Very good! 🌸"
      : known >= total / 2 ? "Good start. Go over the ones you did not know once more." : "These need another look. Go again with the ones you missed.";
  const review = missed.map(x => `<li class="nb-why wrong"><p class="nb-rq">${esc(x.front)}</p><p>${esc(x.back)}${pageTag(x.page)}</p></li>`).join("");
  return `<section class="card">${head(deck)}
    <div class="empty nb-wait">
      <p class="nb-score">${known}<small>/${total}</small></p>
      <p class="lead">${msg}</p>
      <p class="small">Deck: ${progressLine(deck.cards)}.</p>
      <div class="btns center">
        ${missed.length ? `<button class="btn primary" data-act="cardRetry">${icon("repeat", 16)} Go again with the ones I missed</button>` : ""}
        <button class="btn ${missed.length ? "ghost" : "primary"}" data-act="cardStart">New session</button>
      </div>
    </div>
    ${review ? `<div class="card-b"><h4 class="nb-h">Not yet</h4><ol class="nb-review">${review}</ol></div>` : ""}
  </section>`;
}

function deckCard(id, deck) {
  const n = deck.cards.length;
  const room = DECK_MAX - n;
  const add = isRunning(id, KIND)
    ? `<p class="small" role="status"><span class="nb-spin small" aria-hidden="true"></span> Claude is reading the PDF and writing new cards…</p>`
    : room > 0
      ? `<p class="small muted">Claude writes new cards and is told which ones you already have, so it does not repeat them.</p>${genControls("Add more cards", room)}`
      : `<p class="small muted">The deck is full. Delete the cards you no longer need to make room for new ones.</p>`;
  const stats = x => (!x.seen ? "never seen"
    : `knew it ${x.right} of ${plural(x.seen, "time")}${x.lastRight === false ? " · not yet last time" : ""}`);
  const rows = view.showList ? `<div class="nb-bank nbc-list">${deck.cards.map(x => `<div class="row">
      <div class="row-main"><span class="t">${esc(x.front)}</span>
        <span class="nbc-ans">${esc(x.back)}</span>
        <span class="sub"><span>${stats(x)}</span>${pageTag(x.page)}</span></div>
      <button class="iconbtn" data-act="cardDelete" data-card="${esc(x.id)}" title="Delete this card" aria-label="Delete this card">${icon("trash", 16)}</button>
    </div>`).join("")}</div>
    <div class="btns"><button class="btn danger small" data-act="cardClearAll">${icon("trash", 15)} Delete all cards</button></div>` : "";
  return `<section class="card">
    <div class="card-h"><h3>Deck</h3><span class="muted small">${n} of ${DECK_MAX}${deck.createdAt ? ` · started ${esc(relDay(deck.createdAt))}` : ""}</span><span class="grow"></span>
      <button class="btn ghost small" data-act="cardToggleList" aria-expanded="${view.showList}">${view.showList ? "Hide the cards" : "See all cards"}</button></div>
    <div class="card-b">${add}${rows}</div>
  </section>`;
}

function render(id) {
  const deck = deckFor(id);
  current = id;
  if (!deck || !deck.cards.length) return emptyCard(id);
  let p = activePlay(id);
  if (p && !p.done && !findCard(deck, p.ids[p.i])) p = view.play = null; // its card is gone
  if (p && !p.done) return sessionCard(deck, p);
  return `${p ? resultCard(deck, p) : startCard(deck)}${deckCard(id, deck)}`;
}

// ---- what she does

/** Puts Claude's cards in the deck as it is now (cards may have been deleted meanwhile). Returns the toast. */
function store(id, data, title) {
  const nb = ((D.notebook ??= {})[id] ??= {});
  const deck = deckFor(id) || (nb.cards = { createdAt: today(), cards: [] });
  const m = mergeCards(deck.cards, data.cards, { date: today(), makeId: uid });
  if (!m.added.length) {
    throw new Error(m.overflow ? "The deck is full. Delete some cards first."
      : "Claude only wrote cards that are already in the deck. Try again.");
  }
  if (!deck.cards.length) deck.createdAt = today(); // a deck emptied with "Delete all" starts again
  deck.cards = m.cards;
  const left = [m.duplicates && `${m.duplicates} already in the deck`, data.skipped.length && `${data.skipped.length} not usable`]
    .filter(Boolean).join(", ");
  return `${plural(m.added.length, "new flashcard")} for "${title}" 🌸${left ? ` (left out: ${left})` : ""}`;
}

function generate(id) {
  const it = D.items[id];
  if (!it?.pdf || isRunning(id, KIND)) return;
  const deck = deckFor(id);
  const n = deck?.cards.length ?? 0;
  if (n >= DECK_MAX) { toast("The deck is full. Delete some cards first.", "error"); return; }
  const prompt = cardsPrompt(it.title, { count: Math.min(view.genCount, DECK_MAX - n), avoid: (deck?.cards ?? []).map(x => x.front) });
  runJob(id, KIND, prompt, (text, now) => store(id, parseCards(text), now.title));
}

function startSession(id, ids, retry) {
  const deck = deckFor(id);
  if (!deck || !ids.length) return;
  view.play = { lecture: id, deck, ids, i: 0, flipped: false, grades: [], retry, done: false };
  app.refresh();
}

function flip(id) {
  const p = activePlay(id);
  if (!p || p.done || p.flipped) return;
  p.flipped = true;
  app.refresh();
}

function grade(id, knew) {
  const p = activePlay(id);
  if (!p || p.done || !p.flipped) return;
  const at = p.deck.cards.findIndex(x => x.id === p.ids[p.i]);
  if (at === -1) return;
  p.deck.cards[at] = withGrade(p.deck.cards[at], knew, today());
  p.grades[p.i] = knew;
  if (p.i < p.ids.length - 1) { p.i += 1; p.flipped = false; } else p.done = true;
  save();
  app.refresh();
}

/** Keyboard while the Flashcards tab is open: Space or Enter shows the answer, 1 = Not yet, 2 = Knew it. */
function onKey(e, id) {
  const p = activePlay(id);
  if (!p || p.done) return;
  if (e.key === "1" || e.key === "2") {
    if (!p.flipped) return;
    e.preventDefault();
    grade(id, e.key === "2");
    return;
  }
  if (e.key === "Enter" || e.key === " ") {
    if (e.target.closest?.("button, a, summary, label")) return; // the focused control acts on its own
    if (p.flipped) return;
    e.preventDefault();
    flip(id);
  }
}

const actions = {
  cardGenCount: el => { view.genCount = Number(el.value) || 10; app.refresh(); },
  cardGenerate: () => { const id = sel(); if (id) generate(id); },
  cardSetLen: el => { view.len = el.dataset.len === "all" ? "all" : Number(el.dataset.len); app.refresh(); },
  cardStart: () => {
    const id = sel(), deck = deckFor(id);
    if (deck) startSession(id, pickCards(deck.cards, view.len), false);
  },
  cardRetry: () => {
    const id = sel(), p = activePlay(id);
    if (!p?.done) return;
    const ids = p.ids.filter((cid, k) => !p.grades[k] && findCard(p.deck, cid));
    startSession(id, shuffled(ids.length).map(k => ids[k]), true);
  },
  cardFlip: () => flip(sel()),
  cardGrade: el => grade(sel(), el.dataset.knew === "1"),
  cardStop: () => { view.play = null; app.refresh(); },
  cardToggleList: () => { view.showList = !view.showList; app.refresh(); },
  cardDelete: el => {
    const id = sel(), cid = el.dataset.card, deck = deckFor(id);
    if (!findCard(deck, cid)) return;
    deck.cards = deck.cards.filter(x => x.id !== cid);
    const p = activePlay(id);
    const k = p ? p.ids.indexOf(cid) : -1;
    if (p && k !== -1) {
      p.ids.splice(k, 1);
      p.grades.splice(k, 1);
      if (!p.done) {
        if (k < p.i) p.i -= 1;
        else if (k === p.i) p.flipped = false;
        if (!p.ids.length) view.play = null;
        else if (p.i >= p.ids.length) p.done = true;
      }
    }
    save(); app.refresh();
    toast("Card deleted");
  },
  cardClearAll: async () => {
    const id = sel(), deck = deckFor(id);
    if (!deck || !await confirmBox("Delete all the cards?",
      `All ${deck.cards.length} flashcards of this lecture are removed, with what you knew of each.`, "Delete all")) return;
    deck.cards = [];
    view.play = null;
    view.showList = false;
    save(); app.refresh();
  },
};

export const cardsTab = { id: KIND, label: "Flashcards", render, actions, onKey };
