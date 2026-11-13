// Asks the assistant on this Mac, with her own account: Claude Code (the `claude` CLI) or Codex
// (OpenAI's `codex` CLI). Only one ready → that one; both → Claude, and Codex while Claude's usage
// limit lasts (see assistant-core.js). Also sets them up: status, install, sign-in. In the app the
// native shell runs the CLIs; in the browser preview, scripts/preview.mjs answers the status and
// the questions, and setting up is app-only.
import { pdfBlob } from "./files.js";
import { toast } from "./ui.js";
import {
  NAMES, adaptPrompt, checkAnswer, isUsageLimit, limitResetsAt, mergeStatus, runnerFor, isReady, fakeStatus,
} from "./assistant-core.js";

const tauri = window.__TAURI__;

const NO_ASSISTANT = "No assistant is set up on this Mac yet. Set up Claude or Codex in Settings, then try again.";
const NO_CODEX = "Codex is not set up on this Mac yet. Set it up in Settings, then try again.";
const APP_ONLY = "This only works in the installed app.";
const NO_SERVER = "Could not reach the preview server. Is `npm run preview` still running?";

/** Until when (ms) Claude's usage limit lasts; Bloom goes straight to Codex meanwhile. Not saved. */
let limitedUntil = 0;
/** The last merged status and when it was taken, so a run does not check it again at once. */
let last = null, lastAt = 0;
const FRESH_MS = 60_000;

function failure(message) {
  const text = String(message || "Something went wrong with the assistant.");
  if (text === "no-claude") return Object.assign(new Error(NO_ASSISTANT), { code: "no-claude" });
  if (text === "no-codex") return Object.assign(new Error(NO_CODEX), { code: "no-codex" });
  return new Error(text);
}

async function previewJson(url, init) {
  let res;
  try { res = await fetch(url, init); } catch { throw new Error(NO_SERVER); }
  let reply;
  try { reply = await res.json(); } catch { throw new Error(`The preview server gave no answer (HTTP ${res.status}).`); }
  return { res, reply };
}

