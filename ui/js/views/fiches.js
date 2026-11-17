// Fiches: study sheets. Claude Code writes one on demand from the lecture PDFs she picks (first it
// reads them and may ask a few multiple-choice questions, then it writes for as long as it needs,
// keeping progress.json), and she can upload her own PDFs (her LaTeX companions). A module can have
// any number of fiches. Shape of D.fiches and the prompts: fiches-core.js; the run and the files:
// fiche-run.js; the A4 layout, the viewer and the export: fiche-render.js.
import { D, save, uid, isLecture, itemsList, itemWeek, modulesSorted, moduleOf } from "../store.js";
import { today, fmtDay, fmtWday } from "../dates.js";
import { esc, icon, app, openViewer, openModal, confirmBox, cvar, toast, field, input } from "../ui.js";
import { storePdf, pdfUrl, removePdf, fmtSize } from "../files.js";
import { assistantStatus } from "../assistant.js";
import { isUsageLimit, limitResetsAt } from "../assistant-core.js";
import { examGroups } from "../quiz-core.js";
import {
  PRECISIONS, ORGANISATIONS, INCLUDES, DIAGRAMS, LANGUAGES, DEFAULT_OPTIONS, MIN_PAGES, MAX_PAGES,
  normOptions, lectureKeys, modulesOf, questionsPrompt, writePrompt, parseQuestions, answerPairs,
  parseProgress, fmtElapsed, groupByModule,
} from "../fiches-core.js";
import { prepareFiche, startRun, runStatus, cancelRun, readFicheFile, deleteFicheFiles } from "../fiche-run.js";
import { openFiche, forgetImages, hasChapters } from "../fiche-render.js";
import { quizLectures } from "./notebook.js";
import { ficheSrc, ficheQuizzable } from "../sources.js";

const NO_MODULE = "-";
const POLL_MS = 4000;

/**
 * Survives changes of view; never saved. page: "list" | "new" | "fiche"; sel: the fiche on the
 * "fiche" page. form: the new fiche being set up. live: runs being followed, by fiche id:
 * { timer, progress, phase }. checked: fiches whose run was looked up since Bloom started.
 */
const view = {
  page: "list", sel: null, form: null, more: false,
  live: new Map(), checked: new Set(), setup: null, written: new Map(),
};

const nowIso = () => new Date().toISOString();
const here = () => document.getElementById("main")?.dataset.view === "fiches";
const refreshIfHere = () => { if (here() && view.page !== "new") app.refresh(); };

function freshForm() {
  return { pick: new Set(), unfold: new Set(), ...structuredClone({ ...DEFAULT_OPTIONS, include: { ...DEFAULT_OPTIONS.include } }), notes: "", title: "", titleTouched: false };
}

/** Lectures with a PDF, grouped by module in the usual order. */
function groups() {
  const withPdf = itemsList().filter(it => isLecture(it) && it.pdf);
  const order = list => list.sort((a, b) => (itemWeek(a) ?? 99) - (itemWeek(b) ?? 99) || (a.date || "9").localeCompare(b.date || "9") || (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title));
  const out = modulesSorted().map(m => ({ key: m.id, name: m.name, color: m.color, items: order(withPdf.filter(it => it.module === m.id)) }));
  out.push({ key: NO_MODULE, name: "No module", color: "plum", items: order(withPdf.filter(it => !D.modules[it.module])) });
  return out.filter(g => g.items.length);
}

const picked = () => groups().flatMap(g => g.items).filter(it => view.form.pick.has(it.id));

function defaultTitle(form) {
  const lectures = picked();
  const mods = modulesOf(lectures.map(l => l.id), D.items).map(m => D.modules[m]?.name).filter(Boolean);
  const kind = PRECISIONS.find(p => p.id === form.precision)?.label || "Fiche";
  const what = lectures.length === 1 ? lectures[0].title : mods.length ? mods.join(" + ") : "Fiche";
  return `${what} — ${kind.toLowerCase()}`;
}

// ---------------------------------------------------------------- following a run

function errorText(msg) {
  const m = String(msg || "");
  if (m === "cancelled") return "You stopped it.";
  if (m === "no-claude") return "Claude is not installed on this Mac. Set it up in Settings.";
  if (isUsageLimit(m)) {
    const at = new Date(limitResetsAt(m, new Date()));
    return `Claude's usage limit is reached; it resets around ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Press Continue then: Claude goes on from what it has written.`;
  }
  if (/more steps than allowed|max_turns/i.test(m)) return "Claude used all the steps one run may take. Press Continue: it goes on from what it has written.";
  return m;
}

