// Themes: what a question or a flashcard is about. She ticks the themes she wants to be tested on
// (the quiz page, a lecture's Quiz tab, the flashcards); Claude writes only on those and tags what it
// writes, and a quiz or a review session only draws what has a ticked theme. Pure, covered by
// tests/themes.test.mjs.
//
// A question (D.notebook[id].quiz, D.fiches[id].quiz) or a card (D.notebook[id].cards) may carry
// `themes: [keys]`, one or more keys of THEMES in THEMES order. Absent means not classified yet:
// Bloom has Claude classify them, text only, the first time the bank or deck is used (classifyPrompt,
// readClassification); until that works, an unclassified item counts as matching every theme.

/** The eight themes. `short` is the chip's label, `label` the full name, `about` the line Claude reads. */
export const THEMES = [
  { key: "basic", short: "Basic sciences", label: "Basic sciences",
    about: "the normal body: anatomy, histology, physiology, biochemistry, cell biology and genetics of healthy tissues and organs" },
  { key: "molecular", short: "Molecular", label: "Molecular mechanisms",
    about: "molecules, genes, proteins, receptors, channels, signalling pathways and cellular processes, and how they work" },
  { key: "pathology", short: "Pathology", label: "Disease, pathology & pathophysiology",
    about: "what goes wrong in disease: causes, mechanisms, lesions, how a disease develops and progresses" },
  { key: "clinical", short: "Clinical", label: "Clinical aspects",
    about: "patients: symptoms and signs, diagnosis, tests and imaging, classifications, prognosis and clinical management" },
  { key: "epidemiology", short: "Epidemiology", label: "Epidemiology & prevention",
    about: "how common a disease is and who gets it: incidence, prevalence, risk factors, screening and prevention" },
  { key: "pharmacology", short: "Pharmacology", label: "Pharmacology & treatments",
    about: "drugs and other treatments (surgery, devices, therapies): targets, mechanisms of action, effects, side effects, indications" },
  { key: "trials", short: "Trials & research", label: "Clinical trials & research",
    about: "studies and evidence: study designs, landmark trials and their results, endpoints, research and experimental methods" },
  { key: "modelling", short: "Modelling & data", label: "Modelling & data",
    about: "numbers and models: mathematical and computational models, equations, statistics, data analysis and reading quantitative results" },
];

export const THEME_KEYS = THEMES.map(t => t.key);
/** Ticked when Bloom starts; she can tick the others and untick these. */
export const DEFAULT_THEMES = Object.freeze(["basic", "molecular", "pathology", "pharmacology"]);

const BY_KEY = new Map(THEMES.map(t => [t.key, t]));
export const themeOf = key => BY_KEY.get(key) || null;

/**
 * The valid theme keys of `v` (an array of keys; a lone string is accepted), each once, in THEMES
 * order. Case and spacing are ignored; anything else is dropped. → [keys], possibly empty.
 */
export function cleanThemes(v) {
  const list = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  const keys = new Set(list.filter(k => typeof k === "string").map(k => k.trim().toLowerCase()));
  return THEME_KEYS.filter(k => keys.has(k));
}

/** Whether `x` (a question or a card) has been classified. */
export const isClassified = x => Array.isArray(x?.themes) && x.themes.length > 0;

/**
 * Whether `x` may be drawn when `on` (an array of keys) is ticked: it has at least one ticked theme.
 * An unclassified item matches (its classification failed: it is not held back). `on` null or
 * absent: no filter.
 */
export function matchesThemes(x, on) {
  if (!Array.isArray(on)) return true;
  if (!isClassified(x)) return true;
  return x.themes.some(k => on.includes(k));
}

/** The items of `list` not classified yet. */
export const unclassified = list => (Array.isArray(list) ? list.filter(x => x && !isClassified(x)) : []);

const line = t => `- "${t.key}" (${t.label}): ${t.about}.`;

/**
 * The part of a generation prompt about themes: the ticked ones (write only on those, spread across
 * them), the others (do not write on those), and the "themes" field asked of every `what`
 * ("question" or "card"). `on`: the ticked keys. → text, or "" when `on` is not an array.
 */
export function themesBlock(on, what = "question") {
  if (!Array.isArray(on)) return "";
  const yes = THEMES.filter(t => on.includes(t.key)), no = THEMES.filter(t => !on.includes(t.key));
  const plural = `${what}s`;
  return `Themes: the student chose what to be tested on.
Write ${plural} only on these themes, spread across them as far as the document allows:
${yes.map(line).join("\n")}${no.length ? `
Do not write ${plural} on these themes; the student does not want them now:
${no.map(line).join("\n")}` : ""}
If the document says little about a chosen theme, write fewer ${plural} on it rather than stretching it.
"themes" lists the keys of the themes the ${what} is about: one or more, only from these keys: ${THEME_KEYS.map(k => `"${k}"`).join(", ")}.`;
}

/**
 * The prompt that classifies `items` ([{ id, text }]: a question with its right answer, or a card's
 * front and back), text only, no file. `what`: "question" or "card". The reply is { id: [keys] }.
 */
export function classifyPrompt(items, what = "question") {
  const list = items.map(x => `${JSON.stringify(String(x.id))}: ${String(x.text ?? "").replace(/\s+/g, " ").trim()}`).join("\n");
  return `You are helping a university student in biomedical sciences sort revision ${what}s by theme.

The themes:
${THEMES.map(line).join("\n")}

Give every ${what} below the theme or themes it is about: one or more keys, only from these keys: ${THEME_KEYS.map(k => `"${k}"`).join(", ")}. Most ${what}s have one or two themes. Do not use any tool.

The ${what}s, one per line, each after its id:
${list}

Reply with JSON only (no introduction, no comments, no code fences), every id above as a key:
{"id": ["key"]}`;
}

/**
 * Reads a classification reply (already parsed JSON: { id: [keys] }, or the same under "themes")
 * for the ids `ids`. Unknown ids, invalid keys and items with no valid key are left out (they stay
 * unclassified). → Map(id → [keys])
 */
export function readClassification(obj, ids) {
  const src = obj && typeof obj === "object" && !Array.isArray(obj)
    ? (obj.themes && typeof obj.themes === "object" && !Array.isArray(obj.themes) ? obj.themes : obj) : {};
  const out = new Map();
  for (const id of ids) {
    const keys = cleanThemes(src[id]);
    if (keys.length) out.set(id, keys);
  }
  return out;
}

/** The text Claude classifies for a quiz question: the question and its right answer. */
export const questionText = q => `${q.q} (answer: ${Array.isArray(q.options) ? q.options[q.answer] ?? "" : ""})`;
/** The text Claude classifies for a flashcard. */
export const cardText = c => `${c.front} (answer: ${c.back})`;
