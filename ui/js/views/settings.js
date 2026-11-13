// Settings: semester, recall timings, setting up Claude and Codex, modules and exam dates, backups, updates.
import { D, save, uid, modulesSorted, itemsList, exportBackup, replaceAll } from "../store.js";
import { fmtWday, relDay, parse } from "../dates.js";
import { esc, icon, app, openModal, confirmBox, field, input, cvar, toast, COLORS } from "../ui.js";
import { assistantStatus, setup } from "../assistant.js";
import { NAMES } from "../assistant-core.js";

// ---- the Assistant cards: Claude, and Codex as its backup; installing and signing in, without Terminal

/**
 * Survives changes of view. `checks.status` is the last answer of assistantStatus() (null until
 * the first one), with each assistant's own status in `.claude` and `.codex`. Per assistant,
 * `busy` is "install" or "signin" while that is going on; `attempt` tells a sign-in that was
 * cancelled or replaced apart from the current one.
 */
const checks = { status: null, checking: false, checkedAt: 0, error: "" };
const fresh = () => ({ error: "", busy: null, via: "browser", terminalFirst: false, attempt: 0, poll: null, pollUntil: 0 });
const st = { claude: fresh(), codex: fresh() };
const WHO = ["claude", "codex"];
const RECHECK_MS = 30_000;
const POLL_MS = 3_000;
const POLL_FOR_MS = 5 * 60_000;

const COPY = {
  claude: {
    title: "Claude",
    setup: "Bloom uses Claude to write study guides, quizzes and your weekly plan. It needs a small helper from Anthropic, installed once.",
    signin: "Bloom uses Claude with your own Claude account. Sign in once and it stays signed in.",
    browser: "Your browser has opened. Sign in to Claude there, then come back here.",
    ready: "Study guides, quizzes and the weekly plan are written by Claude, with your own Claude account.",
  },
  codex: {
    title: "Codex · backup",
    setup: "Codex is OpenAI's assistant. When Claude's usage limit is reached, Bloom switches to Codex so you can keep studying. It needs a small helper from OpenAI, installed once.",
    signin: "Codex uses your own ChatGPT account. Sign in once and it stays signed in.",
    browser: "Your browser has opened. Sign in with your ChatGPT account there, then come back here.",
    ready: "When Claude cannot answer (its usage limit is reached, or it is not set up), Bloom uses Codex with your ChatGPT account.",
  },
};

/** Re-renders only when Settings is on screen. */
const refreshIfHere = () => { if (document.getElementById("main")?.dataset.view === "settings") app.refresh(); };
const whoOf = el => (el.dataset.who === "codex" ? "codex" : "claude");

async function checkStatus() {
  if (checks.checking) return;
  checks.checking = true;
  try {
    checks.status = await assistantStatus();
    checks.error = "";
    for (const who of WHO) if (checks.status[who]?.loggedIn) st[who].error = "";
  } catch (e) {
    if (!checks.status) checks.error = e?.message || String(e);
  } finally {
    checks.checking = false;
    checks.checkedAt = Date.now();
    refreshIfHere();
  }
}

function stopPolling(who) {
  clearInterval(st[who].poll);
  st[who].poll = null;
}

function connected(who, status) {
  stopPolling(who);
  const a = st[who];
  a.attempt += 1; // a sign-in still running in the background no longer matters
  Object.assign(a, { busy: null, error: "", terminalFirst: false });
  Object.assign(checks, { status, checkedAt: Date.now(), error: "" });
  toast(`${NAMES[who]} is connected 🌸`);
  refreshIfHere();
}

/** While she signs in elsewhere, asks every few seconds whether it is done. */
function startPolling(who) {
  const a = st[who];
  stopPolling(who);
  a.pollUntil = Date.now() + POLL_FOR_MS;
  let asking = false;
  a.poll = setInterval(async () => {
    if (Date.now() > a.pollUntil) {
      stopPolling(who);
      a.attempt += 1;
      Object.assign(a, { busy: null, error: "The sign-in was not finished in time. Try again." });
      refreshIfHere();
      return;
    }
    if (asking) return;
    asking = true;
    try {
      const s = await assistantStatus();
      if (s[who]?.loggedIn && a.poll) connected(who, s);
    } catch { /* try again on the next tick */ }
    finally { asking = false; }
  }, POLL_MS);
}