function follow(id) {
  if (view.live.has(id)) return;
  const live = { timer: 0, progress: null };
  view.live.set(id, live);
  const tick = async () => {
    const f = D.fiches[id];
    if (!f) { stopFollowing(id); return; }
    let s;
    try { s = await runStatus(id); } catch { live.timer = setTimeout(tick, POLL_MS * 2); return; }
    if (f.status === "writing") {
      try { live.progress = parseProgress(await readFicheFile(id, "progress.json")); } catch { /* not there yet */ }
    }
    if (s.running) {
      // redraw only when something she can see changed; the elapsed time is updated in place
      const sig = JSON.stringify([f.status, live.progress]);
      if (sig !== live.sig) { live.sig = sig; refreshIfHere(); }
      else for (const el of document.querySelectorAll(`[data-elapsed="${id}"]`)) el.textContent = elapsed(f);
      live.timer = setTimeout(tick, POLL_MS);
      return;
    }
    stopFollowing(id);
    await finished(id, s);
  };
  live.timer = setTimeout(tick, 1000);
}

function stopFollowing(id) {
  const live = view.live.get(id);
  if (live) clearTimeout(live.timer);
  view.live.delete(id);
}

/** A run ended: read its outcome. */
async function finished(id, s) {
  const f = D.fiches[id];
  if (!f) return;
  f.updatedAt = nowIso();
  if (f.status === "reading") {
    if (s.error || s.result === null) {
      f.status = "failed";
      f.error = errorText(s.error || "Claude stopped before answering.");
    } else {
      try {
        f.questions = parseQuestions(s.result);
        f.error = null;
        if (f.questions.length) {
          f.status = "questions";
          toast(`Claude has ${f.questions.length} question${f.questions.length === 1 ? "" : "s"} about "${f.title}"`);
        } else { save(); refreshIfHere(); return write(id, false); }
      } catch (e) {
        f.status = "failed";
        f.error = e.message;
      }
    }
  } else if (f.status === "writing") {
    const progress = parseProgress(await readFicheFile(id, "progress.json").catch(() => null));
    const any = await hasChapters(id);
    view.written.set(id, any);
    if (!s.error && s.result !== null && any) {
      f.status = "done";
      f.error = progress && !progress.done ? "Claude ended before marking every chapter done; check the last one." : null;
      forgetImages(id);
      toast(`"${f.title}" is ready 🌸`);
    } else {
      f.status = "stopped";
      f.error = errorText(s.error || (any ? "Claude stopped before the end." : "Claude finished without writing the sheet."));
    }
  }
  save();
  refreshIfHere();
}

/** Lectures as the prompts list them. */
function promptLectures(f) {
  return (f.lectures || []).filter(id => D.items[id]).map(id => ({
    key: f.keys[id], title: D.items[id].title, module: moduleOf(D.items[id]).name, pages: f.slides?.[f.keys[id]] || 0,
  }));
}
const totalSlides = f => Object.values(f.slides || {}).reduce((a, b) => a + (Number(b) || 0), 0);

/** Claude is ready, or the "Set up in Settings" card shows and false is returned. */
async function claudeReady() {
  const s = await assistantStatus().catch(() => null);
  if (!s) return true; // a failed check does not block: the run reports its own errors
  const c = s.claude || {};
  view.setup = c.installed && c.loggedIn ? null : c.installed ? "signedout" : "missing";
  return !view.setup;
}

/** Phase 1: copy the PDFs into the fiche's folder, then Claude reads them and may ask questions. */
async function read(id) {
  const f = D.fiches[id];
  if (!f) return;
  f.status = "reading"; f.error = null; f.startedAt = nowIso(); f.updatedAt = nowIso();
  save(); refreshIfHere();
  try {
    if (!await claudeReady()) throw new Error("Claude is not set up yet. Set it up in Settings, then press Try again.");
    const lectures = f.lectures.filter(lid => D.items[lid]?.pdf).map(lid => ({ key: f.keys[lid], pdfId: D.items[lid].pdf.id }));
    if (!lectures.length) throw new Error("None of these lectures has a PDF any more.");
    f.slides = await prepareFiche(id, lectures);
    save();
    await startRun(id, questionsPrompt({ lectures: promptLectures(f), options: f.options, notes: f.notes, slides: totalSlides(f) }));
    follow(id);
  } catch (e) {
    f.status = "failed";
    f.error = errorText(e?.code || e?.message || String(e));
    save();
  }
  refreshIfHere();
}

/** Phase 2: Claude writes the fiche; `resume` continues from the files already in the folder. */
async function write(id, resume) {
  const f = D.fiches[id];
  if (!f) return;
  const again = resume || f.wrote === true;
  f.status = "writing"; f.error = null; f.wrote = true; f.startedAt = nowIso(); f.updatedAt = nowIso();
  save(); refreshIfHere();
  try {
    if (!await claudeReady()) throw new Error("Claude is not set up yet. Set it up in Settings, then press Continue.");
    await startRun(id, writePrompt({
      lectures: promptLectures(f), options: f.options, notes: f.notes, slides: totalSlides(f),
      answers: answerPairs(f.questions, f.answers), resume: again,
    }));
    follow(id);
  } catch (e) {
    f.status = "stopped";
    f.error = errorText(e?.code || e?.message || String(e));
    save();
  }
  refreshIfHere();
}

