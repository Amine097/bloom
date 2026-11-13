// Notebook tab "Ask": she asks anything about a lecture PDF and Claude answers from the document,
// with the pages the answer comes from. Every question is one background run of Claude Code on the
// PDF (runJob); the last exchanges go with it so follow-up questions work. One question at a time
// per lecture. The prompt, the reply reader and the answer formatter are in ../chat-core.js.
import { D, save, uid } from "../store.js";
import { today } from "../dates.js";
import { esc, icon, app, confirmBox, toast } from "../ui.js";
import { runJob, isRunning } from "./notebook-jobs.js";
import {
  chatOf, addExchange, chatPrompt, parseChat, formatAnswer, cleanQuestion, SUGGESTIONS, Q_MAX,
} from "../chat-core.js";

const KIND = "chat";
const COUNT_FROM = 800; // the character count shows from here on

/** Never saved: the text typed in each lecture's box, keyed by lecture id. */
const drafts = {};
/** lecture id → id of the exchange Claude is answering. */
const asking = new Map();
/** exchange id → why Claude's last reply to it could not be used (other failures are shown as a toast). */
const failed = new Map();
/** Set when the newest exchange should be brought into view, and the box focused, after the next render. */
let toNewest = false, focusBox = false;

const hasDom = typeof document !== "undefined";
const lectureOf = el => el.closest("[data-lecture]")?.dataset.lecture;

/** A page number that opens the PDF at that page (the openPage action of notebook.js). */
const pageTag = p => (Number.isInteger(p) && p > 0
  ? `<button type="button" class="pill nb-page" data-act="openPage" data-page="${p}" title="Open the PDF at page ${p}">p. ${p}</button>` : "");

const countText = n => (n >= COUNT_FROM ? `${n}/${Q_MAX}` : "");

// ---- keeping the log scrolled and the box focused across app.refresh(), which rebuilds the view

/** What the screen looks like just before a render: read from the old DOM, still in place. */
function snapshot() {
  if (!hasDom) return null;
  const card = document.querySelector("#main .nba");
  const log = card?.querySelector(".nba-log");
  const box = card?.querySelector(".nba-input");
  return {
    lecture: card?.dataset.lecture ?? null,
    top: log ? log.scrollTop : 0,
    atEnd: log ? log.scrollHeight - log.scrollTop - log.clientHeight < 40 : true,
    hadLog: Boolean(log),
    focused: Boolean(box) && document.activeElement === box,
    sel: box ? [box.selectionStart, box.selectionEnd] : null,
  };
}

/** Runs once the new HTML is in place (after app.refresh() has restored the page scroll). */
function restore(before, id) {
  const card = document.querySelector("#main .nba");
  if (!card || card.dataset.lecture !== id) return;
  const log = card.querySelector(".nba-log");
  const fresh = !before?.hadLog || before.lecture !== id;
  if (log) {
    const end = log.scrollHeight - log.clientHeight;
    const last = log.lastElementChild;
    // the newest exchange from its question down (its start, when it is taller than the log)
    if (toNewest || fresh) log.scrollTop = Math.min(end, Math.max(0, (last?.offsetTop ?? end) - 8));
    else log.scrollTop = before.atEnd ? end : before.top;
  }
  const box = card.querySelector(".nba-input");
  if (box && (focusBox || (before?.focused && before.lecture === id))) {
    box.focus({ preventScroll: true });
    if (before?.sel && !focusBox) box.setSelectionRange(...before.sel);
    else box.setSelectionRange(box.value.length, box.value.length);
  }
  toNewest = false;
  focusBox = false;
}

// ---- screen

function answerPart(id, x, busy) {
  if (typeof x.a === "string" && x.a) {
    const pages = (Array.isArray(x.pages) ? x.pages : []).map(pageTag).join("");
    return `<div class="nba-a">
      <div class="nba-text">${formatAnswer(x.a)}</div>
      <div class="nba-foot">${pages ? `<span class="small muted">From</span>${pages}` : ""}<span class="grow"></span>
        <button type="button" class="iconbtn" data-act="chatDelete" data-ex="${esc(x.id)}" title="Delete this question and its answer" aria-label="Delete this question and its answer">${icon("trash", 15)}</button></div>
    </div>`;
  }
  if (busy && asking.get(id) === x.id) {
    return `<div class="nba-a nba-wait" role="status"><span class="nb-spin small" aria-hidden="true"></span>
      <span>Claude is reading the PDF…<br><span class="small muted">This usually takes under a minute. You can keep using Bloom meanwhile.</span></span></div>`;
  }
  const why = failed.get(x.id);
  return `<div class="nba-a nba-failed">
    <p>${why ? esc(why) : "This question did not get an answer."}</p>
    <div class="nba-foot">
      <button type="button" class="btn soft small" data-act="chatRetry" data-ex="${esc(x.id)}" ${busy ? 'disabled title="Claude is answering another question"' : ""}>${icon("repeat", 15)} Try again</button>
      <span class="grow"></span>
      <button type="button" class="iconbtn" data-act="chatDelete" data-ex="${esc(x.id)}" title="Delete this question" aria-label="Delete this question">${icon("trash", 15)}</button>
    </div>
  </div>`;
}

const exchange = (id, x, busy) => `<div class="nba-ex">
    <div class="nba-q">${esc(x.q)}</div>
    ${answerPart(id, x, busy)}
  </div>`;

