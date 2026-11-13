// Notebook logic that does not touch the screen: the prompts sent to Claude Code, and the
// parsers that turn its answers into study guides and quizzes. Pure, covered by tests/.

/** The command line, shared by the dev preview server. The native shell (lib.rs) uses the same flags. */
export const CLAUDE_ARGS = ["-p", "--output-format", "json", "--no-session-persistence", "--strict-mcp-config", "--allowedTools", "Read", "--max-turns", "8"];

/** Where the caller puts the absolute path of the PDF. */
export const PDF_TOKEN = "{{PDF}}";

const READ = title => `You are helping a university student revise a lecture.
Use the Read tool to read the lecture PDF at this path: "${PDF_TOKEN}"
The lecture is called ${JSON.stringify(String(title || "Untitled"))}.
Read the whole document. If it is long, read it in parts (at most 20 pages at a time) until you have covered every page.

Rules:
- Use only what is in this document. Do not add facts from anywhere else.
- Write in the same language as the document.
- Page numbers are the page numbers of the PDF file: the first page of the file is page 1.
- Reply with JSON only: no introduction, no comments, no code fences.`;

export function guidePrompt(title) {
  return `${READ(title)}

Write a study guide with:
- "summary": what the lecture is about, in 3 to 5 sentences.
- "points": the 5 to 8 most important points, each in one or two sentences, each with the page it comes from.
- "terms": the 6 to 12 key terms, each with a one-line definition.

The reply must be exactly this shape:
{"summary": "...", "points": [{"text": "...", "page": 1}], "terms": [{"term": "...", "def": "..."}]}`;
}

// ---- the quiz: a bank of questions per lecture
//
// D.notebook[itemId].quiz = {
//   createdAt: "YYYY-MM-DD",                    when the bank was first made
//   questions: [{ id, q, options: [4 strings], answer: 0..3 (index in the stored options),
//                 why, page: n | null, level: "recall" | "understanding" | "application" | null,
//                 addedAt: "YYYY-MM-DD", seen: n, right: n, lastSeen: "YYYY-MM-DD" | null,
//                 lastRight: true | false | null }],
//   best: { score, total, date } | null,        best finished session (by share of right answers)
//   sessions: [{ date, score, total }],         the last SESSIONS_KEPT finished sessions, oldest first
// }

export const LEVELS = ["recall", "understanding", "application"];
/** Most questions kept in one lecture's bank. */
export const BANK_MAX = 60;
export const SESSIONS_KEPT = 10;

const LEVEL_TEXT = {
  recall: "remembering a fact, a definition, a name or a number stated in the document",
  understanding: "explaining why or how something happens, or relating two ideas from the document",
  application: "using an idea from the document on a short new case (an experiment, a patient, a drug, a result to interpret), still answerable from the document alone",
};

/**
 * `count` questions at `level` ("mixed" or one of LEVELS). `avoid` lists the texts of the
 * questions already in the bank, which Claude must not repeat.
 */
export function quizPrompt(title, { count = 10, level = "mixed", avoid = [] } = {}) {
  const mix = LEVELS.includes(level)
    ? `Every question is at the "${level}" level.`
    : "Mix the three levels, roughly a third each.";
  const known = avoid.map(t => `- ${String(t).replace(/\s+/g, " ").trim()}`).join("\n");
  return `${READ(title)}

Write ${count} multiple-choice questions that help the student prepare for the exam on this lecture. Test the important ideas, not trivia.

Levels:
${LEVELS.map(l => `- "${l}": ${LEVEL_TEXT[l]}.`).join("\n")}
${mix}

Every question:
- can be answered from this document alone; never test knowledge the document does not contain;
- has exactly 4 options, exactly one of them correct without any doubt according to the document;
- has 3 wrong options that are plausible to someone who has not studied the lecture (common confusions, related terms or numbers from the same lecture) but clearly wrong;
- has options of similar length and style, so that length or wording does not give the answer away;
- never uses "all of the above", "none of the above" or an option that combines other options;
- is different from the other questions: no two questions test the same fact;
- is worded like an exam question: never mention "the lecture", "the document", "the text" or "the slides" in the question or in the options.
"answer" is the index (0 to 3) of the correct option; vary its position across questions.
"level" is "recall", "understanding" or "application".
"why" explains in one or two sentences why the correct option is right. "page" is the page the answer comes from.
${known ? `
The student already has the questions below. Write new questions about other facts and ideas of the document; do not repeat or reword any of these:
${known}
` : ""}
The reply must be exactly this shape:
{"questions": [{"q": "...", "options": ["...", "...", "...", "..."], "answer": 0, "level": "recall", "why": "...", "page": 1}]}`;
}