/** Once per fiche and launch: a run that Bloom no longer follows (it was closed, the page reloaded). */
async function checkStale(id) {
  if (view.checked.has(id) || view.live.has(id)) return;
  view.checked.add(id);
  const f = D.fiches[id];
  if (!f || f.source === "uploaded") return;
  if (f.status === "stopped" || f.status === "done") {
    const any = await hasChapters(id);
    if (view.written.get(id) !== any) { view.written.set(id, any); refreshIfHere(); }
    return;
  }
  if (f.status !== "reading" && f.status !== "writing") return;
  const s = await runStatus(id).catch(() => ({ running: false, result: null, error: null }));
  if (s.running) { follow(id); return; }
  if (s.result !== null || s.error) { await finished(id, s); return; }
  f.status = f.status === "reading" ? "failed" : "stopped";
  f.error = "Bloom was closed while Claude was working.";
  view.written.set(id, await hasChapters(id));
  save();
  refreshIfHere();
}

// ---------------------------------------------------------------- the list

const STATUS = {
  reading: ["Reading the slides", "accent"], questions: ["Questions for you", "accent"], writing: ["Writing", "accent"],
  done: ["Ready", "ok"], stopped: ["Stopped", "warn"], failed: ["Not started", "warn"],
};

function statusPill(f) {
  if (f.source === "uploaded") return "";
  const [label, kind] = STATUS[f.status] || ["", ""];
  const busy = f.status === "reading" || f.status === "writing";
  return `<span class="pill fc-st ${kind}">${busy ? '<span class="nb-spin small" aria-hidden="true"></span>' : ""}${esc(label)}</span>`;
}

function ficheRow(id, f) {
  const up = f.source === "uploaded";
  const sub = up
    ? `${esc(f.pdf?.name || "PDF")}${f.pdf?.size ? ` · ${fmtSize(f.pdf.size)}` : ""}`
    : `${(f.lectures || []).length} lecture${(f.lectures || []).length === 1 ? "" : "s"} · ${esc(PRECISIONS.find(p => p.id === f.options?.precision)?.label || "")}${f.pages ? ` · ${f.pages} pages` : ""}`;
  return `<div class="row fc-row">
    <button class="fc-row-main" data-act="${up ? "openUpload" : "select"}" data-id="${esc(id)}" title="${up ? "Open the PDF" : "Open"}">
      <span class="fc-row-ic ${up ? "up" : ""}">${icon(up ? "file" : "spark", 18)}</span>
      <span class="row-main"><span class="t">${esc(f.title)}</span>
        <span class="sub"><span class="fc-tag ${up ? "up" : "gen"}">${up ? "Uploaded" : "Generated"}</span><span>${sub}</span><span>· ${esc(fmtDay(String(f.createdAt || "").slice(0, 10) || today()))}</span></span></span>
    </button>
    ${statusPill(f)}
    ${ficheQuizzable(f) ? `<button class="btn soft small" data-act="quiz" data-id="${esc(id)}" title="${f.quiz?.questions?.length ? `${f.quiz.questions.length} questions so far` : "Claude writes the questions from the fiche"}">${icon("todo", 15)} Quiz</button>` : ""}
    ${!up && f.status === "done" ? `<button class="btn soft small" data-act="open" data-id="${esc(id)}">${icon("file", 15)} Open</button>` : ""}
    ${!up && f.status === "stopped" ? `<button class="btn soft small" data-act="resume" data-id="${esc(id)}">${icon("repeat", 15)} Continue</button>` : ""}
    ${!up && f.status === "questions" ? `<button class="btn soft small" data-act="select" data-id="${esc(id)}">Answer</button>` : ""}
    <button class="iconbtn" data-act="edit" data-id="${esc(id)}" title="Rename" aria-label="Rename">${icon("edit", 16)}</button>
    <button class="iconbtn" data-act="remove" data-id="${esc(id)}" title="Delete" aria-label="Delete">${icon("trash", 16)}</button>
  </div>`;
}

function listPage() {
  for (const id of Object.keys(D.fiches || {})) checkStale(id);
  const gs = groupByModule(D.fiches, modulesSorted().map(m => m.id));
  if (!gs.length) {
    return `<section class="card coming">
      <div class="coming-ic">${icon("file", 34)}</div>
      <h2>No fiches yet</h2>
      <p class="lead">Choose lectures and how detailed you want it: Claude reads the slides and writes a sheet laid out like your LaTeX companions, ready to print. You can also upload the fiches you already have.</p>
      <div class="btns center"><button class="btn primary" data-act="newFiche">${icon("plus", 16)} New fiche</button>
      <button class="btn ghost" data-act="upload">${icon("clip", 16)} Upload a fiche</button></div>
    </section>`;
  }
  return gs.map(g => {
    const m = g.module ? D.modules[g.module] : null;
    return `<section class="card fc-group" ${cvar(m?.color || "plum")}>
      <div class="card-h"><span class="dot big"></span><h2>${esc(m?.name || "No module")}</h2><span class="muted small">${g.fiches.length} fiche${g.fiches.length === 1 ? "" : "s"}</span></div>
      ${g.fiches.map(([id, f]) => ficheRow(id, f)).join("")}
    </section>`;
  }).join("");
}

