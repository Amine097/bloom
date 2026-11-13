// Notebook: a study guide and a quiz for each lecture PDF, written by Claude Code on this Mac.
// The quiz is a bank of questions per lecture; each session draws a few of them, favouring the
// ones never asked and the ones missed last time.
import { D, save, uid, isLecture, itemsList, itemWeek, modulesSorted, moduleOf } from "../store.js";
import { today, relDay, fmtDay } from "../dates.js";
import { setStep } from "../recall.js";
import { esc, icon, app, openViewer, confirmBox, cvar, toast, select } from "../ui.js";
import { pdfUrl } from "../files.js";
import { askAboutPdf, assistantStatus } from "../assistant.js";
import {
  guidePrompt, quizPrompt, parseGuide, parseQuiz, mergeQuestions, pickSession, shuffled,
  withAnswer, withSession, BANK_MAX,
} from "../notebook-core.js";

const LETTERS = ["A", "B", "C", "D"];
const COUNTS = [5, 10, 15];
const LEVEL_CHOICES = [["mixed", "Mixed"], ["recall", "Recall"], ["understanding", "Understanding"], ["application", "Application"]];
const LEVEL_NAME = { recall: "Recall", understanding: "Understanding", application: "Application" };

/**
 * Survives changes of view and is never saved: which lecture and tab are open, the choices for the
 * next generation and session, and the session being played.
 * play = { lecture, quiz, items: [{ id, order }], i, picks: [stored option index], right: [bool],
 *          retry, done, score, total, missed: [question ids] }
 */
const view = { sel: null, tab: "guide", play: null, len: 10, genCount: 10, genLevel: "mixed", showBank: false };
/** "<lectureId>:guide" or "<lectureId>:quiz" while Claude is working on it. */
const running = new Set();
/** null, or why Claude cannot be used yet: "missing" (not installed) or "signedout". */
let setup = null;

const KIND = {
  guide: { name: "study guide", parse: parseGuide },
  quiz: { name: "quiz questions", parse: parseQuiz },
};

const notes = id => D.notebook[id] || {};
const isRunning = (id, kind) => running.has(`${id}:${kind}`);
/** The lecture's question bank, or null when it has none. */
const bankOf = id => {
  const z = notes(id).quiz;
  return z && Array.isArray(z.questions) ? z : null;
};
const findQ = (z, qid) => z?.questions.find(x => x.id === qid) || null;
/** The session on screen, if any: it belongs to the open lecture and to its current bank. */
const activePlay = () => {
  const p = view.play;
  return p && p.lecture === view.sel && p.quiz === bankOf(view.sel) ? p : null;
};

/** Re-renders only when the Notebook is on screen, so a finished job never disturbs another view. */
const refreshIfHere = () => { if (document.getElementById("main")?.dataset.view === "notebook") app.refresh(); };

/** Lectures that have a PDF, grouped by module in the usual module order. */
function groups() {
  const withPdf = itemsList().filter(it => isLecture(it) && it.pdf);
  const order = list => list.sort((a, b) =>
    (itemWeek(a) ?? 99) - (itemWeek(b) ?? 99) || (a.date || "9").localeCompare(b.date || "9") || (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title));
  const out = modulesSorted().map(m => ({ name: m.name, color: m.color, items: order(withPdf.filter(it => it.module === m.id)) }));
  out.push({ name: "No module", color: "plum", items: order(withPdf.filter(it => !D.modules[it.module])) });
  return out.filter(g => g.items.length);
}

function sideItem(it) {
  const has = { guide: Boolean(notes(it.id).guide), quiz: Boolean(bankOf(it.id)?.questions.length) };
  const mark = (kind, ic, label) => {
    const state = isRunning(it.id, kind) ? "busy" : has[kind] ? "on" : "";
    const what = state === "busy" ? `${label}: Claude is working` : has[kind] ? `${label}: ready` : `${label}: not made yet`;
    return `<i class="nb-mark ${state}" title="${what}">${icon(state === "busy" ? "clock" : ic, 14)}</i>`;
  };
  return `<button class="side-item ${view.sel === it.id ? "on" : ""}" data-act="select" data-id="${it.id}" ${cvar(moduleOf(it).color)} title="${esc(it.title)}">
    <span class="dot"></span><span>${esc(it.title)}</span>
    <small class="nb-marks">${mark("guide", "note", "Study guide")}${mark("quiz", "todo", "Quiz")}</small>
  </button>`;
}

