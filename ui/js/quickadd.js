// Parses a typed task such as "Email supervisor tomorrow p1 #Thesis every week".
// Pure function, covered by tests/.
import { addDays, addMonths, iso, parse } from "./dates.js";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

const weekdayIndex = w => WEEKDAYS.findIndex(d => d === w || d.slice(0, 3) === w);
const monthIndex = m => MONTHS.findIndex(d => d === m || d.slice(0, 3) === m);

/** Next date falling on weekday `idx`, strictly after `now`. */
function nextWeekday(idx, now) {
  const delta = (idx - parse(now).getDay() + 7) % 7 || 7;
  return addDays(now, delta);
}

/** A day and month with no year means the next time that date comes round. */
function dayMonth(day, month, now) {
  if (month < 0 || day < 1 || day > 31) return null;
  const year = parse(now).getFullYear();
  let d = new Date(year, month, day);
  if (d.getMonth() !== month) return null;
  if (iso(d) < now) d = new Date(year + 1, month, day);
  return iso(d);
}

const W = "(sun|mon|tue|wed|thu|fri|sat|sunday|monday|tuesday|wednesday|thursday|friday|saturday)";
const M = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)";

/** Each rule takes the regex match and returns the fields it sets, or null to leave the text alone. */
const RULES = [
  [/\bp([1-4])\b/i, m => ({ prio: Number(m[1]) })],
  [/(?:^|\s)#([\w-]+)/, m => ({ projectName: m[1].replace(/_/g, " ") })],

  [/\bevery\s+(?:(\d+)\s+)?(day|week|month)s?\b/i, m => ({ recur: { every: Number(m[1] || 1), unit: m[2].toLowerCase() } })],
  [/\bevery\s+weekday\b/i, () => ({ recur: { every: 1, unit: "weekday" } })],
  [new RegExp(`\\bevery\\s+${W}\\b`, "i"), (m, now) => ({ recur: { every: 1, unit: "week" }, dueIfNone: nextWeekday(weekdayIndex(m[1].toLowerCase()), now) })],

  [/\b(today|tod)\b/i, (m, now) => ({ due: now })],
  [/\b(tomorrow|tmr|tmrw)\b/i, (m, now) => ({ due: addDays(now, 1) })],
  [/\bnext\s+week\b/i, (m, now) => ({ due: nextWeekday(1, now) })],
  [/\bnext\s+month\b/i, (m, now) => ({ due: addMonths(now, 1) })],
  [/\bin\s+(\d+)\s+(day|week|month)s?\b/i, (m, now) => {
    const n = Number(m[1]), unit = m[2].toLowerCase();
    return { due: unit === "month" ? addMonths(now, n) : addDays(now, unit === "week" ? n * 7 : n) };
  }],
  [new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${M}\\b`, "i"), (m, now) => {
    const due = dayMonth(Number(m[1]), monthIndex(m[2].toLowerCase()), now);
    return due && { due };
  }],
  [new RegExp(`\\b${M}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "i"), (m, now) => {
    const due = dayMonth(Number(m[2]), monthIndex(m[1].toLowerCase()), now);
    return due && { due };
  }],
  [/\b(\d{1,2})\/(\d{1,2})\b/, (m, now) => { // 12/11 is European order: day, then month
    const due = dayMonth(Number(m[1]), Number(m[2]) - 1, now);
    return due && { due };
  }],
  [new RegExp(`\\b(?:(?:on|next)\\s+)?${W}\\b`, "i"), (m, now) => ({ due: nextWeekday(weekdayIndex(m[1].toLowerCase()), now) })],
];

/** Returns { title, prio, due, recur, projectName }; anything not recognised stays in the title. */
export function parseQuick(text, now) {
  const out = { title: "", prio: 4, due: null, recur: null, projectName: null };
  let rest = text;
  let dueIfNone = null;
  for (const [re, fn] of RULES) {
    const m = rest.match(re);
    if (!m) continue;
    const got = fn(m, now);
    if (!got) continue;
    if (got.due && out.due) continue; // the first date wins; a second one stays in the title
    if (got.dueIfNone) { dueIfNone = got.dueIfNone; delete got.dueIfNone; }
    Object.assign(out, got);
    rest = rest.slice(0, m.index) + " " + rest.slice(m.index + m[0].length);
  }
  if (!out.due && dueIfNone) out.due = dueIfNone;
  if (out.recur && !out.due) out.due = now;
  out.title = rest.replace(/\s+/g, " ").trim();
  return out;
}

/** The due date after `due` for a repeating task completed on `now`: always in the future. */
export function nextOccurrence(due, recur, now) {
  let d = due || now;
  const step = s => {
    if (recur.unit === "month") return addMonths(s, recur.every);
    if (recur.unit === "week") return addDays(s, 7 * recur.every);
    if (recur.unit === "weekday") {
      let n = addDays(s, 1);
      while ([0, 6].includes(parse(n).getDay())) n = addDays(n, 1);
      return n;
    }
    return addDays(s, recur.every);
  };
  do d = step(d); while (d <= now);
  return d;
}

export function recurLabel(r) {
  if (!r) return "";
  if (r.unit === "weekday") return "Every weekday";
  return r.every === 1 ? `Every ${r.unit}` : `Every ${r.every} ${r.unit}s`;
}
