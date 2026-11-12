// Notebook: a study guide and a quiz for each lecture PDF, written by Claude Code on this Mac.
import { D, save, isLecture, itemsList, itemWeek, modulesSorted, moduleOf } from "../store.js";
import { today, relDay } from "../dates.js";
import { setStep } from "../recall.js";
import { esc, icon, app, openViewer, confirmBox, cvar, toast } from "../ui.js";
import { pdfUrl } from "../files.js";
import { askAboutPdf } from "../assistant.js";
import { guidePrompt, quizPrompt, parseGuide, parseQuiz, shuffleOptions } from "../notebook-core.js";

const QUESTIONS = 8;
const LETTERS = ["A", "B", "C", "D"];

/** Survives changes of view: which lecture and tab are open, and the quiz being played (never saved). */
const view = { sel: null, tab: "guide", play: null };
/** "<lectureId>:guide" or "<lectureId>:quiz" while Claude is working on it. */
const running = new Set();
let missingClaude = false;

const KIND = {
  guide: { name: "study guide", prompt: guidePrompt, parse: parseGuide },
  quiz: { name: "quiz", prompt: title => quizPrompt(title, QUESTIONS), parse: parseQuiz },
};

const notes = id => D.notebook[id] || {};
const isRunning = (id, kind) => running.has(`${id}:${kind}`);

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
  const n = notes(it.id);
  const mark = (kind, ic, label) => {
    const state = isRunning(it.id, kind) ? "busy" : n[kind] ? "on" : "";
    const what = state === "busy" ? `${label}: Claude is working` : n[kind] ? `${label}: ready` : `${label}: not made yet`;
    return `<i class="nb-mark ${state}" title="${what}">${icon(state === "busy" ? "clock" : ic, 14)}</i>`;
  };
  return `<button class="side-item ${view.sel === it.id ? "on" : ""}" data-act="select" data-id="${it.id}" ${cvar(moduleOf(it).color)} title="${esc(it.title)}">
    <span class="dot"></span><span>${esc(it.title)}</span>
    <small class="nb-marks">${mark("guide", "note", "Study guide")}${mark("quiz", "todo", "Quiz")}</small>
  </button>`;
}

/** The "nothing yet" and "Claude is working" states shared by both tabs. */
function placeholder(id, kind, lead, hint) {
  if (isRunning(id, kind)) {
    return `<div class="empty nb-wait" role="status"><span class="nb-spin" aria-hidden="true"></span>
      <p class="lead">Claude is reading the PDF and writing your ${KIND[kind].name}…</p>
      <p class="small">This usually takes a minute or two. You can keep using Bloom; it will be here when it is done.</p></div>`;
  }
  return `<div class="empty nb-wait"><p class="lead">${lead}</p><p class="small">${hint}</p>
    <div class="btns center"><button class="btn primary" data-act="generate" data-kind="${kind}">${icon("spark", 16)} Generate ${KIND[kind].name}</button></div></div>`;
}

const pageTag = p => (p ? `<span class="pill">p. ${esc(p)}</span>` : "");

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

