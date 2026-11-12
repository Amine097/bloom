// Settings: semester, recall timings, setting up Claude, modules and exam dates, backups, updates.
import { D, save, uid, modulesSorted, itemsList, exportBackup, replaceAll } from "../store.js";
import { fmtWday, relDay, parse } from "../dates.js";
import { esc, icon, app, openModal, confirmBox, field, input, cvar, toast, COLORS } from "../ui.js";
import { assistantStatus, installClaude, signIn, cancelSignIn, signInWithTerminal } from "../assistant.js";

// ---- the Assistant card: installing Claude Code and signing in, without Terminal

/**
 * Survives changes of view. `status` is the last answer of assistantStatus() (null until the
 * first one); `busy` is "install" or "signin" while that is going on; `attempt` tells a sign-in
 * that was cancelled or replaced apart from the current one.
 */
const claude = { status: null, checking: false, checkedAt: 0, error: "", busy: null, via: "browser", terminalFirst: false, attempt: 0, poll: null, pollUntil: 0 };
const RECHECK_MS = 30_000;
const POLL_MS = 3_000;
const POLL_FOR_MS = 5 * 60_000;

/** Re-renders only when Settings is on screen. */
const refreshIfHere = () => { if (document.getElementById("main")?.dataset.view === "settings") app.refresh(); };

async function checkStatus() {
  if (claude.checking) return;
  claude.checking = true;
  try {
    claude.status = await assistantStatus();
    if (claude.status.loggedIn) claude.error = "";
  } catch (e) {
    if (!claude.status) claude.error = e?.message || String(e);
  } finally {
    claude.checking = false;
    claude.checkedAt = Date.now();
    refreshIfHere();
  }
}

function stopPolling() {
  clearInterval(claude.poll);
  claude.poll = null;
}

function connected(status) {
  stopPolling();
  claude.attempt += 1; // a sign-in still running in the background no longer matters
  Object.assign(claude, { status, busy: null, error: "", terminalFirst: false, checkedAt: Date.now() });
  toast("Claude is connected 🌸");
  refreshIfHere();
}

/** While she signs in elsewhere, asks every few seconds whether it is done. */
function startPolling() {
  stopPolling();
  claude.pollUntil = Date.now() + POLL_FOR_MS;
  let asking = false;
  claude.poll = setInterval(async () => {
    if (Date.now() > claude.pollUntil) {
      stopPolling();
      claude.attempt += 1;
      Object.assign(claude, { busy: null, error: "The sign-in was not finished in time. Try again." });
      refreshIfHere();
      return;
    }
    if (asking) return;
    asking = true;
    try {
      const s = await assistantStatus();
      if (s.loggedIn && claude.poll) connected(s);
    } catch { /* try again on the next tick */ }
    finally { asking = false; }
  }, POLL_MS);
}

const planText = plan => (plan ? `${plan[0].toUpperCase()}${plan.slice(1)} plan` : "");