// ---- reading the answers

const fail = msg => { throw new Error(msg); };

/** Finds the JSON object in Claude's reply, even when it is wrapped in a code fence or text. */
export function extractJson(text) {
  const s = String(text ?? "").trim();
  if (!s) fail("Claude's answer was empty. Try again.");
  const tries = [s];
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) tries.push(fence[1].trim());
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a !== -1 && b > a) tries.push(s.slice(a, b + 1));
  for (const t of tries) {
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch { /* try the next candidate */ }
  }
  return fail("Claude's answer could not be read. Try again.");
}

const str = (v, what) => (typeof v === "string" && v.trim() ? v.trim() : fail(`${what} is missing.`));

/** A page number: a positive whole number (digits in a string are accepted), or null when absent. */
function page(v, what) {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : v;
  return Number.isInteger(n) && n >= 1 ? n : fail(`${what} has an invalid page number.`);
}

const list = (v, what) => (Array.isArray(v) && v.length ? v : fail(`The ${what} are missing.`));
const obj = (v, what) => (v && typeof v === "object" && !Array.isArray(v) ? v : fail(`${what} is not in the expected form.`));

/** → { summary, points: [{ text, page }], terms: [{ term, def }] }. Throws a readable Error. */
export function parseGuide(text) {
  const g = extractJson(text);
  const summary = str(g.summary, "The summary");
  const points = list(g.points, "key points").map((p, i) => {
    const what = `Key point ${i + 1}`;
    obj(p, what);
    return { text: str(p.text, what), page: page(p.page, what) };
  });
  const terms = list(g.terms, "key terms").map((t, i) => {
    const what = `Key term ${i + 1}`;
    obj(t, what);
    return { term: str(t.term, what), def: str(t.def, `The definition of key term ${i + 1}`) };
  });
  return { summary, points, terms };
}

/** Lower case, no accents, no punctuation, single spaces: two texts that only differ in those are the same. */
export const normText = s => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const CATCH_ALL = /\b(all|none|both|neither) of the (above|other options)\b|^(all|none) of these\b/i;
const COMBINED = /^\(?[a-d]\)? (and|&|or) \(?[a-d]\)?$/i;

function question(x, i) {
  const what = `Question ${i + 1}`;
  obj(x, what);
  const q = str(x.q, `The text of question ${i + 1}`);
  if (!Array.isArray(x.options) || x.options.length !== 4) fail(`${what} does not have exactly four options.`);
  const options = x.options.map((o, j) => str(o, `Option ${j + 1} of question ${i + 1}`));
  if (new Set(options.map(normText)).size !== 4) fail(`${what} has the same option twice.`);
  if (options.some(o => CATCH_ALL.test(o) || COMBINED.test(o))) fail(`${what} has an "all of the above" kind of option.`);
  const answer = typeof x.answer === "string" && /^\s*[0-3]\s*$/.test(x.answer) ? Number(x.answer) : x.answer;
  if (!Number.isInteger(answer) || answer < 0 || answer > 3) fail(`${what} does not say which option is correct.`);
  const level = typeof x.level === "string" ? x.level.trim().toLowerCase() : "";
  if (!LEVELS.includes(level)) fail(`${what} does not say whether it is recall, understanding or application.`);
  return { q, options, answer, level, why: str(x.why, `The explanation of question ${i + 1}`), page: page(x.page, what) };
}

/**
 * → { questions: [{ q, options: [4 strings], answer: 0..3, level, why, page }], skipped: [messages] }.
 * Invalid questions are left out as long as at least half of the batch is valid; otherwise it
 * throws a readable Error.
 */