function emptyState() {
  return `<div class="empty nb-wait nba-empty">
    <p class="lead">Ask anything about this lecture.</p>
    <p class="small">Claude answers from the PDF only, and shows the pages the answer comes from. Ask in any language.</p>
    <div class="nba-suggest">${SUGGESTIONS.map((s, k) => `<button type="button" class="chip" data-act="chatSuggest" data-k="${k}">${esc(s)}</button>`).join("")}</div>
  </div>`;
}

function render(id) {
  const before = snapshot();
  const chat = chatOf(D.notebook[id]);
  const busy = isRunning(id, KIND);
  const draft = drafts[id] ?? "";
  const n = chat.length;
  const html = `<section class="card nba" data-lecture="${esc(id)}">
    <div class="card-h"><h3>Ask</h3><span class="muted small">${n ? `${n} question${n === 1 ? "" : "s"}` : "Answers from this PDF only"}</span><span class="grow"></span>
      ${n ? `<button type="button" class="btn ghost small" data-act="chatClear">${icon("trash", 15)} Clear the conversation</button>` : ""}</div>
    <div class="card-b">
      ${n ? `<div class="nba-log">${chat.map(x => exchange(id, x, busy)).join("")}</div>` : emptyState()}
      <form class="nba-ask" data-submit="chatSend">
        <textarea class="nba-input" name="q" rows="2" maxlength="${Q_MAX}" data-input="chatDraft" placeholder="Ask anything about this lecture" aria-label="Your question about this lecture">${esc(draft)}</textarea>
        <div class="nba-bar">
          <span class="small muted">${busy ? "Claude is answering. You can type your next question meanwhile." : "Enter to send · Shift+Enter for a new line"}</span>
          <span class="grow"></span><span class="small muted nba-count">${countText(draft.length)}</span>
          <button type="submit" class="btn primary" ${busy ? "disabled" : ""}>Send</button>
        </div>
      </form>
    </div>
  </section>`;
  if (hasDom) queueMicrotask(() => restore(before, id));
  return html;
}

// ---- asking

const lookingAt = id => hasDom && document.querySelector("#main .nba")?.dataset.lecture === id;

/** Asks Claude the exchange `exId` of lecture `id` (new or failed), with the exchanges before it. */
function ask(id, exId) {
  const chat = chatOf(D.notebook[id]);
  const k = chat.findIndex(x => x.id === exId);
  if (k === -1 || isRunning(id, KIND) || !D.items[id]?.pdf) return;
  const prompt = chatPrompt(D.items[id].title, chat[k].q, chat.slice(0, k));
  asking.set(id, exId);
  failed.delete(exId);
  runJob(id, KIND, prompt, (text, now) => {
    let r;
    try { r = parseChat(text); } catch (e) { failed.set(exId, e.message); throw e; }
    const x = chatOf(D.notebook[id]).find(e => e.id === exId);
    if (!x) return ""; // deleted while Claude was answering
    x.a = r.answer;
    x.pages = r.pages;
    toNewest = true;
    return lookingAt(id) ? "" : `Claude answered your question about "${now.title}" 🌸`;
  }).then(() => { if (asking.get(id) === exId) asking.delete(id); });
}

function send(id, text) {
  if (!id || !D.items[id]?.pdf) return;
  const q = cleanQuestion(text);
  if (!q) return;
  if (isRunning(id, KIND)) { toast("Claude is still answering your last question."); return; }
  const nb = (D.notebook[id] ??= {});
  const x = { id: uid(), q, a: null, pages: [], at: today() };
  nb.chat = addExchange(chatOf(nb), x);
  drafts[id] = "";
  toNewest = true;
  focusBox = true;
  save();
  ask(id, x.id); // its refresh shows the question with the waiting bubble
}

// Enter sends, Shift+Enter makes a new line. main.js leaves keys typed in a textarea alone, so the
// box listens here, once for the whole page.
if (hasDom) {
  document.addEventListener("keydown", e => {
    const box = e.target;
    if (!box?.matches?.("#main textarea.nba-input")) return;
    if (e.key !== "Enter" || e.shiftKey || e.altKey || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    const id = lectureOf(box);
    if (isRunning(id, KIND)) { toast("Claude is still answering your last question."); return; }
    send(id, box.value);
  });
}

export const chatTab = {
  id: KIND,
  label: "Ask",
  render,
  actions: {
    chatSend: form => send(lectureOf(form), form.elements.q?.value),
    chatDraft: el => {
      const id = lectureOf(el);
      if (!id) return;
      drafts[id] = el.value;
      const c = el.form?.querySelector(".nba-count");
      if (c) c.textContent = countText(el.value.length);
    },
    chatSuggest: el => {
      const q = SUGGESTIONS[Number(el.dataset.k)];
      if (q) send(lectureOf(el), q);
    },
    chatRetry: el => {
      const id = lectureOf(el);
      if (isRunning(id, KIND)) { toast("Claude is still answering another question."); return; }
      ask(id, el.dataset.ex);
    },
    chatDelete: el => {
      const id = lectureOf(el), nb = D.notebook[id];
      if (!nb) return;
      nb.chat = chatOf(nb).filter(x => x.id !== el.dataset.ex);
      failed.delete(el.dataset.ex);
      save();
      app.refresh();
      toast("Question deleted");
    },
    chatClear: async el => {
      const id = lectureOf(el);
      const n = chatOf(D.notebook[id]).length;
      if (!n || !await confirmBox("Clear the conversation?",
        `${n === 1 ? "The question" : `All ${n} questions`} about this lecture and ${n === 1 ? "its answer are" : "their answers are"} deleted.`, "Clear")) return;
      const nb = D.notebook[id];
      if (nb) nb.chat = [];
      save();
      app.refresh();
    },
  },
};