// ---------------------------------------------------------------- one fiche

function setupCard() {
  if (!view.setup) return "";
  return `<section class="card nb-warn"><div class="card-b">
    <p><b>${view.setup === "missing" ? "Claude is not set up yet." : "Claude is not signed in."}</b></p>
    <p class="muted">${view.setup === "missing"
      ? "Fiches are written by Claude, with your own Claude account. Setting it up takes a minute, in Settings."
      : "Fiches are written by Claude with your own Claude account. Sign in once in Settings, then try again here."}</p>
    <div class="btns"><button class="btn primary small" data-act="goSettings">Set up in Settings</button></div>
  </div></section>`;
}

const elapsed = f => fmtElapsed(Date.now() - Date.parse(f.startedAt || nowIso()));

function stateCard(id, f) {
  const keepOpen = `<p class="small muted">${icon("clock", 14)} Keep Bloom open until it is done (you can use the other tabs). If Bloom closes, the fiche shows “Continue” and Claude goes on from where it stopped.</p>`;
  if (f.status === "reading") {
    return `<div class="fc-state"><span class="nb-spin" aria-hidden="true"></span>
      <div class="grow"><p class="lead">Claude is reading the ${(f.lectures || []).length} PDF${(f.lectures || []).length === 1 ? "" : "s"}…</p>
      <p class="small muted">Then it asks you a few questions if it has real ones, or starts writing at once. <span data-elapsed="${esc(id)}">${esc(elapsed(f))}</span> so far.</p>${keepOpen}</div>
      <button class="btn ghost small" data-act="cancel" data-id="${esc(id)}">Cancel</button></div>`;
  }
  if (f.status === "questions") {
    const qs = f.questions || [];
    return `<form class="fc-qs" data-submit="answer" data-id="${esc(id)}">
      <p class="lead">Claude read the slides and has ${qs.length} question${qs.length === 1 ? "" : "s"} before it writes. The suggested answer is already chosen: change what you like.</p>
      ${qs.map((q, k) => `<fieldset class="fc-q"><legend><b>${k + 1}.</b> ${esc(q.q)}</legend>
        ${q.options.map((o, j) => `<label class="fc-opt"><input type="radio" name="${esc(q.id)}" value="${j}" ${(f.answers?.[q.id] ?? q.default) === j ? "checked" : ""}><span>${esc(o)}${j === q.default ? ' <small class="muted">(suggested)</small>' : ""}</span></label>`).join("")}
      </fieldset>`).join("")}
      <div class="btns"><button class="btn primary" type="submit">${icon("spark", 16)} Write the fiche</button></div>
    </form>`;
  }
  if (f.status === "writing") {
    const p = view.live.get(id)?.progress;
    const total = p?.chapters.length || 0, done = p?.chapters.filter(c => c.done).length || 0;
    const now = p?.chapters.find(c => !c.done);
    const share = total ? Math.round(100 * done / total) : 0;
    return `<div class="fc-state"><span class="nb-spin" aria-hidden="true"></span>
      <div class="grow"><p class="lead">Claude is writing the fiche${total ? `: chapter ${Math.min(done + 1, total)} of ${total}` : "…"}</p>
      ${total ? `<div class="fc-bar" role="progressbar" aria-valuenow="${share}" aria-valuemin="0" aria-valuemax="100"><i style="width:${share}%"></i></div>` : ""}
      <p class="small">${now ? esc(now.title) : ""}${p?.doing ? `${now ? " · " : ""}<span class="muted">${esc(p.doing)}</span>` : ""}</p>
      <p class="small muted"><span data-elapsed="${esc(id)}">${esc(elapsed(f))}</span> so far. It usually takes 30 to 90 minutes, depending on the length.</p>${keepOpen}</div>
      <button class="btn ghost small" data-act="cancel" data-id="${esc(id)}">Cancel</button></div>`;
  }
  const written = view.written.get(id);
  if (f.status === "done") {
    return `<div class="fc-state done"><span class="fc-done-ic">${icon("check", 22)}</span>
      <div class="grow"><p class="lead">Ready${f.pages ? `: ${f.pages} A4 pages` : ""}.</p>${f.error ? `<p class="small muted">${esc(f.error)}</p>` : ""}
      <p class="small muted">Open it here; slide references open the lecture PDF at that page. “Export PDF” saves or prints it on A4.</p></div>
      <button class="btn primary" data-act="open" data-id="${esc(id)}">${icon("file", 16)} Open</button></div>`;
  }
  if (f.status === "stopped") {
    return `<div class="fc-state warn"><span class="fc-done-ic">${icon("clock", 22)}</span>
      <div class="grow"><p class="lead">Claude stopped before the end.</p><p class="small">${esc(f.error || "")}</p></div>
      ${written ? `<button class="btn ghost" data-act="open" data-id="${esc(id)}">Open what is written</button>` : ""}
      <button class="btn primary" data-act="resume" data-id="${esc(id)}">${icon("repeat", 16)} Continue</button></div>`;
  }
  return `<div class="fc-state warn"><span class="fc-done-ic">${icon("close", 22)}</span>
    <div class="grow"><p class="lead">Claude could not read the slides.</p><p class="small">${esc(f.error || "")}</p></div>
    <button class="btn primary" data-act="retry" data-id="${esc(id)}">${icon("repeat", 16)} Try again</button></div>`;
}

