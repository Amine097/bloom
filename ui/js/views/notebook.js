// Notebook: a study guide and a quiz for each lecture PDF, written by Claude Code on this Mac.
// Each lecture keeps a bank of questions. A quiz spans one or more lectures: she picks them, the
// number of questions and the difficulty; Bloom has Claude write what is missing first, then draws
// the missed questions, the new ones and those due again (see quiz-core.js).
import { D, save, uid, isLecture, itemsList, itemWeek, modulesSorted, moduleOf } from "../store.js";
import { today, relDay, fmtDay, fmtWday } from "../dates.js";
import { setStep } from "../recall.js";
import { esc, icon, app, openViewer, confirmBox, cvar, toast, select } from "../ui.js";
import { pdfUrl } from "../files.js";
import {
  runJob, runFicheJob, isRunning, isRunningWithSchemas, setupNeeded, withSchemas, setSchemas, schemasToggle, takesAbout,
  themeChips, themeTags, checkedThemes, toggleTheme, sortByTheme,
} from "./notebook-jobs.js";
import { unclassified } from "../themes-core.js";
import { cardsTab } from "./notebook-cards.js";
import { chatTab } from "./notebook-chat.js";
import {
  guidePrompt, quizPrompt, parseGuide, parseQuiz, mergeQuestions, shuffled, withSession, BANK_MAX,
} from "../notebook-core.js";
import { planQuiz, drawQuiz, answered, standings, examGroups, SIZES } from "../quiz-core.js";
import {
  isFicheSrc, ficheSrc, srcFiche, srcExists, srcTitle, srcQuizzable, ficheQuizzable, srcCount,
} from "../sources.js";

const LETTERS = ["A", "B", "C", "D"];
const COUNTS = [5, 10, 15];
/** The key of the "No module" group (module ids never look like this). */
const NO_MODULE = "-";
const LEVEL_CHOICES = [["mixed", "Mixed"], ["recall", "Recall"], ["understanding", "Understanding"], ["application", "Application"]];
const LEVEL_NAME = { recall: "Recall", understanding: "Understanding", application: "Application" };
/** How many lectures Claude writes questions for at the same time before a quiz. */
const PARALLEL = 3;

/**
 * Survives changes of view and is never saved.
 * page: "lecture" (a lecture and its tabs) or "quiz" (the quiz page). sel: the open lecture.
 * open: module groups unfolded in the sidebar. pick: lectures ticked for the next quiz; unfold:
 * module groups unfolded in the quiz chooser. size, level: the next quiz's length and difficulty.
 * prep: while Claude sorts the questions by theme, then writes those the quiz needs, { lectures,
 * size, level, themes, stage: "sort" | "write", jobs: { id: state } } with state "wait" | "run" |
 * "done" | "fail". play: the quiz being played or just finished,
 * { lectures, size, level, themes, items: [{ lecture, id, order }], i, picks: [stored option index],
 *   right: [bool], retry, done, score, total, missed: [items] }.
 */
const view = {
  page: "lecture", sel: null, tab: "guide", open: new Set(), pick: new Set(), unfold: new Set(),
  size: 10, level: "mixed", prep: null, play: null, genCount: 10, genLevel: "mixed", showBank: false,
};
/**
 * Tabs built in their own files, shown after "Study guide" and "Quiz". Each one is
 * { id, label, render(lectureId), actions, onKey?(event, lectureId) }; its action names are its own.
 * A tab shows a spinner while the job "<lectureId>:<tab id>" runs (see notebook-jobs.js).
 */
const EXTRA_TABS = [cardsTab, chatTab];
const extraTab = () => EXTRA_TABS.find(t => t.id === view.tab) || null;

const KIND = {
  guide: { name: "study guide", parse: parseGuide },
  quiz: { name: "quiz questions", parse: parseQuiz },
};

const notes = id => D.notebook[id] || {};
/** The question bank of a lecture or a fiche ("fiche:<id>", sources.js), or null when it has none. */
const bankOf = id => {
  const z = isFicheSrc(id) ? srcFiche(id)?.quiz : notes(id).quiz;
  return z && Array.isArray(z.questions) ? z : null;
};
const findQ = (z, qid) => z?.questions.find(x => x.id === qid) || null;
/** The question of a session item, looked up in its own lecture's bank; null when it is gone. */
const qOf = item => (item ? findQ(bankOf(item.lecture), item.id) : null);
const qCount = id => bankOf(id)?.questions.length ?? 0;
/** The quiz on screen: only on the quiz page. */
const activePlay = () => (view.page === "quiz" ? view.play : null);
/** A lecture's group key: its module, or NO_MODULE. */
const groupKey = it => (D.modules[it.module] ? it.module : NO_MODULE);

/** Lectures that have a PDF, grouped by module in the usual module order. `key` is the module id or NO_MODULE. */
function groups() {
  const withPdf = itemsList().filter(it => isLecture(it) && it.pdf);
  const order = list => list.sort((a, b) =>
    (itemWeek(a) ?? 99) - (itemWeek(b) ?? 99) || (a.date || "9").localeCompare(b.date || "9") || (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title));
  const out = modulesSorted().map(m => ({ key: m.id, name: m.name, color: m.color, items: order(withPdf.filter(it => it.module === m.id)) }));
  out.push({ key: NO_MODULE, name: "No module", color: "plum", items: order(withPdf.filter(it => !D.modules[it.module])) });
  return out.filter(g => g.items.length);
}

/** A module in the sidebar: its name folds and unfolds its lectures. */
function sideGroup(g) {
  const open = view.open.has(g.key);
  return `<button class="side-h nb-group ${open ? "open" : ""}" data-act="toggleGroup" data-key="${esc(g.key)}" aria-expanded="${open}" ${cvar(g.color)}>
      <span class="dot"></span><span class="nb-group-name">${esc(g.name)}</span><small>${g.items.length}</small><i class="nb-chev" aria-hidden="true"></i>
    </button>${open ? g.items.map(sideItem).join("") : ""}`;
}

