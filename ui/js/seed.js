// What a brand-new install starts with: the modules, their exams and the lectures known on
// 13 Nov 2026, and the LTK video hours as to-dos. Only used when there is no data file yet; after
// that everything is edited in the app. A lecture date is given only where the slides themselves
// carry a teaching date.

const COMBINED_EXAM = "2026-12-21";

// `exam`: the date recalls adapt to. Eight modules share one written exam on 21 December.
export const MODULES = [
  { id: "heart", name: "Heart", color: "rose", exam: COMBINED_EXAM },
  { id: "cns", name: "CNS", color: "lavender", exam: COMBINED_EXAM },
  { id: "pharma", name: "Pharma", color: "peach", exam: COMBINED_EXAM },
  { id: "pkpd", name: "PK/PD", color: "gold", exam: COMBINED_EXAM },
  { id: "blood", name: "Blood", color: "coral", exam: COMBINED_EXAM },
  { id: "tumor", name: "Tumor Biology", color: "sky", exam: COMBINED_EXAM },
  { id: "kidney", name: "Kidney", color: "plum", exam: COMBINED_EXAM },
  { id: "modelling", name: "Modelling", color: "mint", exam: COMBINED_EXAM },
  { id: "ltk", name: "LTK", color: "peach", exam: "2026-12-14" },
  { id: "patho", name: "Pathogenesis", color: "mint", exam: "2027-01-08" },
  { id: "micro", name: "Microscopy", color: "lavender", exam: "2027-01-15" },
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

const BLOOD = [
  ["Haematopoiesis and stem cells"],
  ["Overview of anemias"],
  ["Molecular mechanisms of myelodysplastic syndromes and acute leukemias", "2026-10-26"],
  ["Hemostasis and its regulation", "2026-10-26"],
  ["Next generation sequencing in hematology", "2026-10-27"],
  ["Molecular diagnosis and monitoring of chronic myeloid leukemia", "2026-10-29"],
  ["CML and CLL: pathophysiology and therapeutic approach"],
  ["Myeloproliferative neoplasms: pathophysiology"],
  ["Disorders of hemostasis", "2026-11-02"],
  ["Lymphoproliferative and plasma cell disorders", "2026-11-03"],
  ["Myelodysplasia and acute leukemia: clinical approach", "2026-11-03"],
  ["Thrombophilia and thrombosis"],
  ["Pathophysiology of antibody-mediated diseases in hemostasis"],
  ["Principles of transfusion medicine"],
];

const TUMOR = [
  ["AI biomarkers: part 1", "2026-11-09"],
  ["AI biomarkers: part 2", "2026-11-09"],
  ["Cancer and treatment resistance", "2026-11-09"],
  ["Metastasis", "2026-11-10"],
  ["Autophagy and cancer", "2026-11-11"],
  ["Cancer metabolism", "2026-11-12"],
  ["Proteomics in tumor biology"],
  ["Tumor immunology"],
];

/** Mondays, Tuesdays, Thursdays and Saturdays before the LTK exam: one video hour each. */
const LTK_DAYS = [
  "2026-11-16", "2026-11-17", "2026-11-19", "2026-11-21",
  "2026-11-23", "2026-11-24", "2026-11-26", "2026-11-28",
  "2026-11-30", "2026-12-01", "2026-12-03", "2026-12-05",
  "2026-12-07", "2026-12-08", "2026-12-10", "2026-12-12",
];

export function seedData() {
  const modules = {};
  MODULES.forEach((m, i) => { modules[m.id] = { name: m.name, color: m.color, exam: m.exam || null, order: i }; });

  const items = {};
  const add = (module, list) => list.forEach(([title, date], i) => {
    items[`${module}-${String(i + 1).padStart(2, "0")}`] = {
      kind: "lecture", module, title, week: null, date: date || null, notes: "", order: i,
      seenAt: null, quizzedAt: null, recall1At: null, recall2At: null, recallDue: null, doneAt: null, pdf: null,
    };
  });
  add("heart", HEART);
  add("cns", CNS);
  add("blood", BLOOD);
  add("tumor", TUMOR);

  // the exams, as deadlines; the combined one belongs to no single module (each module above
  // carries its date as its exam)
  const deadlines = {};
  const exam = (id, title, module, due) => { deadlines[id] = { title, module, type: "Exam", due, notes: "", done: false, doneAt: null }; };
  exam("exam-combined", "Combined exam: Blood, Heart, CNS, PK/PD, Pharma, Tumor Biology, Kidney, Modelling", null, COMBINED_EXAM);
  exam("exam-ltk", "LTK exam", "ltk", "2026-12-14");
  exam("exam-patho", "Pathogenesis exam", "patho", "2027-01-08");
  exam("exam-micro", "Microscopy exam", "micro", "2027-01-15");

  // LTK: 20 one-hour videos before the exam, 4 already watched; the other 16 spread over the
  // four weeks before it, four a week
  const projects = { "ltk": { name: "LTK videos", color: "peach", order: 0 } };
  const tasks = {};
  LTK_DAYS.forEach((due, i) => {
    tasks[`ltk-${String(i + 1).padStart(2, "0")}`] = {
      title: "1 hour of LTK videos", notes: "", project: "ltk", parent: null, prio: 4, due, recur: null,
      done: false, doneAt: null, order: i, created: "2026-11-13",
    };
  });

  return {
    version: 4,
    settings: { name: "", semesterStart: "2026-09-14", recall1: 7, recall2: 14, maxRecallsPerDay: 4, theme: "auto", background: "nature", welcomed: false },
    modules,
    items,
    deadlines,
    todo: { projects, tasks },
    planner: {},
    notebook: {},
  };
}

// The original file of each seeded lecture, so "Attach PDFs" can match a folder of slides exactly.
// PowerPoint decks are listed under their PDF name (same base name, ".pdf"): they are converted first.
export const LECTURE_FILES = {
  "heart-01": "Intro heart module.pdf",
  "heart-02": "01_Introduction_2026.pdf",
  "heart-03": "W1.L1 BMSc_Heart_ARRHYTHMIA.pdf",
  "heart-04": "JSR 12th october 2026-1.pdf",
  "heart-05": "JSR 12th october 2026-2.pdf",
  "heart-06": "HRV-MasterBSc2026.pdf",
  "heart-07": "Epidemiology of sudden cardiac death.pdf",
  "heart-08": "Ventricular arrhythmias.pdf",
  "heart-09": "ICD.pdf",
  "heart-10": "02_Valvular Heart Disease_2026.pdf",
  "heart-11": "04_Perfusion_2026.pdf",
  "heart-12": "03_Ischemia and Infarction_2026.pdf",
  "heart-13": "2026HeartMetabolism_WK.pdf",
  "heart-14": "ATT00001 (21).pdf",
  "heart-15": "2026Card_Sig_Day2_1.pdf",
  "heart-16": "2026Card_Sig_Day2_2.pdf",
  "heart-17": "BMS_Heart_Module_Osterwalder_261004_Cardiac Development aamp; Gene Regulation.pdf",
  "heart-18": "Herzmodul_2026.pdf",
  "heart-19": "Lecture slides 20261006f.pdf",
  "heart-20": "cell_culture_techniques 2026.pdf",
  "heart-21": "JSR 13th october 2026.pdf",
  "heart-22": "Extracellular-MasterBSc2026 copy.pdf",
  "heart-23": "BMSc_Optical recording_2026.pdf",
  "heart-24": "Optogenetics 2026.pdf",
  "cns-01": "Vascular disorder of the CNS.pdf",
  "cns-02": "Vincent Pernet-Neurodegenerative diseases-October 2026.pdf",
  "cns-03": "261007_Disorders of Memory and Dementia.pdf",
  "cns-04": "September 2026_Master of medical science Inflammatory disorders of the CNS handout.pdf",
  "cns-05": "neuromuscular diseases.pdf",
  "cns-06": "MBS_Neuropathology_AffDisorders_2026_fin_v4.pdf",
  "cns-07": "Schizophrenia_master of science_2026.pdf",
  "cns-08": "Teaching Ub Msc BioMed 2026 small.pdf",
  "blood-01": "Haematopoesis and Stem Cells.pdf",
  "blood-02": "Overview of Anemias.pdf",
  "blood-03": "Molecular Mechanisms of Myelodysplastic Syndromes and Acute Leukemias.pdf",
  "blood-04": "Hemostasis Regulation.pdf",
  "blood-05": "Next Generation Sequencing Data Analysis in Diagnostics.pdf",
  "blood-06": "Lecture BCR-ABL1 .pdf",
  "blood-07": "CML and CLL pathophysiology and therapeutic approach_SM.pdf",
  "blood-08": "Myeloproliferative neoplasms.pdf",
  "blood-09": "Disorders of hemostasis_2026.pdf",
  "blood-10": "Llymphoproliferative and plasma cell disorders - 20261103.pdf",
  "blood-11": "AML.pdf",
  "blood-12": "Thrombophilia and Thrombosis.pdf",
  "blood-13": "Pathophysiology of antibody mediated diseases in hemostasis.pdf",
  "blood-14": "Transfusion Medicine.pdf",
  "tumor-01": "AI Biomarkers part 1.pdf",
  "tumor-02": "AI Biomarkers _part 2_2026.pdf",
  "tumor-03": "Cancer_treatment_resistance_I_II.pdf",
  "tumor-04": "Metastasis_I_II.pdf",
  "tumor-05": "Breast Cancer Autophagy.pdf",
  "tumor-06": "Cancer Metabolism.pdf",
  "tumor-07": "Proteomics_2026.pdf",
  "tumor-08": "Tumor immunology.pdf",
};
