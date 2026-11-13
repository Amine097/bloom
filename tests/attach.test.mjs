import { test } from "node:test";
import assert from "node:assert/strict";
import * as mod from "../ui/js/attach-core.js";
const { normName, likeness, matchFiles } = mod;

const L = (id, title, pdfName = null) => ({ id, title, pdfName });

test("names are compared without case, accents, punctuation or extension", () => {
  assert.equal(normName("Lecture BCR-ABL1 .pdf"), "lecture bcr abl1");
  assert.equal(normName("Épilepsie_2026.PPTX"), "epilepsie 2026");
});

test("likeness ignores years, filler words and plural endings", () => {
  assert.ok(likeness("Ventricular arrhythmias.pdf", "Ventricular arrhythmia") > 0.9);
  assert.ok(likeness("Schizophrenia_master of science_2026.pdf", "Schizophrenia") > 0.6);
  assert.ok(likeness("Haematopoesis and Stem Cells.pdf", "Hematopoiesis and stem cells") >= 0.6);
  assert.equal(likeness("2026.pdf", "Schizophrenia"), 0);
});

test("an exact original name wins, even when the title says nothing", () => {
  const lectures = [L("heart-14", "Pathophysiology of excitation–contraction coupling"), L("heart-08", "Ventricular arrhythmias")];
  const r = matchFiles([{ name: "ATT00001 (21).pdf" }, { name: "Ventricular arrhythmias.pdf" }], lectures, { "heart-14": "ATT00001 (21).pdf" });
  assert.deepEqual(r, [{ id: "heart-14", how: "known" }, { id: "heart-08", how: "title" }]);
});

test("each lecture gets one file, the closest", () => {
  const lectures = [L("a", "Tumor immunology"), L("b", "Cancer metabolism")];
  const r = matchFiles([{ name: "Tumor immunology.pdf" }, { name: "Tumor immunology copy.pdf" }, { name: "Cancer Metabolism.pdf" }], lectures);
  assert.deepEqual(r.map(x => x.id), ["a", null, "b"]);
});

test("lectures that already have a PDF are left alone", () => {
  const lectures = [L("a", "Tumor immunology", "Tumor immunology.pdf"), L("b", "Metastasis", "old.pdf")];
  const r = matchFiles([{ name: "Tumor immunology.pdf" }, { name: "Metastasis_I_II.pdf" }], lectures, { b: "Metastasis_I_II.pdf" });
  assert.deepEqual(r, [{ id: "a", how: "attached" }, { id: null, how: null }]);
});

test("an unrelated file matches nothing", () => {
  assert.deepEqual(matchFiles([{ name: "CNS_Module_Companion.pdf" }], [L("a", "Schizophrenia"), L("b", "Vascular disorders of the CNS")]), [{ id: null, how: null }]);
  assert.ok(likeness("Metastasis_I_II.pdf", "Metastasis") > 0.9); // a one-word name needs one word
});

test("a file name becomes a tidy lecture title", () => {
  const { titleFromFile } = mod;
  assert.equal(titleFromFile("AI Biomarkers _part 2_2026.pdf"), "AI Biomarkers part 2");
  assert.equal(titleFromFile("Llymphoproliferative and plasma cell disorders - 20261103.pdf"), "Llymphoproliferative and plasma cell disorders");
  assert.equal(titleFromFile("Cancer_treatment_resistance_I_II.pdf"), "Cancer treatment resistance I II");
  assert.equal(titleFromFile("Tumor immunology copy.pdf"), "Tumor immunology");
  assert.equal(titleFromFile("neuromuscular diseases.pdf"), "Neuromuscular diseases");
  assert.equal(titleFromFile("2026.pdf"), "2026");
});

test("a YYYYMMDD in the file name is its date", () => {
  const { dateFromFile } = mod;
  assert.equal(dateFromFile("Llymphoproliferative and plasma cell disorders - 20261103.pdf"), "2026-11-03");
  assert.equal(dateFromFile("Lecture slides 20261006f.pdf"), "2026-10-06");
  assert.equal(dateFromFile("Proteomics_2026.pdf"), null);
  assert.equal(dateFromFile("x 20261399.pdf"), null);
});