/** Runs `prompt` (already adapted) on `who`, with the PDF `pdfId` or none. Returns the final text. */
async function runOn(who, pdfId, prompt) {
  if (tauri) {
    try { return await tauri.core.invoke(who === "codex" ? "ask_codex" : "ask_claude", { pdfId, prompt }); }
    catch (e) { throw failure(e?.message ?? e); }
  }
  // body = the prompt (UTF-8) followed by the PDF bytes; `n` says where the prompt ends (equal to
  // the body length: no PDF)
  const head = new TextEncoder().encode(prompt);
  let body = head;
  if (pdfId) {
    try { body = new Blob([head, await pdfBlob(pdfId)]); }
    catch { throw new Error("The PDF of this lecture is missing. Attach it again from Courses."); }
  }
  const { res, reply } = await previewJson(`/api/ask?n=${head.length}&via=${who}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Bloom-Ask": "1" },
    body,
  });
  if (!res.ok || typeof reply.result !== "string") throw failure(reply.error || `HTTP ${res.status}`);
  return reply.result;
}

/** The last status if it is recent, else a new one; null when it cannot be checked. */
async function statusForRun() {
  if (last && Date.now() - lastAt < FRESH_MS) return mergeStatus(last.claude, last.codex, limitedUntil);
  return assistantStatus().catch(() => null);
}

async function ask(pdfId, prompt) {
  const status = await statusForRun();
  const who = runnerFor(status);
  if (!who) throw failure("no-claude");
  const run = name => runOn(name, pdfId, adaptPrompt(prompt, name, Boolean(pdfId))).then(text => checkAnswer(text, name));
  try {
    return await run(who);
  } catch (e) {
    if (who !== "claude" || !isUsageLimit(e?.message)) throw e;
    // Claude's limit is reached: remember it, and ask Codex instead when it is ready
    limitedUntil = limitResetsAt(e.message, new Date());
    if (!isReady(status?.codex)) throw e;
    toast(`${NAMES.claude} has reached its limit: using ${NAMES.codex} for now`);
    return await run("codex");
  }
}

/**
 * Sends `prompt` to the assistant with the PDF readable by it, and returns its final text.
 * The prompt holds the token {{PDF}}, which is replaced by the absolute path of the PDF.
 * Throws an Error she can read; `error.code` is "no-claude" when no assistant is installed.
 */
export const askAboutPdf = (pdfId, prompt) => ask(pdfId, prompt);

/** Sends `prompt` to the assistant with no file attached, and returns its final text. Throws like askAboutPdf(). */
export const askAssistant = prompt => ask(null, prompt);

/** One assistant's raw status from the shell or the preview server; `{ error }` when the check failed. */
async function rawStatus(who) {
  try {
    if (tauri) return await tauri.core.invoke(`${who}_status`);
    const { res, reply } = await previewJson(`/api/${who}-status`, { headers: { "X-Bloom-Ask": "1" } });
    if (!res.ok) throw new Error(reply.error || `HTTP ${res.status}`);
    return reply;
  } catch (e) {
    return { error: failure(e?.message ?? e).message };
  }
}

/**
 * Whether an assistant is ready. `installed` / `loggedIn`: at least one is installed / signed in;
 * `email` and `plan`: those of the one that will be used (Claude only). Also `use` ("claude",
 * "codex" or null), `reason` ("both", "only", "limit", "none"), `limitedUntil` (ms or null) and
 * per assistant `claude: { installed, loggedIn, email, plan }`, `codex: { installed, loggedIn,
 * method }`. Throws only when neither could be checked.
 */
export async function assistantStatus() {
  // Dev aid for the preview, see fakeStatus() in assistant-core.js: e.g.
  // localStorage.bloom_fake_assistant = "limited/ready" shows that state without asking the server
  // (and runs then go where that state sends them).
  let fake = null;
  if (!tauri) {
    try { fake = fakeStatus(localStorage.getItem("bloom_fake_assistant")); } catch { /* storage blocked */ }
  }
  if (fake) {
    if (fake.limited && limitedUntil <= Date.now()) limitedUntil = Date.now() + 60 * 60 * 1000;
    if (!fake.limited && last?.fake) limitedUntil = 0;
    last = { claude: fake.claude, codex: fake.codex, fake: true };
  } else {
    const [claude, codex] = await Promise.all([rawStatus("claude"), rawStatus("codex")]);
    if (claude.error && codex.error) throw new Error(claude.error);
    last = { claude, codex };
  }
  lastAt = Date.now();
  return mergeStatus(last.claude, last.codex, limitedUntil);
}

async function runNative(command) {
  if (!tauri) throw new Error(APP_ONLY);
  try { await tauri.core.invoke(command); }
  catch (e) { throw failure(e?.message ?? e); }
  last = null; // the status changed
}

/** Installs Claude Code with Anthropic's installer. Takes a minute or more. */
export const installClaude = () => runNative("claude_install");
/** Signs in with her Claude subscription in the browser; resolves once the CLI says it is done. */
export const signIn = () => runNative("claude_login");
/** Stops a sign-in started by signIn(). Never fails when none is running. */
export const cancelSignIn = () => runNative("claude_login_cancel");
/** The fallback: opens Terminal, which runs the CLI's own sign-in. */
export const signInWithTerminal = () => runNative("claude_login_terminal");

/** The same four for Codex, by name: `setup.codex.install()` etc.; `setup.claude` is the above. */
export const setup = {
  claude: { install: installClaude, signIn, cancel: cancelSignIn, terminal: signInWithTerminal },
  codex: {
    install: () => runNative("codex_install"),
    signIn: () => runNative("codex_login"),
    cancel: () => runNative("codex_login_cancel"),
    terminal: () => runNative("codex_login_terminal"),
  },
};