function sideItem(it) {
  const has = { guide: Boolean(notes(it.id).guide), quiz: Boolean(bankOf(it.id)?.questions.length) };
  const mark = (kind, ic, label) => {
    const state = isRunning(it.id, kind) ? "busy" : has[kind] ? "on" : "";
    const what = state === "busy" ? `${label}: Claude is working` : has[kind] ? `${label}: ready` : `${label}: not made yet`;
    return `<i class="nb-mark ${state}" title="${what}">${icon(state === "busy" ? "clock" : ic, 14)}</i>`;
  };
  return `<button class="side-item ${view.page === "lecture" && view.sel === it.id ? "on" : ""}" data-act="select" data-id="${it.id}" ${cvar(moduleOf(it).color)} title="${esc(it.title)}">
    <span class="dot"></span><span>${esc(it.title)}</span>
    <small class="nb-marks">${mark("guide", "note", "Study guide")}${mark("quiz", "todo", "Quiz")}</small>
  </button>`;
}

const spinner = (kind, schemas) => `<div class="empty nb-wait" role="status"><span class="nb-spin" aria-hidden="true"></span>
  <p class="lead">Claude is reading the PDF${schemas ? ", diagrams included," : ""} and writing your ${KIND[kind].name}…</p>
  <p class="small">${takesAbout(schemas)} You can keep using Bloom; it will be here when it is done.</p></div>`;

/** The "nothing yet" and "Claude is working" states of the study guide. */
function placeholder(id, kind, lead, hint) {
  if (isRunning(id, kind)) return spinner(kind, isRunningWithSchemas(id, kind));
  return `<div class="empty nb-wait"><p class="lead">${lead}</p><p class="small">${hint}</p>
    ${schemasToggle()}
    <div class="btns center"><button class="btn primary" data-act="generate" data-kind="${kind}">${icon("spark", 16)} Generate ${KIND[kind].name}</button></div></div>`;
}

/** A page number that opens the PDF (of `lecture`, or of the open lecture) at that page. */
const pageTag = (p, lecture = null) => (!(Number.isInteger(p) && p > 0) ? ""
  : isFicheSrc(lecture) && srcFiche(lecture)?.source !== "uploaded" ? `<span class="pill nb-page" title="Page ${p} of the fiche">fiche p. ${p}</span>`
  : `<button type="button" class="pill nb-page" data-act="openPage" data-page="${p}"${lecture ? ` data-lecture="${esc(lecture)}"` : ""} title="Open the PDF at page ${p}">p. ${p}</button>`);

const levelTag = level => (LEVEL_NAME[level] ? `<span class="pill">${LEVEL_NAME[level]}</span>` : "");

