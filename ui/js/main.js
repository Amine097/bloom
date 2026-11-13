// Start-up, navigation, event wiring and the update prompt.
import { D, load, save, onSaveError, inApp, pendingRecalls, deadlinesList, tasksList, currentWeek } from "./store.js";
import { today, addDays, weekLabel } from "./dates.js";
import { $, esc, icon, app, toast, openModal, bindModal, field, input, FLOWER } from "./ui.js";
import * as dashboard from "./views/dashboard.js";
import * as todo from "./views/todo.js";
import * as deadlines from "./views/deadlines.js";
import * as courses from "./views/courses.js";
import * as settings from "./views/settings.js";
import * as notebook from "./views/notebook.js";
import * as planner from "./views/planner.js";
import { mountScene } from "./scene.js";

const VIEWS = {
  dashboard: { label: "Dashboard", icon: "home", mod: dashboard },
  todo: { label: "To-do", icon: "todo", mod: todo },
  deadlines: { label: "Deadlines", icon: "flag", mod: deadlines },
  courses: { label: "Courses", icon: "book", mod: courses },
  planner: { label: "Planner", icon: "spark", mod: planner },
  notebook: { label: "Notebook", icon: "note", mod: notebook },
  settings: { label: "Settings", icon: "gear", mod: settings },
};

/** Small per-device preferences (not her data): which view was open. */
const pref = {
  get: k => { try { return localStorage.getItem("bloom_" + k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem("bloom_" + k, v); } catch { /* private mode */ } },
};

let current = VIEWS[pref.get("view")] ? pref.get("view") : "dashboard";
let shownDay = today();

function applyTheme() {
  const t = D.settings.theme;
  const dark = t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.bg = D.settings.background === "plain" ? "plain" : "nature";
}

function renderNav() {
  const now = today();
  const counts = {
    todo: tasksList().filter(t => !t.done && t.due && t.due <= now).length,
    deadlines: deadlinesList().filter(d => !d.done && d.due.slice(0, 10) <= addDays(now, 7)).length,
    courses: pendingRecalls().filter(r => r.due <= now).length,
  };
  const item = key => `<button class="nav-item" data-nav="${key}" title="${VIEWS[key].label}" ${current === key ? 'aria-current="page"' : ""}><span class="bubble">${icon(VIEWS[key].icon, 17)}</span><span class="nav-label">${VIEWS[key].label}</span>${counts[key] ? `<span class="count">${counts[key]}</span>` : ""}</button>`;
  const cw = currentWeek();
  const name = D.settings.name || "Bloom";
  const alerts = counts.todo + counts.deadlines + counts.courses;
  $("#nav").innerHTML = `
    <div class="brand"><span class="logo">${FLOWER}</span><b>Bloom</b></div>
    <div class="nav-list">${["dashboard", "todo", "deadlines", "courses", "planner", "notebook", "settings"].map(item).join("")}</div>
    <span class="grow"></span>
    <div class="profile">
      <div class="avatar">${esc(name[0].toUpperCase())}${alerts ? `<span class="count" title="Things waiting today">${alerts}</span>` : ""}</div>
      <b>${esc(name)}</b>
      <small>${cw >= 1 ? `Week ${cw} · ${weekLabel(cw, D.settings.semesterStart)}` : "Before week 1"}</small>
    </div>`;
}

function refresh() {
  applyTheme();
  renderNav();
  const main = $("#main");
  const y = main.scrollTop;
  main.dataset.view = current;
  main.innerHTML = VIEWS[current].mod.render();
  main.scrollTop = y;
}

function go(view) {
  if (!VIEWS[view]) return;
  current = view;
  pref.set("view", view);
  refresh();
  $("#main").scrollTop = 0;
}

const handler = name => VIEWS[current].mod.actions[name];

function bindEvents() {
  document.addEventListener("click", e => {
    const nav = e.target.closest("[data-nav]");
    if (nav) return go(nav.dataset.nav);
    const el = e.target.closest("#main [data-act]");
    if (el) handler(el.dataset.act)?.(el, e);
  });
  document.addEventListener("change", e => {
    const el = e.target.closest("#main [data-change]");
    if (el) handler(el.dataset.change)?.(el, e);
  });
  document.addEventListener("input", e => {
    const el = e.target.closest("#main [data-input]");
    if (el) handler(el.dataset.input)?.(el, e);
  });
  // shortcuts belong to the view on screen (its `onKey`), never while a dialog or the PDF viewer is open
  document.addEventListener("keydown", e => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    if (!$("#modal").hidden || !$("#viewer").hidden) return;
    if (e.target.closest?.("input, select, textarea, [contenteditable]")) return;
    VIEWS[current].mod.onKey?.(e);
  });
  document.addEventListener("submit", e => {
    const form = e.target.closest("#main [data-submit]");
    if (!form) return;
    e.preventDefault();
    handler(form.dataset.submit)?.(form, e);
  });
  // an app left open overnight should not keep showing yesterday
  // (and a new week gets its plan, whichever view is open)
  const rollover = () => { if (today() !== shownDay) { shownDay = today(); refresh(); planner.onStart(); } };
  setInterval(rollover, 60_000);
  document.addEventListener("visibilitychange", rollover);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
}

