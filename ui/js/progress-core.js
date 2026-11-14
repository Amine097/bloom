// The Progress page without the screen: her marks over time, per lecture and per module, the
// lectures she misses most, flashcards and study days. Pure, covered by tests/progress.test.mjs.
//
// Sources (shapes in store.js, notebook-core.js, quiz-core.js and cards-core.js):
//   D.quizLog   every finished quiz { date, lectures, score, total, level, by? }; `by` is her score
//               per lecture { lectureId: [score, total] } and is missing on quizzes logged before v6:
//               those count as a whole, and for one lecture only when they asked nothing else.
//   bank        D.notebook[id].quiz: `sessions` (her last 10 scores on that lecture, also those of
//               older quizzes the log cannot split) and each question's history.
//   D.cardLog   every flashcard session { date, lecture, seen, knew }.
import { standing } from "./quiz-core.js";
import { addDays, diffDays, parse } from "./dates.js";

/** A whole percentage, or null when nothing was asked. */
export const pct = (score, total) => (total > 0 ? Math.round((100 * score) / total) : null);

const add = rows => rows.reduce((a, r) => ({ score: a.score + r.score, total: a.total + r.total }), { score: 0, total: 0 });
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Her part of quiz `e` on the lectures `keep` accepts (all of them when `keep` is null).
 * → { score, total, lectures } or null when the quiz asked none of them, or cannot be split.
 */
export function partOf(e, keep) {
  if (e.by && typeof e.by === "object") {
    const parts = Object.entries(e.by).filter(([id, r]) => Array.isArray(r) && (!keep || keep(id)));
    const r = add(parts.map(([, [score, total]]) => ({ score, total })));
    if (!r.total) return null;
    return keep ? { ...r, lectures: parts.map(([id]) => id) } : { score: e.score, total: e.total, lectures: Object.keys(e.by) };
  }
  const ls = e.lectures || [];
  if (keep && !(ls.length && ls.every(keep))) return null;
  return e.total > 0 ? { score: e.score, total: e.total, lectures: ls } : null;
}

/** The quizzes of `log` on the lectures `keep` accepts, oldest first: [{ date, score, total, pct, lectures, level }]. */
export function quizSeries(log, keep = null) {
  return (log || [])
    .map((e, i) => ({ e, i, r: partOf(e, keep) }))
    .filter(x => x.r && x.e.date)
    .sort((a, b) => a.e.date.localeCompare(b.e.date) || a.i - b.i)
    .map(({ e, r }) => ({ date: e.date, score: r.score, total: r.total, pct: pct(r.score, r.total), lectures: r.lectures, level: e.level || null }));
}

/** The share of right answers over `rows` ([{ score, total }]), as a whole percentage, or null. */
export function average(rows) {
  const r = add(rows);
  return pct(r.score, r.total);
}

/** Her average over the last `days` days (today included) and before them. → { recent, before, delta } */
export function recentAverage(rows, today, days = 30) {
  const from = addDays(today, 1 - days);
  const recent = average(rows.filter(r => r.date >= from));
  const before = average(rows.filter(r => r.date < from));
  return { recent, before, delta: recent != null && before != null ? recent - before : null };
}

/**
 * Where a list of percentages (oldest first) is going: the mean of the last few (up to 3) against
 * the same number just before. → { dir: "up" | "down" | "flat", delta } or null with fewer than 2.
 */
export function trend(values, step = 5) {
  if (values.length < 2) return null;
  const k = Math.min(3, Math.floor(values.length / 2));
  const delta = Math.round(mean(values.slice(-k)) - mean(values.slice(-2 * k, -k)));
  return { dir: delta >= step ? "up" : delta <= -step ? "down" : "flat", delta };
}

/** Each value replaced by the mean of itself and up to `n - 1` values before it. */
export const movingAverage = (values, n = 5) =>
  values.map((_, i) => mean(values.slice(Math.max(0, i - n + 1), i + 1)));

/**
 * Every score she had on lecture `id`, oldest first: [{ date, score, total, src }]. From the log
 * ("log") when it can tell, plus the bank's sessions it has no trace of ("bank": older quizzes
 * the log no longer holds or cannot split); a session and a log entry with the same date, score
 * and total are the same quiz.
 */
export function lectureHistory(id, log, bank) {
  const out = [];
  for (const e of log || []) {
    const r = e.by ? (Array.isArray(e.by[id]) ? { score: e.by[id][0], total: e.by[id][1] } : null)
      : e.lectures?.length === 1 && e.lectures[0] === id ? { score: e.score, total: e.total } : null;
    if (r && r.total > 0 && e.date) out.push({ date: e.date, ...r, src: "log" });
  }
  const unmatched = [...out];
  for (const s of bank?.sessions || []) {
    const at = unmatched.findIndex(r => r.date === s.date && r.score === s.score && r.total === s.total);
    if (at >= 0) unmatched.splice(at, 1);
    else if (s.total > 0 && s.date) out.push({ date: s.date, score: s.score, total: s.total, src: "bank" });
  }
  return out.map((r, i) => ({ r, i })).sort((a, b) => a.r.date.localeCompare(b.r.date) || a.i - b.i).map(x => x.r);
}

