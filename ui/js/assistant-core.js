// Which assistant answers (Claude Code or Codex), and reading what the Codex CLI prints.
// Pure, covered by tests/assistant.test.mjs. The app and the preview server both use it.

export const NAMES = { claude: "Claude", codex: "Codex" };

/**
 * `codex exec` with the prompt on stdin (the final "-"), events as JSON lines on stdout, nothing
 * saved, her own config and rules ignored (only the sign-in is used), a read-only sandbox and no
 * approvals. The native shell (lib.rs) uses the same flags.
 */
export const CODEX_ARGS = ["exec", "--json", "--color", "never", "--ephemeral", "--skip-git-repo-check",
  "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only", "-c", "approval_policy=never", "-"];

/** What Codex is asked to reply when it cannot read the PDF, instead of guessing. */
export const CODEX_NO_PDF = "BLOOM_CANNOT_READ_PDF";

const HOUR = 60 * 60 * 1000;
/** How long Bloom goes straight to Codex when Claude's limit message says no reset time. */
export const LIMIT_FALLBACK_MS = HOUR;
const LIMIT_MAX_MS = 8 * 24 * HOUR;

export const isReady = s => Boolean(s?.installed && s?.loggedIn);

// ---- the prompts

/**
 * The prompts are written for Claude. For Codex: it has no Read tool, so it is told how to read a
 * PDF with the tools it has, and to say so instead of guessing when it cannot.
 */
export function adaptPrompt(prompt, who, withPdf) {
  const text = String(prompt ?? "");
  if (who !== "codex") return text;
  const plain = text.replace(/Use the Read tool to read/g, "Read");
  if (!withPdf) return plain;
  return `${plain}

How to read the PDF: it is a PDF file, so extract its text with a command-line tool (for example pdftotext, a short Python script, or on macOS osascript -l JavaScript with PDFKit), page by page so that the page numbers stay right. Only read files: never create, change or delete any.
If you cannot read the PDF at all, reply with exactly ${CODEX_NO_PDF} and nothing else.`;
}

/** Codex's answer, or a readable Error when it said it could not read the PDF. */
export function checkAnswer(text, who) {
  if (who === "codex" && String(text ?? "").includes(CODEX_NO_PDF)) {
    throw new Error("Codex could not read this PDF on this computer. Try again with Claude.");
  }
  return text;
}

// ---- Claude's usage limit

const LIMIT = [
  /\bhit your\b[^.!\n]{0,40}\blimit\b/i,                                         // You've hit your 5-hour limit · resets 1am
  /\b(?:usage|5-hour|five-hour|weekly|daily|session|opus|sonnet)\s+limit\s+(?:reached|hit|exceeded)\b/i, // Weekly limit reached ∙ resets …
  /\breached your\b[^.!\n]{0,40}\blimit\b/i,                                     // You've reached your usage limit
  /\blimit will reset\b/i,                                                       // Your limit will reset at 1am
];