const spinner = kind => `<div class="empty nb-wait" role="status"><span class="nb-spin" aria-hidden="true"></span>
  <p class="lead">Claude is reading the PDF and writing your ${KIND[kind].name}…</p>
  <p class="small">This usually takes a minute or two. You can keep using Bloom; it will be here when it is done.</p></div>`;

/** The "nothing yet" and "Claude is working" states of the study guide. */
function placeholder(id, kind, lead, hint) {
  if (isRunning(id, kind)) return spinner(kind);
  return `<div class="empty nb-wait"><p class="lead">${lead}</p><p class="small">${hint}</p>
    <div class="btns center"><button class="btn primary" data-act="generate" data-kind="${kind}">${icon("spark", 16)} Generate ${KIND[kind].name}</button></div></div>`;
}

/** A page number that opens the PDF at that page. */
const pageTag = p => (Number.isInteger(p) && p > 0
  ? `<button type="button" class="pill nb-page" data-act="openPage" data-page="${p}" title="Open the PDF at page ${p}">p. ${p}</button>` : "");

const levelTag = level => (LEVEL_NAME[level] ? `<span class="pill">${LEVEL_NAME[level]}</span>` : "");

function cardHead(id, kind, title, info) {
  const busy = isRunning(id, kind);
  return `<div class="card-h"><h3>${title}</h3><span class="muted small">${info}</span><span class="grow"></span>
    ${busy ? `<span class="pill accent"><span class="nb-spin small" aria-hidden="true"></span> Making a new one…</span>`
      : `<button class="btn ghost small" data-act="generate" data-kind="${kind}">${icon("repeat", 15)} Regenerate</button>`}
  </div>`;
}

function guideTab(id) {
  const g = notes(id).guide;
  if (!g) return `<section class="card">${placeholder(id, "guide", "No study guide yet.",
    "Claude reads the PDF and writes a short summary, the key points with their pages, and the key terms.")}</section>`;
  return `<section class="card">
    ${cardHead(id, "guide", "Study guide", `made ${relDay(g.createdAt)}`)}
    <div class="card-b nb-guide">
      <p class="lead">${esc(g.summary)}</p>
      <h4>Key points</h4>
      <ol class="nb-points">${g.points.map(p => `<li><span>${esc(p.text)}</span>${pageTag(p.page)}</li>`).join("")}</ol>
      <h4>Key terms</h4>
      <dl class="nb-terms">${g.terms.map(t => `<div><dt>${esc(t.term)}</dt><dd>${esc(t.def)}</dd></div>`).join("")}</dl>
    </div>
  </section>`;
}

// ---- quiz

/** How many questions and of which kind Claude should write next. */
function genControls(label, room) {
  const counts = COUNTS.map(n => [n, `${n} questions`]);
  const asked = Math.min(view.genCount, room);
  return `<div class="toolbar nb-gen">
      ${select("count", counts, view.genCount, 'class="pill-select" data-change="genCount" aria-label="How many questions"')}
      ${select("level", LEVEL_CHOICES, view.genLevel, 'class="pill-select" data-change="genLevel" aria-label="Kind of questions"')}
      <button class="btn primary" data-act="generate" data-kind="quiz">${icon("spark", 16)} ${label}</button>
    </div>
    ${asked < view.genCount ? `<p class="small muted">The bank has room for ${room} more, so Claude writes ${asked}.</p>` : ""}`;
}

function quizHead(z) {
  const b = z.best;
  const info = `${z.questions.length} question${z.questions.length === 1 ? "" : "s"}${b ? ` · best ${b.score}/${b.total}` : ""}`;
  return `<div class="card-h"><h3>Quiz</h3><span class="muted small">${info}</span><span class="grow"></span></div>`;
}

