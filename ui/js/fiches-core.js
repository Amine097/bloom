// Study sheets ("fiches"), without the screen: their shape, the options of a new one, the two
// prompts Claude Code gets (read and ask, then write) and the readers of its answers. Pure, covered
// by tests/fiches.test.mjs. The tab is views/fiches.js; running Claude and the fiche's files are in
// fiche-run.js; laying a fiche out in A4 pages is fiche-render.js.
//
// D.fiches[id] = {
//   title, createdAt, updatedAt,          ISO date-times
//   source: "generated" | "uploaded",
//   modules: [module ids],                the module(s) it covers; a module may have any number of fiches
//   uploaded only:
//   pdf: { id, name, size, addedAt },     her own PDF, stored by files.js like a lecture's (item.pdf shape)
//   generated only (Claude writes it in its own folder, fiches/<id>/ beside the data file; only
//   this metadata is in D):
//   lectures: [lecture ids],              in the order she ticked them
//   keys: { lectureId: "KEY" },           the short name of each lecture in the sheet ("[KEY 13]")
//   slides: { KEY: page count },          known once the PDFs are copied into the folder
//   options: { pages: number | null (Auto), precision, organisation, include: { mcq, summary, profq,
//              draw, basics }, diagrams, language },   see OPTIONS below
//   notes: "",                            what she wrote for Claude before it started
//   status: "reading" | "questions" | "writing" | "done" | "stopped" | "failed",
//           reading: Claude reads the PDFs (phase 1); questions: it asked, she has not answered yet;
//           writing: phase 2; stopped: phase 2 ended early (Continue); failed: phase 1 did not finish
//   questions: [{ id, q, options: [text], default: index }],   Claude's questions (possibly none)
//   answers: { questionId: option index },
//   wrote: true once phase 2 has started (a new run then continues from the files already there),
//   startedAt: ISO date-time of the current or last run, or null,
//   error: text she can read, or null,
//   pages: number of A4 pages once laid out, or null
//   both:
//   quiz: its question bank, the same shape as a lecture's (notebook-core.js, quiz-core.js) plus
//         `cursor`: the fiche page the next questions start from (see ficheWindow); absent until
//         the first questions are written. In quizzes a fiche stands as the source "fiche:<id>"
//         (sources.js), beside lecture ids, in D.quizLog too.
// }
import { myNotesBlock, withMyNotes } from "./mynotes-core.js";

export const MIN_PAGES = 2, MAX_PAGES = 150;

/** Claude Code for a fiche: long, many turns, may read anything but writes only inside its folder
 *  (acceptEdits approves edits in the working folder; Write/Edit elsewhere would need a prompt,
 *  which -p refuses). Same list as FICHE_ARGS in src-tauri/src/lib.rs. */
export const FICHE_ARGS = ["-p", "--output-format", "json", "--no-session-persistence", "--strict-mcp-config",
  "--tools", "Read,Write,Edit,Glob", "--allowedTools", "Read,Glob", "--permission-mode", "acceptEdits",
  "--max-turns", "400", "--effort", "high"];
export const FICHE_TIMEOUT_MS = 3 * 60 * 60 * 1000;

export const PRECISIONS = [
  { id: "everything", label: "Everything", hint: "Every piece of information (100%)" },
  { id: "essentials", label: "The essentials", hint: "The most important (about 80%)" },
  { id: "revision", label: "Revision sheet", hint: "Condensed, for revising" },
  { id: "emergency", label: "Emergency sheet", hint: "The bare minimum, right before the exam" },
];
export const ORGANISATIONS = [
  { id: "topic", label: "By topic", hint: "Big blocks in a logical order, a chapter per lecture roughly" },
  { id: "lecture", label: "One chapter per lecture", hint: "In the order of the lectures" },
  { id: "professor", label: "The professors' order", hint: "Slide by slide, as taught" },
];
export const INCLUDES = [
  { id: "mcq", label: "Self-test MCQs", hint: "answers at the end", on: true },
  { id: "summary", label: "Chapter summaries", on: true },
  { id: "profq", label: "The professors' questions, answered", on: true },
  { id: "basics", label: "Refreshers of basics and maths", on: true },
  { id: "draw", label: "\"How to draw\" guides for key curves", on: false },
];
export const DIAGRAMS = [
  { id: "both", label: "Redrawn + slide captures" },
  { id: "captures", label: "Slide captures only" },
  { id: "none", label: "None" },
];
export const LANGUAGES = [{ id: "en", label: "English" }, { id: "fr", label: "French" }];