function cardHead(id, kind, title, info) {
  const busy = isRunning(id, kind);
  return `<div class="card-h"><h3>${title}</h3><span class="muted small">${info}</span><span class="grow"></span>
    ${busy ? `<span class="pill accent"><span class="nb-spin small" aria-hidden="true"></span> Making a new one${isRunningWithSchemas(id, kind) ? ", diagrams included" : ""}…</span>`
      : `${schemasToggle({ hint: false })}<button class="btn ghost small" data-act="generate" data-kind="${kind}">${icon("repeat", 15)} Regenerate</button>`}
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

// ---- quiz: the lecture's tab (its bank) and the quiz page (one or more lectures)

/** How many questions and of which kind Claude should write next, from the lecture's tab. */
function genControls(label, room) {
  const counts = COUNTS.map(n => [n, `${n} questions`]);
  const asked = Math.min(view.genCount, room);
  return `<div class="toolbar nb-gen">
      ${select("count", counts, view.genCount, 'class="pill-select" data-change="genCount" aria-label="How many questions"')}
      ${select("level", LEVEL_CHOICES, view.genLevel, 'class="pill-select" data-change="genLevel" aria-label="Kind of questions"')}
      ${schemasToggle()}
      <button class="btn ghost" data-act="generate" data-kind="quiz">${icon("spark", 16)} ${label}</button>
    </div>
    <div class="toolbar nb-themes-row"><span class="small">Themes</span>${themeChips()}</div>
    ${asked < view.genCount ? `<p class="small muted">The bank has room for ${room} more, so Claude writes ${asked}.</p>` : ""}`;
}

/** "3 to review · 4 new · 5 resting" for a bank. */
function standingLine(z) {
  const s = standings(z);
  return [s.missed && `${s.missed} to review`, s.new && `${s.new} new`, s.due && `${s.due} due again`, s.resting && `${s.resting} resting`]
    .filter(Boolean).join(" · ");
}

/** The lecture's Quiz tab: what its bank holds, a button to quiz it, and the bank itself. */
function quizTab(id) {
  const z = bankOf(id);
  const n = z?.questions.length ?? 0;
  const busy = isRunning(id, "quiz");
  const hist = (z?.sessions || []).slice(-6).reverse()
    .map(s => `<span class="pill">${esc(s.date ? fmtDay(s.date) : "")} · ${esc(s.score)}/${esc(s.total)}</span>`).join("");
  const top = `<section class="card">
    <div class="card-h"><h3>Quiz</h3><span class="muted small">${n ? `${n} question${n === 1 ? "" : "s"}${z.best ? ` · best ${z.best.score}/${z.best.total}` : ""}` : "no questions yet"}</span></div>
    <div class="empty nb-wait">
      <p class="lead">${n ? standingLine(z) || `${n} questions` : "Start a quiz: Bloom has Claude write the questions first."}</p>
      <p class="small">Missed questions come back in your next quiz of this lecture; the ones you got right return after a few quizzes.</p>
      ${busy ? `<p class="small" role="status"><span class="nb-spin small" aria-hidden="true"></span> Claude is writing questions for this lecture…</p>` : ""}
      <div class="btns center"><button class="btn primary" data-act="quizLecture">${icon("todo", 16)} Quiz this lecture</button></div>
      ${hist ? `<p class="small">Last quizzes</p><div class="nb-hist">${hist}</div>` : ""}
    </div>
  </section>`;
  return z && n ? top + bankCard(id, z) : top + `<section class="card"><div class="card-b">
      <p class="small muted">Or have Claude write questions now, without starting a quiz:</p>${genControls("Write questions", BANK_MAX)}</div></section>`;
}

function bankCard(id, z) {
  const n = z.questions.length;
  const room = BANK_MAX - n;
  const add = isRunning(id, "quiz") ? ""
    : room > 0
      ? `<p class="small muted">Claude writes new questions and is told which ones you already have, so it does not repeat them.</p>${genControls("Add more questions", room)}`
      : `<p class="small muted">The bank is full. Delete the questions you no longer need to make room for new ones.</p>`;
  const stats = x => (!x.seen ? "never asked"
    : `right ${x.right} of ${x.seen} time${x.seen === 1 ? "" : "s"}${x.lastRight === false ? " · missed last time" : ""}`);
  const rows = view.showBank ? `<div class="nb-bank">${z.questions.map(x => `<div class="row">
      <div class="row-main"><span class="t">${esc(x.q)}</span>
        <span class="sub">${levelTag(x.level)}<span>${stats(x)}</span>${pageTag(x.page)}${themeTags(x)}</span></div>
      <button class="iconbtn" data-act="deleteQuestion" data-q="${esc(x.id)}" title="Delete this question" aria-label="Delete this question">${icon("trash", 16)}</button>
    </div>`).join("")}</div>
    <div class="btns"><button class="btn danger small" data-act="clearBank">${icon("trash", 15)} Delete all questions</button></div>` : "";
  return `<section class="card">
    <div class="card-h"><h3>Question bank</h3><span class="muted small">${n} of ${BANK_MAX}</span><span class="grow"></span>
      <button class="btn ghost small" data-act="toggleBank" aria-expanded="${view.showBank}">${view.showBank ? "Hide the questions" : "See all questions"}</button></div>
    <div class="card-b">${add}${rows}</div>
  </section>`;
}

/** The lecture a question comes from, shown when a quiz spans several lectures. */
const fromTag = lecture => `<p class="nbm-from">${icon(isFicheSrc(lecture) ? "file" : "book", 14)}<span>${esc(srcTitle(lecture))}</span></p>`;

const quizHead = (title, info) => `<div class="card-h"><h3>${title}</h3>${info ? `<span class="muted small">${info}</span>` : ""}<span class="grow"></span></div>`;
const lecturesInfo = ids => (ids.length === 1 ? esc(srcTitle(ids[0])) : srcCount(ids));

function sessionCard(p) {
  const item = p.items[p.i];
  const x = qOf(item);
  const total = p.items.length;
  const picked = p.picks[p.i];
  const answered_ = picked !== undefined;
  const opts = item.order.map((s, k) => {
    const cls = !answered_ ? "" : s === x.answer ? "right" : s === picked ? "wrong" : "";
    return `<button class="nb-opt ${cls}" data-act="pick" data-k="${k}" ${answered_ ? "disabled" : ""}><b>${LETTERS[k]}</b><span>${esc(x.options[s])}</span></button>`;
  }).join("");
  const last = p.i === total - 1;
  const ok = picked === x.answer;
  return `<section class="card">${quizHead(p.retry ? "Retry" : "Quiz", lecturesInfo(p.lectures))}
    <div class="card-b">
      <div class="nb-progress"><span class="muted small">Question ${p.i + 1} of ${total}</span>${levelTag(x.level)}<span class="grow"></span><button class="btn ghost small" data-act="quitQuiz">Stop</button></div>
      <div class="nb-bar" aria-hidden="true"><i style="width:${Math.round(100 * p.i / total)}%"></i></div>
      ${p.lectures.length > 1 ? fromTag(item.lecture) : ""}
      <p class="nb-q">${esc(x.q)}</p>
      <div class="nb-opts">${opts}</div>
      ${answered_ ? `<div class="nb-why ${ok ? "right" : "wrong"}">
          <b>${ok ? "Right!" : `Not quite: the answer is ${LETTERS[item.order.indexOf(x.answer)]}.`}</b>
          <span>${esc(x.why)}</span>${pageTag(x.page, item.lecture)}${themeTags(x)}
        </div>
        <div class="btns end">
          <button class="btn ghost small" data-act="deleteQuestion" data-q="${esc(x.id)}" data-lecture="${esc(item.lecture)}" title="Wrong or unclear? Remove it from the bank">${icon("trash", 15)} Delete this question</button>
          <span class="grow"></span>
          <button class="btn primary" data-act="next">${last ? "See my score" : "Next question"}</button>
        </div>`
        : `<p class="small muted">Keys: 1–4 or A–D to answer, then Enter for the next question.</p>`}
    </div>
  </section>`;
}

const scoreMsg = (score, total, what) => (total === 0 ? "No questions left in this quiz."
  : score === total ? "Perfect score! 🌷" : score >= total * 0.75 ? "Very good! 🌸"
    : score >= total / 2 ? "Good start. Have another look at the ones you missed." : `Worth another read of ${what}, then try again.`);

/** The questions missed in a finished quiz that are still in their bank, as review entries. */
function missedReview(p) {
  return p.missed.map(m => ({ m, x: qOf(m), k: p.items.indexOf(m) })).filter(r => r.x).map(({ m, x, k }) => `<li class="nb-why wrong">
      ${p.lectures.length > 1 ? fromTag(m.lecture) : ""}
      <p class="nb-rq">${esc(x.q)}</p>
      <p><span class="muted">Your answer:</span> ${esc(x.options[p.picks[k]])}</p>
      <p><span class="muted">Right answer:</span> <b>${esc(x.options[x.answer])}</b></p>
      <p class="muted">${esc(x.why)}${pageTag(x.page, m.lecture)}${themeTags(x)}</p>
    </li>`);
}

/** How she did on each lecture of a finished quiz over several lectures. */
function breakdown(p) {
  if (p.lectures.length < 2) return "";
  const by = new Map();
  p.items.forEach((m, k) => {
    const r = by.get(m.lecture) || { score: 0, total: 0 };
    r.total += 1;
    if (p.right[k]) r.score += 1;
    by.set(m.lecture, r);
  });
  const rows = [...by].map(([id, r]) =>
    `<li class="${r.score === r.total ? "ok" : ""}"><span>${esc(srcTitle(id))}</span><b>${r.score}/${r.total}</b></li>`).join("");
  return rows ? `<ul class="nbm-break">${rows}</ul>` : "";
}

function resultCard(p) {
  const { score, total } = p;
  const missed = missedReview(p);
  const notQuizzed = [...new Set(p.items.map(m => m.lecture))].filter(id => D.items[id] && !D.items[id].quizzedAt);
  const what = p.lectures.length > 1 ? "those lectures" : isFicheSrc(p.lectures[0]) ? "the fiche" : "the lecture";
  return `<section class="card">${quizHead(p.retry ? "Retry" : "Quiz", lecturesInfo(p.lectures))}
    <div class="empty nb-wait">
      <p class="nb-score">${score}<small>/${total}</small></p>
      <p class="lead">${scoreMsg(score, total, what)}</p>
      ${p.retry ? `<p class="small">A retry round only asks what you missed, and does not change when questions come back.</p>` : ""}
      ${breakdown(p)}
      <div class="btns center">
        ${missed.length ? `<button class="btn primary" data-act="retryMissed">${icon("repeat", 16)} Retry the ones I missed</button>` : ""}
        <button class="btn ${missed.length ? "ghost" : "primary"}" data-act="quizAgain">Another quiz like this</button>
        <button class="btn ghost" data-act="quizNew">Choose another quiz</button>
        ${notQuizzed.length ? `<button class="btn ghost" data-act="markQuizzed">${icon("check", 16)} Mark ${notQuizzed.length === 1 ? "the lecture" : `these ${notQuizzed.length} lectures`} as quizzed</button>` : ""}
      </div>
    </div>
    ${missed.length ? `<div class="card-b"><h4 class="nb-h">What you missed</h4><ol class="nb-review">${missed.join("")}</ol></div>` : ""}
  </section>`;
}

/** While Claude sorts the questions by theme (stage "sort"), then writes those the quiz needs. */
function prepCard(prep) {
  const sorting = prep.stage === "sort";
  const label = sorting
    ? { wait: "Waiting…", run: "Sorting by theme…", done: "Sorted", fail: "Not sorted this time" }
    : { wait: "Waiting…", run: "Writing questions…", done: "Ready", fail: "Could not write questions" };
  const rows = prep.lectures.map(id => {
    const st = prep.jobs[id] || "done";
    const mark = st === "run" ? '<span class="nb-spin small" aria-hidden="true"></span>' : st === "done" ? icon("check", 15) : st === "fail" ? icon("close", 15) : icon("clock", 15);
    return `<li class="nbq-prep ${st}">${mark}<span class="nbq-t">${esc(srcTitle(id))}</span><small>${prep.jobs[id] ? label[st] : "Ready"}</small></li>`;
  }).join("");
  const n = Object.keys(prep.jobs).length;
  const intro = sorting
    ? `<p class="lead">Sorting your questions by theme…</p>
      <p class="small muted">A quick one-off: Claude tags the questions you already have with their themes, so a quiz only asks those on the themes you chose.</p>`
    : `<p class="lead">Claude is writing questions for ${srcCount(Object.keys(prep.jobs))}${prep.schemas ? ", reading every diagram" : ""}. The quiz starts by itself when they are ready.</p>
      <p class="small muted">It takes ${prep.schemas ? "a few minutes" : "about half a minute"} per lecture, a few at a time. You can use the rest of Bloom meanwhile.</p>`;
  return `<section class="card">${quizHead("Getting your quiz ready", lecturesInfo(prep.lectures))}
    <div class="card-b">
      ${intro}
      <ul class="nbq-preps">${rows}</ul>
      <div class="btns end"><button class="btn ghost small" data-act="quizCancel">Cancel</button></div>
    </div>
  </section>`;
}

/** The lectures of the quiz chooser: by module, foldable, each with its bank's state. */
function pickList(gs) {
  return gs.map(g => {
    const on = g.items.filter(it => view.pick.has(it.id)).length;
    const all = on === g.items.length;
    const open = view.unfold.has(g.key);
    const rows = open ? g.items.map(it => {
      const z = bankOf(it.id);
      const info = z?.questions.length ? `${z.questions.length} questions${standingLine(z) ? ` · ${standingLine(z)}` : ""}` : "no questions yet: Claude writes them";
      return `<label class="row nbq-lecture">
        <input type="checkbox" data-change="quizTick" data-id="${esc(it.id)}" ${view.pick.has(it.id) ? "checked" : ""}>
        <span class="row-main"><span class="t">${esc(it.title)}</span><span class="sub"><span>${info}</span></span></span>
      </label>`;
    }).join("") : "";
    return `<div class="nbq-group" ${cvar(g.color)}>
      <div class="nbq-group-h">
        <label class="nbq-all"><input type="checkbox" data-change="quizTickGroup" data-key="${esc(g.key)}" ${all ? "checked" : ""} class="${on && !all ? "some" : ""}" aria-label="Every lecture of ${esc(g.name)}">
          <span class="dot"></span><b>${esc(g.name)}</b></label>
        <span class="muted small">${on ? `${on} of ${g.items.length}` : `${g.items.length} lecture${g.items.length === 1 ? "" : "s"}`}</span>
        <span class="grow"></span>
        <button class="btn ghost small" data-act="quizUnfold" data-key="${esc(g.key)}" aria-expanded="${open}">${open ? "Hide lectures" : "Choose lectures"}</button>
      </div>${rows}
    </div>`;
  }).join("");
}

/** Fiches that can be quizzed, newest first: [[source, fiche]]. */
const quizFiches = () => Object.entries(D.fiches || {}).filter(([, f]) => ficheQuizzable(f))
  .sort(([, a], [, b]) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))).map(([id, f]) => [ficheSrc(id), f]);
const FICHES_KEY = "fiches";

/** The fiches of the quiz chooser, as one foldable group under the modules. */
function ficheList() {
  const list = quizFiches();
  if (!list.length) return "";
  const on = list.filter(([s]) => view.pick.has(s)).length;
  const all = on === list.length;
  const open = view.unfold.has(FICHES_KEY);
  const rows = open ? list.map(([s, f]) => {
    const z = bankOf(s);
    const mods = (f.modules || []).map(m => D.modules[m]?.name).filter(Boolean).join(", ");
    const info = z?.questions.length ? `${z.questions.length} questions${standingLine(z) ? ` · ${standingLine(z)}` : ""}` : "no questions yet: Claude writes them";
    return `<label class="row nbq-lecture">
        <input type="checkbox" data-change="quizTick" data-id="${esc(s)}" ${view.pick.has(s) ? "checked" : ""}>
        <span class="row-main"><span class="t">${esc(f.title)}</span><span class="sub"><span>${mods ? `${esc(mods)} · ` : ""}${info}</span></span></span>
      </label>`;
  }).join("") : "";
  return `<div class="nbq-group">
      <div class="nbq-group-h">
        <label class="nbq-all"><input type="checkbox" data-change="quizTickFiches" ${all ? "checked" : ""} class="${on && !all ? "some" : ""}" aria-label="Every fiche">
          ${icon("file", 15)}<b>Fiches</b></label>
        <span class="muted small">${on ? `${on} of ${list.length}` : `${list.length} fiche${list.length === 1 ? "" : "s"}`}</span>
        <span class="grow"></span>
        <button class="btn ghost small" data-act="quizUnfold" data-key="${FICHES_KEY}" aria-expanded="${open}">${open ? "Hide fiches" : "Choose fiches"}</button>
      </div>${rows}
    </div>`;
}

/** The quiz chooser: lectures, number of questions, difficulty, and what will happen. */
function chooserCard(gs) {
  const exams = examGroups(D.modules, today()).map(e => {
    const n = e.ids.filter(id => gs.some(g => g.key === id)).length;
    return n ? `<button class="chip" data-act="quizExam" data-date="${e.date}">${icon("cal", 14)} ${esc(fmtWday(e.date))} exam · ${n} module${n === 1 ? "" : "s"}</button>` : "";
  }).join("");
  const picked = pickedLectures(gs);
  const plan = picked.length ? planQuiz(picked.map(bankFor), view.size, view.level, checkedThemes()) : [];
  const toMake = plan.filter(p => p.make > 0).length;
  const sizeChips = SIZES.map(k => `<button class="chip ${view.size === k ? "on" : ""}" data-act="quizSize" data-n="${k}" aria-pressed="${view.size === k}">${k}</button>`).join("");
  const levelChips = LEVEL_CHOICES.map(([k, l]) => `<button class="chip ${view.level === k ? "on" : ""}" data-act="quizLevel" data-level="${k}" aria-pressed="${view.level === k}">${l}</button>`).join("");
  const summary = !picked.length ? "Choose at least one lecture or fiche."
    : `${view.size} questions from ${srcCount(picked)}. ${toMake
      ? `Claude first writes questions for ${toMake} of them (${withSchemas() ? "a few minutes each" : "about half a minute each"}).` : "Ready to start."}`;
  return `<section class="card">
    ${quizHead("New quiz", "")}
    <div class="card-b nbq">
      ${exams ? `<div class="toolbar"><span class="small">Whole exam</span>${exams}</div>` : ""}
      <div class="nbq-h"><h4 class="nb-h">Lectures${quizFiches().length ? " and fiches" : ""}</h4><span class="grow"></span>${view.pick.size ? `<button class="btn ghost small" data-act="quizClear">Clear</button>` : ""}</div>
      <div class="nbq-list">${pickList(gs)}${ficheList()}</div>
      <div class="toolbar"><span class="small">Questions</span>${sizeChips}</div>
      <div class="toolbar"><span class="small">Difficulty</span>${levelChips}</div>
      <div class="toolbar nb-themes-row"><span class="small">Themes</span>${themeChips()}</div>
      <div class="toolbar nbq-mode"><span class="small">New questions</span>${schemasToggle()}</div>
      <div class="nbq-go"><p class="small">${summary}</p><span class="grow"></span>
        <button class="btn primary" data-act="quizStart" ${picked.length ? "" : "disabled"}>${icon("todo", 16)} Start the quiz</button></div>
    </div>
  </section>`;
}

/** The last finished quizzes. */
function recentCard() {
  const log = (D.quizLog || []).slice(-5).reverse();
  if (!log.length) return "";
  return `<section class="card">${quizHead("Recent quizzes", "")}
    <div class="card-b"><ul class="nbm-break">${log.map(r => {
      const names = r.lectures.filter(srcExists).map(srcTitle);
      const label = names.length === 1 ? names[0] : srcCount(r.lectures);
      return `<li class="${r.score === r.total ? "ok" : ""}"><span>${esc(fmtDay(r.date))} · ${esc(label)}</span><b>${r.score}/${r.total}</b></li>`;
    }).join("")}</ul></div>
  </section>`;
}

function quizPage(gs) {
  const head = `<section class="card"><div class="card-h"><div class="nb-title"><h2>Quiz</h2>
    <span class="muted small">Questions from the lectures and fiches you choose. Missed ones come back first; the ones you know return after a few quizzes.</span></div></div></section>`;
  if (view.prep) return head + prepCard(view.prep);
  let p = view.play;
  if (p && !p.done && !qOf(p.items[p.i])) p = view.play = null; // its question is gone
  if (p && !p.done) return head + sessionCard(p);
  return head + (p ? resultCard(p) : "") + chooserCard(gs) + recentCard();
}

export function render() {
  const head = `<header class="page-h"><div><h1>Notebook</h1><p class="muted">Study guides, quizzes, flashcards and answers, made from your lecture PDFs.</p></div></header>`;
  const gs = groups();
  // fiches alone can be quizzed: the quiz page then shows without lectures
  if (!gs.length && !quizFiches().length) {
    return `${head}<section class="card coming">
      <div class="coming-ic">${icon("note", 34)}</div>
      <h2>Add a lecture PDF to start</h2>
      <p class="lead">Attach the PDF of a lecture in Courses (the paper-clip on its row). It then shows up here, ready for a study guide and a quiz.</p>
      <div class="btns"><button class="btn primary" data-act="goCourses">${icon("book", 16)} Go to Courses</button></div>
    </section>`;
  }
  const all = gs.flatMap(g => g.items);
  if (!all.length) view.page = "quiz";
  if (!all.some(it => it.id === view.sel)) view.sel = all[0]?.id ?? null;
  for (const id of view.pick) if (isFicheSrc(id) ? !srcQuizzable(id) : !all.some(it => it.id === id)) view.pick.delete(id); // lecture, PDF or fiche removed
  const it = all.find(x => x.id === view.sel);
  if (!view.open.size && it) view.open.add(groupKey(it));
  const m = it ? moduleOf(it) : null;
  const setup = setupNeeded();
  const extra = extraTab();

  const warn = setup ? `<section class="card nb-warn"><div class="card-b">
      <p><b>${setup === "missing" ? "Claude is not set up yet." : "Claude is not signed in."}</b></p>
      <p class="muted">${setup === "missing"
        ? "The Notebook uses Claude, with your own Claude account, to write study guides and quizzes. Setting it up takes a minute, in Settings."
        : "The Notebook uses Claude with your own Claude account. Sign in once in Settings, then try again here."}</p>
      <div class="btns"><button class="btn primary small" data-act="goSettings">Set up in Settings</button></div>
    </div></section>` : "";

  const busyQuiz = view.prep || (view.play && !view.play.done);
  return `${head}
    <div class="todo nb">
      <aside class="todo-side nb-side">
        <button class="side-item nb-quiz ${view.page === "quiz" ? "on" : ""}" data-act="quizOpen">
          ${icon("todo", 16)}<span>Quiz</span>${busyQuiz ? '<small class="nb-marks"><span class="nb-spin small" aria-hidden="true"></span></small>' : ""}
        </button>
        ${gs.map(sideGroup).join("")}
      </aside>
      <div class="todo-main nb-main">
        ${warn}
        ${view.page === "quiz" ? quizPage(gs) : `<section class="card" ${cvar(m.color)}>
          <div class="card-h"><span class="dot big"></span>
            <div class="nb-title"><h2>${esc(it.title)}</h2><span class="muted small">${esc(m.name)} · ${esc(it.pdf.name)}</span></div>
            <span class="grow"></span>
            <button class="btn ghost small" data-act="openPdf">${icon("file", 15)} Open the PDF</button>
          </div>
          <div class="card-b"><div class="toolbar nb-tabs">
            ${[["guide", "Study guide"], ["quiz", "Quiz"], ...EXTRA_TABS.map(t => [t.id, t.label])].map(([k, l]) =>
              `<button class="chip ${view.tab === k ? "on" : ""}" data-act="tab" data-tab="${k}" aria-pressed="${view.tab === k}">${l}${isRunning(it.id, k) ? ' <span class="nb-spin small" aria-hidden="true"></span>' : ""}</button>`).join("")}
          </div></div>
        </section>
        ${extra ? extra.render(it.id) : view.tab === "quiz" ? quizTab(it.id) : guideTab(it.id)}`}
      </div>
    </div>`;
}

/** The prompt for a job started from a lecture's tab, built when it starts. */
function promptFor(id, kind, schemas) {
  const title = D.items[id].title;
  if (kind === "guide") return guidePrompt(title, { schemas });
  const z = bankOf(id);
  const room = BANK_MAX - (z?.questions.length ?? 0);
  return quizPrompt(title, { count: Math.min(view.genCount, room), level: view.genLevel, avoid: (z?.questions ?? []).map(x => x.q), schemas, themes: checkedThemes() });
}

/** Adds the questions Claude wrote to lecture `id`'s bank. Returns the message for the toast. */
function addQuestions(id, data, title) {
  const owner = isFicheSrc(id) ? srcFiche(id) : (D.notebook[id] ??= {});
  if (!owner) throw new Error("This fiche no longer exists.");
  // into the bank as it is now: questions may have been deleted while Claude was writing
  const z = bankOf(id) || (owner.quiz = { createdAt: today(), questions: [], best: null, sessions: [], quizzes: 0 });
  const m = mergeQuestions(z.questions, data.questions, { date: today(), makeId: uid });
  if (!m.added.length) {
    throw new Error(m.overflow ? "The question bank is full. Delete some questions first."
      : "Claude only wrote questions that are already in the bank. Try again, perhaps with another kind of question.");
  }
  for (const x of m.added) Object.assign(x, { streak: 0, lastQuiz: null });
  z.questions = m.questions;
  const left = [m.duplicates && `${m.duplicates} already in the bank`, data.skipped.length && `${data.skipped.length} not usable`]
    .filter(Boolean).join(", ");
  return `${m.added.length} new question${m.added.length === 1 ? "" : "s"} for "${title}" 🌸${left ? ` (left out: ${left})` : ""}`;
}

/** Puts a finished job's result in the data. Returns the message for the toast. */
function store(id, kind, data, title) {
  if (kind === "guide") {
    (D.notebook[id] ??= {}).guide = { createdAt: today(), ...data };
    return `The study guide for "${title}" is ready 🌸`;
  }
  return addQuestions(id, data, title);
}

/** Asks Claude for a study guide or quiz questions. Runs in the background; what exists stays usable meanwhile. */
function generate(id, kind) {
  if (isRunning(id, kind) || !D.items[id]?.pdf) return;
  const schemas = withSchemas();
  runJob(id, kind, promptFor(id, kind, schemas), (text, now) => store(id, kind, KIND[kind].parse(text), now.title), { schemas });
}

// ---- running a quiz

/** Lectures with a PDF, grouped by module (see groups()), that are ticked for the next quiz. */
const pickedLectures = (gs = groups()) => [
  ...gs.flatMap(g => g.items).filter(it => view.pick.has(it.id)).map(it => it.id),
  ...quizFiches().map(([s]) => s).filter(s => view.pick.has(s)),
];
const bankFor = id => ({ lecture: id, questions: bankOf(id)?.questions ?? [], quizzes: bankOf(id)?.quizzes ?? 0 });
const scrollTop = () => { const main = document.getElementById("main"); if (main) main.scrollTop = 0; };

/**
 * Has Claude write `count` questions at `level` on `themes` for lecture `id`, quietly, "With
 * schemas" or not. Resolves true when some were added.
 */
function makeQuestions(id, count, level, schemas, themes) {
  const z = bankOf(id);
  const fiche = isFicheSrc(id);
  // a fiche's questions come from its text (fiches-core.js): "With schemas" does not apply
  const prompt = quizPrompt(srcTitle(id), { count, level, avoid: (z?.questions ?? []).map(x => x.q), schemas: schemas && !fiche, themes });
  const done = (text, now) => { addQuestions(id, parseQuiz(text), now.title); };
  return fiche ? runFicheJob(id, "quiz", prompt, done) : runJob(id, "quiz", prompt, done, { schemas });
}

/** Runs `work(item)` for every item, at most `n` at a time. */
async function pool(items, n, work) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) await work(queue.shift());
  }));
}

/**
 * Prepares and starts a quiz of `size` questions at `level` on `themes` over `lectures`: the
 * questions not sorted by theme yet are sorted first (one quick run per lecture), then Claude
 * writes what is missing on those themes.
 */
async function startQuiz(lectures, size, level, themes = checkedThemes()) {
  if (!lectures.length || view.prep) return;
  view.page = "quiz";
  view.play = null;
  const schemas = withSchemas();
  const prep = { lectures, size, level, themes, schemas, stage: "sort", jobs: {} };
  const unsorted = lectures.filter(id => unclassified(bankOf(id)?.questions).length);
  if (unsorted.length) {
    prep.jobs = Object.fromEntries(unsorted.map(id => [id, "wait"]));
    view.prep = prep;
    app.refresh();
    await pool(unsorted, PARALLEL, async id => {
      if (view.prep !== prep) return; // cancelled
      prep.jobs[id] = "run";
      app.refresh();
      // a failed sort does not hold the quiz back: its questions then count for every theme
      prep.jobs[id] = await sortByTheme(id, "question", () => bankOf(id)?.questions ?? []) ? "done" : "fail";
      app.refresh();
    });
    if (view.prep !== prep) return;
  }
  const todo = planQuiz(lectures.map(bankFor), size, level, themes).filter(p => p.make > 0);
  if (todo.length) {
    Object.assign(prep, { stage: "write", jobs: Object.fromEntries(todo.map(p => [p.lecture, "wait"])) });
    view.prep = prep;
    app.refresh();
    await pool(todo, PARALLEL, async p => {
      if (view.prep !== prep) return; // cancelled
      prep.jobs[p.lecture] = "run";
      app.refresh();
      prep.jobs[p.lecture] = await makeQuestions(p.lecture, p.make, level, schemas, themes) ? "done" : "fail";
      app.refresh();
    });
    if (view.prep !== prep) return;
    const failed = Object.values(prep.jobs).filter(s => s === "fail").length;
    if (failed) toast(`Claude could not write questions for ${failed} lecture${failed === 1 ? "" : "s"}; the quiz uses what is there.`, "error");
  }
  view.prep = null;
  begin(lectures, size, level, null, themes);
}

/** Draws the quiz on `themes` and starts it; a retry asks `items` again without counting it. */
function begin(lectures, size, level, items = null, themes = checkedThemes()) {
  const retry = Boolean(items);
  const live = lectures.filter(srcExists);
  const chosen = items || drawQuiz(live.map(bankFor), size, level, Math.random, themes);
  if (!chosen.length) {
    view.play = null;
    toast("There are no questions on these themes to ask yet for these lectures.", "error");
    app.refresh();
    return;
  }
  if (!retry) for (const id of new Set(chosen.map(m => m.lecture))) { const z = bankOf(id); if (z) z.quizzes = (z.quizzes || 0) + 1; }
  view.play = { lectures: live, size, level, themes, items: chosen, i: 0, picks: [], right: [], retry, done: false, score: 0, total: 0, missed: [] };
  view.page = "quiz";
  save();
  app.refresh();
  scrollTop();
}

/** Answers the question on screen with the option shown at position k. */
function choose(k) {
  const p = activePlay();
  if (!p || p.done || p.picks[p.i] !== undefined) return;
  const item = p.items[p.i];
  const s = item.order[k];
  const z = bankOf(item.lecture);
  const at = z ? z.questions.findIndex(x => x.id === item.id) : -1;
  if (s === undefined || at === -1) return;
  const right = s === z.questions[at].answer;
  p.picks[p.i] = s;
  p.right[p.i] = right;
  // a retry comes right after seeing the answers: it does not change when questions come back
  if (!p.retry) z.questions[at] = answered(z.questions[at], right, today(), z.quizzes || 0);
  save();
  app.refresh();
}

function finish(p) {
  p.done = true;
  p.total = p.items.length;
  p.score = p.right.filter(Boolean).length;
  p.missed = p.items.filter((_, k) => !p.right[k]);
  if (!p.retry && p.total) {
    // each lecture keeps its own part of the score; the log keeps the whole quiz
    const by = new Map();
    p.items.forEach((m, k) => {
      const r = by.get(m.lecture) || { score: 0, total: 0 };
      r.total += 1;
      if (p.right[k]) r.score += 1;
      by.set(m.lecture, r);
    });
    for (const [id, r] of by) { const z = bankOf(id); if (z) Object.assign(z, withSession(z, { date: today(), ...r })); }
    // every quiz is kept (Progress reads them), with her score per lecture
    const per = Object.fromEntries([...by].map(([id, r]) => [id, [r.score, r.total]]));
    D.quizLog = [...(D.quizLog || []), { date: today(), lectures: [...by.keys()], score: p.score, total: p.total, level: p.level, by: per }];
  }
  save();
}

/** Opens the quiz page with lectures `ids` ticked (from Progress); the caller then goes to "notebook". */
export function quizLectures(ids) {
  view.pick = new Set(ids.filter(srcQuizzable));
  for (const id of view.pick) view.unfold.add(isFicheSrc(id) ? FICHES_KEY : groupKey(D.items[id]));
  view.page = "quiz";
  if (view.play?.done) view.play = null;
}

function next() {
  const p = activePlay();
  if (!p || p.done || p.picks[p.i] === undefined) return;
  if (p.i < p.items.length - 1) p.i += 1;
  else finish(p);
  app.refresh();
}

/** Keyboard during a quiz: 1–4 or A–D answers, Enter or Space goes on. Called by main.js. */
export function onKey(e) {
  if (view.page !== "quiz") {
    const extra = extraTab();
    if (extra) extra.onKey?.(e, view.sel);
    return;
  }
  const p = activePlay();
  if (!p || p.done) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const k = Math.max(["1", "2", "3", "4"].indexOf(key), ["a", "b", "c", "d"].indexOf(key));
  if (k !== -1) {
    if (p.picks[p.i] !== undefined) return;
    e.preventDefault();
    choose(k);
    return;
  }
  if (key === "Enter" || key === " ") {
    if (e.target.closest?.("button, a, summary, label, input")) return; // the focused control acts on its own
    if (p.picks[p.i] === undefined) return;
    e.preventDefault();
    next();
  }
}

export const actions = {
  ...Object.assign({}, ...EXTRA_TABS.map(t => t.actions)),
  select: el => {
    view.sel = el.dataset.id;
    view.page = "lecture";
    if (D.items[view.sel]) view.open.add(groupKey(D.items[view.sel]));
    app.refresh();
    scrollTop();
  },
  toggleGroup: el => {
    const k = el.dataset.key;
    if (view.open.has(k)) view.open.delete(k); else view.open.add(k);
    app.refresh();
  },
  tab: el => { view.tab = el.dataset.tab; app.refresh(); },
  goCourses: () => app.go("courses"),
  goSettings: () => app.go("settings"),
  genCount: el => { view.genCount = Number(el.value) || 10; app.refresh(); },
  genLevel: el => { view.genLevel = el.value; },
  // "Standard | With schemas", wherever it is shown (study guide, quiz, flashcards): one remembered choice
  nbSchemas: el => { setSchemas(el.dataset.on === "1"); app.refresh(); },
  // the theme chips, wherever they are shown (quiz page, a lecture's Quiz tab, flashcards): one choice for all
  nbTheme: el => {
    if (!toggleTheme(el.dataset.theme)) { toast("Keep at least one theme ticked."); return; }
    app.refresh();
  },
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
    try { openViewer(it.title, await pdfUrl(it.pdf.id), null, { notes: view.sel }); }
    catch { toast("This PDF could not be opened. Attach it again from the lecture.", "error"); }
  },
  openPage: async el => {
    const src = el.dataset.lecture || view.sel;
    const it = isFicheSrc(src) ? srcFiche(src) : D.items[src];
    try { openViewer(it.title, await pdfUrl(it.pdf.id), Number(el.dataset.page), { notes: src }); }
    catch { toast("This PDF could not be opened. Attach it again from the lecture.", "error"); }
  },
  // the quiz page
  quizOpen: () => { view.page = "quiz"; app.refresh(); scrollTop(); },
  quizLecture: () => {
    view.pick = new Set([view.sel]);
    view.unfold.add(groupKey(D.items[view.sel]));
    view.play = null;
    view.page = "quiz";
    app.refresh();
    scrollTop();
  },
  quizTick: el => { if (el.checked) view.pick.add(el.dataset.id); else view.pick.delete(el.dataset.id); app.refresh(); },
  quizTickGroup: el => {
    const g = groups().find(x => x.key === el.dataset.key);
    if (!g) return;
    for (const it of g.items) if (el.checked) view.pick.add(it.id); else view.pick.delete(it.id);
    app.refresh();
  },
  quizTickFiches: el => {
    for (const [s] of quizFiches()) if (el.checked) view.pick.add(s); else view.pick.delete(s);
    app.refresh();
  },
  quizUnfold: el => {
    const k = el.dataset.key;
    if (view.unfold.has(k)) view.unfold.delete(k); else view.unfold.add(k);
    app.refresh();
  },
  quizExam: el => {
    const ids = new Set(Object.entries(D.modules).filter(([, m]) => m.exam === el.dataset.date).map(([id]) => id));
    view.pick = new Set(groups().filter(g => ids.has(g.key)).flatMap(g => g.items.map(it => it.id)));
    app.refresh();
  },
  quizClear: () => { view.pick.clear(); app.refresh(); },
  quizSize: el => { view.size = Number(el.dataset.n) || 10; app.refresh(); },
  quizLevel: el => { view.level = el.dataset.level; app.refresh(); },
  quizStart: () => startQuiz(pickedLectures(), view.size, view.level),
  quizAgain: () => { const p = view.play; if (p) startQuiz(p.lectures.filter(srcQuizzable), p.size, p.level, p.themes || checkedThemes()); },
  quizNew: () => { view.play = null; app.refresh(); },
  quizCancel: () => { view.prep = null; app.refresh(); }, // what Claude is writing still goes into the banks
  retryMissed: () => {
    const p = activePlay();
    if (!p?.done) return;
    const left = p.missed.filter(m => qOf(m));
    begin(p.lectures, left.length, p.level, shuffled(left.length).map(k => ({ lecture: left[k].lecture, id: left[k].id, order: shuffled(4) })), p.themes);
  },
  pick: el => choose(Number(el.dataset.k)),
  next,
  quitQuiz: () => { view.play = null; app.refresh(); },
  toggleBank: () => { view.showBank = !view.showBank; app.refresh(); },
  deleteQuestion: async el => {
    const id = el.dataset.lecture || view.sel, qid = el.dataset.q;
    const x = findQ(bankOf(id), qid);
    if (!x || !await confirmBox("Delete this question?", `"${x.q}" is removed from the question bank.`)) return;
    const z = bankOf(id);
    if (!z) return;
    z.questions = z.questions.filter(q => q.id !== qid);
    // the quiz that asks it, on screen or not
    const p = view.play;
    const k = p ? p.items.findIndex(m => m.lecture === id && m.id === qid) : -1;
    if (p && k !== -1) {
      const gone = p.items[k];
      for (const list of [p.items, p.picks, p.right]) list.splice(k, 1);
      if (p.done) {
        p.total = p.items.length;
        p.score = p.right.filter(Boolean).length;
        p.missed = p.missed.filter(m => m !== gone);
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
      `All ${z.questions.length} questions of this lecture are removed. Your best score and past quizzes are kept.`, "Delete all")) return;
    z.questions = [];
    if (view.play?.items.some(m => m.lecture === view.sel)) view.play = null;
    view.showBank = false;
    save(); app.refresh();
  },
  markQuizzed: () => {
    const p = view.play;
    const ids = p ? [...new Set(p.items.map(m => m.lecture))] : [view.sel];
    let n = 0;
    for (const id of ids) {
      const it = D.items[id];
      if (it && !it.quizzedAt) { setStep(it, "quizzed", today()); n++; }
    }
    if (!n) return;
    save(); app.refresh();
    toast(`Marked as quizzed 🌸`);
  },
};
