import { test } from "node:test";
import assert from "node:assert/strict";
import { normName, likeness, matchFiles } from "../ui/js/attach-core.js";

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