/** The Assistant card for the current state. Every string from the CLI goes through esc(). */
function assistantCard() {
  const s = claude.status;
  const head = pill => `<div class="card-h"><h3>Assistant</h3><span class="grow"></span>${pill}</div>`;
  const working = text => `<p class="as-working"><span class="nb-spin small" aria-hidden="true"></span> ${text}</p>`;
  const error = claude.error ? `<p class="as-error">${esc(claude.error)}</p>` : "";
  const card = (pill, body) => `<section class="card" aria-live="polite">${head(pill)}<div class="card-b">${body}</div></section>`;

  if (!s) {
    if (!claude.error) return card("", working("Checking…"));
    return card("", `<p class="muted">Bloom could not check whether Claude is set up.</p>${error}
      <div class="btns"><button class="btn ghost small" data-act="claudeCheck">Check again</button></div>`);
  }

  if (!s.installed) {
    const intro = `<p class="muted">Bloom uses Claude to write study guides and quizzes. It needs a small helper from Anthropic, installed once.</p>`;
    if (claude.busy === "install") return card(`<span class="pill">not set up</span>`, `${intro}${working("Installing… this can take a minute")}`);
    return card(`<span class="pill">not set up</span>`, `${intro}${error}
      <div class="btns"><button class="btn primary" data-act="claudeInstall">${icon("spark", 16)} Set up Claude</button></div>`);
  }

  if (!s.loggedIn) {
    const pill = `<span class="pill">not signed in</span>`;
    if (claude.busy === "signin") {
      const where = claude.via === "terminal"
        ? "A Terminal window has opened. Follow the steps there to sign in to Claude, then come back here."
        : "Your browser has opened. Sign in to Claude there, then come back here.";
      return card(pill, `${working(where)}
        <div class="btns as-btns"><button class="btn ghost small" data-act="claudeCancel">Cancel</button>
          ${claude.via === "terminal" ? "" : `<button class="link" data-act="claudeTerminal">Nothing opened? Sign in through Terminal</button>`}</div>`);
    }
    const terminal = claude.terminalFirst
      ? `<button class="btn soft" data-act="claudeTerminal">Sign in through Terminal</button>`
      : `<button class="link" data-act="claudeTerminal">Nothing opens? Sign in through Terminal</button>`;
    return card(pill, `<p class="muted">Bloom uses Claude to write study guides and quizzes, with your own Claude account. Sign in once and it stays signed in.</p>${error}
      <div class="btns as-btns"><button class="btn ${claude.terminalFirst ? "ghost" : "primary"}" data-act="claudeSignIn">Sign in to Claude</button>${terminal}</div>`);
  }

  const who = [s.email ? `<b>${esc(s.email)}</b>` : "", esc(planText(s.plan))].filter(Boolean).join(" · ");
  return card(`<span class="pill ok">${icon("check", 13)} connected</span>`,
    `<p class="muted">Study guides and quizzes in the Notebook are written by Claude, with your own Claude account.</p>
    ${who ? `<p>${who}</p>` : ""}
    <div class="btns"><button class="btn ghost small" data-act="claudeCheck">${claude.checking ? '<span class="nb-spin small" aria-hidden="true"></span> ' : ""}Check again</button></div>`);
}

/** Starts a sign-in `via` "browser" or "terminal", and waits for the status to say it is done. */
async function beginSignIn(via) {
  const attempt = ++claude.attempt;
  Object.assign(claude, { busy: "signin", via, error: "" });
  app.refresh();
  startPolling();
  try {
    if (via === "terminal") {
      await cancelSignIn().catch(() => {}); // only one sign-in at a time
      await signInWithTerminal();
      return; // the polling notices when she is done
    }
    await signIn();
  } catch (e) {
    if (attempt !== claude.attempt) return; // cancelled or replaced meanwhile
    const s = await assistantStatus().catch(() => null);
    if (attempt !== claude.attempt) return;
    if (s?.loggedIn) { connected(s); return; }
    stopPolling();
    Object.assign(claude, { busy: null, error: e?.message || String(e), terminalFirst: true });
    refreshIfHere();
    return;
  }
  // the CLI says it is signed in: confirm at once instead of waiting for the next poll
  if (attempt !== claude.attempt) return;
  const s = await assistantStatus().catch(() => null);
  if (attempt === claude.attempt && s?.loggedIn) connected(s);
}

const assistantActions = {
  claudeCheck: () => {
    if (claude.checking) return;
    if (!claude.status) claude.error = "";
    checkStatus();
    app.refresh();
  },
  claudeInstall: async () => {
    if (claude.busy) return;
    Object.assign(claude, { busy: "install", error: "" });
    app.refresh();
    try {
      await installClaude();
      claude.status = await assistantStatus();
      claude.checkedAt = Date.now();
    } catch (e) {
      claude.error = e?.message || String(e);
    } finally {
      claude.busy = null;
      refreshIfHere();
    }
  },
  claudeSignIn: () => { if (!claude.busy) beginSignIn("browser"); },
  claudeTerminal: () => { if (claude.busy !== "signin" || claude.via !== "terminal") beginSignIn("terminal"); },
  claudeCancel: () => {
    stopPolling();
    claude.attempt += 1;
    claude.busy = null;
    cancelSignIn().catch(() => {});
    app.refresh();
  },
};

export function render() {
  // first visit: fetch the status; later visits: show the last one and refresh it quietly
  if (!claude.checking && !claude.busy && !(claude.error && !claude.status) && (!claude.status || Date.now() - claude.checkedAt > RECHECK_MS)) checkStatus();
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
        ${assistantCard()}
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
