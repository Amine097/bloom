// Asks Claude Code (the `claude` CLI on this Mac, with her own account) about a lecture PDF, and
// sets it up: status, install, sign-in. In the app the native shell runs it; in the browser
// preview, scripts/preview.mjs answers the status and the questions, and setting up is app-only.
import { pdfBlob } from "./files.js";

const tauri = window.__TAURI__;

const NO_CLAUDE = "Claude is not set up on this Mac yet. Set it up in Settings, then try again.";
const APP_ONLY = "This only works in the installed app.";

function failure(message) {
  const text = String(message || "Something went wrong with Claude.");
  if (text === "no-claude") return Object.assign(new Error(NO_CLAUDE), { code: "no-claude" });
  return new Error(text);
}

/**
 * Sends `prompt` to Claude Code with the PDF readable by it, and returns Claude's final text.
 * The prompt holds the token {{PDF}}, which is replaced by the absolute path of the PDF.
 * Throws an Error she can read; `error.code` is "no-claude" when the CLI cannot be found.
 */
export async function askAboutPdf(pdfId, prompt) {
  if (tauri) {
    try { return await tauri.core.invoke("ask_claude", { pdfId, prompt }); }
    catch (e) { throw failure(e?.message ?? e); }
  }

  let pdf;
  try { pdf = await pdfBlob(pdfId); }
  catch { throw new Error("The PDF of this lecture is missing. Attach it again from Courses."); }
  // body = the prompt (UTF-8) followed by the PDF bytes; `n` says where the prompt ends
  const head = new TextEncoder().encode(prompt);
  let res;
  try {
    res = await fetch(`/api/ask?n=${head.length}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Bloom-Ask": "1" },
      body: new Blob([head, pdf]),
    });
  } catch {
    throw new Error("Could not reach the preview server. Is `npm run preview` still running?");
  }
  let reply;
  try { reply = await res.json(); }
  catch { throw new Error(`The preview server gave no answer (HTTP ${res.status}).`); }
  if (!res.ok || typeof reply.result !== "string") throw failure(reply.error || `HTTP ${res.status}`);
  return reply.result;
}

const statusOf = s => ({
  installed: Boolean(s?.installed),
  loggedIn: Boolean(s?.installed && s?.loggedIn),
  email: typeof s?.email === "string" && s.email ? s.email : null,
  plan: typeof s?.plan === "string" && s.plan ? s.plan : null,
});

/** Whether Claude Code is installed and signed in: `{ installed, loggedIn, email, plan }`. */
export async function assistantStatus() {
  if (tauri) {
    try { return statusOf(await tauri.core.invoke("claude_status")); }
    catch (e) { throw failure(e?.message ?? e); }
  }
  // Dev aid for the preview: localStorage.bloom_fake_assistant = "missing" or "signedout" shows that
  // state (to look at the Settings card and the Notebook warning) without asking the server.
  let fake = null;
  try { fake = localStorage.getItem("bloom_fake_assistant"); } catch { /* storage blocked */ }
  if (fake === "missing") return statusOf({ installed: false });
  if (fake === "signedout") return statusOf({ installed: true, loggedIn: false });

  let res;
  try { res = await fetch("/api/claude-status", { headers: { "X-Bloom-Ask": "1" } }); }
  catch { throw new Error("Could not reach the preview server. Is `npm run preview` still running?"); }
  let reply;
  try { reply = await res.json(); }
  catch { throw new Error(`The preview server gave no answer (HTTP ${res.status}).`); }
  if (!res.ok) throw failure(reply.error || `HTTP ${res.status}`);
  return statusOf(reply);
}

async function runNative(command) {
  if (!tauri) throw new Error(APP_ONLY);
  try { await tauri.core.invoke(command); }
  catch (e) { throw failure(e?.message ?? e); }
}

/** Installs Claude Code with Anthropic's installer. Takes a minute or more. */
export const installClaude = () => runNative("claude_install");
/** Signs in with her Claude subscription in the browser; resolves once the CLI says it is done. */
export const signIn = () => runNative("claude_login");
/** Stops a sign-in started by signIn(). Never fails when none is running. */
export const cancelSignIn = () => runNative("claude_login_cancel");
/** The fallback: opens Terminal, which runs the CLI's own sign-in. */
export const signInWithTerminal = () => runNative("claude_login_terminal");
