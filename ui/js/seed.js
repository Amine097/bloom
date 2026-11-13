// What a brand-new install starts with: the modules and the lectures known on 13 Nov 2026.
// Only used when there is no data file yet; after that everything is edited in the app.
// A date is given only where the slides themselves carry a teaching date.

export const MODULES = [
  { id: "heart", name: "Heart", color: "rose" },
  { id: "cns", name: "CNS", color: "lavender" },
  { id: "pharma", name: "Pharma", color: "peach" },
  { id: "blood", name: "Blood", color: "coral" },
  { id: "patho", name: "Pathogenesis", color: "mint" },
  { id: "tumor", name: "Tumor Biology", color: "sky" },
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
  add("blood", BLOOD);
  add("tumor", TUMOR);

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