const planText = plan => (plan ? `${plan[0].toUpperCase()}${plan.slice(1)} plan` : "");
const clock = ms => new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));

/** The card of one assistant for its current state. Every string from a CLI goes through esc(). */
function assistantCard(who) {
  const all = checks.status;
  const s = all?.[who];
  const a = st[who];
  const copy = COPY[who];
  const act = (name, cls, label) => `<button class="${cls}" data-act="${name}" data-who="${who}">${label}</button>`;
  const head = pill => `<div class="card-h"><h3>${copy.title}</h3><span class="grow"></span>${pill}</div>`;
  const working = text => `<p class="as-working"><span class="nb-spin small" aria-hidden="true"></span> ${text}</p>`;
  const error = a.error ? `<p class="as-error">${esc(a.error)}</p>` : "";
  const card = (pill, body) => `<section class="card" aria-live="polite">${head(pill)}<div class="card-b">${body}</div></section>`;

  if (!all) {
    if (!checks.error) return card("", working("Checking…"));
    return card("", `<p class="muted">Bloom could not check whether ${NAMES[who]} is set up.</p><p class="as-error">${esc(checks.error)}</p>
      <div class="btns">${act("asCheck", "btn ghost small", "Check again")}</div>`);
  }

  if (!s?.installed) {
    const intro = `<p class="muted">${copy.setup}</p>`;
    if (a.busy === "install") return card(`<span class="pill">not set up</span>`, `${intro}${working("Installing… this can take a minute")}`);
    return card(`<span class="pill">not set up</span>`, `${intro}${error}
      <div class="btns">${act("asInstall", "btn primary", `${icon("spark", 16)} Set up ${NAMES[who]}`)}</div>`);
  }

  if (!s.loggedIn) {
    const pill = `<span class="pill">not signed in</span>`;
    if (a.busy === "signin") {
      const where = a.via === "terminal"
        ? `A Terminal window has opened. Follow the steps there to sign in to ${NAMES[who]}, then come back here.`
        : copy.browser;
      return card(pill, `${working(where)}
        <div class="btns as-btns">${act("asCancel", "btn ghost small", "Cancel")}
          ${a.via === "terminal" ? "" : act("asTerminal", "link", "Nothing opened? Sign in through Terminal")}</div>`);
    }
    const terminal = a.terminalFirst
      ? act("asTerminal", "btn soft", "Sign in through Terminal")
      : act("asTerminal", "link", "Nothing opens? Sign in through Terminal");
    return card(pill, `<p class="muted">${copy.signin}</p>${error}
      <div class="btns as-btns">${act("asSignIn", `btn ${a.terminalFirst ? "ghost" : "primary"}`, `Sign in to ${NAMES[who]}`)}${terminal}</div>`);
  }

  const account = who === "claude"
    ? [s.email ? `<b>${esc(s.email)}</b>` : "", esc(planText(s.plan))].filter(Boolean).join(" · ")
    : s.method ? `Signed in with ${esc(s.method)}` : "";
  const limit = who === "claude" && all.limitedUntil
    ? `<p class="muted small">Its usage limit is reached until about ${clock(all.limitedUntil)}${all.codex?.loggedIn ? "; Bloom uses Codex meanwhile" : ""}.</p>` : "";
  return card(`<span class="pill ok">${icon("check", 13)} connected</span>`,
    `<p class="muted">${copy.ready}</p>
    ${account ? `<p>${account}</p>` : ""}${limit}
    <div class="btns">${act("asCheck", "btn ghost small", `${checks.checking ? '<span class="nb-spin small" aria-hidden="true"></span> ' : ""}Check again`)}</div>`);
}

/** Starts a sign-in `via` "browser" or "terminal", and waits for the status to say it is done. */
async function beginSignIn(who, via) {
  const a = st[who];
  const attempt = ++a.attempt;
  Object.assign(a, { busy: "signin", via, error: "" });
  app.refresh();
  startPolling(who);
  try {
    if (via === "terminal") {
      await setup[who].cancel().catch(() => {}); // only one sign-in at a time
      await setup[who].terminal();
      return; // the polling notices when she is done
    }
    await setup[who].signIn();
  } catch (e) {
    if (attempt !== a.attempt) return; // cancelled or replaced meanwhile
    const s = await assistantStatus().catch(() => null);
    if (attempt !== a.attempt) return;
    if (s?.[who]?.loggedIn) { connected(who, s); return; }
    stopPolling(who);
    Object.assign(a, { busy: null, error: e?.message || String(e), terminalFirst: true });
    refreshIfHere();
    return;
  }
  // the CLI says it is signed in: confirm at once instead of waiting for the next poll
  if (attempt !== a.attempt) return;
  const s = await assistantStatus().catch(() => null);
  if (attempt === a.attempt && s?.[who]?.loggedIn) connected(who, s);
}