/** Whether a Claude error says that its usage limit (5-hour, weekly…) is reached. */
export const isUsageLimit = message => LIMIT.some(r => r.test(String(message ?? "")));

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const RESET = /\bresets?\s+(?:at\s+|on\s+)?(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?,?\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;

/**
 * When Claude's limit resets, in ms, from its message ("resets 1am", "resets Mon 9am",
 * "resets Oct 9, 9am", "…limit reached|1736323200"). The time is read in this computer's time
 * zone, which is the one the CLI prints. Unreadable or implausible: `now` + LIMIT_FALLBACK_MS.
 */
export function limitResetsAt(message, now = new Date()) {
  const text = String(message ?? "");
  const t0 = now.getTime();
  const plausible = t => (t > t0 && t - t0 <= LIMIT_MAX_MS ? t : t0 + LIMIT_FALLBACK_MS);
  const epoch = text.match(/limit reached\|(\d{9,13})\b/i);
  if (epoch) {
    const n = Number(epoch[1]);
    return plausible(n < 1e12 ? n * 1000 : n);
  }
  const m = text.match(RESET);
  if (!m) return t0 + LIMIT_FALLBACK_MS;
  const [, wday, mon, mday, hh, mm, ampm] = m;
  let h = Number(hh);
  const min = mm ? Number(mm) : 0;
  if (ampm) {
    if (h < 1 || h > 12) return t0 + LIMIT_FALLBACK_MS;
    h = (h % 12) + (ampm.toLowerCase() === "pm" ? 12 : 0);
  }
  if (h > 23 || min > 59) return t0 + LIMIT_FALLBACK_MS;
  const at = new Date(now);
  at.setSeconds(0, 0);
  at.setHours(h, min);
  if (mon) {
    at.setMonth(MONTHS.indexOf(mon.toLowerCase()), Number(mday));
    if (at.getTime() <= t0) at.setFullYear(at.getFullYear() + 1);
  } else if (wday) {
    const ahead = (DAYS.indexOf(wday.toLowerCase()) - at.getDay() + 7) % 7;
    at.setDate(at.getDate() + ahead);
    if (at.getTime() <= t0) at.setDate(at.getDate() + 7);
  } else if (at.getTime() <= t0) {
    at.setDate(at.getDate() + 1);
  }
  return plausible(at.getTime());
}

// ---- choosing

/**
 * Which assistant answers: only one ready → that one; both ready → Claude, unless Claude's limit
 * (`limitedUntil`, ms) is not over yet → Codex. Neither ready → null.
 * → { use: "claude" | "codex" | null, reason: "both" | "only" | "limit" | "none" }
 */
export function chooseAssistant(claude, codex, limitedUntil = 0, now = Date.now()) {
  const a = isReady(claude), b = isReady(codex);
  if (a && b) return limitedUntil > now ? { use: "codex", reason: "limit" } : { use: "claude", reason: "both" };
  if (a) return { use: "claude", reason: "only" };
  if (b) return { use: "codex", reason: "only" };
  return { use: null, reason: "none" };
}

const text = v => (typeof v === "string" && v ? v : null);

/** One assistant's status in a known shape. A failed check (`error`) counts as not installed. */
export function normStatus(s) {
  const out = { installed: Boolean(s?.installed), loggedIn: Boolean(s?.installed && s?.loggedIn) };
  if (s && "email" in s) out.email = text(s.email);
  if (s && "plan" in s) out.plan = text(s.plan);
  if (s && "method" in s) out.method = text(s.method);
  if (text(s?.error)) out.error = s.error;
  return out;
}

/**
 * The status of both assistants, as assistantStatus() returns it. `installed` and `loggedIn` say
 * whether at least one assistant is installed / ready; `email` and `plan` are those of the one
 * that will be used (only Claude tells them). `limitedUntil` is set while Claude's limit lasts.
 */
export function mergeStatus(claudeRaw, codexRaw, limitedUntil = 0, now = Date.now()) {
  const claude = normStatus(claudeRaw), codex = normStatus(codexRaw);
  const { use, reason } = chooseAssistant(claude, codex, limitedUntil, now);
  return {
    installed: claude.installed || codex.installed,
    loggedIn: isReady(claude) || isReady(codex),
    email: use === "claude" ? claude.email ?? null : null,
    plan: use === "claude" ? claude.plan ?? null : null,
    use, reason,
    limitedUntil: limitedUntil > now ? limitedUntil : null,
    claude, codex,
  };
}

/**
 * Which assistant runs a request: the chosen one; when none is ready, the first installed one
 * (its own error then says what is wrong); null when none is installed.
 */
export function runnerFor(status) {
  if (!status) return "claude"; // the check failed: try as before, the run reports its own errors
  if (status.use) return status.use;
  if (status.claude?.installed) return "claude";
  if (status.codex?.installed) return "codex";
  return null;
}

// ---- reading Codex

/**
 * Reads what `codex login status` printed (on stderr) and its exit code:
 * "Logged in using ChatGPT", "Logged in using an API key - sk-…", or "Not logged in" (exit 1).
 */
export function readCodexLogin(output, exitCode = 0) {
  const s = String(output ?? "");
  const loggedIn = exitCode === 0 && /\blogged in\b/i.test(s) && !/\bnot logged in\b/i.test(s);
  const method = !loggedIn ? null : /chatgpt/i.test(s) ? "ChatGPT" : /api key/i.test(s) ? "API key" : null;
  return { installed: true, loggedIn, method };
}

const tail = (s, max = 300) => String(s ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split(/\r?\n/)
  .map(l => l.trim()).filter(Boolean).slice(-3).join(" ").slice(-max);

/**
 * Reads the JSON lines printed by `codex exec --json` and returns Codex's last message.
 * `exitCode` is the process exit code. Throws a readable Error.
 */
export function readCodexEvents(stdout, exitCode = 0, stderr = "") {
  let answer = "", failed = "", error = "", events = 0;
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== "object") continue;
    events++;
    if (e.type === "item.completed" && e.item?.type === "agent_message" && typeof e.item.text === "string") answer = e.item.text.trim();
    else if (e.type === "turn.failed") failed = String(e.error?.message ?? "the request failed");
    else if (e.type === "error") error = String(e.message ?? "");
  }
  if (failed) throw new Error(`Codex: ${failed}`);
  if (answer && !exitCode) return answer;
  if (error) throw new Error(`Codex: ${error}`);
  if (!events || exitCode) {
    const detail = tail(stderr);
    throw new Error(`Codex did not answer${exitCode ? ` (exit code ${exitCode})` : ""}.${detail ? " " + detail : ""}`);
  }
  throw new Error("Codex's answer was empty. Try again.");
}

// ---- the preview's dev aid

const STATES = ["missing", "signedout", "ready"];
const fakeOne = (state, extra) => (state === "missing" ? { installed: false }
  : { installed: true, loggedIn: state !== "signedout", ...extra });

/**
 * localStorage.bloom_fake_assistant = "<claude>/<codex>", each missing | signedout | ready, and
 * Claude also "limited" (ready, but its usage limit is reached). "missing" or "signedout" alone
 * applies to both. → { claude, codex, limited } or null when the value is not one of these.
 */
export function fakeStatus(value) {
  const v = String(value ?? "").trim().toLowerCase();
  const [a, b = a] = v.split("/");
  if (!(STATES.includes(a) || a === "limited") || !STATES.includes(b)) return null;
  if (!v.includes("/") && a !== "missing" && a !== "signedout") return null;
  return {
    claude: fakeOne(a === "limited" ? "ready" : a, { email: "sarra@example.com", plan: "pro" }),
    codex: fakeOne(b, { method: "ChatGPT" }),
    limited: a === "limited",
  };
}
