import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CODEX_ARGS, CODEX_NO_PDF, LIMIT_FALLBACK_MS, adaptPrompt, checkAnswer, isUsageLimit, limitResetsAt,
  chooseAssistant, mergeStatus, runnerFor, readCodexLogin, readCodexEvents, fakeStatus,
} from "../ui/js/assistant-core.js";
import { guidePrompt, PDF_TOKEN } from "../ui/js/notebook-core.js";

const ready = { installed: true, loggedIn: true };
const signedOut = { installed: true, loggedIn: false };
const missing = { installed: false };

test("the choice: only one ready → that one; both → Claude, or Codex while Claude's limit lasts", () => {
  const now = 1_000_000;
  assert.deepEqual(chooseAssistant(ready, missing, 0, now), { use: "claude", reason: "only" });
  assert.deepEqual(chooseAssistant(signedOut, ready, 0, now), { use: "codex", reason: "only" });
  assert.deepEqual(chooseAssistant(ready, ready, 0, now), { use: "claude", reason: "both" });
  assert.deepEqual(chooseAssistant(ready, ready, now + 1, now), { use: "codex", reason: "limit" });
  assert.deepEqual(chooseAssistant(ready, ready, now, now), { use: "claude", reason: "both" }, "the limit is over");
  // Claude limited but Codex not ready: Claude still runs and shows its own limit message
  assert.deepEqual(chooseAssistant(ready, signedOut, now + 1, now), { use: "claude", reason: "only" });
  assert.deepEqual(chooseAssistant(signedOut, missing, 0, now), { use: null, reason: "none" });
  assert.deepEqual(chooseAssistant({ installed: false, loggedIn: true }, missing), { use: null, reason: "none" });
});

test("real-looking usage-limit messages are recognised", () => {
  for (const m of [
    "Claude Code: You've hit your 5-hour limit · resets 1am (Europe/Zurich)",
    "You’ve hit your weekly limit · resets Mon 9am (Europe/Zurich)",
    "Claude Code: You've hit your Opus limit · resets Nov 17, 3pm (Europe/Zurich)",
    "You've hit your limit · resets 4:30pm",
    "5-hour limit reached ∙ resets 1am",
    "Weekly limit reached ∙ resets Oct 9, 9am",
    "Claude Code: Claude AI usage limit reached|1736323200",
    "Claude usage limit reached. Your limit will reset at 1am (Europe/Zurich).",
    "You've reached your usage limit for this period.",
  ]) assert.ok(isUsageLimit(m), m);
});

test("ordinary errors do not count as the usage limit", () => {
  for (const m of [
    "Claude Code: Invalid API key · Please run /login",
    "Claude Code: API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}",
    "Claude Code: API Error: 429 This request would exceed the rate limit for your organization",
    "Claude needed more steps than allowed (the PDF may be very long). Try again.",
    "Claude Code: Prompt is too long",
    "Claude's response exceeded the 32000 output token maximum.",
    "Claude took longer than 5 minutes and was stopped. Try again.",
    "Claude Code did not answer (exit code 1). ENOTFOUND api.anthropic.com",
    "The PDF of this lecture is missing. Attach it again from Courses.",
    "",
    undefined,
  ]) assert.ok(!isUsageLimit(m), String(m));
});

test("the reset time is read from the message, in local time", () => {
  const now = new Date(2026, 10, 13, 22, 15); // Friday 13 Nov 2026, 22:15
  const at = (...a) => new Date(...a).getTime();
  assert.equal(limitResetsAt("You've hit your 5-hour limit · resets 1am (Europe/Zurich)", now), at(2026, 10, 14, 1, 0));
  assert.equal(limitResetsAt("resets 11:30pm", now), at(2026, 10, 13, 23, 30));
  assert.equal(limitResetsAt("resets 12am", now), at(2026, 10, 14, 0, 0));
  assert.equal(limitResetsAt("You've hit your weekly limit · resets Mon 9am (Europe/Zurich)", now), at(2026, 10, 16, 9, 0));
  assert.equal(limitResetsAt("resets Fri 9am", now), at(2026, 10, 20, 9, 0), "today's 9am is past: next week");
  assert.equal(limitResetsAt("Weekly limit reached ∙ resets Nov 17, 3pm", now), at(2026, 10, 17, 15, 0));
  assert.equal(limitResetsAt("Your limit will reset at 23:00", now), at(2026, 10, 13, 23, 0));
  const epoch = Math.floor(now.getTime() / 1000) + 3600;
  assert.equal(limitResetsAt(`Claude AI usage limit reached|${epoch}`, now), epoch * 1000);
});