function quizEmpty(id) {
  if (isRunning(id, "quiz")) return `<section class="card">${spinner("quiz")}</section>`;
  return `<section class="card"><div class="empty nb-wait">
    <p class="lead">No quiz questions yet.</p>
    <p class="small">Claude reads the PDF and writes multiple-choice questions, each with an explanation and its page. They go into this lecture's question bank; every session draws from it.</p>
    ${genControls("Generate questions", BANK_MAX)}
  </div></section>`;
}

function startCard(z) {
  const n = z.questions.length;
  const fresh = z.questions.filter(x => !x.seen).length;
  const missed = z.questions.filter(x => x.seen && x.lastRight === false).length;
  const lens = [...COUNTS.slice(0, 2).filter(k => k < n), "all"];
  const len = view.len === "all" || view.len >= n ? "all" : view.len;
  const chips = lens.map(k => `<button class="chip ${len === k ? "on" : ""}" data-act="setLen" data-len="${k}" aria-pressed="${len === k}">${k === "all" ? `All ${n}` : k}</button>`).join("");
  const hist = (z.sessions || []).slice().reverse()
    .map(s => `<span class="pill">${esc(s.date ? fmtDay(s.date) : "")} · ${esc(s.score)}/${esc(s.total)}</span>`).join("");
  const status = [fresh && `${fresh} never asked`, missed && `${missed} missed last time`].filter(Boolean).join(" · ");
  return `<section class="card">${quizHead(z)}
    <div class="empty nb-wait">
      <p class="lead">${n} question${n === 1 ? "" : "s"} in the bank.</p>
      <p class="small">${status ? `${status}. ` : ""}Each session asks those first, then the ones you have not seen for longest.</p>
      <div class="toolbar nb-len" role="group" aria-label="Questions per session"><span class="small">Questions per session</span>${chips}</div>
      <div class="btns center"><button class="btn primary" data-act="startQuiz">Start a session</button></div>
      ${hist ? `<p class="small">Last sessions</p><div class="nb-hist">${hist}</div>` : ""}
    </div>
  </section>`;
}

function bankCard(id, z) {
  const n = z.questions.length;
  const room = BANK_MAX - n;
  const add = isRunning(id, "quiz")
    ? `<p class="small" role="status"><span class="nb-spin small" aria-hidden="true"></span> Claude is reading the PDF and writing new questions…</p>`
    : room > 0
      ? `<p class="small muted">Claude writes new questions and is told which ones you already have, so it does not repeat them.</p>${genControls("Add more questions", room)}`
      : `<p class="small muted">The bank is full. Delete the questions you no longer need to make room for new ones.</p>`;
  const stats = x => (!x.seen ? "never asked"
    : `right ${x.right} of ${x.seen} time${x.seen === 1 ? "" : "s"}${x.lastRight === false ? " · missed last time" : ""}`);
  const rows = view.showBank ? `<div class="nb-bank">${z.questions.map(x => `<div class="row">
      <div class="row-main"><span class="t">${esc(x.q)}</span>
        <span class="sub">${levelTag(x.level)}<span>${stats(x)}</span>${pageTag(x.page)}</span></div>
      <button class="iconbtn" data-act="deleteQuestion" data-q="${esc(x.id)}" title="Delete this question" aria-label="Delete this question">${icon("trash", 16)}</button>
    </div>`).join("")}</div>
    <div class="btns"><button class="btn danger small" data-act="clearBank">${icon("trash", 15)} Delete all questions</button></div>` : "";
  return `<section class="card">
    <div class="card-h"><h3>Question bank</h3><span class="muted small">${n} of ${BANK_MAX}</span><span class="grow"></span>
      <button class="btn ghost small" data-act="toggleBank" aria-expanded="${view.showBank}">${view.showBank ? "Hide the questions" : "See all questions"}</button></div>
    <div class="card-b">${add}${rows}</div>
  </section>`;
}

