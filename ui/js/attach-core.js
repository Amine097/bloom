// "Attach PDFs": pairs a batch of chosen files with lectures. Pure, so it can be tested.
// A file is matched by its exact original name first (the seed's LECTURE_FILES), then by the
// words it shares with a lecture title. She checks every pair before anything is attached.

const STOP = new Set(("the and of for in on to with from an a by lecture lectures slides slide copy part " +
  "msc bmsc bms mbs master masterbsc handout final fin module teaching small version " +
  "january february march april may june july august september october november december").split(" "));

/** Lower case, no accents, no extension, words separated by single spaces. */
export function normName(name) {
  return String(name).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/\.(pdf|pptx?|key)$/i, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/** The meaningful words of a name, cut to a stem so "arrhythmia" meets "arrhythmias". */
export function words(name) {
  return new Set(normName(name).replace(/ae|oe/g, "e").split(" ")
    .filter(w => w.length >= 3 && !/^\d+$/.test(w) && !STOP.has(w))
    .map(w => w.slice(0, 6)));
}

/** How alike two names are, 0 to 1 (Dice coefficient of their words); two words must be shared unless a name has one. */
export function likeness(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  if (shared < Math.min(2, A.size, B.size)) return 0; // one common word ("CNS") is not enough
  return (2 * shared) / (A.size + B.size);
}

export const MIN_LIKENESS = 0.4;

/**
 * files:    [{ name }]
 * lectures: [{ id, title, pdfName }]   pdfName is the attached PDF's name, or null
 * known:    { [lectureId]: originalFileName }
 * Returns one entry per file, in order: { id, how } where how is
 *   "known" (exact original name), "title" (guessed from the title), "attached" (that lecture
 *   already carries this very file) or null with id null (no match).
 * Each lecture gets at most one file; only lectures without a PDF are matched.
 */
export function matchFiles(files, lectures, known = {}) {
  const out = files.map(() => ({ id: null, how: null }));
  const free = new Map(lectures.filter(l => !l.pdfName).map(l => [l.id, l]));
  const byName = new Map();
  for (const [id, name] of Object.entries(known)) if (free.has(id)) byName.set(normName(name), id);
  const attached = new Map(lectures.filter(l => l.pdfName).map(l => [normName(l.pdfName), l.id]));

  const open = [];
  files.forEach((f, i) => {
    const n = normName(f.name);
    const id = byName.get(n);
    if (id && free.has(id)) { out[i] = { id, how: "known" }; free.delete(id); byName.delete(n); }
    else if (attached.has(n)) out[i] = { id: attached.get(n), how: "attached" };
    else open.push(i);
  });

  const pairs = [];
  for (const i of open) for (const l of free.values()) {
    const s = likeness(files[i].name, l.title);
    if (s >= MIN_LIKENESS) pairs.push([s, i, l.id]);
  }
  pairs.sort((a, b) => b[0] - a[0]);
  const done = new Set();
  for (const [, i, id] of pairs) {
    if (done.has(i) || !free.has(id)) continue;
    out[i] = { id, how: "title" };
    done.add(i);
    free.delete(id);
  }
  return out;
}

/** A readable lecture title from a file name: "AI Biomarkers _part 2_2026.pdf" → "AI Biomarkers part 2". */
export function titleFromFile(name) {
  const base = String(name).replace(/\.(pdf|pptx?|key)$/i, "");
  const t = base.replace(/_+/g, " ")
    // no lookbehind here or below: older macOS webviews reject it, and the whole app then fails to load
    .replace(/(^|\W)(?:20\d{6}|20\d{2})(?!\w)/g, "$1 ") // 20261103, 2026
    .replace(/(^|\W)copy(?!\w)/gi, "$1 ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–.,;:]+|[\s\-–.,;:]+$/g, "");
  const out = t || base.trim();
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** The teaching date written in a file name as YYYYMMDD ("… - 20261103.pdf"), or null. */
export function dateFromFile(name) {
  const m = String(name).match(/(?:^|\D)(20\d{2})(\d{2})(\d{2})(?!\d)/);
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}