const assistantActions = {
  asCheck: () => {
    if (checks.checking) return;
    if (!checks.status) checks.error = "";
    checkStatus();
    app.refresh();
  },
  asInstall: async el => {
    const who = whoOf(el), a = st[who];
    if (a.busy) return;
    Object.assign(a, { busy: "install", error: "" });
    app.refresh();
    try {
      await setup[who].install();
      checks.status = await assistantStatus();
      checks.checkedAt = Date.now();
    } catch (e) {
      a.error = e?.message || String(e);
    } finally {
      a.busy = null;
      refreshIfHere();
    }
  },
  asSignIn: el => { const who = whoOf(el); if (!st[who].busy) beginSignIn(who, "browser"); },
  asTerminal: el => { const who = whoOf(el), a = st[who]; if (a.busy !== "signin" || a.via !== "terminal") beginSignIn(who, "terminal"); },
  asCancel: el => {
    const who = whoOf(el), a = st[who];
    stopPolling(who);
    a.attempt += 1;
    a.busy = null;
    setup[who].cancel().catch(() => {});
    app.refresh();
  },
};

export function render() {
  // first visit: fetch the status; later visits: show the last one and refresh it quietly
  if (!checks.checking && !st.claude.busy && !st.codex.busy && !(checks.error && !checks.status) && (!checks.status || Date.now() - checks.checkedAt > RECHECK_MS)) checkStatus();
  const s = D.settings;
  const items = itemsList();
  const mods = modulesSorted().map(m => {
    const n = items.filter(it => it.module === m.id).length;
    return `<div class="row" ${cvar(m.color)}>
      <span class="dot big"></span>
      <button class="row-main" data-act="editModule" data-id="${m.id}">
        <span class="t">${esc(m.name)}</span>
        <span class="sub">${n} item${n === 1 ? "" : "s"}${m.exam ? ` · exam ${fmtWday(m.exam)} (${relDay(m.exam)})` : ""}</span>
      </button>
      <span class="inline">Exam</span>
      <input type="date" class="mini ${m.exam ? "" : "empty"}" value="${m.exam || ""}" data-change="setExam" data-id="${m.id}" aria-label="Exam date for ${esc(m.name)}">
    </div>`;
  }).join("");

  return `<header class="page-h"><div><h1>Settings</h1></div></header>
    <div class="grid">
      <div class="col">
        <section class="card"><div class="card-h"><h3>You</h3></div>
          <div class="card-b">
            ${field("Your name", input("name", s.name, 'data-change="setText" placeholder="Shown on the dashboard"'))}
            ${field("Appearance", `<select data-change="setText" name="theme">${[["auto", "Follow the Mac"], ["light", "Light"], ["dark", "Dark"]].map(([v, l]) => `<option value="${v}" ${s.theme === v ? "selected" : ""}>${l}</option>`).join("")}</select>`)}
            ${field("Background", `<select data-change="setText" name="background">${[["nature", "Meadow with butterflies"], ["plain", "Plain"]].map(([v, l]) => `<option value="${v}" ${s.background === v ? "selected" : ""}>${l}</option>`).join("")}</select>`)}
          </div>
        </section>
        <section class="card"><div class="card-h"><h3>Semester and recalls</h3></div>
          <div class="card-b">
            ${field("Week 1 starts on", input("semesterStart", s.semesterStart, 'type="date" data-change="setStart"'), "Use the Monday of the first study week.")}
            <div class="grid3">
              ${field("Recall 1 after", input("recall1", s.recall1, 'type="number" min="1" max="60" data-change="setNumber"'), "days after seen")}
              ${field("Recall 2 after", input("recall2", s.recall2, 'type="number" min="1" max="120" data-change="setNumber"'), "days after recall 1")}
              ${field("At most", input("maxRecallsPerDay", s.maxRecallsPerDay, 'type="number" min="1" max="30" data-change="setNumber"'), "recalls a day")}
            </div>
            <p class="muted small">When a module has an exam date, its recalls are brought forward so the last one falls before the exam.</p>
          </div>
        </section>
        ${assistantCard("claude")}
        ${assistantCard("codex")}
      </div>
      <div class="col">
        <section class="card"><div class="card-h"><h3>Modules and exams</h3><span class="grow"></span><button class="btn ghost small" data-act="addModule">${icon("plus", 15)} Module</button></div>
          ${mods || `<div class="empty small">No modules yet.</div>`}
        </section>
        <section class="card"><div class="card-h"><h3>Your data</h3></div>
          <div class="card-b">
            <p class="muted">Everything stays on this Mac. Bloom keeps a backup for each of the last 14 days it was used, and updates never touch your data.</p>
            <p class="muted small">Lecture PDFs are kept on this Mac as well, but they are not included in backup copies.</p>
            <div class="btns">
              <button class="btn soft" data-act="export">Save a backup copy</button>
              <label class="btn ghost">Restore from a backup<input type="file" accept=".json,application/json" data-change="import" hidden></label>
            </div>
          </div>
        </section>
        <section class="card"><div class="card-h"><h3>About</h3></div>
          <div class="card-b">
            <p>Bloom <span class="mono" id="version">${esc(app.version || "preview")}</span></p>
            <div class="btns"><button class="btn soft" data-act="checkUpdate">Check for updates</button></div>
          </div>
        </section>
      </div>
    </div>`;
}

