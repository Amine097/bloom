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

export function quizPrompt(title, count = 8) {
  return `${READ(title)}

Write a quiz of ${count} multiple-choice questions that test understanding of the important ideas, not trivia.
Each question has exactly 4 options and exactly one correct option. The wrong options must be plausible.
"answer" is the index (0 to 3) of the correct option; vary its position across questions.
"why" explains the correct answer in one sentence. "page" is the page the answer comes from.

The reply must be exactly this shape:
{"questions": [{"q": "...", "options": ["...", "...", "...", "..."], "answer": 0, "why": "...", "page": 1}]}`;
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

/** → { questions: [{ q, options: [4 strings], answer: 0..3, why, page }] }. Throws a readable Error. */
export function parseQuiz(text) {
  const z = extractJson(text);
  const questions = list(z.questions, "questions").map((x, i) => {
    const what = `Question ${i + 1}`;
    obj(x, what);
    const q = str(x.q, `The text of question ${i + 1}`);
    if (!Array.isArray(x.options) || x.options.length !== 4) fail(`${what} does not have exactly four options.`);
    const options = x.options.map((o, j) => str(o, `Option ${j + 1} of question ${i + 1}`));
    if (new Set(options).size !== 4) fail(`${what} has the same option twice.`);
    const answer = typeof x.answer === "string" && /^\s*[0-3]\s*$/.test(x.answer) ? Number(x.answer) : x.answer;
    if (!Number.isInteger(answer) || answer < 0 || answer > 3) fail(`${what} does not say which option is correct.`);
    return { q, options, answer, why: str(x.why, `The explanation of question ${i + 1}`), page: page(x.page, what) };
  });
  return { questions };
}

/** Shuffles the options of each question (keeping track of the right one), so its position says nothing. */
export function shuffleOptions(questions, rand = Math.random) {
  return questions.map(x => {
    const order = [0, 1, 2, 3];
    for (let i = 3; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return { ...x, options: order.map(k => x.options[k]), answer: order.indexOf(x.answer) };
  });
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
