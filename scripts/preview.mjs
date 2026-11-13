// Serves ui/ on http://localhost:4173 so the interface can be developed in a normal browser.
// It also answers POST /api/ask, which runs the local Claude Code CLI on a lecture PDF, the way the
// native shell does in the app (see ask_claude in src-tauri/src/lib.rs), and GET /api/claude-status.
import { createServer } from "node:http";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_ARGS, PDF_TOKEN, readEnvelope } from "../ui/js/notebook-core.js";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "ui");
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
const port = Number(process.env.PORT) || 4173;
const MAX_BODY = 160 * 1024 * 1024;
const TIMEOUT_MS = 5 * 60 * 1000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("That PDF is too large.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Runs `claude` in `cwd` with the prompt on stdin; resolves with Claude's text. */
function runClaude(cwd, prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", CLAUDE_ARGS, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "", err = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", c => { out += c; });
    child.stderr.on("data", c => { err += c; });
    child.on("error", e => {
      clearTimeout(timer);
      reject(e.code === "ENOENT" ? Object.assign(new Error("no-claude"), { code: "no-claude" }) : e);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error("Claude took longer than 5 minutes and was stopped. Try again."));
      try { resolve(readEnvelope(out, code ?? 1, err)); } catch (e) { reject(e); }
    });
    child.stdin.on("error", () => { /* reported through the exit code */ });
    child.stdin.end(prompt);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Only the page served here may use the API: a custom header forces a CORS preflight, which is never granted. */
function allowed(req) {
  const host = String(req.headers.host || "");
  return req.headers["x-bloom-ask"] === "1" && /^(localhost|127\.0\.0\.1):\d+$/.test(host);
}

/** Runs `claude auth status`; same shape as claude_status in src-tauri/src/lib.rs. */
function claudeStatus() {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["auth", "status"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", c => { out += c; });
    child.on("error", e => {
      clearTimeout(timer);
      if (e.code === "ENOENT") resolve({ installed: false });
      else reject(e);
    });
    // signed out may end with a non-zero exit code, so only the printed JSON counts
    child.on("close", () => {
      clearTimeout(timer);
      let s = null;
      try { s = JSON.parse(out.trim()); } catch { /* not JSON: signed out */ }
      const str = v => (typeof v === "string" ? v : null);
      resolve({ installed: true, loggedIn: s?.loggedIn === true, email: str(s?.email), plan: str(s?.subscriptionType) });
    });
  });
}

async function status(req, res) {
  if (!allowed(req)) return sendJson(res, 403, { error: "Forbidden" });
  try { sendJson(res, 200, await claudeStatus()); }
  catch (e) { sendJson(res, 500, { error: e.message || String(e) }); }
}

async function ask(req, res) {
  const send = (code, body) => sendJson(res, code, body);
  if (!allowed(req)) return send(403, { error: "Forbidden" });
  let dir = null;
  try {
    const body = await readBody(req);
    const n = Number(new URL(req.url, "http://x").searchParams.get("n"));
    if (!Number.isInteger(n) || n <= 0 || n > body.length) return send(400, { error: "Bad request" });
    const prompt = body.subarray(0, n).toString("utf8");
    const pdf = body.subarray(n); // empty when the question comes with no PDF
    if (pdf.length && !pdf.subarray(0, 1024).includes("%PDF-")) return send(400, { error: "That file is not a PDF." });
    dir = await mkdtemp(join(tmpdir(), "bloom-ask-"));
    const file = join(dir, "lecture.pdf");
    if (pdf.length) await writeFile(file, pdf);
    send(200, { result: await runClaude(dir, pdf.length ? prompt.replaceAll(PDF_TOKEN, file) : prompt) });
  } catch (e) {
    send(e.code === "no-claude" ? 503 : 500, { error: e.message || String(e) });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

createServer(async (req, res) => {
  let path;
  try { path = decodeURIComponent(new URL(req.url, "http://x").pathname); }
  catch { res.writeHead(400).end("Bad request"); return; } // a malformed URL must not stop the server
  if (path === "/api/ask") {
    if (req.method === "POST") return ask(req, res);
    res.writeHead(405).end(); return;
  }
  if (path === "/api/claude-status") {
    if (req.method === "GET") return status(req, res);
    res.writeHead(405).end(); return;
  }
  const file = normalize(join(root, path === "/" ? "index.html" : path));
  if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": (types[extname(file)] || "application/octet-stream") + "; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`Bloom preview: http://localhost:${port}`));