function fichePage(id) {
  const f = D.fiches[id];
  if (!f) { view.page = "list"; return listPage(); }
  checkStale(id);
  const o = normOptions(f.options);
  const lectures = (f.lectures || []).filter(lid => D.items[lid]).map(lid => ({ ...D.items[lid], key: f.keys?.[lid] || "" }));
  const mods = (f.modules || []).map(m => D.modules[m]?.name).filter(Boolean);
  const inc = INCLUDES.filter(i => o.include[i.id]).map(i => i.label.replace(/"/g, ""));
  const lbl = (list, v) => list.find(x => x.id === v)?.label || "";
  return `<section class="card">
    <div class="card-h"><button class="btn ghost small" data-act="back">All fiches</button>
      <div class="nb-title"><h2>${esc(f.title)}</h2><span class="muted small">${esc(mods.join(" · ") || "No module")} · started ${esc(fmtDay(String(f.createdAt).slice(0, 10)))}</span></div>
      <span class="grow"></span>${statusPill(f)}
      <button class="iconbtn" data-act="edit" data-id="${esc(id)}" title="Rename" aria-label="Rename">${icon("edit", 16)}</button>
      <button class="iconbtn" data-act="remove" data-id="${esc(id)}" title="Delete" aria-label="Delete">${icon("trash", 16)}</button></div>
    <div class="card-b">${stateCard(id, f)}</div>
  </section>
  <section class="card"><div class="card-b fc-facts">
    <div><h4 class="nb-h">Lectures</h4><ul class="fc-lec">${lectures.map(it => `<li ${cvar(moduleOf(it).color)}><span class="dot"></span>${esc(it.title)} <span class="muted small">[${esc(it.key)}]</span></li>`).join("")}</ul></div>
    <div><h4 class="nb-h">Settings</h4><dl class="fc-dl">
      <div><dt>Length</dt><dd>${o.pages ? `about ${o.pages} pages` : "Auto"}</dd></div>
      <div><dt>Precision</dt><dd>${esc(lbl(PRECISIONS, o.precision))}</dd></div>
      <div><dt>Organisation</dt><dd>${esc(lbl(ORGANISATIONS, o.organisation))}</dd></div>
      <div><dt>Includes</dt><dd>${esc(inc.join(", ") || "nothing extra")}</dd></div>
      <div><dt>Diagrams</dt><dd>${esc(lbl(DIAGRAMS, o.diagrams))}</dd></div>
      <div><dt>Language</dt><dd>${esc(lbl(LANGUAGES, o.language))}</dd></div>
      ${f.notes ? `<div><dt>Your notes</dt><dd class="fc-notes">${esc(f.notes)}</dd></div>` : ""}
    </dl></div>
  </div></section>`;
}

// ---------------------------------------------------------------- a new fiche

function pickList(gs) {
  const F = view.form;
  return gs.map(g => {
    const on = g.items.filter(it => F.pick.has(it.id)).length;
    const all = on === g.items.length;
    const open = F.unfold.has(g.key);
    const rows = open ? g.items.map(it => `<label class="row nbq-lecture">
        <input type="checkbox" data-change="tick" data-id="${esc(it.id)}" ${F.pick.has(it.id) ? "checked" : ""}>
        <span class="row-main"><span class="t">${esc(it.title)}</span><span class="sub"><span>${esc(it.pdf.name)}</span></span></span>
      </label>`).join("") : "";
    return `<div class="nbq-group" ${cvar(g.color)}>
      <div class="nbq-group-h">
        <label class="nbq-all"><input type="checkbox" data-change="tickGroup" data-key="${esc(g.key)}" ${all ? "checked" : ""} class="${on && !all ? "some" : ""}" aria-label="Every lecture of ${esc(g.name)}">
          <span class="dot"></span><b>${esc(g.name)}</b></label>
        <span class="muted small">${on ? `${on} of ${g.items.length}` : `${g.items.length} lecture${g.items.length === 1 ? "" : "s"}`}</span>
        <span class="grow"></span>
        <button class="btn ghost small" data-act="unfold" data-key="${esc(g.key)}" aria-expanded="${open}">${open ? "Hide lectures" : "Choose lectures"}</button>
      </div>${rows}
    </div>`;
  }).join("");
}

const chips = (list, value, act) => list.map(x => `<button type="button" class="chip ${value === x.id ? "on" : ""}" data-act="${act}" data-v="${x.id}" aria-pressed="${value === x.id}"${x.hint ? ` title="${esc(x.hint)}"` : ""}>${esc(x.label)}</button>`).join("");

function newPage() {
  const F = view.form ??= freshForm();
  const gs = groups();
  if (!gs.length) {
    return `<section class="card coming"><div class="coming-ic">${icon("book", 34)}</div><h2>Add lecture PDFs first</h2>
      <p class="lead">A fiche is written from lecture PDFs. Attach them in Courses (the paper-clip on a lecture, or “Attach slides” for many at once).</p>
      <div class="btns center"><button class="btn primary" data-act="goCourses">${icon("book", 16)} Go to Courses</button><button class="btn ghost" data-act="back">Back</button></div></section>`;
  }
  for (const id of F.pick) if (!gs.some(g => g.items.some(it => it.id === id))) F.pick.delete(id);
  const exams = examGroups(D.modules, today()).map(e => {
    const n = e.ids.filter(id => gs.some(g => g.key === id)).length;
    return n ? `<button type="button" class="chip" data-act="exam" data-date="${e.date}">${icon("cal", 14)} ${esc(fmtWday(e.date))} exam · ${n} module${n === 1 ? "" : "s"}</button>` : "";
  }).join("");
  const n = F.pick.size;
  if (!F.titleTouched) F.title = n ? defaultTitle(F) : "";
  const precision = PRECISIONS.map(p => `<button type="button" class="fc-prec ${F.precision === p.id ? "on" : ""}" data-act="precision" data-v="${p.id}" aria-pressed="${F.precision === p.id}"><b>${esc(p.label)}</b><small>${esc(p.hint)}</small></button>`).join("");
  return `<section class="card">
    <div class="card-h"><button class="btn ghost small" data-act="back">All fiches</button><div class="nb-title"><h2>New fiche</h2>
      <span class="muted small">Claude reads the slides you choose, asks you a few questions if it needs to, then writes the sheet.</span></div></div>
    <div class="card-b fc-form">
      <div class="fc-step"><span class="fc-num">1</span><div class="grow">
        <div class="nbq-h"><h4 class="nb-h">Lectures</h4><span class="grow"></span>${n ? `<span class="muted small">${n} chosen</span><button type="button" class="btn ghost small" data-act="clear">Clear</button>` : ""}</div>
        ${exams ? `<div class="toolbar fc-tight"><span class="small muted">Whole exam</span>${exams}</div>` : ""}
        <div class="nbq-list">${pickList(gs)}</div>
        <p class="small muted">Only lectures with a PDF are listed.</p>
      </div></div>
      <div class="fc-step"><span class="fc-num">2</span><div class="grow">
        <h4 class="nb-h">How detailed</h4>
        <div class="fc-precs">${precision}</div>
      </div></div>
      <div class="fc-step"><span class="fc-num">3</span><div class="grow">
        <h4 class="nb-h">Length</h4>
        <div class="toolbar fc-tight"><button type="button" class="chip ${F.pages ? "" : "on"}" data-act="auto" aria-pressed="${!F.pages}">Auto</button>
          <label class="fc-pages"><input type="number" min="${MIN_PAGES}" max="${MAX_PAGES}" step="1" placeholder="e.g. 20" value="${F.pages || ""}" data-input="pages" aria-label="Number of A4 pages"> A4 pages</label></div>
        <p class="small muted">${F.pages ? `About ${F.pages} pages.` : "Auto: as long as the slides need at this level of detail."}</p>
      </div></div>
      <div class="fc-step"><span class="fc-num">4</span><div class="grow">
        <button type="button" class="fc-more" data-act="more" aria-expanded="${view.more}"><h4 class="nb-h">Fine-tune</h4><span class="muted small">${view.more ? "" : "organisation, what to include, diagrams, language"}</span><i class="nb-chev ${view.more ? "open" : ""}" aria-hidden="true"></i></button>
        ${view.more ? `<div class="fc-tune">
          <div class="toolbar fc-tight"><span class="small fc-lab">Organisation</span>${chips(ORGANISATIONS, F.organisation, "org")}</div>
          <div class="fc-checks"><span class="small fc-lab">Include</span>${INCLUDES.map(i => `<label class="fc-check"><input type="checkbox" data-change="include" data-v="${i.id}" ${F.include[i.id] ? "checked" : ""}> ${esc(i.label)}${i.hint ? ` <span class="muted">(${esc(i.hint)})</span>` : ""}</label>`).join("")}</div>
          <div class="toolbar fc-tight"><span class="small fc-lab">Diagrams</span>${chips(DIAGRAMS, F.diagrams, "diagrams")}</div>
          <div class="toolbar fc-tight"><span class="small fc-lab">Language</span>${chips(LANGUAGES, F.language, "language")}</div>
        </div>` : ""}
      </div></div>
      <div class="fc-step"><span class="fc-num">5</span><div class="grow fc-two">
        ${field("Title", input("title", F.title, 'data-input="title" placeholder="Chosen from the lectures"'))}
        <label class="field"><span>Notes for Claude</span><textarea rows="3" data-input="notes" placeholder="Anything it should know: what the exam stresses, what to leave out, what you find hard…">${esc(F.notes)}</textarea></label>
      </div></div>
      <div class="nbq-go"><p class="small">${n ? `${n} lecture${n === 1 ? "" : "s"}. Reading takes a few minutes, writing 30 to 90 minutes; keep Bloom open meanwhile.` : "Choose at least one lecture."}</p><span class="grow"></span>
        <button class="btn primary" data-act="start" ${n ? "" : "disabled"}>${icon("spark", 16)} Start</button></div>
    </div>
  </section>`;
}

async function start() {
  const F = view.form;
  const lectures = picked();
  if (!lectures.length) return;
  const id = uid();
  const ids = lectures.map(l => l.id);
  D.fiches[id] = {
    title: F.title.trim() || defaultTitle(F), createdAt: nowIso(), updatedAt: nowIso(),
    source: "generated", modules: modulesOf(ids, D.items),
    lectures: ids, keys: lectureKeys(lectures.map(l => ({ id: l.id, title: l.title }))), slides: {},
    options: normOptions(F), notes: F.notes.trim(), status: "reading",
    questions: null, answers: {}, wrote: false, startedAt: nowIso(), error: null, pages: null,
  };
  save();
  view.form = null;
  view.page = "fiche";
  view.sel = id;
  view.checked.add(id);
  app.refresh();
  document.getElementById("main").scrollTop = 0;
  await read(id);
}

// ---------------------------------------------------------------- uploading and editing

function moduleChecks(selected) {
  return `<div class="fc-modchecks">${modulesSorted().map(m => `<label class="fc-check" ${cvar(m.color)}><input type="checkbox" name="mod-${esc(m.id)}" ${selected.includes(m.id) ? "checked" : ""}><span class="dot"></span> ${esc(m.name)}</label>`).join("")}</div>`;
}
const checkedModules = values => modulesSorted().map(m => m.id).filter(m => values[`mod-${m}`] === "on");

function upload() {
  openModal({
    title: "Upload a fiche",
    body: `${field("PDF", '<input type="file" name="file" accept="application/pdf,.pdf" required>', "A PDF only, such as a course companion you compiled.")}
      ${field("Title", input("title", "", 'placeholder="The file name if left empty"'))}
      <div class="field"><span>Modules it covers</span>${moduleChecks([])}</div>
      <p class="small muted" id="fc-up-status"></p>`,
    submit: "Upload",
    onSubmit: async (v, form) => {
      const file = form.querySelector('input[type="file"]').files[0];
      const status = form.querySelector("#fc-up-status");
      if (!file) { status.textContent = "Choose a PDF first."; return false; }
      if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") { status.textContent = "Only PDF files can be uploaded as a fiche."; return false; }
      form.querySelectorAll("button").forEach(b => { b.disabled = true; });
      status.textContent = "Copying the PDF into Bloom…";
      let pdf;
      try { pdf = await storePdf(file); } catch (e) {
        form.querySelectorAll("button").forEach(b => { b.disabled = false; });
        status.textContent = e?.message || String(e);
        return false;
      }
      const id = uid();
      D.fiches[id] = {
        title: v.title.trim() || file.name.replace(/\.pdf$/i, "").replace(/[_]+/g, " "),
        createdAt: nowIso(), updatedAt: nowIso(), source: "uploaded", modules: checkedModules(v), pdf, status: "done",
      };
      save(); app.refresh();
      toast("Fiche added 🌸");
    },
  });
}

function edit(id) {
  const f = D.fiches[id];
  if (!f) return;
  const up = f.source === "uploaded";
  openModal({
    title: up ? "Edit fiche" : "Rename fiche",
    body: `${field("Title", input("title", f.title, "required autofocus"))}
      ${up ? `<div class="field"><span>Modules it covers</span>${moduleChecks(f.modules || [])}</div>` : ""}`,
    onSubmit: v => {
      if (!v.title.trim()) return false;
      f.title = v.title.trim();
      if (up) f.modules = checkedModules(v);
      f.updatedAt = nowIso();
      save(); app.refresh();
    },
  });
}

async function remove(id) {
  const f = D.fiches[id];
  if (!f) return;
  const busy = f.status === "reading" || f.status === "writing";
  if (!await confirmBox("Delete this fiche?", `"${f.title}" is deleted${f.source === "uploaded" ? ", with Bloom's copy of the PDF" : ""}.${busy ? " Claude stops working on it." : ""}`)) return;
  stopFollowing(id);
  if (f.source === "uploaded") { if (f.pdf) await removePdf(f.pdf.id); }
  else {
    if (busy) await cancelRun(id).catch(() => {});
    await deleteFicheFiles(id);
    forgetImages(id);
  }
  delete D.fiches[id];
  delete D.slideNotes?.[ficheSrc(id)];
  save();
  if (view.sel === id) { view.page = "list"; view.sel = null; }
  app.refresh();
  toast("Fiche deleted");
}

// ---------------------------------------------------------------- the view

export function render() {
  D.fiches ??= {};
  const head = `<header class="page-h"><div><h1>Fiches</h1><p class="muted">Study sheets: written by Claude from your lecture PDFs, or your own.</p></div>
    ${view.page === "list" && Object.keys(D.fiches).length ? `<div class="btns"><button class="btn ghost" data-act="upload">${icon("clip", 16)} Upload a fiche</button><button class="btn primary" data-act="newFiche">${icon("plus", 16)} New fiche</button></div>` : ""}</header>`;
  if (view.page === "fiche" && !D.fiches[view.sel]) view.page = "list";
  const body = view.page === "new" ? newPage() : view.page === "fiche" ? fichePage(view.sel) : listPage();
  return `${head}<div class="fc">${setupCard()}${body}</div>`;
}

const F = () => (view.form ??= freshForm());
const redraw = () => app.refresh();

export const actions = {
  newFiche: () => { view.page = "new"; view.form ??= freshForm(); redraw(); document.getElementById("main").scrollTop = 0; },
  upload,
  back: () => { view.page = "list"; view.sel = null; redraw(); },
  select: el => { view.page = "fiche"; view.sel = el.dataset.id; redraw(); document.getElementById("main").scrollTop = 0; },
  open: el => openFiche(el.dataset.id),
  openUpload: async el => {
    const f = D.fiches[el.dataset.id];
    if (!f?.pdf) return;
    try { openViewer(f.title, await pdfUrl(f.pdf.id), null, { notes: ficheSrc(el.dataset.id) }); }
    catch { toast("This PDF could not be opened. Upload it again.", "error"); }
  },
  quiz: el => {
    quizLectures([ficheSrc(el.dataset.id)]);
    app.go("notebook");
  },
  edit: el => edit(el.dataset.id),
  remove: el => remove(el.dataset.id),
  cancel: async el => {
    try { await cancelRun(el.dataset.id); toast("Stopping…"); } catch (e) { toast(e?.message || String(e), "error"); }
  },
  resume: el => write(el.dataset.id, true),
  retry: el => read(el.dataset.id),
  answer: form => {
    const id = form.dataset.id;
    const f = D.fiches[id];
    if (!f) return;
    const data = new FormData(form);
    f.answers = {};
    for (const q of f.questions || []) {
      const v = Number(data.get(q.id));
      f.answers[q.id] = Number.isInteger(v) ? v : q.default;
    }
    write(id, false);
  },
  goSettings: () => app.go("settings"),
  goCourses: () => app.go("courses"),
  // the new-fiche form
  tick: el => { if (el.checked) F().pick.add(el.dataset.id); else F().pick.delete(el.dataset.id); redraw(); },
  tickGroup: el => {
    const g = groups().find(x => x.key === el.dataset.key);
    if (!g) return;
    for (const it of g.items) if (el.checked) F().pick.add(it.id); else F().pick.delete(it.id);
    redraw();
  },
  unfold: el => { const u = F().unfold, k = el.dataset.key; if (u.has(k)) u.delete(k); else u.add(k); redraw(); },
  exam: el => {
    const ids = new Set(Object.entries(D.modules).filter(([, m]) => m.exam === el.dataset.date).map(([id]) => id));
    F().pick = new Set(groups().filter(g => ids.has(g.key)).flatMap(g => g.items.map(it => it.id)));
    redraw();
  },
  clear: () => { F().pick.clear(); redraw(); },
  precision: el => { F().precision = el.dataset.v; redraw(); },
  auto: () => { F().pages = null; redraw(); },
  pages: el => {
    const n = Number(el.value);
    F().pages = el.value === "" ? null : Number.isFinite(n) && n > 0 ? Math.min(MAX_PAGES, Math.round(n)) : F().pages;
    const hint = el.closest(".grow")?.querySelector("p.small");
    if (hint) hint.textContent = F().pages ? `About ${F().pages} pages.` : "Auto: as long as the slides need at this level of detail.";
    el.closest(".toolbar")?.querySelector("[data-act=auto]")?.classList.toggle("on", !F().pages);
  },
  more: () => { view.more = !view.more; redraw(); },
  org: el => { F().organisation = el.dataset.v; redraw(); },
  include: el => { F().include[el.dataset.v] = el.checked; },
  diagrams: el => { F().diagrams = el.dataset.v; redraw(); },
  language: el => { F().language = el.dataset.v; redraw(); },
  title: el => { F().title = el.value; F().titleTouched = el.value.trim() !== ""; },
  notes: el => { F().notes = el.value; },
  start,
};