export function parseQuiz(text) {
  const z = extractJson(text);
  const all = list(z.questions, "questions");
  const questions = [], skipped = [];
  all.forEach((x, i) => {
    try { questions.push(question(x, i)); } catch (e) { skipped.push(e.message); }
  });
  if (questions.length * 2 < all.length) {
    fail(questions.length
      ? `Only ${questions.length} of Claude's ${all.length} questions could be used. ${skipped[0]} Try again.`
      : all.length === 1 ? skipped[0] : `None of Claude's ${all.length} questions could be used. ${skipped[0]} Try again.`);
  }
  return { questions, skipped };
}

/**
 * Adds parsed questions to a bank. Drops those whose text (normalised) is already in the bank or
 * earlier in the batch, and those beyond `max`. Does not change its arguments.
 * → { questions: the whole new bank, added: [new questions], duplicates: n, overflow: n }
 */
export function mergeQuestions(bank, incoming, { date, makeId, max = BANK_MAX }) {
  const seen = new Set(bank.map(x => normText(x.q)));
  const added = [];
  let duplicates = 0, overflow = 0;
  for (const x of incoming) {
    const key = normText(x.q);
    if (seen.has(key)) { duplicates++; continue; }
    if (bank.length + added.length >= max) { overflow++; continue; }
    seen.add(key);
    added.push({
      id: makeId(), q: x.q, options: [...x.options], answer: x.answer, why: x.why, page: x.page ?? null,
      level: LEVELS.includes(x.level) ? x.level : null, addedAt: date,
      seen: 0, right: 0, lastSeen: null, lastRight: null,
    });
  }
  return { questions: [...bank, ...added], added, duplicates, overflow };
}