function sessionCard(z, p) {
  const item = p.items[p.i];
  const x = findQ(z, item.id);
  const total = p.items.length;
  const picked = p.picks[p.i];
  const answered = picked !== undefined;
  const opts = item.order.map((s, k) => {
    const cls = !answered ? "" : s === x.answer ? "right" : s === picked ? "wrong" : "";
    return `<button class="nb-opt ${cls}" data-act="pick" data-k="${k}" ${answered ? "disabled" : ""}><b>${LETTERS[k]}</b><span>${esc(x.options[s])}</span></button>`;
  }).join("");
  const last = p.i === total - 1;
  const ok = picked === x.answer;
  return `<section class="card">${quizHead(z)}
    <div class="card-b">
      <div class="nb-progress"><span class="muted small">${p.retry ? "Retry · " : ""}Question ${p.i + 1} of ${total}</span>${levelTag(x.level)}<span class="grow"></span><button class="btn ghost small" data-act="quitQuiz">Stop</button></div>
      <p class="nb-q">${esc(x.q)}</p>
      <div class="nb-opts">${opts}</div>
      ${answered ? `<div class="nb-why ${ok ? "right" : "wrong"}">
          <b>${ok ? "Right!" : `Not quite: the answer is ${LETTERS[item.order.indexOf(x.answer)]}.`}</b>
          <span>${esc(x.why)}</span>${pageTag(x.page)}
        </div>
        <div class="btns end">
          <button class="btn ghost small" data-act="deleteQuestion" data-q="${esc(x.id)}" title="Wrong or unclear? Remove it from the bank">${icon("trash", 15)} Delete this question</button>
          <span class="grow"></span>
          <button class="btn primary" data-act="next">${last ? "See my score" : "Next question"}</button>
        </div>`
        : `<p class="small muted">Keys: 1–4 or A–D to answer, then Enter for the next question.</p>`}
    </div>
  </section>`;
}

function resultCard(id, z, p) {
  const it = D.items[id];
  const { score, total } = p;
  const msg = total === 0 ? "No questions left in this session."
    : score === total ? "Perfect score! 🌷" : score >= total * 0.75 ? "Very good! 🌸"
      : score >= total / 2 ? "Good start. Have another look at the ones you missed." : "Worth another read of the lecture, then try again.";
  const missed = p.missed.map(qid => ({ x: findQ(z, qid), k: p.items.findIndex(m => m.id === qid) })).filter(m => m.x);
  const review = missed.map(({ x, k }) => `<li class="nb-why wrong">
      <p class="nb-rq">${esc(x.q)}</p>
      <p><span class="muted">Your answer:</span> ${esc(x.options[p.picks[k]])}</p>
      <p><span class="muted">Right answer:</span> <b>${esc(x.options[x.answer])}</b></p>
      <p class="muted">${esc(x.why)}${pageTag(x.page)}</p>
    </li>`).join("");
  return `<section class="card">${quizHead(z)}
    <div class="empty nb-wait">
      <p class="nb-score">${score}<small>/${total}</small></p>
      <p class="lead">${msg}</p>
      ${p.retry ? `<p class="small">Retry rounds do not count toward your best score.</p>` : ""}
      ${it.quizzedAt ? `<p class="small">This lecture is marked as quizzed.</p>` : ""}
      <div class="btns center">
        ${missed.length ? `<button class="btn primary" data-act="retryMissed">${icon("repeat", 16)} Retry the ones I missed</button>` : ""}
        ${it.quizzedAt ? "" : `<button class="btn ${missed.length ? "ghost" : "primary"}" data-act="markQuizzed">${icon("check", 16)} Mark the lecture as quizzed</button>`}
        <button class="btn ghost" data-act="startQuiz">New session</button>
      </div>
    </div>
    ${review ? `<div class="card-b"><h4 class="nb-h">What you missed</h4><ol class="nb-review">${review}</ol></div>` : ""}
  </section>`;
}

