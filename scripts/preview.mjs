// Serves ui/ on http://localhost:4173 so the interface can be developed in a normal browser.
// It also answers POST /api/ask?via=claude|codex, which runs the local Claude Code or Codex CLI (on a
// lecture PDF or none), the way the native shell does in the app (see ask_claude and ask_codex in
// src-tauri/src/lib.rs), and GET /api/claude-status and /api/codex-status.
import { createServer } from "node:http";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_ARGS, PDF_TOKEN, readEnvelope } from "../ui/js/notebook-core.js";
import { CODEX_ARGS, NAMES, readCodexEvents, readCodexLogin } from "../ui/js/assistant-core.js";

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

/**
 * Runs a CLI with `input` on stdin. Resolves { code, out, err }, or { missing: true } when the
 * program is not installed, or { timedOut: true }. On Windows the npm install of Codex is a .cmd
 * file, which only starts through the shell (its arguments are plain words, so this is safe).
 */
function runCli(name, args, { cwd, input = "", timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const viaShell = process.platform === "win32" && name === "codex";
    const child = viaShell
      ? spawn([name, ...args].join(" "), { cwd, shell: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
      : spawn(name, args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "", err = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", c => { out += c; });
    child.stderr.on("data", c => { err += c; });
    child.on("error", e => {
      clearTimeout(timer);
      if (e.code === "ENOENT") resolve({ missing: true });
      else reject(e);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (timedOut) return resolve({ timedOut: true });
      // cmd.exe exits with 9009 when the command does not exist
      if (viaShell && code === 9009) return resolve({ missing: true });
      resolve({ code: code ?? 1, out, err });
    });
    child.stdin.on("error", () => { /* reported through the exit code */ });
    child.stdin.end(input);
  });
}

const ASSISTANTS = {
  claude: { args: CLAUDE_ARGS, read: readEnvelope },
  codex: { args: CODEX_ARGS, read: readCodexEvents },
};

/** Runs `who` ("claude" or "codex") in `cwd` with the prompt on stdin; resolves with its text. */
async function runAssistant(who, cwd, prompt) {
  const { args, read } = ASSISTANTS[who];
  const r = await runCli(who, args, { cwd, input: prompt });
  if (r.missing) throw Object.assign(new Error(`no-${who}`), { code: `no-${who}` });
  if (r.timedOut) throw new Error(`${NAMES[who]} took longer than 5 minutes and was stopped. Try again.`);
  return read(r.out, r.code, r.err);
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
async function claudeStatus() {
  const r = await runCli("claude", ["auth", "status"], { timeoutMs: 15_000 });
  if (r.missing) return { installed: false };
  if (r.timedOut) throw new Error("Claude Code did not answer in time. Try again.");
  // signed out may end with a non-zero exit code, so only the printed JSON counts
  let s = null;
  try { s = JSON.parse(r.out.trim()); } catch { /* not JSON: signed out */ }
  const str = v => (typeof v === "string" ? v : null);
  return { installed: true, loggedIn: s?.loggedIn === true, email: str(s?.email), plan: str(s?.subscriptionType) };
}

/** Runs `codex login status`; same shape as codex_status in src-tauri/src/lib.rs. */
async function codexStatus() {
  const r = await runCli("codex", ["login", "status"], { timeoutMs: 15_000 });
  if (r.missing) return { installed: false };
  if (r.timedOut) throw new Error("Codex did not answer in time. Try again.");
  return readCodexLogin(`${r.out}
${r.err}`, r.code);
}

const STATUS = { claude: claudeStatus, codex: codexStatus };

async function status(req, res, who) {
  if (!allowed(req)) return sendJson(res, 403, { error: "Forbidden" });
  try { sendJson(res, 200, await STATUS[who]()); }
  catch (e) { sendJson(res, 500, { error: e.message || String(e) }); }
}

async function ask(req, res) {
  const send = (code, body) => sendJson(res, code, body);
  if (!allowed(req)) return send(403, { error: "Forbidden" });
  let dir = null;
  try {
    const query = new URL(req.url, "http://x").searchParams;
    const who = query.get("via") || "claude";
    if (!Object.hasOwn(ASSISTANTS, who)) return send(400, { error: "Bad request" });
    const body = await readBody(req);
    const n = Number(query.get("n"));
    if (!Number.isInteger(n) || n <= 0 || n > body.length) return send(400, { error: "Bad request" });
    const prompt = body.subarray(0, n).toString("utf8");
    const pdf = body.subarray(n); // empty when the question comes with no PDF
    if (pdf.length && !pdf.subarray(0, 1024).includes("%PDF-")) return send(400, { error: "That file is not a PDF." });
    dir = await mkdtemp(join(tmpdir(), "bloom-ask-"));
    const file = join(dir, "lecture.pdf");
    if (pdf.length) await writeFile(file, pdf);
    send(200, { result: await runAssistant(who, dir, pdf.length ? prompt.replaceAll(PDF_TOKEN, file) : prompt) });
  } catch (e) {
    send(e.code === "no-claude" || e.code === "no-codex" ? 503 : 500, { error: e.message || String(e) });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---- POST /api/convert?ext=ppt|pptx|key: slides in, PDF out (convert_to_pdf in the native shell
// does this with Keynote). Here: Keynote on a Mac, PowerPoint on Windows (and from WSL), else LibreOffice.

/** Runs a program; resolves { code, out, err }, { missing: true } or { timedOut: true }. */
function runTool(name, args, timeoutMs = TIMEOUT_MS) {
  return new Promise(resolve => {
    const child = spawn(name, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "", err = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", c => { out += c; });
    child.stderr.setEncoding("utf8").on("data", c => { err += c; });
    child.on("error", e => { clearTimeout(timer); resolve(e.code === "ENOENT" ? { missing: true } : { code: 1, out, err: e.message }); });
    child.on("close", code => { clearTimeout(timer); resolve(timedOut ? { timedOut: true } : { code: code ?? 1, out, err }); });
  });
}

const SLIDE_TYPES = ["ppt", "pptx", "key"];
const KEYNOTE_EXPORT = `on run argv
  set inFile to POSIX file (item 1 of argv)
  set outFile to POSIX file (item 2 of argv)
  tell application id "com.apple.iWork.Keynote"
    set doc to open inFile
    export doc to outFile as PDF
    close doc saving no
  end tell
end run`;
const POWERPOINT_EXPORT = "& { param($i, $o) $pp = New-Object -ComObject PowerPoint.Application; " +
  "$p = $pp.Presentations.Open($i, $true, $false, $false); $p.SaveAs($o, 32); $p.Close(); " +
  "if ($pp.Presentations.Count -eq 0) { $pp.Quit() } }";

const isWsl = process.platform === "linux" && /microsoft/i.test(await readFile("/proc/version", "utf8").catch(() => ""));

/** A fresh folder PowerPoint can reach: the Windows temp folder when running in WSL. */
async function convertDir() {
  if (!isWsl) return mkdtemp(join(tmpdir(), "bloom-convert-"));
  const win = (await runTool("powershell.exe", ["-NoProfile", "-Command", "[IO.Path]::GetTempPath()"], 30_000)).out?.trim();
  const unix = win && (await runTool("wslpath", ["-u", win], 10_000)).out?.trim();
  if (!unix) throw new Error("Could not find the Windows temp folder.");
  return mkdtemp(join(unix, "bloom-convert-"));
}

const winPath = async p => (isWsl ? (await runTool("wslpath", ["-w", p], 10_000)).out.trim() : p);

async function convert(req, res) {
  if (!allowed(req)) return sendJson(res, 403, { error: "Not allowed." });
  const ext = new URL(req.url, "http://x").searchParams.get("ext")?.toLowerCase();
  if (!SLIDE_TYPES.includes(ext)) return sendJson(res, 400, { error: "Bloom can turn PowerPoint (.ppt, .pptx) and Keynote files into a PDF, not this kind of file." });
  let dir;
  try {
    const body = await readBody(req);
    dir = await convertDir();
    const input = join(dir, `slides.${ext}`), output = join(dir, "slides.pdf");
    await writeFile(input, body);
    const run = process.platform === "darwin"
      ? (await writeFile(join(dir, "export.applescript"), KEYNOTE_EXPORT), await runTool("osascript", [join(dir, "export.applescript"), input, output]))
      : process.platform === "win32" || isWsl
      ? await runTool(isWsl ? "powershell.exe" : "powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", POWERPOINT_EXPORT, await winPath(input), await winPath(output)])
      : await runTool("soffice", ["--headless", "--convert-to", "pdf", "--outdir", dir, input]);
    const pdf = await readFile(output).catch(() => null);
    if (!pdf || !pdf.subarray(0, 1024).toString("latin1").includes("%PDF-")) {
      const why = run.missing ? "no program to convert slides was found on this computer" : run.timedOut ? "it took too long" : "the file could not be opened";
      return sendJson(res, 500, { error: `The slides could not be turned into a PDF${why ? ` (${why})` : ""}. Save them as a PDF instead.` });
    }
    res.writeHead(200, { "Content-Type": "application/pdf", "Cache-Control": "no-store" });
    res.end(pdf);
  } catch (e) {
    sendJson(res, 500, { error: e.message || String(e) });
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
  if (path === "/api/convert") {
    if (req.method === "POST") return convert(req, res);
    res.writeHead(405).end(); return;
  }
  if (path === "/api/claude-status" || path === "/api/codex-status") {
    if (req.method === "GET") return status(req, res, path === "/api/codex-status" ? "codex" : "claude");
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
