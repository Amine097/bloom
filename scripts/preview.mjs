// Serves ui/ on http://localhost:4173 so the interface can be developed in a normal browser.
// It also answers POST /api/ask?via=claude|codex, which runs the local Claude Code or Codex CLI (on a
// lecture PDF or none), the way the native shell does in the app (see ask_claude and ask_codex in
// src-tauri/src/lib.rs), GET /api/claude-status and /api/codex-status, and POST /api/pdf-text (the
// text of a lecture PDF, like pdf_text in lib.rs), and POST /api/media and /api/media-image (her Jellyfin and
// Jellyseerr, like media_fetch and media_image).
import { createServer } from "node:http";
import { readFile, writeFile, mkdtemp, rm, mkdir, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PDF_TOKEN, askTimeout, claudeArgs, readEnvelope } from "../ui/js/notebook-core.js";
import { NAMES, codexArgs, readCodexEvents, readCodexLogin } from "../ui/js/assistant-core.js";
import { FICHE_ARGS, FICHE_TIMEOUT_MS } from "../ui/js/fiches-core.js";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "ui");
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".txt": "text/plain" };
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
  claude: { args: claudeArgs, read: readEnvelope },
  codex: { args: codexArgs, read: readCodexEvents },
};

/**
 * Runs `who` ("claude" or "codex") in `cwd` with the prompt on stdin; resolves with its text.
 * `schemas`: more steps, effort and time, as ask_claude / ask_codex do in the native shell.
 */