/** A random order of 0..n-1 (Fisher–Yates). `rand` returns a number in [0, 1). */
export function shuffled(n, rand = Math.random) {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * Chooses the questions of a session: first those never seen and those missed last time, then
 * the least recently seen; ties are broken at random. `size` is a number or "all".
 * → [{ id, order }] in the order to ask them; `order[k]` is the stored index of the option shown at
 * position k, so option positions change from one session to the next.
 */
export function pickSession(questions, size, rand = Math.random) {
  const n = size === "all" ? questions.length : Math.max(0, Math.min(Number(size) || 0, questions.length));
  const tier = x => (!x.seen || x.lastRight === false ? 0 : 1);
  const mixed = shuffled(questions.length, rand).map(i => questions[i]);
  const chosen = mixed
    .map((x, k) => ({ x, k }))
    .sort((a, b) => tier(a.x) - tier(b.x) || (a.x.lastSeen || "").localeCompare(b.x.lastSeen || "") || a.k - b.k)
    .slice(0, n)
    .map(({ x }) => x);
  return shuffled(chosen.length, rand).map(i => ({ id: chosen[i].id, order: shuffled(chosen[i].options.length, rand) }));
}

/** A bank's questions in the order pickSession would choose them (same ranking, same use of `rand`). */
function ranked(questions, rand) {
  const tier = x => (!x.seen || x.lastRight === false ? 0 : 1);
  return shuffled(questions.length, rand).map(i => questions[i])
    .map((x, k) => ({ x, k }))
    .sort((a, b) => tier(a.x) - tier(b.x) || (a.x.lastSeen || "").localeCompare(b.x.lastSeen || "") || a.k - b.k)
    .map(({ x }) => x);
}

/**
 * Chooses a session across several lectures' banks (a module quiz). `banks` is
 * [{ lecture, questions }]. Each bank is ranked as in pickSession (never seen and missed last time
 * first, then the least recently seen), and the lectures take turns, in a random order, giving
 * their next question: a big bank cannot crowd out a small one. `size` is a number or "all".
 * → [{ lecture, id, order }] in the order to ask them. With one bank, the same draw as pickSession.
 */
export function pickModuleSession(banks, size, rand = Math.random) {
  const lists = banks.map(b => ({ lecture: b.lecture, queue: ranked(b.questions || [], rand) })).filter(l => l.queue.length);
  const total = lists.reduce((sum, l) => sum + l.queue.length, 0);
  const n = size === "all" ? total : Math.max(0, Math.min(Number(size) || 0, total));
  const turns = shuffled(lists.length, rand).map(i => lists[i]);
  const chosen = [];
  for (let round = 0; chosen.length < n; round++) {
    for (const l of turns) {
      if (chosen.length >= n) break;
      if (round < l.queue.length) chosen.push({ lecture: l.lecture, x: l.queue[round] });
    }
  }
  return shuffled(chosen.length, rand)
    .map(i => ({ lecture: chosen[i].lecture, id: chosen[i].x.id, order: shuffled(chosen[i].x.options.length, rand) }));
}

/** A question's history after one more answer. Returns a new question. */
export const withAnswer = (x, right, date) =>
  ({ ...x, seen: (x.seen || 0) + 1, right: (x.right || 0) + (right ? 1 : 0), lastSeen: date, lastRight: Boolean(right) });

const better = (a, b) => !b || a.score * b.total > b.score * a.total || (a.score * b.total === b.score * a.total && a.total > b.total);

/** The best score and session list after a finished session `{ date, score, total }`. → { best, sessions } */
export function withSession(quiz, result) {
  const r = { date: result.date, score: result.score, total: result.total };
  return {
    best: r.total > 0 && better(r, quiz.best) ? r : quiz.best ?? null,
    sessions: [...(quiz.sessions || []), r].slice(-SESSIONS_KEPT),
  };
}

/**
 * Brings a saved quiz to the bank shape. Version 2 saved `{ createdAt, questions: [{ q, options,
 * answer, why, page }], best: number | null }`; nothing is lost: `best` becomes `{ score, total,
 * date: null }`. Already-converted quizzes come back unchanged in content. Returns null for
 * something that is not a quiz at all.
 */
export function migrateQuiz(old) {
  if (!old || typeof old !== "object" || !Array.isArray(old.questions)) return null;
  const date = typeof old.createdAt === "string" ? old.createdAt : null;
  const ids = new Set();
  const questions = old.questions.filter(x => x && typeof x === "object").map((x, i) => {
    let id = typeof x.id === "string" && x.id ? x.id : `m${i + 1}`;
    while (ids.has(id)) id += "x";
    ids.add(id);
    return {
      ...x, id,
      page: x.page ?? null,
      level: LEVELS.includes(x.level) ? x.level : null,
      addedAt: x.addedAt ?? date,
      seen: Number.isInteger(x.seen) ? x.seen : 0,
      right: Number.isInteger(x.right) ? x.right : 0,
      lastSeen: x.lastSeen ?? null,
      lastRight: typeof x.lastRight === "boolean" ? x.lastRight : null,
    };
  });
  let best = old.best ?? null;
  if (typeof best === "number") best = { score: best, total: old.questions.length, date: null };
  else if (!best || typeof best !== "object") best = null;
  return { ...old, createdAt: date, questions, best, sessions: Array.isArray(old.sessions) ? old.sessions : [] };
}

/**
 * Reads the JSON envelope printed by `claude -p --output-format json` and returns Claude's text.
 * `exitCode` is the process exit code. Throws a readable Error.
 */
export function readEnvelope(stdout, exitCode = 0, stderr = "") {
  const out = String(stdout ?? "").trim();
  let env = null;
  try { env = JSON.parse(out); } catch {
    for (const line of out.split(/\r?\n/).reverse()) {
      try { const v = JSON.parse(line); if (v && typeof v === "object" && !Array.isArray(v)) { env = v; break; } } catch { /* not JSON */ }
    }
  }
  if (!env || typeof env !== "object") {
    const detail = String(stderr ?? "").trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 300);
    fail(`Claude Code did not answer${exitCode ? ` (exit code ${exitCode})` : ""}.${detail ? " " + detail : ""}`);
  }
  const result = typeof env.result === "string" ? env.result.trim() : "";
  if (env.is_error || exitCode) {
    if (env.subtype === "error_max_turns") fail("Claude needed more steps than allowed (the PDF may be very long). Try again.");
    fail(`Claude Code: ${result || env.subtype || "unknown error"}`);
  }
  if (!result) fail("Claude's answer was empty. Try again.");
  return result;
}