function quizTab(id) {
  const z = bankOf(id);
  if (!z || !z.questions.length) return quizEmpty(id);
  let p = activePlay();
  if (p && !p.done && !findQ(z, p.items[p.i]?.id)) p = view.play = null; // its question is gone
  if (p && !p.done) return sessionCard(z, p);
  return `${p ? resultCard(id, z, p) : startCard(z)}${bankCard(id, z)}`;
}

export function render() {
  const head = `<header class="page-h"><div><h1>Notebook</h1><p class="muted">Study guides and quizzes made from your lecture PDFs by Claude.</p></div></header>`;
  const gs = groups();
  if (!gs.length) {
    return `${head}<section class="card coming">
      <div class="coming-ic">${icon("note", 34)}</div>
      <h2>Add a lecture PDF to start</h2>
      <p class="lead">Attach the PDF of a lecture in Courses (the paper-clip on its row). It then shows up here, ready for a study guide and a quiz.</p>
      <div class="btns"><button class="btn primary" data-act="goCourses">${icon("book", 16)} Go to Courses</button></div>
    </section>`;
  }
  const all = gs.flatMap(g => g.items);
  if (!all.some(it => it.id === view.sel)) view.sel = all[0].id;
  const it = all.find(x => x.id === view.sel);
  const m = moduleOf(it);

  const warn = setup ? `<section class="card nb-warn"><div class="card-b">
      <p><b>${setup === "missing" ? "Claude is not set up yet." : "Claude is not signed in."}</b></p>
      <p class="muted">${setup === "missing"
        ? "The Notebook uses Claude, with your own Claude account, to write study guides and quizzes. Setting it up takes a minute, in Settings."
        : "The Notebook uses Claude with your own Claude account. Sign in once in Settings, then try again here."}</p>
      <div class="btns"><button class="btn primary small" data-act="goSettings">Set up in Settings</button></div>
    </div></section>` : "";

  return `${head}
    <div class="todo nb">
      <aside class="todo-side nb-side">
        ${gs.map(g => `<div class="side-h"><span>${esc(g.name)}</span></div>${g.items.map(sideItem).join("")}`).join("")}
      </aside>
      <div class="todo-main nb-main">
        ${warn}
        <section class="card" ${cvar(m.color)}>
          <div class="card-h"><span class="dot big"></span>
            <div class="nb-title"><h2>${esc(it.title)}</h2><span class="muted small">${esc(m.name)} · ${esc(it.pdf.name)}</span></div>
            <span class="grow"></span>
            <button class="btn ghost small" data-act="openPdf">${icon("file", 15)} Open the PDF</button>
          </div>
          <div class="card-b"><div class="toolbar nb-tabs">
            ${[["guide", "Study guide"], ["quiz", "Quiz"]].map(([k, l]) =>
              `<button class="chip ${view.tab === k ? "on" : ""}" data-act="tab" data-tab="${k}" aria-pressed="${view.tab === k}">${l}${isRunning(it.id, k) ? ' <span class="nb-spin small" aria-hidden="true"></span>' : ""}</button>`).join("")}
          </div></div>
        </section>
        ${view.tab === "quiz" ? quizTab(it.id) : guideTab(it.id)}
      </div>
    </div>`;
}

/** The prompt for a job, built when it starts. */
function promptFor(id, kind) {
  const title = D.items[id].title;
  if (kind === "guide") return guidePrompt(title);
  const z = bankOf(id);
  const room = BANK_MAX - (z?.questions.length ?? 0);
  return quizPrompt(title, { count: Math.min(view.genCount, room), level: view.genLevel, avoid: (z?.questions ?? []).map(x => x.q) });
}