async function runAssistant(who, cwd, prompt, schemas = false) {
  const { args, read } = ASSISTANTS[who];
  const limit = askTimeout(schemas);
  const r = await runCli(who, args(schemas), { cwd, input: prompt, timeoutMs: limit.ms });
  if (r.missing) throw Object.assign(new Error(`no-${who}`), { code: `no-${who}` });
  if (r.timedOut) throw new Error(`${NAMES[who]} took longer than ${limit.words} and was stopped. Try again.`);
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
    const schemas = query.get("schemas") === "1" && pdf.length > 0;
    send(200, { result: await runAssistant(who, dir, pdf.length ? prompt.replaceAll(PDF_TOKEN, file) : prompt, schemas) });
  } catch (e) {
    send(e.code === "no-claude" || e.code === "no-codex" ? 503 : 500, { error: e.message || String(e) });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---- POST /api/pdf-text: a PDF in, its text out, page by page ("--- Page n ---" starts page n), as
// pdf_text in the native shell gives it. With pdftotext when it is installed, else Python's pypdf
// (BLOOM_PYTHON, default python3). Neither: 501, and the Notebook then lets the assistant read the PDF.

const PYPDF_TEXT = `import json, sys
from pypdf import PdfReader
pages = []
for page in PdfReader(sys.argv[1]).pages:
    try:
        pages.append(page.extract_text() or "")
    except Exception:
        pages.append("")
print(json.dumps(pages))`;

const asPages = pages => pages.map((t, i) => `\n--- Page ${i + 1} ---\n${t}`).join("");

async function extractText(file) {
  const a = await runTool("pdftotext", ["-layout", "-enc", "UTF-8", file, "-"], 60_000);
  if (!a.missing && !a.timedOut && a.code === 0 && a.out.trim()) {
    // pdftotext ends every page with a form feed
    const pages = a.out.split("\f");
    if (pages.length > 1 && !pages.at(-1).trim()) pages.pop();
    return asPages(pages);
  }
  const b = await runTool(process.env.BLOOM_PYTHON || "python3", ["-I", "-c", PYPDF_TEXT, file], 60_000);
  if (!b.missing && !b.timedOut && b.code === 0) {
    try {
      const pages = JSON.parse(b.out);
      if (Array.isArray(pages)) return asPages(pages.map(String));
    } catch { /* not what was expected */ }
  }
  return null;
}

async function pdfText(req, res) {
  if (!allowed(req)) return sendJson(res, 403, { error: "Forbidden" });
  let dir;
  try {
    const pdf = await readBody(req);
    if (!pdf.subarray(0, 1024).includes("%PDF-")) return sendJson(res, 400, { error: "That file is not a PDF." });
    dir = await mkdtemp(join(tmpdir(), "bloom-text-"));
    const file = join(dir, "lecture.pdf");
    await writeFile(file, pdf);
    const text = await extractText(file);
    if (text === null) return sendJson(res, 501, { error: "No tool to extract a PDF's text was found on this computer." });
    sendJson(res, 200, { text });
  } catch (e) {
    sendJson(res, 500, { error: e.message || String(e) });
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

// ---- /api/fiche/*: a generated fiche's folder and its long Claude Code run, like the fiche_*
// commands of the native shell. Folders live in BLOOM_FICHES_DIR (default: <temp>/bloom-preview-fiches).
// A run goes on in the background; the page asks for its status (so a reload does not lose it).

const FICHES_DIR = process.env.BLOOM_FICHES_DIR || join(tmpdir(), "bloom-preview-fiches");
const ficheRuns = new Map(); // id → { child, running, result, error, cancelled }
const SAFE_ID = /^[A-Za-z0-9]{1,40}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

// page `page` of a PDF → PNG on stdout, with pypdfium2 (BLOOM_PYTHON); exits 3 when it is missing
const SLIDE_PNG = `import sys
try:
    import pypdfium2 as pdfium
except Exception:
    sys.exit(3)
pdf = pdfium.PdfDocument(sys.argv[1])
i = int(sys.argv[2]) - 1
if i < 0 or i >= len(pdf):
    sys.exit(4)
page = pdf[i]
w, h = page.get_size()
img = page.render(scale=min(4.0, 1600.0 / max(w, h))).to_pil()
img.save(sys.argv[3], format="PNG", optimize=True)`;

async function ficheApi(req, res, action) {
  if (!allowed(req)) return sendJson(res, 403, { error: "Forbidden" });
  const query = new URL(req.url, "http://x").searchParams;
  const id = query.get("id") || "";
  if (!SAFE_ID.test(id)) return sendJson(res, 400, { error: "Bad request" });
  const dir = join(FICHES_DIR, id);
  const keyOk = k => /^[A-Za-z0-9]{1,12}$/.test(k || "");
  try {
    if (action === "prepare" && req.method === "POST") {
      const key = query.get("key");
      if (!keyOk(key)) return sendJson(res, 400, { error: "Bad request" });
      const pdf = await readBody(req);
      if (!pdf.subarray(0, 1024).includes("%PDF-")) return sendJson(res, 400, { error: "That file is not a PDF." });
      await mkdir(join(dir, "slides"), { recursive: true });
      const file = join(dir, "slides", `${key}.pdf`);
      await writeFile(file, pdf);
      const text = await extractText(file);
      if (text !== null) await writeFile(join(dir, "slides", `${key}.txt`), text);
      return sendJson(res, 200, { pages: text ? (text.match(/\n--- Page \d+ ---\n/g) || []).length : 0 });
    }
    if (action === "start" && req.method === "POST") {
      if (ficheRuns.get(id)?.running) return sendJson(res, 409, { error: "This fiche is already being written." });
      const prompt = (await readBody(req)).toString("utf8");
      await mkdir(dir, { recursive: true });
      const run = { running: true, result: null, error: null, cancelled: false, child: null };
      ficheRuns.set(id, run);
      const child = spawn("claude", FICHE_ARGS, { cwd: dir, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      run.child = child;
      let out = "", err = "";
      const timer = setTimeout(() => { run.timedOut = true; child.kill(); }, FICHE_TIMEOUT_MS);
      child.stdout.setEncoding("utf8").on("data", c => { out += c; });
      child.stderr.setEncoding("utf8").on("data", c => { err += c; });
      child.on("error", e => {
        clearTimeout(timer);
        Object.assign(run, { running: false, error: e.code === "ENOENT" ? "no-claude" : e.message, child: null });
      });
      child.on("close", code => {
        clearTimeout(timer);
        if (!run.running) return;
        run.running = false;
        run.child = null;
        if (run.cancelled) run.error = "cancelled";
        else if (run.timedOut) run.error = "Claude took longer than 3 hours and was stopped.";
        else {
          try { run.result = readEnvelope(out, code ?? 1, err); }
          catch (e) { run.error = e.message || String(e); }
        }
      });
      child.stdin.on("error", () => { /* reported through the exit code */ });
      child.stdin.end(prompt);
      return sendJson(res, 200, { ok: true });
    }
    if (action === "status" && req.method === "GET") {
      const r = ficheRuns.get(id);
      return sendJson(res, 200, { running: Boolean(r?.running), result: r?.result ?? null, error: r?.error ?? null });
    }
    if (action === "cancel" && req.method === "POST") {
      const r = ficheRuns.get(id);
      if (r?.running && r.child) { r.cancelled = true; r.child.kill(); }
      return sendJson(res, 200, { ok: true });
    }
    if (action === "files" && req.method === "GET") {
      const names = await readdir(dir, { withFileTypes: true }).catch(() => []);
      return sendJson(res, 200, { files: names.filter(d => d.isFile()).map(d => d.name) });
    }
    if (action === "file" && req.method === "GET") {
      const name = query.get("name") || "";
      if (!SAFE_NAME.test(name) || name.includes("..")) return sendJson(res, 400, { error: "Bad request" });
      const body = await readFile(join(dir, name)).catch(() => null);
      if (!body) { res.writeHead(204, { "Cache-Control": "no-store" }); return res.end(); } // not written yet (not an error)
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(body);
    }
    if (action === "slide" && req.method === "GET") {
      const key = query.get("key"), page = Number(query.get("page"));
      if (!keyOk(key) || !Number.isInteger(page) || page < 1 || page > 9999) return sendJson(res, 400, { error: "Bad request" });
      const img = join(dir, "img", `${key}-${page}.png`);
      let png = await readFile(img).catch(() => null);
      if (!png) {
        await mkdir(join(dir, "img"), { recursive: true });
        const r = await runTool(process.env.BLOOM_PYTHON || "python3", ["-I", "-c", SLIDE_PNG, join(dir, "slides", `${key}.pdf`), String(page), img], 60_000);
        if (r.missing || r.timedOut || r.code !== 0) return sendJson(res, 501, { error: "No tool to draw a PDF page was found on this computer." });
        png = await readFile(img).catch(() => null);
        if (!png) return sendJson(res, 501, { error: "The page could not be drawn." });
      }
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
      return res.end(png);
    }
    if (action === "delete" && req.method === "POST") {
      const r = ficheRuns.get(id);
      if (r?.running && r.child) { r.cancelled = true; r.child.kill(); }
      ficheRuns.delete(id);
      await rm(dir, { recursive: true, force: true });
      return sendJson(res, 200, { ok: true });
    }
    res.writeHead(405).end();
  } catch (e) {
    sendJson(res, 500, { error: e.message || String(e) });
  }
}

// ---- POST /api/media: one request to her Jellyfin or Jellyseerr, { method, url, headers: [[k, v]],
// body } in, { status, body, cookie } out, as media_fetch in the native shell; POST /api/media-image:
// { url } in, the poster's bytes out (media_image).

const isHttp = u => typeof u === "string" && /^https?:\/\/[^\s]+$/i.test(u);

async function mediaFetch(req, res) {
  if (!allowed(req)) return sendJson(res, 403, { error: "Not allowed." });
  let q;
  try { q = JSON.parse(String(await readBody(req))); } catch { return sendJson(res, 400, { error: "Bad request." }); }
  if (!isHttp(q.url) || !["GET", "POST", "PUT", "DELETE"].includes(q.method)) return sendJson(res, 400, { error: "invalid request" });
  try {
    const r = await fetch(q.url, {
      method: q.method, headers: q.headers || [], body: q.body ?? undefined,
      redirect: "manual", signal: AbortSignal.timeout(25_000),
    });
    const cookie = (r.headers.getSetCookie?.() || []).map(c => c.split(";")[0].trim()).join("; ");
    sendJson(res, 200, { status: r.status, body: await r.text(), cookie });
  } catch (e) {
    sendJson(res, 502, { error: "unreachable: " + (e.cause?.message || e.message) });
  }
}

async function mediaImage(req, res) {
  if (!allowed(req)) return sendJson(res, 403, { error: "Not allowed." });
  let q;
  try { q = JSON.parse(String(await readBody(req))); } catch { return sendJson(res, 400, { error: "Bad request." }); }
  if (!isHttp(q.url)) return sendJson(res, 400, { error: "invalid address" });
  try {
    const r = await fetch(q.url, { signal: AbortSignal.timeout(25_000) });
    if (!r.ok) return sendJson(res, 404, { error: "no image" });
    res.writeHead(200, { "Content-Type": r.headers.get("content-type") || "image/jpeg", "Cache-Control": "no-store" });
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch {
    sendJson(res, 404, { error: "no image" });
  }
}

createServer(async (req, res) => {
  let path;
  try { path = decodeURIComponent(new URL(req.url, "http://x").pathname); }
  catch { res.writeHead(400).end("Bad request"); return; } // a malformed URL must not stop the server
  if (path.startsWith("/api/fiche/")) return ficheApi(req, res, path.slice("/api/fiche/".length));
  if (path === "/api/ask") {
    if (req.method === "POST") return ask(req, res);
    res.writeHead(405).end(); return;
  }
  if (path === "/api/pdf-text") {
    if (req.method === "POST") return pdfText(req, res);
    res.writeHead(405).end(); return;
  }
  if (path === "/api/convert") {
    if (req.method === "POST") return convert(req, res);
    res.writeHead(405).end(); return;
  }
  if (path === "/api/media" || path === "/api/media-image") {
    if (req.method === "POST") return path === "/api/media" ? mediaFetch(req, res) : mediaImage(req, res);
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
