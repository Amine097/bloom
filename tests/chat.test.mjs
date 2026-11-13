import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chatPrompt, parseChat, formatAnswer, cleanQuestion, chatOf, addExchange, historyFor,
  CHAT_KEEP, Q_MAX, HISTORY_TURNS, HISTORY_CHARS, SUGGESTIONS,
} from "../ui/js/chat-core.js";
import { PDF_TOKEN } from "../ui/js/notebook-core.js";

const ex = (i, a = `Answer ${i}`) => ({ id: `e${i}`, q: `Question ${i}?`, a, pages: [i], at: "2026-11-13" });

test("the prompt carries the PDF placeholder, the title, the rules, the question and the reply shape", () => {
  const p = chatPrompt('Heart "rhythm"', "  What is phase 0?  ");
  assert.equal(p.split(PDF_TOKEN).length, 2);
  assert.ok(p.includes('"Heart \\"rhythm\\""'));
  assert.ok(p.includes("Answer only from this document") && p.includes("does not cover"));
  assert.ok(p.includes("language of the student's question"));
  assert.ok(p.includes("----------\nWhat is phase 0?\n----------"));
  assert.ok(p.includes('{"answer": "...", "pages": [3, 7]}'));
  assert.ok(!p.includes("conversation so far"));
});

test("her text never carries the PDF placeholder", () => {
  const p = chatPrompt("Heart", `Read ${PDF_TOKEN} please`, [{ q: PDF_TOKEN, a: `see ${PDF_TOKEN}` }]);
  assert.equal(p.split(PDF_TOKEN).length, 2);
  assert.ok(p.includes("Read {PDF} please"));
});

test("follow-ups: the prompt holds the last answered exchanges, oldest first", () => {
  const chat = [ex(1), ex(2), { ...ex(3), a: null }, ex(4), ex(5), ex(6)];
  const p = chatPrompt("Heart", "and why is that?", chat);
  assert.ok(p.includes("conversation so far"));
  assert.ok(!p.includes("Question 1?") && !p.includes("Question 3?"), "older and unanswered ones are left out");
  for (const i of [2, 4, 5, 6]) assert.ok(p.includes(`Question ${i}?`) && p.includes(`Answer ${i}`));
  assert.ok(p.indexOf("Question 2?") < p.indexOf("Question 6?"));
  assert.ok(p.indexOf("Question 6?") < p.indexOf("and why is that?"));
});

test("history is capped in turns and in characters", () => {
  const many = Array.from({ length: 10 }, (_, i) => ex(i));
  assert.equal(historyFor(many).length, HISTORY_TURNS);
  const long = Array.from({ length: 4 }, (_, i) => ex(i, "x".repeat(5000)));
  const h = historyFor(long);
  const size = h.reduce((n, x) => n + x.q.length + x.a.length, 0);
  assert.ok(size <= HISTORY_CHARS && h.length >= 1);
  assert.ok(h.every(x => x.a.length <= 1500 && x.a.endsWith("…")));
  assert.equal(h.at(-1).q, "Question 3?", "the newest is kept");
  assert.deepEqual(historyFor([{ q: "a", a: "  " }, { q: "b" }]), []);
});

test("cleanQuestion trims and caps at Q_MAX", () => {
  assert.equal(cleanQuestion("  hi \r\n there  "), "hi \n there");
  assert.equal(cleanQuestion(null), "");
  assert.equal(cleanQuestion("   "), "");
  assert.equal(cleanQuestion("a".repeat(Q_MAX + 50)).length, Q_MAX);
});

test("parseChat reads a good answer, in a fence or with text around it", () => {
  assert.deepEqual(parseChat('{"answer": "Sodium influx.", "pages": [3, 7]}'), { answer: "Sodium influx.", pages: [3, 7] });
  assert.deepEqual(parseChat('Here:\n```json\n{"answer": " A\\r\\nB ", "pages": ["2", 2, 5]}\n```'), { answer: "A\nB", pages: [2, 5] });
  assert.deepEqual(parseChat('{"answer": "Not covered.", "pages": []}'), { answer: "Not covered.", pages: [] });
  assert.deepEqual(parseChat('{"answer": "x"}').pages, []);
  assert.deepEqual(parseChat('{"answer": "x", "pages": 4}').pages, [4]);
});

