// Progress: her marks and how she improves. Quick figures along the top, quiz scores over time
// beside the lectures she misses most, then every module and lecture, then flashcards and study
// days. One module filter applies to everything but the study days. The sums are in progress-core.js.
import { D, itemsList, isLecture, itemWeek, modulesSorted } from "../store.js";
import { today, addDays, diffDays, fmtDay, fmtWday, weekOf } from "../dates.js";
import { esc, icon, app, cvar, COLORS } from "../ui.js";
import { quizLectures } from "./notebook.js";
import { isFicheSrc, ficheSrc, srcFiche, srcModules, srcExists, srcTitle, srcQuizzable, srcCount } from "../sources.js";
import {
  pct, quizSeries, average, recentAverage, trend, movingAverage, lectureStats, addMastery, weakSpots,
  activity, streaks, cardTotals, monday, perWeek, calendar, heat,
} from "../progress-core.js";

/** Survives changes of view, never saved: the module shown ("all" or its id) and the modules unfolded in the table. */
const view = { module: "all", open: new Set() };

const NO_MODULE = "_none";
const plural = (n, word, many = word + "s") => `${n} ${n === 1 ? word : many}`;
const pctText = p => (p == null ? "–" : `${p}%`);
/** The question bank of a lecture or of a fiche ("fiche:<id>"). */
const bankOf = id => (isFicheSrc(id) ? srcFiche(id)?.quiz : D.notebook?.[id]?.quiz);
const moduleKey = it => (D.modules[it?.module] ? it.module : NO_MODULE);
/** A quiz source's module key: a lecture's module, or the first module a fiche covers (sources.js). */
const srcKey = id => {
  if (!isFicheSrc(id)) return moduleKey(D.items[id]);
  const m = srcModules(id).find(x => D.modules[x]);
  return m || NO_MODULE;
};
/** Whether source `id` belongs to module `key`: a fiche to every module it covers. */
const inModule = (id, key) => (isFicheSrc(id) && srcModules(id).some(x => D.modules[x]) ? srcModules(id).includes(key) : srcKey(id) === key);
const moduleName = key => (key === NO_MODULE ? "No module" : D.modules[key]?.name || "No module");
const moduleColor = key => D.modules[key]?.color || "plum";
const colorOf = key => (COLORS.includes(moduleColor(key)) ? moduleColor(key) : "plum");

const LEVEL = { recall: "Recall", understanding: "Understanding", application: "Application", mixed: "Mixed" };

// ---- small pieces

function trendBadge(t) {
  if (!t) return `<span class="pg-tr none" title="Not enough quizzes yet">–</span>`;
  const glyph = { up: "↑", down: "↓", flat: "→" }[t.dir];
  const words = { up: "Going up", down: "Going down", flat: "Steady" }[t.dir];
  return `<span class="pg-tr ${t.dir}" title="${words}: last quizzes against the ones before">${glyph} ${t.dir === "flat" ? "" : Math.abs(t.delta)}</span>`;
}