function openModule(id) {
  const m = id ? D.modules[id] : { name: "", color: COLORS[modulesSorted().length % COLORS.length], exam: null };
  openModal({
    title: id ? "Edit module" : "New module",
    body: `${field("Name", input("name", m.name, 'required autofocus placeholder="e.g. Immunology"'))}
      ${field("Colour", `<div class="swatches">${COLORS.map(c => `<label ${cvar(c)}><input type="radio" name="color" value="${c}" ${m.color === c ? "checked" : ""}><span></span></label>`).join("")}</div>`)}
      ${field("Exam date", input("exam", m.exam, 'type="date"'), "Optional. Recalls adapt to it.")}`,
    danger: id && { label: "Delete module", onClick: async () => {
      const n = Object.values(D.items).filter(it => it.module === id).length;
      if (!await confirmBox("Delete this module?", n ? `Its ${n} item${n > 1 ? "s" : ""} will be kept, without a module.` : `"${m.name}" will be removed.`)) return;
      for (const it of Object.values(D.items)) if (it.module === id) it.module = null;
      for (const d of Object.values(D.deadlines)) if (d.module === id) d.module = null;
      delete D.modules[id];
      save(); app.refresh();
    } },
    onSubmit: v => {
      const fields = { name: v.name.trim(), color: v.color, exam: v.exam || null };
      if (id) Object.assign(D.modules[id], fields);
      else D.modules[uid()] = { ...fields, order: Date.now() };
      save(); app.refresh();
    },
  });
}

export const actions = {
  ...assistantActions,
  addModule: () => openModule(null),
  editModule: el => openModule(el.dataset.id),
  checkUpdate: () => app.checkUpdate(true),

  setText: el => { D.settings[el.name] = el.value.trim(); save(); app.refresh(); },
  setNumber: el => {
    const n = Math.round(Number(el.value));
    if (n >= Number(el.min) && n <= Number(el.max)) D.settings[el.name] = n;
    save(); app.refresh();
  },
  setStart: el => {
    if (!el.value) return;
    D.settings.semesterStart = el.value;
    save(); app.refresh();
    if (parse(el.value).getDay() !== 1) toast("That day is not a Monday, so weeks will not start on Mondays.");
  },
  setExam: el => { D.modules[el.dataset.id].exam = el.value || null; save(); app.refresh(); },

  export: async () => {
    try { toast(`Backup saved: ${await exportBackup()}`); }
    catch (e) { toast("Could not save the backup: " + e, "error"); }
  },
  import: async el => {
    const file = el.files[0];
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
      if (!data || typeof data !== "object" || !data.items || !data.settings) throw new Error("not a Bloom backup");
    } catch (e) { toast("That file is not a Bloom backup.", "error"); return; }
    if (!await confirmBox("Restore this backup?", "Everything currently in Bloom will be replaced by the contents of this file.", "Restore")) return;
    await replaceAll(data);
    app.refresh();
    toast("Backup restored");
  },
};
