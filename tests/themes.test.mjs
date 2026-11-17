import { test } from "node:test";
import assert from "node:assert/strict";
import {
  THEMES, THEME_KEYS, DEFAULT_THEMES, themeOf, cleanThemes, isClassified, matchesThemes, unclassified,
  themesBlock, classifyPrompt, readClassification, questionText, cardText,
} from "../ui/js/themes-core.js";

test("eight themes, each with a key, a chip label, a full label and a line for Claude", () => {
  assert.deepEqual(THEME_KEYS, ["basic", "molecular", "pathology", "clinical", "epidemiology", "pharmacology", "trials", "modelling"]);
  for (const t of THEMES) for (const f of ["key", "short", "label", "about"]) assert.ok(typeof t[f] === "string" && t[f], `${t.key}.${f}`);
  assert.equal(themeOf("trials").label, "Clinical trials & research");
  assert.equal(themeOf("nope"), null);
});

test("the defaults are basic sciences, molecular mechanisms, pathology and pharmacology", () => {
  assert.deepEqual([...DEFAULT_THEMES], ["basic", "molecular", "pathology", "pharmacology"]);
  assert.ok(Object.isFrozen(DEFAULT_THEMES));
});

test("cleanThemes keeps valid keys once, in theme order, ignoring case and spaces", () => {
  assert.deepEqual(cleanThemes(["Pharmacology", " basic ", "basic", "cardiology", 3, null]), ["basic", "pharmacology"]);
  assert.deepEqual(cleanThemes("trials"), ["trials"]);
  assert.deepEqual(cleanThemes(undefined), []);
  assert.deepEqual(cleanThemes({ basic: true }), []);
});

test("matchesThemes: a ticked theme matches, an unclassified item matches anything, no filter matches all", () => {
  const x = { themes: ["clinical", "trials"] };
  assert.equal(matchesThemes(x, ["trials"]), true);
  assert.equal(matchesThemes(x, ["basic", "molecular"]), false);
  assert.equal(matchesThemes({}, ["basic"]), true);
  assert.equal(matchesThemes({ themes: [] }, ["basic"]), true);
  assert.equal(matchesThemes(x, null), true);
  assert.equal(isClassified(x), true);
  assert.equal(isClassified({ themes: [] }), false);
  assert.deepEqual(unclassified([x, { id: 2 }, null, { id: 3, themes: [] }]).map(y => y.id), [2, 3]);
  assert.deepEqual(unclassified(undefined), []);
});

test("themesBlock lists the ticked themes to write on and the others to leave out", () => {
  const b = themesBlock(["trials"], "question");
  assert.match(b, /Write questions only on these themes/);
  const [yes, no] = b.split("Do not write questions on these themes");
  assert.match(yes, /"trials" \(Clinical trials & research\)/);
  assert.doesNotMatch(yes, /"basic"/);
  for (const k of THEME_KEYS.filter(k => k !== "trials")) assert.match(no, new RegExp(`"${k}" \\(`));
  assert.match(b, /"themes" lists the keys/);
  // every theme ticked: nothing to leave out
  assert.doesNotMatch(themesBlock(THEME_KEYS, "card"), /Do not write/);
  assert.match(themesBlock(THEME_KEYS, "card"), /Write cards only/);
  assert.equal(themesBlock(null), "");
});

test("classifyPrompt lists every item with its id and asks for { id: [keys] }, without a file", () => {
  const p = classifyPrompt([{ id: "a1", text: "What is a QT interval?\n (answer: x)" }, { id: "b2", text: "Which trial?" }], "question");
  assert.match(p, /"a1": What is a QT interval\? \(answer: x\)/);
  assert.match(p, /"b2": Which trial\?/);
  for (const k of THEME_KEYS) assert.match(p, new RegExp(`"${k}"`));
  assert.match(p, /\{"id": \["key"\]\}/);
  assert.doesNotMatch(p, /\{\{PDF\}\}/);
});

test("readClassification keeps known ids with valid keys, under the reply or under \"themes\"", () => {
  const got = readClassification({ a: ["Pathology", "x"], b: [], c: ["basic"], z: ["trials"] }, ["a", "b", "c"]);
  assert.deepEqual([...got], [["a", ["pathology"]], ["c", ["basic"]]]);
  assert.deepEqual([...readClassification({ themes: { a: ["trials"] } }, ["a"])], [["a", ["trials"]]]);
  assert.equal(readClassification(null, ["a"]).size, 0);
  assert.equal(readClassification([], ["a"]).size, 0);
});

test("the text classified is the question with its right answer, or both sides of a card", () => {
  assert.equal(questionText({ q: "Q?", options: ["a", "b", "c", "d"], answer: 2 }), "Q? (answer: c)");
  assert.equal(cardText({ front: "F", back: "B" }), "F (answer: B)");
});
