// Dates are plain "YYYY-MM-DD" strings in local time; a deadline adds "THH:mm".

const pad = n => String(n).padStart(2, "0");

export const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => iso(new Date());

export function parse(s) {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s, n) {
  const d = parse(s);
  d.setDate(d.getDate() + n);
  return iso(d);
}

export function addMonths(s, n) {
  const d = parse(s);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return iso(d);
}

/** Whole days from a to b (positive when b is later). */
export const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);

/** Study week of a date; week 1 starts on `start`. Dates before the semester give 0 or less. */
export const weekOf = (date, start) => Math.floor(diffDays(start, date) / 7) + 1;

export const weekStart = (week, start) => addDays(start, (week - 1) * 7);

const F = {
  day: new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }),
  wday: new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }),
  long: new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" }),
};
export const fmtDay = s => F.day.format(parse(s));
export const fmtWday = s => F.wday.format(parse(s));
export const fmtLong = s => F.long.format(parse(s));

export function weekLabel(week, start) {
  const a = weekStart(week, start);
  return `${fmtDay(a)} – ${fmtDay(addDays(a, 6))}`;
}

/** "today", "tomorrow", "in 3 days", "2 days ago" */
export function relDay(date, now = today()) {
  const n = diffDays(now, date);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "yesterday";
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

/** Short label for a due date: "Today", "Tomorrow", "Fri" within a week, else "14 Nov". */
export function dueLabel(date, now = today()) {
  const n = diffDays(now, date);
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n === -1) return "Yesterday";
  if (n > 1 && n < 7) return new Intl.DateTimeFormat("en-GB", { weekday: "long" }).format(parse(date));
  return fmtDay(date);
}