/** Asks before installing anything. `manual` is true when she pressed "Check for updates". */
async function checkUpdate(manual = false) {
  if (!inApp) { if (manual) toast("Updates only exist in the installed app."); return; }
  let update;
  try {
    update = await window.__TAURI__.updater.check();
  } catch (e) {
    if (manual) toast("Could not check for updates. Are you online?", "error");
    return;
  }
  if (!update) { if (manual) toast("Bloom is up to date 🌸"); return; }
  openModal({
    title: `Bloom ${update.version} is ready`,
    body: `<p class="lead">A new version is available${app.version ? ` (you have ${esc(app.version)})` : ""}.</p>
      ${update.body ? `<div class="notes">${esc(update.body)}</div>` : ""}
      <p class="muted">Your lectures, deadlines and to-dos stay exactly as they are. Bloom restarts once the update is installed.</p>
      <p class="muted" id="update-status"></p>`,
    submit: "Update now", cancel: "Later",
    onSubmit: async (values, form) => {
      form.querySelectorAll("button").forEach(b => { b.disabled = true; });
      const status = $("#update-status");
      try {
        let total = 0, got = 0;
        await update.downloadAndInstall(ev => {
          if (ev.event === "Started") total = ev.data.contentLength || 0;
          if (ev.event === "Progress") { got += ev.data.chunkLength; status.textContent = total ? `Downloading… ${Math.round(100 * got / total)}%` : "Downloading…"; }
          if (ev.event === "Finished") status.textContent = "Installing…";
        });
        await window.__TAURI__.process.relaunch();
      } catch (e) {
        form.querySelectorAll("button").forEach(b => { b.disabled = false; });
        status.textContent = "The update could not be installed. Nothing was changed; try again later.";
      }
      return false;
    },
  });
}

function welcome() {
  openModal({
    title: "Welcome to Bloom",
    body: `<div class="welcome">${FLOWER}</div>
      <p class="lead">Your semester in one place: lectures, recalls, deadlines and to-dos.</p>
      ${field("What should Bloom call you?", input("name", "", 'autofocus placeholder="Your first name"'))}
      <p class="muted">To start, open <b>Courses</b> and tick the lectures you have already seen. Bloom plans the recalls from there.</p>`,
    submit: "Let's go", cancel: "",
    onSubmit: v => {
      D.settings.name = v.name.trim();
      D.settings.welcomed = true;
      save(); refresh();
    },
  });
}

async function start() {
  Object.assign(app, { refresh, go, checkUpdate, version: "" });
  bindModal();
  try {
    await load();
  } catch (e) {
    // never start from empty over a file that exists but cannot be read
    $("#main").innerHTML = `<div class="empty fatal"><h2>Bloom could not open your data</h2><p>Nothing was changed. Close Bloom and ask for help before trying again.</p><p class="mono">${esc(e?.message || e)}</p></div>`;
    return;
  }
  onSaveError(e => toast("Could not save: " + (e?.message || e), "error"));
  bindEvents();
  todo.bindDrag($("#main"));
  mountScene();
  if (inApp) {
    try { app.version = await window.__TAURI__.app.getVersion(); } catch { /* shown as blank */ }
  }
  refresh();
  planner.onStart();
  if (!D.settings.welcomed) welcome();
  else checkUpdate();
}

start();
