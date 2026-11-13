// What a brand-new install starts with: the modules and the lectures known on 11 Nov 2026.
// Only used when there is no data file yet; after that everything is edited in the app.
// A date is given only where the slides themselves carry a teaching date.

export const MODULES = [
  { id: "heart", name: "Heart", color: "rose" },
  { id: "cns", name: "CNS", color: "lavender" },
  { id: "pharma", name: "Pharma", color: "peach" },
  { id: "blood", name: "Blood", color: "coral" },
  { id: "patho", name: "Pathogenesis", color: "mint" },
];

const HEART = [
  ["Introduction: module \"Heart\""],
  ["Introduction to cardiac disease"],
  ["Cardiac arrhythmia mechanisms"],
  ["Genetic mutations and drugs affecting electrical function", "2026-10-12"],
  ["Principles of drug therapy: ion-channel drugs", "2026-10-12"],
  ["Heart rate variability and the autonomic nervous system"],
  ["Epidemiology of sudden cardiac death"],
  ["Ventricular arrhythmias"],
  ["Implantable cardioverter defibrillator"],
  ["Valvular heart disease"],
  ["Tissue perfusion"],
  ["Ischemia and infarction"],
  ["Energy metabolism of the heart", "2026-09-25"],
  ["Pathophysiology of excitation–contraction coupling"],
  ["Cardiac signalling: the hypertrophied heart", "2026-10-08"],
  ["Cardiac signalling: the failing heart", "2026-10-08"],
  ["Cardiac development & gene regulation", "2026-10-05"],
  ["From cardiac repair to regeneration", "2026-10-13"],
  ["The isolated, perfused heart", "2026-10-06"],
  ["Cell culture techniques & cell engineering"],
  ["Microelectrode and patch-clamp recordings", "2026-10-13"],
  ["Extracellular electrical recording"],
  ["Optical recording of electrical activity"],
  ["Optogenetics (slides + 2 videos)"],
];

const CNS = [
  ["Vascular disorders of the CNS"],
  ["Neurodegenerative diseases of the CNS", "2026-10-08"],
  ["Disorders of memory and dementia", "2026-10-07"],
  ["Inflammatory disorders in the CNS"],
  ["Neuromuscular disorders"],
  ["Neuropathology: affective disorders", "2026-10-07"],
  ["Schizophrenia", "2026-10-12"],
  ["Sleep, sleep disorders and the nervous system", "2026-10-27"],
];

export function seedData() {
  const modules = {};
  MODULES.forEach((m, i) => { modules[m.id] = { name: m.name, color: m.color, exam: null, order: i }; });

  const items = {};
  const add = (module, list) => list.forEach(([title, date], i) => {
    items[`${module}-${String(i + 1).padStart(2, "0")}`] = {
      kind: "lecture", module, title, week: null, date: date || null, notes: "", order: i,
      seenAt: null, quizzedAt: null, recall1At: null, recall2At: null, recallDue: null, doneAt: null, pdf: null,
    };
  });
  add("heart", HEART);
  add("cns", CNS);

  return {
    version: 3,
    settings: { name: "", semesterStart: "2026-09-14", recall1: 7, recall2: 14, maxRecallsPerDay: 4, theme: "auto", background: "nature", welcomed: false },
    modules,
    items,
    deadlines: {},
    todo: { projects: {}, tasks: {} },
    planner: {},
    notebook: {},
  };
}