test("parseChat drops page numbers that are not positive whole numbers", () => {
  assert.deepEqual(parseChat('{"answer": "x", "pages": [0, -2, 1.5, "abc", null, {}, [3], "4", 6]}').pages, [4, 6]);
  assert.deepEqual(parseChat('{"answer": "x", "pages": "three"}').pages, []);
  assert.equal(parseChat(`{"answer": "x", "pages": [${Array.from({ length: 20 }, (_, i) => i + 1)}]}`).pages.length, 8);
});

test("parseChat rejects bad answers with a readable message", () => {
  assert.throws(() => parseChat(""), /empty/);
  assert.throws(() => parseChat("Phase 0 is the sodium upstroke."), /could not be read/);
  assert.throws(() => parseChat("[1, 2]"), /could not be read/);
  assert.throws(() => parseChat('{"pages": [1]}'), /empty/);
  assert.throws(() => parseChat('{"answer": "   ", "pages": [1]}'), /empty/);
  assert.throws(() => parseChat('{"answer": 42}'), /empty/);
});

test("formatAnswer: paragraphs, line breaks and bold", () => {
  assert.equal(formatAnswer("One.\n\nTwo\nlines."), "<p>One.</p><p>Two<br>lines.</p>");
  assert.equal(formatAnswer("The **plateau** is **phase 2**."), "<p>The <strong>plateau</strong> is <strong>phase 2</strong>.</p>");
  assert.equal(formatAnswer("a ** b ** c"), "<p>a ** b ** c</p>");
  assert.equal(formatAnswer("**x"), "<p>**x</p>");
  assert.equal(formatAnswer(""), "");
  assert.equal(formatAnswer(null), "");
});

test("formatAnswer: bullet and numbered lists", () => {
  assert.equal(formatAnswer("Key points:\n- one\n- **two**\n* three"),
    "<p>Key points:</p><ul><li>one</li><li><strong>two</strong></li><li>three</li></ul>");
  assert.equal(formatAnswer("1. first\n2) second\n   goes on\n\nAfter."),
    "<ol><li>first</li><li>second<br>goes on</li></ol><p>After.</p>");
  assert.equal(formatAnswer("3. third\n4. fourth"), '<ol start="3"><li>third</li><li>fourth</li></ol>');
  assert.equal(formatAnswer("- a\n1. b"), "<ul><li>a</li></ul><ol><li>b</li></ol>");
  assert.equal(formatAnswer("- a\nnot an item"), "<ul><li>a</li></ul><p>not an item</p>");
  assert.equal(formatAnswer("1.5 mg is the dose"), "<p>1.5 mg is the dose</p>");
});

test("formatAnswer escapes everything: no HTML from the answer reaches the page", () => {
  const out = formatAnswer('<script>alert("x")</script>\n- <img src=x onerror=alert(1)>\n**<b>bold</b>** & \'q\'');
  assert.ok(!/<script|<img|<b>/i.test(out));
  assert.ok(out.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"));
  assert.ok(out.includes("<li>&lt;img src=x onerror=alert(1)&gt;</li>"));
  assert.ok(out.includes("<strong>&lt;b&gt;bold&lt;/b&gt;</strong> &amp; &#39;q&#39;"));
  const tags = out.match(/<\/?[a-z]+[^>]*>/gi) || [];
  assert.ok(tags.every(t => /^<\/?(p|br|ul|ol|li|strong)(\s+start="\d+")?>$/.test(t)), tags.join(" "));
});

test("chatOf never assumes the field exists and skips malformed exchanges", () => {
  assert.deepEqual(chatOf(undefined), []);
  assert.deepEqual(chatOf({}), []);
  assert.deepEqual(chatOf({ chat: "nope" }), []);
  const good = ex(1);
  assert.deepEqual(chatOf({ chat: [null, 3, { id: "x" }, { q: "no id" }, good] }), [good]);
});

test("addExchange keeps the last CHAT_KEEP and does not change its argument", () => {
  const chat = Array.from({ length: CHAT_KEEP }, (_, i) => ex(i));
  const next = addExchange(chat, ex(99));
  assert.equal(chat.length, CHAT_KEEP);
  assert.equal(next.length, CHAT_KEEP);
  assert.equal(next[0].id, "e1");
  assert.equal(next.at(-1).id, "e99");
  assert.deepEqual(addExchange([], ex(1)), [ex(1)]);
});

test("three suggestions", () => {
  assert.equal(SUGGESTIONS.length, 3);
  assert.ok(SUGGESTIONS.every(s => typeof s === "string" && s.length < 60));
});