/**
 * Where the questions of a bank stand: mastered (answered right at least twice in a row), learning
 * (right last time), missed (wrong last time), fresh (never asked); `review` counts those the next
 * quiz brings back (missed, or right but rested long enough); `answers` and `wrong` are all-time.
 */
export function mastery(bank) {
  const out = { total: 0, mastered: 0, learning: 0, missed: 0, fresh: 0, review: 0, answers: 0, wrong: 0 };
  for (const q of bank?.questions || []) {
    out.total++;
    out.answers += q.seen || 0;
    out.wrong += Math.max(0, (q.seen || 0) - (q.right || 0));
    const s = standing(q, bank.quizzes || 0);
    if (s === "missed" || s === "due") out.review++;
    if (!q.seen) out.fresh++;
    else if (q.lastRight === false) out.missed++;
    else if ((q.streak || 0) >= 2) out.mastered++;
    else out.learning++;
  }
  return out;
}

/** Several `mastery` results added up. */
export function addMastery(list) {
  const out = mastery(null);
  for (const m of list) for (const k of Object.keys(out)) out[k] += m[k] || 0;
  return out;
}

/** One lecture at a glance: its history, quizzes, average, last score, trend and questions. */
export function lectureStats(id, log, bank) {
  const history = lectureHistory(id, log, bank);
  const last = history.at(-1);
  return {
    id,
    history,
    quizzes: history.length,
    average: average(history),
    last: last ? pct(last.score, last.total) : null,
    lastDate: last?.date || null,
    recent: average(history.slice(-3)),
    trend: trend(history.map(r => pct(r.score, r.total))),
    mastery: mastery(bank),
  };
}

/**
 * The lectures she misses most, worst first: those whose last 3 quizzes average under `under`, or
 * under 90% with at least a fifth of the questions asked missed last time; ranked by that recent
 * average, then by questions missed.
 */
export function weakSpots(stats, n = 5, under = 75) {
  const missedShare = m => m.missed / Math.max(1, m.total - m.fresh);
  return stats
    .filter(s => s.quizzes > 0 && (s.recent < under || (s.recent < 90 && missedShare(s.mastery) >= 0.2)))
    .sort((a, b) => a.recent - b.recent || b.mastery.missed - a.mastery.missed)
    .slice(0, n);
}

/**
 * What she did each day: Map date → { questions, cards }. Questions come from the log and from the
 * bank sessions it has no trace of (`histories`: lectureHistory results); cards from D.cardLog.
 */
export function activity(log, cardLog, histories = []) {
  const days = new Map();
  const at = d => days.get(d) || (days.set(d, { questions: 0, cards: 0 }), days.get(d));
  for (const e of log || []) if (e.date && e.total > 0) at(e.date).questions += e.total;
  for (const h of histories) for (const r of h) if (r.src === "bank") at(r.date).questions += r.total;
  for (const c of cardLog || []) if (c.date && c.seen > 0) at(c.date).cards += c.seen;
  return days;
}

/**
 * Study days in a row: `current` ends today, or yesterday when she has not studied yet today
 * (the streak is still alive); `best` is the longest run. `days` is a Set or Map of dates.
 */
export function streaks(days, today) {
  let current = 0;
  for (let d = days.has(today) ? today : addDays(today, -1); days.has(d); d = addDays(d, -1)) current++;
  let best = 0, run = 0, prev = null;
  for (const d of [...days.keys()].sort()) {
    run = prev && diffDays(prev, d) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return { current, best, today: days.has(today) };
}

/** Flashcard sessions added up: { sessions, seen, knew, share (% knew, or null) }. */
export function cardTotals(rows) {
  const seen = rows.reduce((a, r) => a + (r.seen || 0), 0);
  const knew = rows.reduce((a, r) => a + (r.knew || 0), 0);
  return { sessions: rows.length, seen, knew, share: pct(knew, seen) };
}

/** The Monday of the week of `date`. */
export const monday = date => addDays(date, -((parse(date).getDay() + 6) % 7));

/**
 * `rows` ([{ date, ... }]) summed per week for the `weeks` weeks ending with the week of `today`:
 * [{ start: Monday, ...sums of `fields` }], oldest first.
 */
export function perWeek(rows, today, weeks, fields) {
  const first = addDays(monday(today), -7 * (weeks - 1));
  const out = Array.from({ length: weeks }, (_, i) => ({ start: addDays(first, 7 * i), ...Object.fromEntries(fields.map(f => [f, 0])) }));
  for (const r of rows) {
    if (!r.date || r.date < first || r.date > today) continue;
    const w = out[Math.floor(diffDays(first, r.date) / 7)];
    if (w) for (const f of fields) w[f] += r[f] || 0;
  }
  return out;
}

/** The days of the `weeks` weeks ending with the week of `today`, Monday first: [[date | null] x 7]; days after today are null. */
export function calendar(today, weeks) {
  const first = addDays(monday(today), -7 * (weeks - 1));
  return Array.from({ length: weeks }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => { const x = addDays(first, 7 * w + d); return x > today ? null : x; }));
}

/** How dark a study day is drawn, 0 (nothing) to 4, from the questions and cards of that day. */
export const heat = n => (n <= 0 ? 0 : n < 10 ? 1 : n < 25 ? 2 : n < 50 ? 3 : 4);