export const DEFAULT_OPTIONS = Object.freeze({
  pages: null, precision: "essentials", organisation: "topic", diagrams: "both", language: "en",
  include: Object.freeze(Object.fromEntries(INCLUDES.map(i => [i.id, i.on]))),
});

const ids = list => list.map(x => x.id);
const oneOf = (v, list, fallback) => (ids(list).includes(v) ? v : fallback);

/** Options as stored: anything missing or unknown takes its default. */
export function normOptions(o = {}) {
  const pages = Number(o?.pages);
  const include = {};
  for (const i of INCLUDES) include[i.id] = typeof o?.include?.[i.id] === "boolean" ? o.include[i.id] : i.on;
  return {
    pages: Number.isFinite(pages) && pages > 0 ? Math.min(MAX_PAGES, Math.max(MIN_PAGES, Math.round(pages))) : null,
    precision: oneOf(o?.precision, PRECISIONS, DEFAULT_OPTIONS.precision),
    organisation: oneOf(o?.organisation, ORGANISATIONS, DEFAULT_OPTIONS.organisation),
    diagrams: oneOf(o?.diagrams, DIAGRAMS, DEFAULT_OPTIONS.diagrams),
    language: oneOf(o?.language, LANGUAGES, DEFAULT_OPTIONS.language),
    include,
  };
}

/** Slides per A4 page of the sheet, by precision: the "Auto" length. */
const SLIDES_PER_PAGE = { everything: 9, essentials: 13, revision: 25, emergency: 50 };

/** The length "Auto" stands for, from the number of slides. */
export function autoPages(precision, slides) {
  const per = SLIDES_PER_PAGE[precision] || SLIDES_PER_PAGE.essentials;
  return Math.min(MAX_PAGES, Math.max(MIN_PAGES, Math.round((Number(slides) || 0) / per)));
}

const STOP = new Set(["a", "an", "and", "the", "of", "in", "on", "to", "for", "with", "from", "by", "at", "its", "into", "how", "what", "part", "lecture", "introduction", "intro"]);

/**
 * A short, distinct key per lecture, as the sheet's slide references use ("[ICD 13]"): the
 * title's acronym when it has one (ICD, HRV), else the first four letters of its first real word
 * ("Ventricular arrhythmias" → "Vent"). `lectures` is [{ id, title }]. → { id: key }
 */
export function lectureKeys(lectures) {
  const out = {}, used = new Set();
  for (const { id, title } of lectures) {
    const words = String(title || "").normalize("NFKD").replace(/[^\w\s-]/g, " ").split(/[\s_-]+/).filter(Boolean);
    const acro = words.find(w => /^[A-Z][A-Z0-9]{1,5}$/.test(w) && !/^(BMSC?|MSC|PDF|PPT|W\d+|L\d+)$/.test(w));
    const real = words.filter(w => /[a-z]/i.test(w) && !STOP.has(w.toLowerCase()) && !/^\d/.test(w));
    const cap = w => w[0].toUpperCase() + w.slice(1, 4).toLowerCase();
    let key = acro || (real[0] ? cap(real[0]) : "L");
    key = key.replace(/[^A-Za-z0-9]/g, "").slice(0, 6) || "L";
    if (used.has(key) && real[1]) key = (key + real[1][0].toUpperCase()).slice(0, 7);
    let k = key, n = 2;
    while (used.has(k)) k = key + n++;
    used.add(k);
    out[id] = k;
  }
  return out;
}