test("an unreadable or implausible reset time falls back to an hour", () => {
  const now = new Date(2026, 10, 13, 22, 15);
  const hour = now.getTime() + LIMIT_FALLBACK_MS;
  assert.equal(limitResetsAt("You've hit your usage limit", now), hour);
  assert.equal(limitResetsAt("resets 25pm", now), hour);
  assert.equal(limitResetsAt("Claude AI usage limit reached|1000000000", now), hour, "in the past");
  assert.equal(limitResetsAt("resets Dec 31, 9am", now), hour, "more than 8 days away");
});

test("the merged status keeps installed / loggedIn as 'at least one' and says which is used", () => {
  const now = 5000;
  const claude = { installed: true, loggedIn: true, email: "s@x.ch", plan: "pro" };
  const codex = { installed: true, loggedIn: true, method: "ChatGPT" };
  const both = mergeStatus(claude, codex, 0, now);
  assert.equal(both.installed, true);
  assert.equal(both.loggedIn, true);
  assert.equal(both.use, "claude");
  assert.equal(both.email, "s@x.ch");
  assert.equal(both.plan, "pro");
  assert.equal(both.limitedUntil, null);
  assert.deepEqual(both.codex, { installed: true, loggedIn: true, method: "ChatGPT" });

  const limited = mergeStatus(claude, codex, now + 10, now);
  assert.equal(limited.use, "codex");
  assert.equal(limited.reason, "limit");
  assert.equal(limited.limitedUntil, now + 10);
  assert.equal(limited.email, null);

  const none = mergeStatus({ installed: false }, { installed: true, loggedIn: false }, 0, now);
  assert.deepEqual([none.installed, none.loggedIn, none.use], [true, false, null]);
  const nothing = mergeStatus({ installed: false }, { installed: false }, 0, now);
  assert.deepEqual([nothing.installed, nothing.loggedIn], [false, false]);

  // a failed check counts as not installed, and keeps its message
  const failed = mergeStatus({ error: "timed out" }, codex, 0, now);
  assert.equal(failed.use, "codex");
  assert.equal(failed.claude.error, "timed out");
  assert.equal(failed.claude.installed, false);
  // signed in without being installed makes no sense
  assert.equal(mergeStatus({ installed: false, loggedIn: true }, {}, 0, now).loggedIn, false);
});

test("which assistant runs a request when none is ready", () => {
  assert.equal(runnerFor(null), "claude");
  assert.equal(runnerFor(mergeStatus(ready, ready)), "claude");
  assert.equal(runnerFor(mergeStatus(signedOut, signedOut)), "claude");
  assert.equal(runnerFor(mergeStatus(missing, signedOut)), "codex");
  assert.equal(runnerFor(mergeStatus(missing, missing)), null);
});

test("prompts: unchanged for Claude, adapted for Codex", () => {
  const p = guidePrompt("Heart");
  assert.equal(adaptPrompt(p, "claude", true), p);
  const c = adaptPrompt(p, "codex", true);
  assert.ok(!c.includes("Read tool"));
  assert.ok(c.includes(`Read the lecture PDF at this path: "${PDF_TOKEN}"`));
  assert.ok(c.includes(CODEX_NO_PDF) && c.includes("pdftotext"));
  const plain = adaptPrompt("Plan my week.", "codex", false);
  assert.equal(plain, "Plan my week.");
  assert.throws(() => checkAnswer(` ${CODEX_NO_PDF}\n`, "codex"), /could not read this PDF/);
  assert.equal(checkAnswer("{}", "codex"), "{}");
  assert.equal(checkAnswer(CODEX_NO_PDF, "claude"), CODEX_NO_PDF);
});