function quizTab(id) {
  const z = notes(id).quiz;
  if (!z) return `<section class="card">${placeholder(id, "quiz", "No quiz yet.",
    `Claude reads the PDF and writes ${QUESTIONS} multiple-choice questions, each with an explanation and its page.`)}</section>`;
  const total = z.questions.length;
  const head = cardHead(id, "quiz", "Quiz", `${total} questions${z.best != null ? ` · best ${z.best}/${total}` : ""} · made ${relDay(z.createdAt)}`);
  const p = view.play?.quiz === z ? view.play : null;

  if (!p) {
    return `<section class="card">${head}
      <div class="empty nb-wait"><p class="lead">${total} questions, one at a time.</p>
        <p class="small">You see right away whether you were right, and why.</p>
        <div class="btns center"><button class="btn primary" data-act="startQuiz">Start the quiz</button></div></div>
    </section>`;
  }

  if (p.done) {
    const score = p.picks.filter((k, i) => k === z.questions[i].answer).length;
    const it = D.items[id];
    const msg = score === total ? "Perfect score! 🌷" : score >= total * 0.75 ? "Very good! 🌸" : score >= total / 2 ? "Good start. Have another look at the ones you missed." : "Worth another read of the lecture, then try again.";
    return `<section class="card">${head}
      <div class="empty nb-wait">
        <p class="nb-score">${score}<small>/${total}</small></p>
        <p class="lead">${msg}</p>
        ${it.quizzedAt ? `<p class="small">This lecture is marked as quizzed.</p>` : ""}
        <div class="btns center">
          ${it.quizzedAt ? "" : `<button class="btn primary" data-act="markQuizzed">${icon("check", 16)} Mark the lecture as quizzed</button>`}
          <button class="btn ghost" data-act="startQuiz">Try again</button>
        </div>
      </div>
    </section>`;
  }

  const x = z.questions[p.i];
  const picked = p.picks[p.i];
  const answered = picked !== undefined;
  const opts = x.options.map((o, k) => {
    const cls = !answered ? "" : k === x.answer ? "right" : k === picked ? "wrong" : "";
    return `<button class="nb-opt ${cls}" data-act="pick" data-k="${k}" ${answered ? "disabled" : ""}><b>${LETTERS[k]}</b><span>${esc(o)}</span></button>`;
  }).join("");
  const last = p.i === total - 1;
  return `<section class="card">${head}
    <div class="card-b">
      <div class="nb-progress"><span class="muted small">Question ${p.i + 1} of ${total}</span><span class="grow"></span><button class="btn ghost small" data-act="quitQuiz">Stop</button></div>
      <p class="nb-q">${esc(x.q)}</p>
      <div class="nb-opts">${opts}</div>
      ${answered ? `<div class="nb-why ${picked === x.answer ? "right" : "wrong"}">
          <b>${picked === x.answer ? "Right!" : `Not quite: the answer is ${LETTERS[x.answer]}.`}</b>
          <span>${esc(x.why)}</span>${pageTag(x.page)}
        </div>
        <div class="btns end"><button class="btn primary" data-act="next">${last ? "See my score" : "Next question"}</button></div>` : ""}
    </div>
  </section>`;
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

  const warn = missingClaude ? `<section class="card nb-warn"><div class="card-b">
      <p><b>Claude Code is needed for the Notebook.</b></p>
      <p class="muted">The Notebook uses Claude Code, the Claude app for the Terminal, installed and signed in on this Mac with your own Claude account. Install it from claude.com/claude-code, open Terminal, type <span class="mono">claude</span>, sign in once, then try again here.</p>
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

/** Asks Claude for a study guide or a quiz. Runs in the background; the old one stays until the new one is ready. */
async function generate(id, kind) {
  const key = `${id}:${kind}`;
  const it = D.items[id];
  if (running.has(key) || !it?.pdf) return;
  const pdfId = it.pdf.id;
  running.add(key);
  refreshIfHere();
  try {
    const text = await askAboutPdf(pdfId, KIND[kind].prompt(it.title));
    const data = KIND[kind].parse(text);
    missingClaude = false;
    const now = D.items[id];
    if (!now || now.pdf?.id !== pdfId) return; // the lecture or its PDF changed meanwhile
    const nb = (D.notebook[id] ??= {});
    if (kind === "guide") nb.guide = { createdAt: today(), ...data };
    else nb.quiz = { createdAt: today(), questions: shuffleOptions(data.questions), best: null };
    save();
    toast(`The ${KIND[kind].name} for "${now.title}" is ready 🌸`);
  } catch (e) {
    if (e?.code === "no-claude") {
      missingClaude = true;
      toast("Claude Code is not installed on this Mac.", "error");
    } else toast(e?.message || String(e), "error");
  } finally {
    running.delete(key);
    refreshIfHere();
  }
}

export const actions = {
  select: el => { view.sel = el.dataset.id; app.refresh(); },
  tab: el => { view.tab = el.dataset.tab; app.refresh(); },
  goCourses: () => app.go("courses"),
  generate: async el => {
    const id = view.sel, kind = el.dataset.kind;
    if (isRunning(id, kind)) return;
    if (notes(id)[kind] && !await confirmBox(`Make a new ${KIND[kind].name}?`,
      `Claude writes a new one from the PDF. The current ${KIND[kind].name} stays until the new one is ready, then it is replaced.`, "Regenerate")) return;
    generate(id, kind);
  },
  openPdf: async () => {
    const it = D.items[view.sel];
    try { openViewer(it.title, await pdfUrl(it.pdf.id)); }
    catch { toast("This PDF could not be opened. Attach it again from the lecture.", "error"); }
  },
  startQuiz: () => {
    const z = notes(view.sel).quiz;
    if (!z) return;
    // tied to this quiz object, so a regenerated or restored quiz starts fresh
    view.play = { quiz: z, i: 0, picks: [], done: false };
    app.refresh();
  },
  pick: el => {
    const p = view.play;
    if (!p || p.done || p.picks[p.i] !== undefined) return;
    p.picks[p.i] = Number(el.dataset.k);
    app.refresh();
  },
  next: () => {
    const p = view.play;
    const z = p?.quiz;
    if (!p || p.done) return;
    if (p.i < z.questions.length - 1) { p.i += 1; app.refresh(); return; }
    p.done = true;
    const score = p.picks.filter((k, i) => k === z.questions[i].answer).length;
    if (z.best == null || score > z.best) { z.best = score; save(); }
    app.refresh();
  },
  quitQuiz: () => { view.play = null; app.refresh(); },
  markQuizzed: () => {
    const it = D.items[view.sel];
    if (!it || it.quizzedAt) return;
    setStep(it, "quizzed", today());
    save(); app.refresh();
    toast("Marked as quizzed 🌸");
  },
};