/** The modules of these lectures, without repeats, in the order of `lectureIds`. */
export function modulesOf(lectureIds, items) {
  const out = [];
  for (const id of lectureIds) {
    const m = items?.[id]?.module;
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}

// ---- the words Bloom adds to a sheet, in its two languages

export const LABELS = {
  en: {
    def: "Definition", mech: "Mechanism", clin: "Clinical", num: "Numbers to know", meth: "Method", math: "Maths",
    prof: "Professor's question", trap: "MCQ trap", warn: "Slides disagree", added: "Added explanation (not on the slides)",
    takehome: "Take-home messages", draw: "How to draw it", summary: "Chapter summary — read this the night before",
    contents: "Contents", part: "Part", keyFigures: "Key figures of this chapter", selftest: "Test yourself (MCQ)",
    answers: "Answers to the MCQs", howto: "How to use this companion", colourCode: "Colour code",
    lectureIndex: "Lecture index", toolbox: "Maths toolbox", minor: "Also mentioned (low priority):",
    objectives: "Learning objectives (from the slides):", key: "key", file: "file", pages: "p.",
    indexCols: ["Key", "Lecture", "Lecturer", "Chapter", "File"], mustKnow: "Must know",
    legend: ["= high priority (in the lecturer's learning objectives or take-home messages)", "bold purple", "= a number to know", "link", "= the same topic in another chapter", "Also mentioned (low priority):", "= on the slides, unlikely to be asked."],
    code: {
      def: ["term", "A definition to know word for word."],
      mech: ["process", "How or why something happens (pathophysiology, signalling)."],
      clin: ["topic", "Symptoms, diagnosis, treatment, guidelines."],
      num: ["topic", "Thresholds, percentages, trial results."],
      meth: ["technique", "Experimental and diagnostic techniques."],
      math: ["formula", "Formulas, explained step by step."],
      prof: ["", "A question printed on a slide, with its answer from the slides."],
      trap: ["", "A classic confusion that MCQs like to test."],
      warn: ["", "Two slides (or lectures) contradict each other; what to retain."],
      added: ["", "An explanation that is not on the slides, added only to help understanding."],
      draw: ["", "How to draw a key curve or diagram, step by step."],
    },
  },
  fr: {
    def: "Définition", mech: "Mécanisme", clin: "Clinique", num: "Chiffres à retenir", meth: "Méthode", math: "Maths",
    prof: "Question du professeur", trap: "Piège QCM", warn: "Les diapositives se contredisent", added: "Explication ajoutée (pas sur les diapositives)",
    takehome: "À retenir", draw: "Comment le dessiner", summary: "Résumé du chapitre — à relire la veille",
    contents: "Table des matières", part: "Partie", keyFigures: "Figures clés du chapitre", selftest: "Testez-vous (QCM)",
    answers: "Réponses aux QCM", howto: "Comment utiliser ce document", colourCode: "Code couleur",
    lectureIndex: "Index des cours", toolbox: "Boîte à outils de maths", minor: "Également mentionné (secondaire) :",
    objectives: "Objectifs d'apprentissage (des diapositives) :", key: "clé", file: "fichier", pages: "p.",
    indexCols: ["Clé", "Cours", "Enseignant", "Chapitre", "Fichier"], mustKnow: "À savoir absolument",
    legend: ["= priorité haute (dans les objectifs ou les messages à retenir)", "violet gras", "= un chiffre à retenir", "lien", "= le même sujet dans un autre chapitre", "Également mentionné (secondaire) :", "= sur les diapositives, peu susceptible d'être demandé."],
    code: {
      def: ["terme", "Une définition à connaître mot pour mot."],
      mech: ["processus", "Comment ou pourquoi cela se produit (physiopathologie, signalisation)."],
      clin: ["sujet", "Symptômes, diagnostic, traitement, recommandations."],
      num: ["sujet", "Seuils, pourcentages, résultats d'essais."],
      meth: ["technique", "Techniques expérimentales et diagnostiques."],
      math: ["formule", "Formules, expliquées pas à pas."],
      prof: ["", "Une question posée sur une diapositive, avec sa réponse tirée des diapositives."],
      trap: ["", "Une confusion classique que les QCM aiment tester."],
      warn: ["", "Deux diapositives (ou cours) se contredisent ; ce qu'il faut retenir."],
      added: ["", "Une explication qui n'est pas sur les diapositives, ajoutée seulement pour aider à comprendre."],
      draw: ["", "Comment dessiner une courbe ou un schéma clé, pas à pas."],
    },
  },
};
export const labelsFor = lang => LABELS[lang] || LABELS.en;

/** Box types Claude may use, in the order of the colour code. */
export const BOX_TYPES = ["def", "mech", "clin", "num", "meth", "math", "prof", "trap", "warn", "added", "takehome", "draw", "summary"];

// ---- the prompts

/** The markup Claude writes; Bloom's stylesheet (ui/fiche.css) gives it the look of the LaTeX fiches. */
export const MARKUP = `FORMAT
(KEY below stands for a lecture's key from the list above, e.g. its slide references are <cite>KEY 13</cite>.)
Every file you write is a fragment of HTML: no <html>, <head>, <style>, <script>, no style attributes, no colours or fonts of your own (except inside SVG drawings), no images or links. Bloom lays the files out in A4 pages with its own stylesheet, which gives the sheet its whole look. Use only these elements and classes.

Chapter files (ch01.html, ch02.html, ...), one chapter each:
<div class="part">Electrical activity and arrhythmias</div>   optional, just before the <h1> of the first chapter of a part (a big block); Bloom numbers the parts
<h1>Chapter title</h1>   first, once per file; Bloom numbers the chapters
<div class="lecture" data-lecture="KEY" data-who="L. Roten" data-when="12.10.2026">Lecture title, as on its first slide</div>   right after the <h1>, one per lecture the chapter covers (professor and date from the slides; leave data-who / data-when empty when the slides do not say)
<p class="objectives">the learning objectives from the slides</p>   optional (Bloom writes the label)
<h2>Section</h2>, <h3>Subsection</h3>   Bloom numbers them (6.1, 6.1.1)
<p>, <ul>/<ol> with <li>, <table> with <thead> and <tbody> (short cells), <b>, <i>, <sub>, <sup>, <br>
Inline marks:
  <cite>KEY 13</cite>   the slide a fact comes from: the lecture's KEY and the PDF page number as the PDF viewer shows it ("13–15", "2–3,18"). Several: <cite>SCD 4</cite><cite>ICD 6–8</cite>. Put one after every fact or group of facts; say in which slides each big notion is introduced.
  <span class="must"></span>   a star: high priority (in the learning objectives or take-home messages of the lecturer)
  <span class="num">84%</span>   a number to know
  <dfn>term</dfn>   a key term in running text
  <span class="see">Ch. 3 (channelopathies)</span>   a cross-reference to another chapter or lecture
  <p class="minor">...</p>   an "Also mentioned (low priority):" line (Bloom writes the label)
Boxes: <div class="box TYPE"><h4>short title <cite>KEY 5</cite></h4> ...content... </div>
  The <h4> is optional; Bloom writes the box's name before it ("Definition: short title"). TYPE is one of:
  def        a definition to know word for word
  mech       a mechanism or pathophysiology: how and why
  clin       clinical: symptoms, diagnosis, treatment, guidelines
  num        numbers and thresholds, percentages, trial results
  meth       an experimental or diagnostic method
  math       a formula, explained step by step: every symbol, then a worked example with numbers
  prof       a question printed on a slide, answered from the slides (h4 e.g. "(slide 45)")
  trap       a classic confusion that MCQs like to test
  warn       two slides or lectures contradict each other: say which, and what to retain
  added      an explanation that is NOT on the slides. Anything from outside the slides goes in such a box, and only there.
  takehome   take-home messages of a lecture or section (its h4 replaces the default title)
  draw       how to draw a key curve or diagram: axes, steps in order, landmarks and values to label
  summary    the chapter summary, at the end of the chapter: <p><b>In one paragraph.</b> ...</p><h5>Must know</h5><ul>...</ul>
Formulas: <var>p</var> for a variable, <span class="frac"><span>p × r</span><span>2h</span></span> for a fraction, <div class="eq">σ = <span class="frac">...</span></div> for a formula on its own line. Write symbols in Unicode (→ ↑ ↓ ≤ ≥ ≈ × ± µ Δ α β σ).
Key figures, at the end of a chapter (before its summary and MCQs):
<section class="figures">
  <figure class="slide" data-lecture="KEY" data-page="9" data-width="0.32">short caption <cite>KEY 9</cite></figure>
      Bloom puts the image of that PDF page there. data-width = its share of the line (0.24 to 1); figures fill rows left to right.
  <figure class="drawn" data-width="0.48"><svg viewBox="0 0 400 240">...</svg><figcaption>short caption</figcaption></figure>
      a simple diagram you redraw yourself as SVG (no <image>, no <script>, no links)
</section>
Self-test, at the very end of a chapter:
<section class="selftest">
  <div class="mcq" data-answer="B"><p>Question?</p><ol><li>option A</li><li>option B</li><li>option C</li><li>option D</li></ol><p class="why">one-line explanation <cite>KEY 5</cite></p></div>
  ...
</section>
  Four options, one right answer (data-answer = its letter); vary its position. Bloom numbers the questions (Q3.1, Q3.2...), sets them in two columns and gathers the answers and explanations in "Answers to the MCQs" at the end of the sheet.

front.html (the front matter):
<header class="titlepage"><h1>Main title (e.g. The Heart)</h1><p class="subtitle">Module "Heart" — revision sheet</p><p class="course">Master of Science in Biomedical Sciences, University of Bern, autumn 2026</p><p class="topics">the main themes · separated · by middle dots</p><p class="built">Built from the N slide decks of ... Source tags such as <cite>KEY 13</cite> give the PDF page number as shown in the PDF viewer.</p><p class="running">Heart module — revision sheet</p></header>
   (class "running" = the short text at the top right of every page)
<section class="howto"><p>How to use this sheet, in a few lines.</p></section>
<section class="toolbox"><div class="box math"><h4>...</h4>...</div>...</section>   the maths toolbox, only when the sheet needs maths
<p class="notcovered">Not covered (no slides provided): ...</p>   optional
Bloom adds the colour code, the lecture index (from your lecture cards), the table of contents and the answers to the MCQs itself: do not write them.

SVG drawings use only these colours: Plum #5B1E4F, Raspberry #B0225A, Fuchsia #C8177A, Lavender #5E46A0, Lilac #8650B5, Orchid #9C2F9A, Powder #C04D73, Mauve #8A6787, Ink #2E2230, Grey #85707D, and the light fills #F5ECF3 #FBE9EF #FDE7F2 #EEEAF8 #F2ECFA #F3EFF2; no font-family (the sheet's font is used); text 10-13 units high in a viewBox about 400 wide.`;

const PRECISION_TEXT = {
  everything: "Everything (100%). Every piece of information on the slides goes into the sheet: every fact, number, case, trial, figure and mechanism, each explained. Nothing is left out; what matters little still appears, briefly, in an \"Also mentioned\" line.",
  essentials: "The essentials (about 80%). Keep everything important or likely to be examined, well explained. Drop the details of little value; at most name them in an \"Also mentioned\" line.",
  revision: "Revision sheet. Condensed, to revise from: the key concepts, the mechanisms in a few steps, the numbers to know and the classic traps, as short bullet points, compact boxes and summary tables. Explain only what is hard to understand, in a sentence or two. No long prose, no case stories, no \"Also mentioned\" lines.",
  emergency: "Emergency sheet. The bare minimum to cram right before the exam: only the must-know definitions, each mechanism in one line, the numbers to know and the classic traps. Mostly bullet points and one summary table per chapter, no explanations beyond a few words, at most one or two key figures in the whole sheet.",
};

const ORGANISATION_TEXT = {
  topic: "Organise it by topic, which need not be the professors' order: big blocks (parts) in a logical order (physiology before pathology, basics before applications), roughly one chapter per lecture inside them, cross-references between lectures, and synthesis chapters or tables for what recurs across lectures.",
  lecture: "One chapter per lecture, in the order of the table above; cross-references between them, and one short synthesis chapter at the end when several lectures share topics.",
  professor: "Follow the professors' order: one chapter per lecture, in the order of the table above, and inside each chapter the order of the slides.",
};

const MCQ_COUNT = { everything: "8 to 12", essentials: "6 to 10", revision: "4 to 6", emergency: "3" };

function includeLines(o) {
  const inc = o.include, out = [];
  out.push(inc.mcq
    ? `- Self-test: end each chapter with ${MCQ_COUNT[o.precision]} MCQs (section "selftest"), testing understanding as well as facts.`
    : "- No MCQs.");
  out.push(inc.summary
    ? "- A summary at the end of each chapter (box \"summary\": the chapter in one paragraph, then the must-know points)."
    : "- No chapter summaries.");
  out.push(inc.profq
    ? "- When a slide asks a question (the professor's question), answer it from the slides in a box \"prof\"."
    : "- Professors' questions printed on slides need no box of their own.");
  out.push(inc.basics
    ? "- Refreshers: when a chapter relies on basics she may have forgotten (physiology, chemistry, statistics, maths), add a short refresher (box \"added\", or \"math\" for maths), and gather the maths the sheet uses in a maths toolbox in front.html. She is not strong in maths: introduce every formula, explain each symbol in words, and give a worked example with numbers."
    : "- No refreshers of basics; still explain any formula in a sentence.");
  if (inc.draw) out.push("- For each key curve or diagram she may have to draw at the exam (an action potential, a pressure–volume loop...), a box \"draw\": the axes, the steps in order, the landmarks and the values to label.");
  return out.join("\n");
}

const DIAGRAM_TEXT = {
  both: "Diagrams: analyse the important diagrams of the slides carefully (open the PDF pages to see them). At the end of each chapter, a section \"figures\" shows them: complex ones as slide captures (figure class \"slide\"), simple ones redrawn as SVG in the sheet's colours (figure class \"drawn\"). Explain in the text what each one shows.",
  captures: "Diagrams: analyse the important diagrams of the slides carefully (open the PDF pages to see them). At the end of each chapter, a section \"figures\" shows them as slide captures only (figure class \"slide\"); no SVG drawings. Explain in the text what each one shows.",
  none: "Diagrams: none in the sheet (no section \"figures\", no SVG); describe in words what the important diagrams show.",
};

function lectureTable(lectures) {
  return lectures.map(l => `- ${l.key}: "${l.title}"${l.module ? ` (module ${l.module})` : ""}, file slides/${l.key}.pdf${l.pages ? `, ${l.pages} pages` : ""}, text slides/${l.key}.txt`).join("\n");
}

function settingsLines(o, slides) {
  const target = o.pages
    ? `about ${o.pages} A4 pages in the final layout (stay within 15% of it)`
    : `as long as the content needs at this precision; as a guide, about ${autoPages(o.precision, slides)} A4 pages`;
  return [
    `- Precision: ${PRECISION_TEXT[o.precision]}`,
    `- Length: ${target}. One A4 page holds about 550 words of running text, fewer with boxes and tables; a row of three slide captures takes about a quarter of a page. The count is the whole sheet: the title page, the contents and the rest of front.html count too, and every chapter starts on a new page. For a short sheet (under about 15 pages), keep front.html to the title page, a few lines on how to use it and the colour code, with no maths toolbox (put a needed formula in its chapter instead), and use few chapters.`,
    `- Organisation: ${ORGANISATION_TEXT[o.organisation]}`,
    includeLines(o),
    `- ${DIAGRAM_TEXT[o.diagrams]}`,
    `- Language: ${o.language === "fr"
      ? "write the sheet in French (keep the English technical terms of the slides in brackets the first time they appear)."
      : "write the sheet in English."}`,
  ].join("\n");
}

const notesBlock = notes => (String(notes || "").trim()
  ? `\nHer notes for you (follow them; they win over the settings above when they disagree):\n"""\n${String(notes).trim()}\n"""\n` : "");

/**
 * Phase 1: read every PDF, write plan.md, and ask her real questions only. `lectures` is
 * [{ key, title, module, pages }]; `slides` their total page count. The answer is JSON (parseQuestions).
 */
export function questionsPrompt({ lectures, options, notes = "", slides = 0 }) {
  const o = normOptions(options);
  return `You are preparing a study sheet ("fiche") for Sarra, who studies an MSc in Biomedical Sciences at the University of Bern. She prints it and reads it next to the slides, so it must be complete for what she asked, very well organised and easy to follow. You will write it in a second step; now you only read and prepare.

The lectures, in this folder (everything you need is in this folder; do not look elsewhere):
${lectureTable(lectures)}
For each lecture, slides/<its key>.txt (for example slides/${lectures[0]?.key}.txt) holds the text of its PDF slides/<its key>.pdf page by page: "--- Page n ---" starts PDF page n. These ${lectures.length} lecture${lectures.length === 1 ? " is" : "s are"} all there is. Read every text file in full. Open the PDF itself (Read, with the pages you need) wherever figures, diagrams, tables or images matter or the text of a page is thin.

What she asked for:
${settingsLines(o, slides)}
${notesBlock(notes)}
Then:
1. Write plan.md in this folder: the chapter plan you would follow (parts, chapters, which lectures and pages each one covers, synthesis chapters), each lecture's professor and date when the slides give them, the contradictions between slides you noticed, numbers that look wrong, and what is missing (a lecture referred to but not provided...). Keep it compact: you will rely on it when you write.
2. Decide whether you have real questions for her: only ones whose answer changes the sheet (a missing lecture, a structure choice, which of two contradictory slides to follow, how deep to go on something ambiguous). Never ask what her settings or notes already answer, never ask for the sake of it: no questions at all is normal. At most 6. Each one is multiple choice with 2 to 4 short options, and a default: the option you would choose without her answer. Write the questions in English.

Reply with only this JSON, nothing else:
{"questions":[{"id":"q1","q":"the question","options":["first option","second option"],"default":0}]}
or {"questions":[]} when you have none.`;
}

/**
 * Phase 2: write the sheet into files in this folder, keeping progress.json. `answers` pairs each
 * question with her choice: [{ q, answer }]. `resume`: a run stopped before, continue from the files.
 */
export function writePrompt({ lectures, options, notes = "", slides = 0, answers = [], resume = false }) {
  const o = normOptions(options);
  const answered = answers.length
    ? `\nYou asked her some questions after reading the slides; her answers:\n${answers.map(a => `- ${a.q} → ${a.answer}`).join("\n")}\n` : "";
  const cont = resume
    ? `\nCONTINUE: an earlier run stopped before the end. The files already in this folder are your own work. Read progress.json and plan.md, keep the chapters marked done (re-read one only when you need it), check that the last chapter file you were writing is complete (it may be cut off; rewrite it if so), then go on from there. Do not start again from scratch.\n` : "";
  return `You are writing a study sheet ("fiche") for Sarra, who studies an MSc in Biomedical Sciences at the University of Bern. She prints it (A4) and annotates it on paper while she reads the slides as PDFs next to it; later she revises from it alone. Take all the time you need: quality and completeness matter more than speed.

The lectures, in this folder (everything you need is in this folder; read and write only inside it):
${lectureTable(lectures)}
For each lecture, slides/<its key>.txt (for example slides/${lectures[0]?.key}.txt) holds the text of its PDF slides/<its key>.pdf page by page: "--- Page n ---" starts PDF page n. Read the text files, and open the PDFs (Read, with the pages you need) for figures, diagrams and tables. plan.md, if present, is the plan you made after a first reading: use it.

What she asked for:
${settingsLines(o, slides)}
${answered}${notesBlock(notes)}
Rules for the content:
- Faithful to the slides: within the precision she chose, no information missing. Nothing from outside the slides, except to explain something, and then only inside a box "added" (grey, "not on the slides").
- Very well organised and easy to follow; complicated concepts explained clearly and simply; no glossary.
- Slide references everywhere (<cite>KEY page</cite>, PDF page numbers), so she can find each fact in the PDF.
- A consistent colour code: use the box types for what they mean (definition, mechanism, clinical, numbers, method, maths, professor's question, MCQ trap, slides that disagree, added explanation). Mark the high-priority points with the star and the numbers to know as numbers.
- When two slides or lectures disagree, say so in a box "warn" with what to retain.
- Correct medical and scientific content; check every number against the slides.

${MARKUP}

How to work:
1. First write progress.json (and keep it up to date after every chapter):
   {"chapters":[{"file":"ch01.html","title":"Chapter title","done":false}],"doing":"what you are doing now, in a few words","done":false}
   Bloom shows it to her while you work.
2. Write the chapters one file at a time (ch01.html, ch02.html, ... in reading order), each in one Write (or a few Edits), then mark it done in progress.json.
3. Write front.html.
4. Read your files once more: fix mistakes, missing references, broken HTML, inconsistent numbering of parts. Then set "done": true in progress.json.
${cont}
When everything is written, reply with one short sentence saying what the sheet contains.`;
}

// ---- reading Claude's answers

/** The first JSON object in `text` (Claude may wrap it in a code fence or a sentence), or null. */
function firstJson(text) {
  const s = String(text ?? "");
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === "\"") inStr = false;
    } else if (c === "\"") inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try { return JSON.parse(body.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

/** Claude's phase-1 answer → [{ id, q, options, default }] (possibly empty). Throws when unreadable. */
export function parseQuestions(text) {
  const data = firstJson(text);
  if (!data || !Array.isArray(data.questions)) throw new Error("Claude's answer could not be read. Try again.");
  const out = [], seen = new Set();
  for (const x of data.questions) {
    const q = typeof x?.q === "string" ? x.q.trim() : "";
    const options = Array.isArray(x?.options) ? x.options.filter(o => typeof o === "string" && o.trim()).map(o => o.trim()).slice(0, 5) : [];
    if (!q || options.length < 2) continue;
    let id = typeof x.id === "string" && /^[\w-]{1,20}$/.test(x.id) ? x.id : `q${out.length + 1}`;
    while (seen.has(id)) id += "x";
    seen.add(id);
    const d = Number(x.default);
    out.push({ id, q, options, default: Number.isInteger(d) && d >= 0 && d < options.length ? d : 0 });
    if (out.length === 6) break;
  }
  return out;
}

/** The pairs the writing prompt gets: each question with the option she chose (or its default). */
export function answerPairs(questions, answers = {}) {
  return (questions || []).map(x => {
    const k = Number.isInteger(answers?.[x.id]) && answers[x.id] >= 0 && answers[x.id] < x.options.length ? answers[x.id] : x.default;
    return { q: x.q, answer: x.options[k] };
  });
}

/** progress.json as Claude keeps it → { chapters: [{ file, title, done }], doing, done }, or null. */
export function parseProgress(text) {
  let data;
  try { data = JSON.parse(String(text ?? "")); } catch { data = firstJson(text); }
  if (!data || typeof data !== "object") return null;
  const chapters = (Array.isArray(data.chapters) ? data.chapters : [])
    .filter(c => c && typeof c === "object")
    .map(c => ({ file: typeof c.file === "string" ? c.file : "", title: typeof c.title === "string" ? c.title : "", done: c.done === true }));
  return { chapters, doing: typeof data.doing === "string" ? data.doing.slice(0, 200) : "", done: data.done === true };
}

/** The chapter files among a folder's file names, in order (ch1.html, ch02.html, ch10.html...). */
export function chapterFiles(names) {
  return (names || [])
    .filter(n => /^ch\d{1,3}[\w-]*\.html$/i.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]) || a.localeCompare(b));
}