/** Puts a finished job's result in the data. Returns the message for the toast. */
function store(id, kind, data, title) {
  const nb = (D.notebook[id] ??= {});
  if (kind === "guide") {
    nb.guide = { createdAt: today(), ...data };
    return `The study guide for "${title}" is ready 🌸`;
  }
  // into the bank as it is now: questions may have been deleted while Claude was writing
  const z = bankOf(id) || (nb.quiz = { createdAt: today(), questions: [], best: null, sessions: [] });
  const m = mergeQuestions(z.questions, data.questions, { date: today(), makeId: uid });
  if (!m.added.length) {
    throw new Error(m.overflow ? "The question bank is full. Delete some questions first."
      : "Claude only wrote questions that are already in the bank. Try again, perhaps with another kind of question.");
  }
  z.questions = m.questions;
  const left = [m.duplicates && `${m.duplicates} already in the bank`, data.skipped.length && `${data.skipped.length} not usable`]
    .filter(Boolean).join(", ");
  return `${m.added.length} new question${m.added.length === 1 ? "" : "s"} for "${title}" 🌸${left ? ` (left out: ${left})` : ""}`;
}

/** Asks Claude for a study guide or quiz questions. Runs in the background; what exists stays usable meanwhile. */
async function generate(id, kind) {
  const key = `${id}:${kind}`;
  const it = D.items[id];
  if (running.has(key) || !it?.pdf) return;
  const pdfId = it.pdf.id;
  const prompt = promptFor(id, kind);
  running.add(key);
  refreshIfHere();
  try {
    // do not start when Claude is not set up; a failed check does not block (the run reports its own errors)
    const s = await assistantStatus().catch(() => null);
    if (s && !s.loggedIn) {
      setup = s.installed ? "signedout" : "missing";
      return;
    }
    if (s) setup = null;
    const text = await askAboutPdf(pdfId, prompt);
    const data = KIND[kind].parse(text);
    setup = null;
    const now = D.items[id];
    if (!now || now.pdf?.id !== pdfId) return; // the lecture or its PDF changed meanwhile
    const msg = store(id, kind, data, now.title);
    save();
    toast(msg);
  } catch (e) {
    if (e?.code === "no-claude") {
      setup = "missing";
      toast("Claude Code is not installed on this Mac.", "error");
    } else toast(e?.message || String(e), "error");
  } finally {
    running.delete(key);
    refreshIfHere();
  }
}

function startSession(items, retry) {
  const z = bankOf(view.sel);
  if (!z || !items.length) return;
  view.play = { lecture: view.sel, quiz: z, items, i: 0, picks: [], right: [], retry, done: false, score: 0, total: 0, missed: [] };
  app.refresh();
}

/** Answers the question on screen with the option shown at position k. */
function choose(k) {
  const p = activePlay();
  if (!p || p.done || p.picks[p.i] !== undefined) return;
  const item = p.items[p.i];
  const s = item.order[k];
  const z = p.quiz;
  const at = z.questions.findIndex(x => x.id === item.id);
  if (s === undefined || at === -1) return;
  const right = s === z.questions[at].answer;
  p.picks[p.i] = s;
  p.right[p.i] = right;
  z.questions[at] = withAnswer(z.questions[at], right, today());
  save();
  app.refresh();
}

function finish(p) {
  p.done = true;
  p.total = p.items.length;
  p.score = p.right.filter(Boolean).length;
  p.missed = p.items.filter((_, k) => !p.right[k]).map(m => m.id);
  if (!p.retry && p.total) Object.assign(p.quiz, withSession(p.quiz, { date: today(), score: p.score, total: p.total }));
  save();
}

function next() {
  const p = activePlay();
  if (!p || p.done || p.picks[p.i] === undefined) return;
  if (p.i < p.items.length - 1) p.i += 1;
  else finish(p);
  app.refresh();
}

/** Keyboard during a session: 1–4 or A–D answers, Enter or Space goes on. Called by main.js. */
export function onKey(e) {
  const p = activePlay();
  if (!p || p.done || view.tab !== "quiz") return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const k = Math.max(["1", "2", "3", "4"].indexOf(key), ["a", "b", "c", "d"].indexOf(key));
  if (k !== -1) {
    if (p.picks[p.i] !== undefined) return;
    e.preventDefault();
    choose(k);
    return;
  }
  if (key === "Enter" || key === " ") {
    if (e.target.closest?.("button, a, summary, label")) return; // the focused control acts on its own
    if (p.picks[p.i] === undefined) return;
    e.preventDefault();
    next();
  }
}

