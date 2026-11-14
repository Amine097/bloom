// The quiz across one or more lectures, without the screen: which questions a quiz asks, how many
// new ones each lecture needs first, and when a question comes back. Pure, covered by
// tests/quiz.test.mjs. The banks themselves are in D.notebook[id].quiz (shape in notebook-core.js);
// this adds, per bank, `quizzes` (how many quizzes included this lecture) and, per question,
// `streak` (right answers in a row) and `lastQuiz` (the bank's `quizzes` when it was last asked).
//
// A question is
//   "missed"   when its last answer was wrong: it comes back first, in the next quiz of its lecture;
//   "new"      when it was never asked;
//   "due"      when it was answered right and enough quizzes of its lecture have passed since:
//              GAPS[streak - 1] quizzes (3 after one right answer, 6 after two in a row, then 12);
//   "resting"  otherwise. Resting questions are only used when nothing else is left.
import { shuffled, LEVELS, BANK_MAX } from "./notebook-core.js";

export const SIZES = [5, 10, 20, 30];
export const GAPS = [3, 6, 12];
/** Questions asked of Claude beyond what a quiz needs, so the next quiz can start at once. */
export const SPARE = 3;
/** Fewest and most questions asked of Claude for one lecture at a time. */
export const GEN_MIN = 5, GEN_MAX = 15;
/** Finished quizzes kept in D.quizLog. */
export const LOG_KEPT = 20;

export const gapFor = streak => GAPS[Math.min(Math.max(streak || 1, 1), GAPS.length) - 1];

/** "missed" | "new" | "due" | "resting" for question `q` of a bank that has had `quizzes` quizzes. */
export function standing(q, quizzes = 0) {
  if (!q.seen) return "new";
  if (q.lastRight === false) return "missed";
  const since = Number.isInteger(q.lastQuiz) ? quizzes - q.lastQuiz : Infinity;
  return since >= gapFor(q.streak) ? "due" : "resting";
}

const TIER = { missed: 0, new: 1, due: 2, resting: 3 };
const fits = (q, level) => !LEVELS.includes(level) || q.level === level;

/** `size` split between `n` lectures as evenly as possible, the first ones taking the remainder. */
export function share(size, n) {
  if (n <= 0) return [];
  const base = Math.floor(size / n), extra = size % n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

/** The questions of one bank a quiz may ask, best first: missed, new, due, then resting. */
function queue(bank, level, rand, withResting) {
  const quizzes = bank.quizzes || 0;
  return shuffled((bank.questions || []).length, rand)
    .map(i => bank.questions[i])
    .filter(q => fits(q, level))
    .map((q, k) => ({ q, k, t: TIER[standing(q, quizzes)] }))
    .filter(r => withResting || r.t < TIER.resting)
    .sort((a, b) => a.t - b.t || (a.q.lastSeen || "").localeCompare(b.q.lastSeen || "") || a.k - b.k)
    .map(r => r.q);
}

/**
 * What a quiz of `size` questions at `level` ("mixed" or one of LEVELS) over `banks`
 * ([{ lecture, questions, quizzes }]) needs. Per lecture: `want` (its share), `ready` (questions it
 * can ask that are not resting) and `make` (how many to ask Claude for first: 0 when it has
 * enough, otherwise the shortfall plus SPARE, between GEN_MIN and GEN_MAX, within the room left in
 * the bank). → [{ lecture, want, ready, make }]
 */
export function planQuiz(banks, size, level) {
  const wants = share(size, banks.length);
  return banks.map((b, i) => {
    const ready = queue(b, level, () => 0.5, false).length;
    const short = wants[i] - ready;
    const room = BANK_MAX - (b.questions || []).length;
    const make = short > 0 ? Math.max(0, Math.min(room, GEN_MAX, Math.max(GEN_MIN, short + SPARE))) : 0;
    return { lecture: b.lecture, want: wants[i], ready, make };
  });
}

/**
 * Draws a quiz: each lecture first gives up to its share of its best questions (missed, new, due);
 * the places left are filled from any lecture, then with resting questions. A lecture with too few
 * questions does not shorten the quiz while others have more. → [{ lecture, id, order }] in the
 * order to ask them; `order[k]` is the stored index of the option shown at position k.
 */
export function drawQuiz(banks, size, level, rand = Math.random) {
  const wants = share(size, banks.length);
  const lists = banks.map((b, i) => ({ lecture: b.lecture, want: wants[i], q: queue(b, level, rand, true), quizzes: b.quizzes || 0 }));
  const chosen = [];
  const take = (l, ok) => {
    const at = l.q.findIndex(ok);
    if (at === -1) return false;
    chosen.push({ lecture: l.lecture, x: l.q.splice(at, 1)[0] });
    return true;
  };
  const fresh = l => q => standing(q, l.quizzes) !== "resting";
  // its share from each lecture, then any lecture's other good questions, then resting ones
  for (const l of lists) for (let k = 0; k < l.want && take(l, fresh(l)); k++);
  for (const pass of ["fresh", "any"]) {
    let more = true;
    while (chosen.length < size && more) {
      more = false;
      for (const l of shuffled(lists.length, rand).map(i => lists[i])) {
        if (chosen.length >= size) break;
        if (take(l, pass === "fresh" ? fresh(l) : () => true)) more = true;
      }
    }
  }
  return shuffled(chosen.length, rand)
    .map(i => ({ lecture: chosen[i].lecture, id: chosen[i].x.id, order: shuffled(chosen[i].x.options.length, rand) }));
}

/** A question after one more answer in quiz number `quizNo` of its bank. Returns a new question. */
export const answered = (q, right, date, quizNo) => ({
  ...q,
  seen: (q.seen || 0) + 1,
  right: (q.right || 0) + (right ? 1 : 0),
  lastSeen: date,
  lastRight: Boolean(right),
  streak: right ? (q.streak || 0) + 1 : 0,
  lastQuiz: quizNo,
});

/** How many questions of a bank are in each standing. → { missed, new, due, resting } */
export function standings(bank) {
  const out = { missed: 0, new: 0, due: 0, resting: 0 };
  for (const q of bank?.questions || []) out[standing(q, bank.quizzes || 0)]++;
  return out;
}

/**
 * Brings a bank saved before version 5 to the new shape: `quizzes` from its finished sessions, and
 * per question `streak` (1 when its last answer was right) and `lastQuiz` (unknown: null, so a
 * question answered right comes back in the next quiz). Nothing else changes.
 */
export function migrateBank(bank) {
  if (!bank || typeof bank !== "object" || !Array.isArray(bank.questions)) return bank;
  if (!Number.isInteger(bank.quizzes)) bank.quizzes = Array.isArray(bank.sessions) ? bank.sessions.length : 0;
  for (const q of bank.questions) {
    if (!Number.isInteger(q.streak)) q.streak = q.lastRight === true ? 1 : 0;
    if (q.lastQuiz === undefined) q.lastQuiz = null;
  }
  return bank;
}

/**
 * Modules that share one exam date still to come, for the "whole exam" shortcut.
 * `modules` is D.modules. → [{ date, ids: [module ids] }] with at least two modules, soonest first.
 */
export function examGroups(modules, today) {
  const by = new Map();
  for (const [id, m] of Object.entries(modules || {})) {
    if (!m?.exam || m.exam < today) continue;
    if (!by.has(m.exam)) by.set(m.exam, []);
    by.get(m.exam).push(id);
  }
  return [...by].filter(([, ids]) => ids.length >= 2).sort(([a], [b]) => a.localeCompare(b)).map(([date, ids]) => ({ date, ids }));
}