test("codex login status is read from its text and exit code", () => {
  assert.deepEqual(readCodexLogin("Logged in using ChatGPT\n", 0), { installed: true, loggedIn: true, method: "ChatGPT" });
  assert.deepEqual(readCodexLogin("Logged in using an API key - sk-proj-***ABCD", 0), { installed: true, loggedIn: true, method: "API key" });
  assert.deepEqual(readCodexLogin("Not logged in\n", 1), { installed: true, loggedIn: false, method: null });
  assert.deepEqual(readCodexLogin("Not logged in", 0), { installed: true, loggedIn: false, method: null });
  assert.deepEqual(readCodexLogin("Error loading config.toml", 1), { installed: true, loggedIn: false, method: null });
});

test("the Codex answer is the last agent message of the JSON events", () => {
  const lines = [
    { type: "thread.started", thread_id: "x" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "thinking" } },
    { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "pdftotext a.pdf -" } },
    { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "I will read it." } },
    { type: "item.completed", item: { id: "item_3", type: "agent_message", text: " {\"capital\":\"Bern\"} " } },
    { type: "turn.completed", usage: { input_tokens: 1 } },
  ].map(e => JSON.stringify(e)).join("\n");
  assert.equal(readCodexEvents(lines, 0, ""), "{\"capital\":\"Bern\"}");
  assert.equal(readCodexEvents(`warning: something\n${lines}\n`, 0), "{\"capital\":\"Bern\"}");
  assert.ok(CODEX_ARGS.includes("--json") && CODEX_ARGS.at(-1) === "-");
});

test("Codex errors become readable messages", () => {
  const ev = (...e) => e.map(x => JSON.stringify(x)).join("\n");
  assert.throws(() => readCodexEvents(ev({ type: "turn.started" },
    { type: "turn.failed", error: { message: "You've hit your usage limit. Try again at Nov 14th, 2026 1:00 AM." } }), 1),
  /^Error: Codex: You've hit your usage limit/);
  assert.throws(() => readCodexEvents(ev({ type: "thread.started" }, { type: "error", message: "401 Unauthorized" }), 1), /Codex: 401 Unauthorized/);
  assert.throws(() => readCodexEvents("", 1, "Error: not logged in\n"), /Codex did not answer \(exit code 1\)\. Error: not logged in/);
  assert.throws(() => readCodexEvents(ev({ type: "turn.started" }, { type: "turn.completed" }), 0), /answer was empty/);
  // a passing stream error does not hide an answer that came after it
  assert.equal(readCodexEvents(ev({ type: "error", message: "Reconnecting... 1/5" },
    { type: "item.completed", item: { type: "agent_message", text: "ok" } }), 0), "ok");
});

test("the preview's fake states", () => {
  assert.equal(fakeStatus(null), null);
  assert.equal(fakeStatus("ready"), null);
  assert.equal(fakeStatus("ready/maybe"), null);
  const legacy = fakeStatus("missing");
  assert.deepEqual([legacy.claude.installed, legacy.codex.installed], [false, false]);
  const out = fakeStatus("signedout");
  assert.deepEqual([out.claude.loggedIn, out.codex.loggedIn, out.codex.installed], [false, false, true]);
  const lim = fakeStatus("limited/ready");
  assert.equal(lim.limited, true);
  assert.equal(mergeStatus(lim.claude, lim.codex, 10, 0).use, "codex");
  const mix = fakeStatus("missing/ready");
  assert.equal(mergeStatus(mix.claude, mix.codex).use, "codex");
  assert.equal(fakeStatus("Ready/SignedOut").codex.loggedIn, false);
});