/** A tiny line of the last scores (percentages, oldest first). */
function spark(values) {
  const v = values.slice(-10);
  if (v.length < 2) return `<span class="pg-spark"></span>`;
  const W = 72, H = 22, x = i => 2 + (i * (W - 4)) / (v.length - 1), y = p => 2 + ((100 - p) * (H - 4)) / 100;
  const pts = v.map((p, i) => `${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(" ");
  return `<svg class="pg-spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    <polyline points="${pts}" fill="none" stroke="var(--mc)" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(v.length - 1).toFixed(1)}" cy="${y(v.at(-1)).toFixed(1)}" r="2.6" fill="var(--mc)"/></svg>`;
}

/** Where the questions stand, as one bar: mastered, learning, missed, not asked yet. */
function masteryBar(m) {
  if (!m.total) return `<span class="muted small">No questions yet</span>`;
  const seg = (k, n) => (n ? `<i class="pg-m-${k}" style="flex:${n}"></i>` : "");
  return `<span class="pg-mbar" title="${m.mastered} mastered · ${m.learning} right once · ${m.missed} missed · ${m.fresh} not asked yet">
      <span class="stack">${seg("mastered", m.mastered)}${seg("learning", m.learning)}${seg("missed", m.missed)}${seg("fresh", m.fresh)}</span>
      <span class="pg-mnum"><b>${m.mastered}</b>/${m.total}</span></span>`;
}

const quizBtn = (ids, label = "", cls = "iconbtn ring") => {
  const ok = ids.filter(srcQuizzable);
  if (!ok.length) return label ? "" : `<span></span>`;
  return label
    ? `<button class="btn ${cls}" data-act="quiz" data-ids="${ok.join(",")}">${icon("repeat", 15)} ${label}</button>`
    : `<button class="${cls}" data-act="quiz" data-ids="${ok.join(",")}" title="Quiz this" aria-label="Quiz this">${icon("repeat", 15)}</button>`;
};

// ---- quiz scores over time

/** Quiz scores as dots, with a line through the average of the last 5; one dot per quiz, coloured by its module. */
function scoreChart(series, now) {
  if (!series.length) return `<div class="empty small">Finish a quiz in the Notebook and your scores show up here.</div>`;
  let start = monday(series[0].date);
  if (diffDays(start, now) < 27) start = monday(addDays(now, -27));
  const span = diffDays(start, now) + 1;
  const X = (date, shift = 0) => (100 * (diffDays(start, date) + 0.5 + shift)) / span;

  // quizzes of one day sit side by side
  const perDay = new Map();
  for (const r of series) perDay.set(r.date, (perDay.get(r.date) || 0) + 1);
  const seen = new Map();
  const pts = series.map(r => {
    const n = perDay.get(r.date), k = seen.get(r.date) || 0;
    seen.set(r.date, k + 1);
    const shift = n > 1 ? (k - (n - 1) / 2) * Math.min(0.28, 0.84 / n) : 0;
    const mods = [...new Set(r.lectures.map(srcKey))];
    return { ...r, x: X(r.date, shift), mod: mods.length === 1 ? mods[0] : null };
  });
  const avg = movingAverage(series.map(r => r.pct), 5);
  const line = pts.map((p, i) => `${p.x.toFixed(2)},${(100 - avg[i]).toFixed(2)}`);
  const area = `${pts[0].x.toFixed(2)},100 ${line.join(" ")} ${pts.at(-1).x.toFixed(2)},100`;

  const mondays = [];
  for (let d = start; d <= now; d = addDays(d, 7)) mondays.push(d);
  const every = Math.ceil(mondays.length / 10);
  const ticks = mondays.filter((_, i) => i % every === 0).map(d => {
    const w = weekOf(d, D.settings.semesterStart);
    return `<span style="left:${(100 * diffDays(start, d)) / span}%">${w >= 1 ? "W" + w : fmtDay(d)}</span>`;
  }).join("");

  const dot = p => {
    const names = p.lectures.filter(srcExists).map(srcTitle);
    const side = p.x > 78 ? "r" : p.x < 22 ? "l" : "";
    return `<button class="pg-pt ${p.mod ? "" : "mixed"}" style="--mc:var(--c-${colorOf(p.mod)});left:${p.x.toFixed(2)}%;top:${100 - p.pct}%"
        aria-label="${fmtWday(p.date)}: ${p.score} of ${p.total}">
        <span class="tip ${side}"><b>${fmtWday(p.date)} · ${p.pct}%</b><span>${p.score} of ${p.total} right${p.level ? ` · ${LEVEL[p.level] || esc(p.level)}` : ""}</span>
        ${names.slice(0, 3).map(t => `<span class="pg-tip-l">${esc(t)}</span>`).join("")}${names.length > 3 ? `<span class="pg-tip-l">and ${names.length - 3} more</span>` : ""}</span>
      </button>`;
  };

  return `<div class="pg-chart">
      <div class="chart-y" aria-hidden="true">${[100, 75, 50, 25, 0].map(t => `<span>${t}%</span>`).join("")}</div>
      <div class="pg-plot">
        <div class="pg-area">
        <svg class="pg-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <defs><linearGradient id="pg-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".22"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
          ${[0, 25, 50, 75].map(y => `<line x1="0" x2="100" y1="${y}" y2="${y}" class="pg-grid"/>`).join("")}<line x1="0" x2="100" y1="100" y2="100" class="pg-base"/>
          ${pts.length > 1 ? `<polygon points="${area}" fill="url(#pg-fill)"/><polyline points="${line.join(" ")}" class="pg-line"/>` : ""}
        </svg>
        ${pts.map(dot).join("")}
        </div>
        <div class="pg-x" aria-hidden="true">${ticks}</div>
      </div>
    </div>`;
}

function chartLegend(series) {
  const mods = new Set(), mixed = series.some(r => new Set(r.lectures.map(srcKey)).size > 1);
  for (const r of series) { const k = new Set(r.lectures.map(srcKey)); if (k.size === 1) mods.add([...k][0]); }
  const order = [...modulesSorted().map(m => m.id), NO_MODULE].filter(k => mods.has(k));
  return `<div class="pg-legend">
      ${order.map(k => `<span ${cvar(moduleColor(k))}><i class="pg-k"></i>${esc(moduleName(k))}</span>`).join("")}
      ${mixed ? `<span><i class="pg-k mixed"></i>Several modules</span>` : ""}
      ${series.length > 1 ? `<span><i class="pg-k line"></i>Average of the last 5</span>` : ""}
    </div>`;
}

// ---- flashcards and study days

function cardChart(rows, now) {
  const weeks = perWeek(rows, now, 8, ["seen", "knew"]);
  const top = Math.max(20, ...weeks.map(w => w.seen));
  const step = Math.ceil(top / 4 / 5) * 5, max = step * 4;
  const ticks = [4, 3, 2, 1, 0].map(i => i * step);
  const label = d => { const w = weekOf(d, D.settings.semesterStart); return w >= 1 ? "W" + w : fmtDay(d); };
  return `<div class="chart pg-cchart">
      <div class="chart-y" aria-hidden="true">${ticks.map(t => `<span>${t}</span>`).join("")}</div>
      <div class="chart-plot">
        <div class="chart-grid" aria-hidden="true">${ticks.map(() => "<i></i>").join("")}</div>
        ${weeks.map(w => `<div class="grp ${w.start === monday(now) ? "now" : ""}" tabindex="0" aria-label="Week of ${fmtDay(w.start)}: ${w.seen} cards, ${w.knew} known">
          <div class="bars"><i class="b pg-seen" style="height:${(100 * w.seen) / max}%"></i><i class="b pg-knew" style="height:${(100 * w.knew) / max}%"></i></div>
          <span class="x">${label(w.start)}</span>
          <div class="tip"><b>Week of ${fmtDay(w.start)}</b><span><i class="key pg-seen"></i>${plural(w.seen, "card")} reviewed</span><span><i class="key pg-knew"></i>${w.knew} known${w.seen ? ` (${pct(w.knew, w.seen)}%)` : ""}</span></div>
        </div>`).join("")}
      </div>
    </div>`;
}

function heatmap(days, now) {
  const weeks = calendar(now, 20);
  const cell = d => {
    if (!d) return `<i class="pg-day off"></i>`;
    const a = days.get(d), n = a ? a.questions + a.cards : 0;
    const what = a ? [a.questions && plural(a.questions, "question"), a.cards && plural(a.cards, "card")].filter(Boolean).join(", ") : "nothing";
    return `<i class="pg-day h${heat(n)} ${d === now ? "today" : ""}" title="${fmtWday(d)}: ${what}"></i>`;
  };
  return `<div class="pg-heat">
      <div class="pg-wd" aria-hidden="true"><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span><span>Sun</span></div>
      <div class="pg-cal">${weeks.map(w => `<div class="pg-wk">${w.map(cell).join("")}</div>`).join("")}</div>
    </div>
    <div class="pg-heat-l"><span>${fmtDay(weeks[0][0])}</span><span class="grow"></span>Less ${[0, 1, 2, 3, 4].map(h => `<i class="pg-day h${h}"></i>`).join("")} More</div>`;
}

// ---- the lectures, module by module

function lectureRow(s) {
  const title = srcTitle(s.id);
  return `<div class="pg-trow lec">
      <span class="t" title="${esc(title)}">${isFicheSrc(s.id) ? `${icon("file", 13)} ` : ""}${esc(title)}</span>
      <span class="num">${s.quizzes || "–"}</span>
      <span class="num">${pctText(s.average)}</span>
      <span class="num" title="${s.lastDate ? fmtWday(s.lastDate) : ""}">${pctText(s.last)}</span>
      <span class="pg-trend">${spark(s.history.map(r => pct(r.score, r.total)))}${trendBadge(s.trend)}</span>
      ${masteryBar(s.mastery)}
      <span class="num ${s.mastery.review ? "" : "muted"}">${s.mastery.review || "–"}</span>
      ${quizBtn([s.id])}
    </div>`;
}

function moduleRows(key, stats, log) {
  const keep = id => inModule(id, key);
  const series = quizSeries(log, keep);
  const m = addMastery(stats.map(s => s.mastery));
  const open = view.module !== "all" || view.open.has(key);
  const shown = stats.filter(s => s.quizzes || s.mastery.total);
  return `<div class="pg-mod ${open ? "open" : ""}" ${cvar(moduleColor(key))}>
      <div class="pg-trow head">
        <button class="t pg-fold" data-act="fold" data-key="${key}" aria-expanded="${open}">
          <span class="pg-chev">${icon("arrow", 13)}</span><span class="dot"></span>${esc(moduleName(key))}
          <span class="muted small">${srcCount(shown.map(s => s.id))}</span></button>
        <span class="num">${series.length || "–"}</span>
        <span class="num">${pctText(average(series))}</span>
        <span class="num">${pctText(series.at(-1)?.pct ?? null)}</span>
        <span class="pg-trend">${spark(series.map(r => r.pct))}${trendBadge(trend(series.map(r => r.pct)))}</span>
        ${masteryBar(m)}
        <span class="num ${m.review ? "" : "muted"}">${m.review || "–"}</span>
        ${quizBtn(shown.map(s => s.id))}
      </div>
      ${open ? shown.map(lectureRow).join("") : ""}
    </div>`;
}

// ---- the page

export function render() {
  const now = today();
  if (view.module !== "all" && view.module !== NO_MODULE && !D.modules[view.module]) view.module = "all";
  const keep = view.module === "all" ? null : id => inModule(id, view.module);
  const log = D.quizLog || [];
  const cardLog = D.cardLog || [];

  const lectures = itemsList().filter(isLecture)
    .sort((a, b) => (itemWeek(a) ?? 99) - (itemWeek(b) ?? 99) || (a.date || "9").localeCompare(b.date || "9") || (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title));
  // the lectures, then the fiches (their own banks, sources.js)
  const sources = [...lectures.map(it => it.id), ...Object.keys(D.fiches || {}).map(ficheSrc)];
  const allStats = sources.map(id => lectureStats(id, log, bankOf(id)));
  const stats = allStats.filter(s => !keep || keep(s.id));
  const series = quizSeries(log, keep);
  const cards = cardLog.filter(c => !keep || keep(c.lecture));
  const days = activity(log, cardLog, allStats.map(s => s.history));

  const anything = allStats.some(s => s.quizzes || s.mastery.answers) || cardLog.length || log.length;
  if (!anything) {
    return `<header class="page-h"><div><h1>Progress</h1><p class="muted">Your marks and how they grow.</p></div></header>
      <section class="card pg-empty">
        <div class="coming-ic">${icon("chart", 34)}</div>
        <h2>Nothing to show yet</h2>
        <p class="muted">Take a quiz or review flashcards in the Notebook: your scores, the lectures to work on and your study days show up here.</p>
        <button class="btn primary" data-act="go" data-view="notebook">${icon("note", 16)} Open the Notebook</button>
      </section>`;
  }

  // ---- figures along the top
  const avg = recentAverage(series, now);
  const all = average(series);
  const mAll = addMastery(stats.map(s => s.mastery));
  const ct = cardTotals(cards);
  const st = streaks(days, now);
  const thisWeek = series.filter(r => r.date >= monday(now)).length;
  const delta = avg.delta == null ? `<span class="pg-sub">${avg.recent != null ? "last 30 days" : all != null ? "all time" : "no quiz yet"}</span>`
    : `<span class="pg-sub ${avg.delta > 0 ? "up" : avg.delta < 0 ? "down" : ""}">${avg.delta > 0 ? "↑" : avg.delta < 0 ? "↓" : "→"} ${Math.abs(avg.delta)} pts vs before</span>`;
  const tiles = [
    { n: series.length, label: series.length === 1 ? "Quiz done" : "Quizzes done", ic: "todo", sub: `<span class="pg-sub">${thisWeek} this week</span>` },
    { n: mAll.answers, label: "Questions answered", ic: "book", sub: `<span class="pg-sub">${mAll.mastered} mastered</span>` },
    { n: pctText(avg.recent ?? all), label: "Average score", ic: "chart", sub: delta, lead: true },
    { n: ct.seen, label: "Flashcards reviewed", ic: "note", sub: `<span class="pg-sub">${ct.share == null ? "none yet" : `${ct.share}% known`}</span>` },
    { n: st.current, label: st.current === 1 ? "Day in a row" : "Days in a row", ic: "sun",
      sub: `<span class="pg-sub">${st.current && !st.today ? "study today to keep it" : `best ${st.best}`}</span>` },
  ];
  const mods = modulesSorted();
  const hasLoose = lectures.some(it => !D.modules[it.module]);
  const filter = `<select class="pill-select" data-change="module" aria-label="Module">
      <option value="all">All modules</option>
      ${mods.map(m => `<option value="${m.id}" ${view.module === m.id ? "selected" : ""}>${esc(m.name)}</option>`).join("")}
      ${hasLoose ? `<option value="${NO_MODULE}" ${view.module === NO_MODULE ? "selected" : ""}>No module</option>` : ""}
    </select>`;
  const head = `<section class="stats pg-stats">
      <div class="stats-intro">
        <p class="eyebrow">Your marks and how they grow</p>
        <h1>Progress</h1>
        <div>${filter}</div>
      </div>
      ${tiles.map(t => `<div class="tile pg-tile ${t.lead ? "lead" : ""}">
        <span class="bubble">${icon(t.ic, 18)}</span><b>${t.n}</b><span class="tile-l">${t.label}</span>${t.sub}
      </div>`).join("")}
    </section>`;

  // ---- scores + weak spots
  const scoreCard = `<section class="card pg-score-card">
      <div class="card-h"><h2>Quiz scores</h2><span class="grow"></span>${series.length ? chartLegend(series) : ""}</div>
      ${scoreChart(series, now)}
    </section>`;

  const weak = weakSpots(stats);
  const weakIds = weak.map(s => s.id);
  const weakCard = `<section class="card pg-weak">
      <div class="card-h"><h2>To work on</h2><span class="grow"></span>${weak.length > 1 ? quizBtn(weakIds, `Quiz all ${weak.length}`, "primary small") : ""}</div>
      ${weak.length ? weak.map(s => {
        const title = srcTitle(s.id), key = srcKey(s.id);
        return `<div class="row plain" ${cvar(moduleColor(key))}>
          <span class="bubble tint pg-score">${pctText(s.recent)}</span>
          <div class="row-main"><span class="t" title="${esc(title)}">${esc(title)}</span>
            <span class="sub">${esc(moduleName(key))} · ${s.mastery.missed ? `${plural(s.mastery.missed, "question")} missed` : "lately low"} · last ${fmtDay(s.lastDate)}</span></div>
          ${quizBtn([s.id])}
        </div>`;
      }).join("") + `<p class="pg-note muted small">Your score over the last 3 quizzes of each lecture.</p>`
      : `<div class="empty small">${series.length ? "Nothing to worry about: every lecture you quizzed is at 75% or more lately 🌷" : "The lectures you miss most show up here after a few quizzes."}</div>`}
    </section>`;

  // ---- modules and lectures
  const groups = [...mods.map(m => m.id), NO_MODULE]
    .filter(k => view.module === "all" || k === view.module)
    .map(k => ({ k, list: stats.filter(s => srcKey(s.id) === k && (s.quizzes || s.mastery.total)) }))
    .filter(g => g.list.length);
  const tableCard = `<section class="card">
      <div class="card-h"><h2>${view.module === "all" ? "By module" : "By lecture"}</h2><span class="grow"></span>
        ${view.module === "all" && groups.length ? `<button class="link" data-act="foldAll">${groups.every(g => view.open.has(g.k)) ? "Fold all" : "Show every lecture"}</button>` : ""}</div>
      ${groups.length ? `<div class="pg-table">
        <div class="pg-trow pg-thead"><span>${view.module === "all" ? "Module" : "Lecture"}</span><span class="num">Quizzes</span><span class="num">Average</span><span class="num">Last</span><span>Trend</span><span>Mastered</span><span class="num" title="Missed last time, or due to come back">To review</span><span></span></div>
        ${groups.map(g => moduleRows(g.k, g.list, log)).join("")}
      </div>
      <div class="legend"><span><i class="pg-m-mastered"></i>Mastered (right twice in a row)</span><span><i class="pg-m-learning"></i>Right once</span><span><i class="pg-m-missed"></i>Missed last time</span><span><i class="pg-m-fresh"></i>Not asked yet</span></div>`
      : `<div class="empty small">No quiz questions here yet.</div>`}
    </section>`;

  // ---- flashcards + study days
  const recentCards = cardTotals(cards.filter(c => c.date >= addDays(now, -29)));
  const cardCard = `<section class="card">
      <div class="card-h"><h2>Flashcards</h2><span class="grow"></span>
        ${ct.seen ? `<span class="legend-i"><i class="key pg-seen"></i>Reviewed</span><span class="legend-i"><i class="key pg-knew"></i>Knew it</span>` : ""}</div>
      ${ct.seen ? `<div class="pg-facts">
          <div><b>${ct.seen}</b><span>cards in ${plural(ct.sessions, "session")}</span></div>
          <div><b>${pctText(ct.share)}</b><span>known overall</span></div>
          <div><b>${pctText(recentCards.share)}</b><span>known, last 30 days</span></div>
        </div>${cardChart(cards, now)}`
      : `<div class="empty small">Review flashcards in the Notebook and they show up here.</div>`}
    </section>`;

  const dayCount = [...days.keys()].filter(d => d >= addDays(now, -29)).length;
  const daysCard = `<section class="card">
      <div class="card-h"><h2>Study days</h2><span class="grow"></span><span class="muted small">every module</span></div>
      <div class="pg-facts">
        <div><b>${plural(st.current, "day")}</b><span>in a row${st.current && !st.today ? " (until yesterday)" : ""}</span></div>
        <div><b>${plural(st.best, "day")}</b><span>longest run</span></div>
        <div><b>${dayCount}</b><span>of the last 30 days</span></div>
      </div>
      ${heatmap(days, now)}
    </section>`;

  return `${head}
    <div class="pg-2">${scoreCard}${weakCard}</div>
    ${tableCard}
    <div class="grid" style="margin-top:20px">${cardCard}${daysCard}</div>`;
}

export const actions = {
  go: el => app.go(el.dataset.view),
  module: el => { view.module = el.value; app.refresh(); },
  fold: el => {
    if (view.module !== "all") return;
    const k = el.dataset.key;
    if (view.open.has(k)) view.open.delete(k); else view.open.add(k);
    app.refresh();
  },
  foldAll: () => {
    const keys = [...document.querySelectorAll("#main .pg-fold")].map(b => b.dataset.key);
    const all = keys.every(k => view.open.has(k));
    for (const k of keys) if (all) view.open.delete(k); else view.open.add(k);
    app.refresh();
  },
  quiz: el => {
    quizLectures(el.dataset.ids.split(",").filter(Boolean));
    app.go("notebook");
  },
};
