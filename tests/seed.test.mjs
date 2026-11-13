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
