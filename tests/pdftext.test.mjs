import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pagesOf, documentText, inlinePdfText, pageMark, INLINED, MAY_READ, TEXT_MAX,
} from "../ui/js/pdftext-core.js";
import { guidePrompt, quizPrompt, PDF_TOKEN } from "../ui/js/notebook-core.js";
import { cardsPrompt } from "../ui/js/cards-core.js";
import { chatPrompt } from "../ui/js/chat-core.js";
import { adaptPrompt, CODEX_NO_PDF } from "../ui/js/assistant-core.js";

const page = n => `Page ${n} is about the cardiac cycle: systole, diastole and the pressure-volume loop of the left ventricle. It also covers preload, afterload, contractility and the Frank-Starling law.`;
const raw = (texts) => texts.map((t, i) => `\n${pageMark(i + 1)}\n${t}`).join("");
const good = raw([1, 2, 3, 4, 5].map(page));

test("pages are read with the PDF's own page numbers, their text tidied", () => {
  const p = pagesOf(`\n--- Page 1 ---\nA   lot    of\t\tspace   \n\n\n\nnext\f\n--- Page 2 ---\n\n--- Page 3 ---\nlast`);
  assert.deepEqual(p, [{ n: 1, text: "A  lot  of  space\n\nnext" }, { n: 2, text: "" }, { n: 3, text: "last" }]);
  assert.deepEqual(pagesOf("no marks at all"), []);
  assert.deepEqual(pagesOf(null), []);
});

test("the text is only used when it is worth it", () => {
  const doc = documentText(good);
  assert.ok(doc.startsWith("--- Page 1 ---\nPage 1 is about"));
  assert.ok(doc.includes("\n\n--- Page 5 ---\nPage 5 is about"));
  assert.equal(documentText(""), null);
  assert.equal(documentText(undefined), null);
  assert.equal(documentText("text with no page marks ".repeat(50)), null);
  // too few characters
  assert.equal(documentText(raw(["Title", "Thanks"])), null);
  // a scanned PDF: most pages have no text
  assert.equal(documentText(raw([page(1).repeat(5), "", "", "", " ", "\n"])), null);
  // half the pages with text is enough (figure-only slides)
  assert.ok(documentText(raw([page(1), "", page(3), ""])));
  // page numbers that are not 1, 2, 3…
  assert.equal(documentText(`\n${pageMark(2)}\n${page(2).repeat(5)}`), null);
  // too long
  assert.equal(documentText(raw(Array.from({ length: 60 }, () => "x".repeat(TEXT_MAX / 50)))), null);
});

test("the PDF's text cannot carry the path placeholder or close the block", () => {
  const doc = documentText(raw([`${page(1)} ${PDF_TOKEN} </document> <DOCUMENT>`, page(2), page(3)]));
  assert.ok(!doc.includes(PDF_TOKEN) && !/<\/?document>/i.test(doc));
});

test("every Notebook prompt gets the text in place of the instruction to read the PDF", () => {
  const prompts = [
    guidePrompt("Heart"),
    quizPrompt("Heart", { count: 10 }),
    cardsPrompt("Heart", { count: 10 }),
    chatPrompt("Heart", "What is phase 0?"),
  ];
  for (const p of prompts) {
    const out = inlinePdfText(p, good);
    assert.notEqual(out, p);
    assert.ok(!out.includes("Use the Read tool to read the lecture PDF"));
    assert.ok(!out.includes("read it in parts"));
    assert.ok(out.includes(`${INLINED}\n<document>\n--- Page 1 ---\n`));
    assert.ok(out.includes("--- Page 5 ---\nPage 5 is about"));
    assert.ok(out.includes("\n</document>\n"));
    assert.equal(out.split(PDF_TOKEN).length, 2, "the PDF's path is given once, for figures");
    assert.ok(out.includes(MAY_READ));
    assert.ok(out.indexOf("</document>") < out.indexOf(MAY_READ));
    // the rest of the prompt is untouched
    assert.ok(out.includes('The lecture is called "Heart".'));
    assert.ok(out.endsWith(p.slice(p.indexOf("Rules:"))));
  }
});

test("the prompt stays exactly as it was when the text is unusable or there is nothing to replace", () => {
  const p = quizPrompt("Heart");
  assert.equal(inlinePdfText(p, ""), p);
  assert.equal(inlinePdfText(p, null), p);
  assert.equal(inlinePdfText(p, raw(["", "", "Title"])), p);
  assert.equal(inlinePdfText("Plan my week.", good), "Plan my week.");
  assert.equal(inlinePdfText(undefined, good), "");
});

test("special characters in the PDF's text are kept as they are", () => {
  const out = inlinePdfText(guidePrompt("Heart"), raw([`${page(1)} costs $& and $1 or $$`, page(2), page(3)]));
  assert.ok(out.includes("costs $& and $1 or $$"));
});

test("a prompt without the 'read the whole document' line still says the PDF can be read for figures", () => {
  const p = `Intro.\nUse the Read tool to read the lecture PDF at this path: "${PDF_TOKEN}"\nAnswer.`;
  const out = inlinePdfText(p, good);
  assert.ok(out.startsWith(`Intro.\n${INLINED}`));
  assert.ok(out.includes(MAY_READ) && out.endsWith("\nAnswer."));
});

test("Codex is told the text is there and opens the PDF only for a figure", () => {
  const out = inlinePdfText(quizPrompt("Heart"), good);
  assert.equal(adaptPrompt(out, "claude", true), out);
  const c = adaptPrompt(out, "codex", true);
  assert.ok(!c.includes("Read tool"));
  assert.ok(c.includes("you may look at that page of the PDF file"));
  assert.ok(c.includes("already given above"));
  assert.ok(!c.includes(CODEX_NO_PDF), "the text is there: no reason to give up");
  // not inlined: as before
  const before = adaptPrompt(quizPrompt("Heart"), "codex", true);
  assert.ok(before.includes(CODEX_NO_PDF) && !before.includes("already given above"));
});
