// The five lecture states and the spaced-recall schedule. Pure functions, covered by tests/.
import { addDays, diffDays } from "./dates.js";

export const STATES = ["todo", "seen", "quizzed", "recall1", "recall2"];
export const LABEL = { todo: "To do", seen: "Seen", quizzed: "Quizzed", recall1: "Recall 1", recall2: "Recall 2" };

/** A lecture stores the day each step was done; its state is the furthest step reached. */
export function stateOf(l) {
  if (l.recall2At) return "recall2";
  if (l.recall1At) return "recall1";
  if (l.quizzedAt) return "quizzed";
  if (l.seenAt) return "seen";
  return "todo";
}

/**
 * Click on a step. Clicking a later step moves the lecture there; clicking the step it is on
 * steps back one. "Quizzed" is optional: it never blocks a recall, and once a recall is done
 * it is just a tick that can be toggled.
 */
export function setStep(l, step, day) {
  const cur = stateOf(l);
  l.recallDue = null; // a manual reschedule only applies to the recall that was pending
  if (step === "quizzed") {
    if (l.quizzedAt) l.quizzedAt = null;
    else { l.seenAt ??= day; l.quizzedAt = day; }
    return;
  }
  if (step === "seen" && cur === "quizzed") { l.quizzedAt = null; return; }
  const order = ["todo", "seen", "recall1", "recall2"];
  let target = order.indexOf(step);
  if (step !== "todo" && step === (cur === "quizzed" ? "seen" : cur)) target -= 1;
  if (target < 1) { l.seenAt = null; l.quizzedAt = null; } else l.seenAt ??= day;
  if (target < 2) l.recall1At = null; else l.recall1At ??= day;
  if (target < 3) l.recall2At = null; else l.recall2At ??= day;
}

/**
 * The recall a lecture is waiting for, or null.
 * Normally recall 1 is `cfg.recall1` days after "seen" and recall 2 `cfg.recall2` days after
 * recall 1 was actually done. When the module's exam leaves less room than that, both gaps
 * shrink in proportion so recall 2 still lands on the eve of the exam at the latest.
 * Returns { n: 1|2, due, adapted, manual }.
 */
export function nextRecall(l, exam, cfg, now) {
  const state = stateOf(l);
  if (state === "todo" || state === "recall2") return null;
  if (exam && exam < now) return null; // the exam is over: nothing left to revise for
  const n = l.recall1At ? 2 : 1;
  const from = n === 1 ? l.seenAt : l.recall1At;
  const gap = n === 1 ? cfg.recall1 : cfg.recall2;
  let due = addDays(from, gap);
  let adapted = false;

  if (exam && exam > from) {
    const eve = addDays(exam, -1);
    const room = diffDays(from, eve);
    if (n === 1 && room < cfg.recall1 + cfg.recall2) {
      const short = Math.max(1, Math.min(gap, Math.round(room * gap / (cfg.recall1 + cfg.recall2))));
      adapted = short !== gap;
      due = addDays(from, short);
    } else if (n === 2 && due > eve) {
      if (room < 1) return null; // recall 1 was done on the eve: no time for another
      due = eve;
      adapted = true;
    }
  }
  if (l.recallDue) return { n, due: l.recallDue, adapted: false, manual: true };
  return { n, due, adapted, manual: false };
}

/**
 * Evens out the load: no more than `maxPerDay` recalls on one day. Each recall keeps its own
 * date when there is room, otherwise it moves to the next free day (never before today, and
 * not past the eve of its exam). Returns [{ id, due }] for the recalls that have to move.
 */
export function spreadPlan(pending, maxPerDay, now) {
  const load = {};
  const moves = [];
  const sorted = [...pending].sort((a, b) => a.due.localeCompare(b.due));
  for (const p of sorted) {
    let day = p.due < now ? now : p.due;
    while ((load[day] || 0) >= maxPerDay && !(p.latest && day >= p.latest)) day = addDays(day, 1);
    load[day] = (load[day] || 0) + 1;
    if (day !== p.due) moves.push({ id: p.id, due: day });
  }
  return moves;
}