export const actions = {
  select: el => { view.sel = el.dataset.id; app.refresh(); },
  tab: el => { view.tab = el.dataset.tab; app.refresh(); },
  goCourses: () => app.go("courses"),
  goSettings: () => app.go("settings"),
  genCount: el => { view.genCount = Number(el.value) || 10; app.refresh(); },
  genLevel: el => { view.genLevel = el.value; },
  generate: async el => {
    const id = view.sel, kind = el.dataset.kind;
    if (isRunning(id, kind)) return;
    if (kind === "guide" && notes(id).guide && !await confirmBox("Make a new study guide?",
      "Claude writes a new one from the PDF. The current study guide stays until the new one is ready, then it is replaced.", "Regenerate")) return;
    if (kind === "quiz" && (bankOf(id)?.questions.length ?? 0) >= BANK_MAX) { toast("The question bank is full. Delete some questions first.", "error"); return; }
    generate(id, kind);
  },
  openPdf: async () => {
    const it = D.items[view.sel];
    try { openViewer(it.title, await pdfUrl(it.pdf.id)); }
    catch { toast("This PDF could not be opened. Attach it again from the lecture.", "error"); }
  },
  openPage: async el => {
    const it = D.items[view.sel];
    try { openViewer(it.title, await pdfUrl(it.pdf.id), Number(el.dataset.page)); }
    catch { toast("This PDF could not be opened. Attach it again from the lecture.", "error"); }
  },
  setLen: el => { view.len = el.dataset.len === "all" ? "all" : Number(el.dataset.len); app.refresh(); },
  startQuiz: () => {
    const z = bankOf(view.sel);
    if (z) startSession(pickSession(z.questions, view.len), false);
  },
  retryMissed: () => {
    const p = activePlay();
    if (!p?.done) return;
    const ids = p.missed.filter(qid => findQ(p.quiz, qid));
    startSession(shuffled(ids.length).map(k => ({ id: ids[k], order: shuffled(4) })), true);
  },
  pick: el => choose(Number(el.dataset.k)),
  next,
  quitQuiz: () => { view.play = null; app.refresh(); },
  toggleBank: () => { view.showBank = !view.showBank; app.refresh(); },
  deleteQuestion: async el => {
    const id = view.sel, qid = el.dataset.q;
    const x = findQ(bankOf(id), qid);
    if (!x || !await confirmBox("Delete this question?", `"${x.q}" is removed from the question bank.`)) return;
    const z = bankOf(id);
    if (!z) return;
    z.questions = z.questions.filter(q => q.id !== qid);
    const p = activePlay();
    const k = p ? p.items.findIndex(m => m.id === qid) : -1;
    if (p && k !== -1) {
      for (const list of [p.items, p.picks, p.right]) list.splice(k, 1);
      if (p.done) {
        p.total = p.items.length;
        p.score = p.right.filter(Boolean).length;
        p.missed = p.missed.filter(m => m !== qid);
      } else {
        if (k < p.i) p.i -= 1;
        if (!p.items.length) view.play = null;
        else if (p.i >= p.items.length) { p.i = p.items.length - 1; if (p.picks[p.i] !== undefined) finish(p); }
      }
    }
    save(); app.refresh();
    toast("Question deleted");
  },
  clearBank: async () => {
    const z = bankOf(view.sel);
    if (!z || !await confirmBox("Delete all the questions?",
      `All ${z.questions.length} questions of this lecture are removed. Your best score and past sessions are kept.`, "Delete all")) return;
    z.questions = [];
    view.play = null;
    view.showBank = false;
    save(); app.refresh();
  },
  markQuizzed: () => {
    const it = D.items[view.sel];
    if (!it || it.quizzedAt) return;
    setStep(it, "quizzed", today());
    save(); app.refresh();
    toast("Marked as quizzed 🌸");
  },
};