/** "<cite>" text → { key, page } of its first page ("SCD 2–3,18" → SCD, 2), or null. */
export function citeTarget(text) {
  const m = String(text ?? "").trim().match(/^([A-Za-z][\w-]{0,11})\s*[\s.,:]\s*(?:p\.?\s*|slides?\s*)?(\d{1,4})/i);
  return m ? { key: m[1], page: Number(m[2]) } : null;
}

/** Pages of text → the "--- Page n ---" form of pdf_text. */
export const asPageText = pages => pages.map((t, i) => `\n--- Page ${i + 1} ---\n${t}`).join("");

/** "1 h 05 min", "12 min", "40 s". */
export function fmtElapsed(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/** Fiches grouped by module for the list: [{ module, fiches: [[id, fiche]] }], newest first in each
 *  group; a fiche covering several modules is listed under each; those without a module come last. */
export function groupByModule(fiches, moduleOrder) {
  const groups = new Map(moduleOrder.map(m => [m, []]));
  const none = [];
  const entries = Object.entries(fiches || {}).sort(([, a], [, b]) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  for (const [id, f] of entries) {
    const ms = (f.modules || []).filter(m => groups.has(m));
    if (!ms.length) none.push([id, f]);
    for (const m of ms) groups.get(m).push([id, f]);
  }
  const out = [...groups].filter(([, l]) => l.length).map(([module, l]) => ({ module, fiches: l }));
  if (none.length) out.push({ module: null, fiches: none });
  return out;
}

/** Id of a fiche or file: letters and digits only (it names a folder). */
export const isSafeId = id => typeof id === "string" && /^[A-Za-z0-9]{1,40}$/.test(id);

// ---- quizzes over a fiche
//
// A fiche can be long (a 100-page companion is far more text than one prompt should carry), so
// each time Claude writes questions it gets one window of pages, and the next time the window
// after it: over a few rounds the questions cover the whole fiche.

/** Most characters of fiche text in one prompt. */
export const FICHE_QUIZ_CHARS = 90_000;

/**
 * The window of `pages` ([{ n, text }], as pagesOf() in pdftext-core.js reads them) the next
 * questions are written from: it starts at page `cursor` (back to the first page past the end) and
 * takes pages while they fit in `maxChars` (at least one). → { from, to, next } in page numbers,
 * `next` being the cursor after it; null when there are no pages.
 */
export function ficheWindow(pages, cursor = 1, maxChars = FICHE_QUIZ_CHARS) {
  if (!pages?.length) return null;
  let i = pages.findIndex(p => p.n >= (Number(cursor) || 1));
  if (i === -1) i = 0;
  let j = i, size = 0;
  while (j < pages.length && (j === i || size + pages[j].text.length <= maxChars)) size += pages[j++].text.length;
  const last = pages[j - 1].n;
  return { from: pages[i].n, to: last, next: j < pages.length ? pages[j].n : 1 };
}

/**
 * `prompt` (a Notebook quiz prompt, which opens by asking to read a lecture PDF) turned into one on
 * the pages `from`..`to` of fiche `title`, whose text is given in full: no file to read.
 * `pages`: [{ n, text }] of those pages. `myNotes`: her notes and marks on the uploaded fiche's PDF
 * ("Use my notes", notesPages of mynotes-core.js); only those on these pages are given, just before
 * the reply shape. Absent or empty leaves the prompt as without them.
 */
export function ficheQuizPrompt(prompt, title, pages, total, myNotes = null) {
  const doc = pages.map(p => `--- Page ${p.n} ---\n${p.text.replace(/<\/?document>/gi, "").replace(/\{\{PDF\}\}/g, "{PDF}")}`).join("\n\n");
  const from = pages[0]?.n ?? 1, to = pages.at(-1)?.n ?? from;
  const part = total > to - from + 1 ? ` (pages ${from} to ${to} of ${total}: write the questions on these pages only)` : "";
  const intro = `This document is the student's study sheet (a "fiche") called ${JSON.stringify(String(title || "Untitled"))}, made from several lectures. Here is its text${part}, page by page ("--- Page n ---" starts page n of the sheet):
<document>
${doc}
</document>
Everything you need is above: do not use any tool. Cover these pages from the first to the last.`;
  const mine = myNotes?.length
    ? myNotesBlock(myNotes.filter(p => p.page >= from && p.page <= to), { what: "question", themes: /"themes": \[/.test(String(prompt)) }) : "";
  return withMyNotes(prompt, mine)
    .split("\n")
    .filter(l => !/^The lecture is called /.test(l) && !/^Read the whole document\./.test(l))
    .map(l => (/^Use the Read tool to read the lecture PDF/.test(l) ? intro : l))
    .join("\n")
    .replace("Page numbers are the page numbers of the PDF file: the first page of the file is page 1.", "Page numbers are those of the sheet, as given by the \"--- Page n ---\" marks.");
}
