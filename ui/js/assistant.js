// Asks Claude Code (the `claude` CLI on this Mac, with her own account) about a lecture PDF.
// In the app the native shell runs it; in the browser preview, scripts/preview.mjs does.
import { pdfBlob } from "./files.js";

const tauri = window.__TAURI__;

const NO_CLAUDE = "Claude Code is not installed on this Mac. Install it, open Terminal, run `claude` once and sign in, then try again.";

function failure(message) {
  const text = String(message || "Something went wrong while asking Claude.");
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
