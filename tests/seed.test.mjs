import { test } from "node:test";
import assert from "node:assert/strict";
import { seedData, LECTURE_FILES, MODULES } from "../ui/js/seed.js";

test("every LECTURE_FILES key is a seeded lecture, and every lecture has a file", () => {
  const { items } = seedData();
  for (const id of Object.keys(LECTURE_FILES)) assert.ok(items[id], `${id} is not a seeded item`);
  for (const id of Object.keys(items)) assert.ok(LECTURE_FILES[id], `${id} has no file`);
});

test("LECTURE_FILES values are distinct PDF names", () => {
  const files = Object.values(LECTURE_FILES);
  for (const f of files) assert.ok(f.endsWith(".pdf"), `${f} should end in .pdf`);
  assert.equal(new Set(files).size, files.length, "duplicate file name");
});

test("every seeded item belongs to an existing module", () => {
  const { items, modules } = seedData();
  for (const [id, it] of Object.entries(items)) assert.ok(modules[it.module], `${id}: unknown module ${it.module}`);
  assert.equal(new Set(MODULES.map((m) => m.id)).size, MODULES.length);
});

test("seed counts", () => {
  const n = (m) => Object.values(seedData().items).filter((i) => i.module === m).length;
  assert.deepEqual([n("heart"), n("cns"), n("blood"), n("tumor")], [24, 8, 14, 8]);
});

test("exams: eight modules share the 21 December exam; LTK, Pathogenesis and Microscopy have their own", () => {
  const { modules, deadlines } = seedData();
  const combined = ["heart", "cns", "pharma", "pkpd", "blood", "tumor", "kidney", "modelling"];
  for (const id of combined) assert.equal(modules[id].exam, "2026-12-21", id);
  assert.equal(modules.ltk.exam, "2026-12-14");
  assert.equal(modules.patho.exam, "2027-01-08");
  assert.equal(modules.micro.exam, "2027-01-15");
  const exams = Object.values(deadlines).filter(d => d.type === "Exam");
  assert.equal(exams.length, 4);
  for (const d of exams) {
    assert.ok(d.module === null || modules[d.module], d.title);
    if (d.module) assert.equal(d.due, modules[d.module].exam, d.title);
  }
});

test("LTK: 16 one-hour video to-dos, all before the LTK exam", () => {
  const { todo, modules } = seedData();
  const tasks = Object.values(todo.tasks).filter(t => t.project === "ltk");
  assert.equal(tasks.length, 16);
  assert.ok(todo.projects.ltk);
  for (const t of tasks) {
    assert.equal(t.title, "1 hour of LTK videos");
    assert.ok(t.due < modules.ltk.exam && t.due > "2026-11-13", t.due);
    assert.equal(t.done, false);
  }
  assert.equal(new Set(tasks.map(t => t.due)).size, 16);
});
