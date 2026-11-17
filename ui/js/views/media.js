// Movies & series: her Jellyfin library (what she watched, started, not touched yet), "For you"
// (suggestions from what she finished, picks-core.js) and, through Jellyseerr, films and series to ask
// for. Play starts her Jellyfin app and has it play; Bloom has no player.
// Requests: media.js. Pure logic: media-core.js, picks-core.js.
import { D, save } from "../store.js";
import { fmtDay, today } from "../dates.js";
import { esc, icon, app, toast, openModal, closeModal, field, input, $ } from "../ui.js";
import * as media from "../media.js";
import { askAssistant } from "../assistant.js";
import {
  normUrl, libraryCard, filterLibrary, stateCounts, continueList, bySeason, episodeToPlay, jellyfinImage,
  tmdbIndex, seerrCard, isTitle, requestableSeasons, requestRow, seasonsLabel, mediaError, needsAutoConnect,
  STATES, KINDS,
} from "../media-core.js";
import {
  PICKS, MORE, seedsFrom, tasteOf, rankCandidates, picksPrompt, parsePicks, algoPicks, toPick, keepBatch, dismiss,
  autoDue, keyOf, genreNames,
} from "../picks-core.js";

const view = { tab: "library", kind: "all", state: "all", query: "", sort: "title", list: "trending", search: "", connecting: false, error: "", draft: null };
const lib = { cards: null, cont: [], loading: false, error: null, at: 0 };
const disc = { key: "", results: [], page: 0, pages: 1, loading: false, error: null };
const reqs = { rows: null, loading: false, error: null, at: 0 };
/** Connecting by itself with the connection built into the app (media.builtInConnection), once per
 *  start: "idle", "busy", "failed" (with `error`) or "done". `manual`: she chose to set it by hand. */
const auto = { state: "idle", error: "", manual: false };
let autoRun = null;
/** "For you": `busy` is "fresh" or "more" while suggestions are being chosen; `tried`: asked once this start. */
const picks = { busy: null, error: "", note: "", tried: false };
const titles = new Map(); // "movie:603" → { title, year, poster }, from Jellyseerr

const LIB_STALE = 2 * 60_000;
const REQ_STALE = 60_000;
const here = () => $("#main")?.dataset.view === "media";
const refreshIfHere = () => { if (here()) app.refresh(); };
const cfg = media.cfg;

// ---- loading

/** Connects with the built-in connection when needed; one run at a time, shared by every caller. */
function autoConnect() {
  if (auto.state === "idle") autoRun = runAutoConnect();
  return autoRun || Promise.resolve();
}

async function runAutoConnect() {
  auto.state = "busy";
  try {
    const built = await media.builtInConnection();
    if (!needsAutoConnect(cfg(), built)) { auto.state = "done"; return; }
    refreshIfHere();
    try {
      await media.connect({ ...built, auto: true });
      resetAll();
      auto.state = "done";
    } catch (e) {
      // Jellyfin connected but not Jellyseerr: Discover signs in again by itself and says why it cannot
      if (e?.partial) { resetAll(); auto.state = "done"; }
      else Object.assign(auto, { state: "failed", error: mediaError(e, "your library") });
    }
  } finally {
    if (auto.state === "busy") auto.state = "done";
    refreshIfHere();
  }
}

let libRun = null;
function loadLibrary() {
  if (!lib.loading) libRun = runLoadLibrary();
  return libRun;
}

async function runLoadLibrary() {
  lib.loading = true;
  refreshIfHere();
  try {
    const [items, cont] = await Promise.all([media.library(), media.continueWatching().catch(() => ({ resume: [], next: [] }))]);
    lib.cards = items.map(libraryCard);
    lib.cont = continueList(cont.resume, cont.next);
    lib.error = null;
  } catch (e) {
    lib.error = mediaError(e, "your Jellyfin");
  } finally {
    lib.loading = false;
    lib.at = Date.now();
    refreshIfHere();
  }
}

const discKey = () => (view.search.trim() ? `q:${view.search.trim()}` : `l:${view.list}`);

async function loadDiscover(more = false) {
  if (disc.loading) return;
  const key = discKey();
  if (!more) Object.assign(disc, { key, results: [], page: 0, pages: 1 });
  disc.loading = true;
  disc.error = null;
  refreshIfHere();
  try {
    const r = await media.discover({ query: view.search, list: view.list, page: disc.page + 1 });
    if (disc.key !== key) return; // she searched for something else meanwhile
    const seen = new Set(disc.results.map(c => `${c.type}:${c.tmdb}`));
    for (const c of r.results.filter(isTitle).map(seerrCard)) if (!seen.has(`${c.type}:${c.tmdb}`)) disc.results.push(c);
    disc.page = r.page;
    disc.pages = r.pages;
  } catch (e) {
    if (disc.key === key) disc.error = mediaError(e, "Jellyseerr");
  } finally {
    disc.loading = false;
    refreshIfHere();
  }
}

/** Runs `fn` over `list`, `n` at a time. */
async function pool(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) await fn(list[i++]); }));
}

async function loadRequests() {
  if (reqs.loading) return;
  reqs.loading = true;
  refreshIfHere();
  try {
    const rows = (await media.myRequests()).map(requestRow);
    const missing = [...new Set(rows.map(r => `${r.type}:${r.tmdb}`))].filter(k => !titles.has(k));
    await pool(missing, 6, async k => {
      const [type, tmdb] = k.split(":");
      const d = await media.details(type, tmdb).catch(() => null);
      if (d) titles.set(k, seerrCard({ ...d, mediaType: type }));
    });
    reqs.rows = rows;
    reqs.error = null;
  } catch (e) {
    reqs.error = mediaError(e, "Jellyseerr");
  } finally {
    reqs.loading = false;
    reqs.at = Date.now();
    refreshIfHere();
  }
}

/** Starts whatever the open tab needs. Never during a render. */
function ensureLoaded() {
  if (!here() || !cfg()?.token) return;
  const now = Date.now();
  if (view.tab === "library" || view.tab === "discover" || view.tab === "foryou") {
    // the library also tells Discover what is already there
    if (!lib.loading && !lib.error && (!lib.cards || now - lib.at > LIB_STALE)) loadLibrary();
  }
  if (!cfg().seerr) return;
  if (view.tab === "discover" && !disc.loading && !disc.error && disc.key !== discKey()) loadDiscover();
  if (view.tab === "requests" && !reqs.loading && !reqs.error && (!reqs.rows || now - reqs.at > REQ_STALE)) loadRequests();
  if (view.tab === "foryou" && !picks.busy && !picks.tried && !D.mediaPicks.items.length) makePicks();
}

// ---- posters: Jellyfin's come through the native shell, a few at a time, as they scroll near

let observer = null;
const queue = [];
let active = 0;

function pump() {
  while (active < 6 && queue.length) {
    const img = queue.shift();
    if (!img.isConnected || img.getAttribute("src")) continue;
    active++;
    media.loadImage(img.dataset.jf)
      .then(url => { img.onerror = () => img.classList.add("none"); img.src = url; }, () => { img.classList.add("none"); })
      .finally(() => { active--; pump(); });
  }
}

function hydrate() {
  observer?.disconnect();
  const main = $("#main");
  observer = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) { observer.unobserve(e.target); queue.push(e.target); }
    pump();
  }, { root: main, rootMargin: "900px 0px" });
  for (const img of document.querySelectorAll("#main img[data-jf]:not([src])")) observer.observe(img);
  for (const img of document.querySelectorAll("#modal img[data-jf]:not([src])")) queue.push(img);
  pump();
}

function poster(url, alt = "") {
  if (!url) return `<span class="mv-noimg">${icon("film", 28)}</span>`;
  if (url.startsWith("https://image.tmdb.org/")) return `<img src="${esc(url)}" alt="${esc(alt)}" loading="lazy">`;
  const ready = media.cachedImage(url);
  return ready ? `<img src="${esc(ready)}" alt="${esc(alt)}">` : `<img data-jf="${esc(url)}" alt="${esc(alt)}">`;
}

const jfPoster = (c, h = 330) => jellyfinImage(cfg().jellyfin, c.imageId, c.imageTag, h);

// ---- For you: suggestions from what she finished (picks-core.js)

/**
 * Chooses suggestions: TMDB's recommendations of what she watched give the candidates, Claude picks
 * among them (and may add a few of its own); without Claude the best candidates are kept as they
 * are. `more` adds a few to those shown instead of replacing them. `auto`: the run at start, silent.
 */
async function makePicks({ more = false, auto = false } = {}) {
  const c = cfg();
  if (picks.busy || !c?.token || !c.seerr) return;
  Object.assign(picks, { busy: more ? "more" : "fresh", error: "", tried: true });
  refreshIfHere();
  try {
    if (!lib.cards || lib.loading) await loadLibrary();
    if (!lib.cards) throw new Error(lib.error || "Your library could not be read.");
    const seeds = seedsFrom(lib.cards);
    if (!seeds.length) throw new Error("Finish a few films or series first: the suggestions start from what you watched.");
    const lists = [];
    await pool(seeds, 4, async seed => {
      const results = await media.recommendations(seed.type, seed.tmdb).catch(() => null);
      if (results) lists.push({ seed, results });
    });
    if (!lists.length) throw new Error("Jellyseerr gave no recommendations. Try again in a moment.");
    const state = D.mediaPicks;
    const exclude = new Set([...tmdbIndex(lib.cards).keys(), ...state.dismissed, ...(more ? state.items.map(p => p.key) : [])]);
    const candidates = rankCandidates(lists, { exclude, avoid: new Set(state.shown) });
    if (!candidates.length) throw new Error("Nothing new to propose for now.");
    const count = more ? MORE : PICKS;
    let chosen, by = "claude";
    picks.note = "";
    try {
      const reply = await askAssistant(picksPrompt(tasteOf(lib.cards), candidates, count));
      const got = parsePicks(reply, candidates, count);
      chosen = got.picks;
      for (const idea of got.ideas) {
        const r = await media.findTitle(idea.title, idea.year, idea.type).catch(() => null);
        if (!r) continue;
        const card = seerrCard(r);
        const key = keyOf(card.type, card.tmdb);
        if (exclude.has(key) || card.status.key !== "none" || chosen.some(p => p.key === key)) continue;
        chosen.push({ ...card, key, genres: genreNames(r.genreIds), why: idea.why || "Picked for you by Claude." });
      }
    } catch (e) {
      by = "algo";
      chosen = algoPicks(candidates, count);
      picks.note = e?.code === "no-claude"
        ? "Claude is not set up, so these come straight from what you watched."
        : "Claude could not choose this time, so these come straight from what you watched.";
    }
    D.mediaPicks = keepBatch(state, chosen.map(toPick), { more, by, at: new Date().toISOString() });
    save();
  } catch (e) {
    picks.error = mediaError(e, "Jellyseerr");
    if (!auto && !here()) toast(picks.error, "error");
  } finally {
    picks.busy = null;
    refreshIfHere();
  }
}

function whenLabel(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return day === today() ? `today at ${time}` : `${fmtDay(day)} at ${time}`;
}

function pickCard(p) {
  if (!titles.has(p.key)) titles.set(p.key, { ...p, status: { key: "none", label: "" } });
  return `<div class="mv-pick">
      <button class="mv-card" data-act="openTitle" data-type="${p.type}" data-tmdb="${esc(p.tmdb)}">
        <span class="mv-poster">${poster(p.poster, p.title)}${p.asked ? `<span class="mv-badge pending">Asked for</span>` : ""}</span>
        <span class="mv-t">${esc(p.title)}</span><span class="mv-s">${esc([p.year, p.type === "tv" ? "Series" : "Film", p.genres?.[0]].filter(Boolean).join(" · "))}</span>
      </button>
      ${p.why ? `<p class="mv-why">${esc(p.why)}</p>` : ""}
      <button class="mv-x" data-act="dismissPick" data-key="${esc(p.key)}" title="Not for me" aria-label="Not for me: ${esc(p.title)}">${icon("close", 13)}</button>
    </div>`;
}

function forYouTab() {
  const s = D.mediaPicks;
  const busy = picks.busy;
  const sub = s.at
    ? `${s.by === "claude" ? "Chosen by Claude" : "From your favourites"} from what you watched · ${whenLabel(s.at)}`
    : "Films and series like the ones you finished.";
  const head = `<div class="mv-fy-h">
      <div><h2 class="mv-h">Picked for you</h2><p class="muted small">${esc(sub)}</p></div><span class="grow"></span>
      <button class="btn soft small" data-act="morePicks" ${busy ? "disabled" : ""}>${busy === "more" ? `<span class="nb-spin small"></span> Choosing…` : `${icon("spark", 15)} Propose more`}</button>
    </div>`;
  const working = busy === "fresh"
    ? `<div class="pl-working mv-working" role="status"><span class="nb-spin small" aria-hidden="true"></span><span>Claude is choosing films and series for you… This takes a minute.</span></div>` : "";
  const note = picks.note && !busy ? `<p class="muted small mv-note">${esc(picks.note)}</p>` : "";
  const err = picks.error && !busy ? errorCard(picks.error, "retryPicks") : "";
  const body = s.items.length
    ? `<div class="mv-grid mv-picks">${s.items.map(pickCard).join("")}</div>`
    : busy || err ? "" : `<div class="empty small">No suggestions yet. Press “Propose more”.</div>`;
  return `<section class="card mv-panel">${head}${working}${err}${note}${body}</section>`;
}

/** At start (main.js): connects by itself, then asks for fresh suggestions, in the background. */
export async function onStart() {
  await autoConnect();
  const c = cfg();
  if (c?.token && c.seerr && autoDue(D.mediaPicks)) makePicks({ auto: true });
}

// ---- the page

const pct = n => `<div class="mv-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${n}" aria-label="Watched"><i style="width:${n}%"></i></div>`;

function libCard(c) {
  const sub = [c.year, c.type === "series" ? "Series" : c.minutes ? `${c.minutes} min` : ""].filter(Boolean).join(" · ");
  const corner = c.state === "watched" ? `<span class="mv-done" title="Watched">${icon("check", 13)}</span>`
    : c.type === "series" && c.state === "started" && c.unplayed ? `<span class="mv-left">${c.unplayed} left</span>` : "";
  return `<button class="mv-card ${c.state}" data-act="openItem" data-id="${esc(c.id)}">
      <span class="mv-poster">${poster(jfPoster(c), c.title)}${corner}${c.state === "started" ? pct(c.pct) : ""}</span>
      <span class="mv-t">${esc(c.title)}</span><span class="mv-s">${esc(sub)}</span>
    </button>`;
}

function contCard(c) {
  const sub = c.type === "episode" ? c.episode : c.left ? `${c.left} min left` : c.year || "";
  return `<button class="mv-card started" data-act="openItem" data-id="${esc(c.id)}" data-cont="1">
      <span class="mv-poster">${poster(jfPoster(c), c.title)}${c.pct ? pct(c.pct) : `<span class="mv-left">Next</span>`}</span>
      <span class="mv-t">${esc(c.title)}</span><span class="mv-s">${esc(sub)}</span>
    </button>`;
}

function libraryBody() {
  const list = filterLibrary(lib.cards, view);
  if (!list.length) {
    return `<div class="empty small">${view.query ? `Nothing called “${esc(view.query)}” here.` : "Nothing here yet."}</div>`;
  }
  return `<div class="mv-grid">${list.map(libCard).join("")}</div>`;
}

const loading = what => `<section class="card"><div class="card-b mv-wait"><span class="nb-spin" aria-hidden="true"></span><p class="muted">${what}</p></div></section>`;

function errorCard(message, act) {
  return `<div class="banner mv-error" role="alert"><span>${icon("close", 16)} ${esc(message)}</span>
      <button class="btn ghost small" data-act="${act}">Try again</button></div>`;
}

function libraryTab() {
  if (!lib.cards) return lib.error ? errorCard(lib.error, "retryLibrary") : loading("Opening your library…");
  const counts = stateCounts(lib.cards, view.kind);
  const filtered = view.query || view.kind !== "all" || view.state !== "all";
  const cont = !filtered && lib.cont.length ? `<section class="card mv-panel">
      <h2 class="mv-h">Continue watching</h2>
      <div class="mv-row">${lib.cont.map(contCard).join("")}</div>
    </section>` : "";
  return `${lib.error ? errorCard(lib.error, "retryLibrary") : ""}${cont}
    <section class="card mv-panel">
      <div class="toolbar mv-tools">
        <input class="mv-search" type="search" placeholder="Search your library" value="${esc(view.query)}" data-input="query" aria-label="Search your library">
        <select class="pill-select" data-change="sort" aria-label="Order">
          <option value="title" ${view.sort === "title" ? "selected" : ""}>A to Z</option>
          <option value="added" ${view.sort === "added" ? "selected" : ""}>Recently added</option>
        </select>
      </div>
      <div class="toolbar mv-tools">
        <div class="nb-seg">${KINDS.map(([k, l]) => `<button class="nb-seg-b ${view.kind === k ? "on" : ""}" data-act="kind" data-k="${k}">${l}</button>`).join("")}</div>
        <span class="mv-gap"></span>
        ${STATES.map(([k, l]) => `<button class="chip ${view.state === k ? "on" : ""}" data-act="state" data-k="${k}">${l} <span class="mv-n">${counts[k]}</span></button>`).join("")}
      </div>
      <div id="mv-body">${libraryBody()}</div>
    </section>`;
}

function badge(c, inLib) {
  if (inLib && (c.status.key === "available" || c.status.key === "none")) return `<span class="mv-badge ok">In your library</span>`;
  if (c.status.key === "none") return "";
  return `<span class="mv-badge ${c.status.key}">${esc(c.status.label)}</span>`;
}

function discCard(c, index) {
  const inLib = index.get(`${c.type}:${c.tmdb}`);
  return `<button class="mv-card" data-act="openTitle" data-type="${c.type}" data-tmdb="${esc(c.tmdb)}">
      <span class="mv-poster">${poster(c.poster, c.title)}${badge(c, inLib)}</span>
      <span class="mv-t">${esc(c.title)}</span><span class="mv-s">${esc([c.year, c.type === "tv" ? "Series" : "Film"].filter(Boolean).join(" · "))}</span>
    </button>`;
}

function discoverTab() {
  const index = tmdbIndex(lib.cards || []);
  const searching = Boolean(view.search.trim());
  const tools = `<div class="toolbar mv-tools">
      <form class="mv-find" data-submit="search">
        <input class="mv-search" type="search" name="q" placeholder="Find a film or a series" value="${esc(view.search)}" aria-label="Find a film or a series">
        <button class="btn primary small">Search</button>
      </form>
      ${searching ? `<button class="btn ghost small" data-act="clearSearch">Back to ${esc(media.DISCOVER[view.list].label.toLowerCase())}</button>`
        : Object.entries(media.DISCOVER).map(([k, d]) => `<button class="chip ${view.list === k ? "on" : ""}" data-act="list" data-k="${k}">${d.label}</button>`).join("")}
    </div>`;
  let body;
  if (disc.error && !disc.results.length) body = errorCard(disc.error, "retryDiscover");
  else if (!disc.results.length) body = disc.loading ? loading(searching ? "Searching…" : "Looking for what is new…") : `<div class="empty small">Nothing found${searching ? ` for “${esc(view.search)}”` : ""}.</div>`;
  else {
    body = `${searching ? `<h2 class="mv-h">Results for “${esc(view.search.trim())}”</h2>` : ""}
      <div class="mv-grid">${disc.results.map(c => discCard(c, index)).join("")}</div>
      ${disc.error ? errorCard(disc.error, "more") : ""}
      ${disc.page < disc.pages && !disc.error ? `<div class="btns center mv-more"><button class="btn ghost" data-act="more" ${disc.loading ? "disabled" : ""}>${disc.loading ? `<span class="nb-spin small"></span> Loading…` : "Show more"}</button></div>` : ""}`;
  }
  return `<section class="card mv-panel">${tools}${body}</section>`;
}

function requestsTab() {
  if (!reqs.rows) return reqs.error ? errorCard(reqs.error, "retryRequests") : loading("Fetching your requests…");
  const rows = reqs.rows.map(r => {
    const t = titles.get(`${r.type}:${r.tmdb}`);
    const sub = [r.type === "tv" ? "Series" : "Film", r.type === "tv" ? seasonsLabel(r.seasons) : "", r.date ? `asked ${fmtDay(r.date)}` : ""].filter(Boolean).join(" · ");
    return `<button class="row mv-req" data-act="openTitle" data-type="${r.type}" data-tmdb="${esc(r.tmdb)}">
        <span class="mv-thumb">${poster(t?.poster, "")}</span>
        <span class="row-main"><span class="t">${esc(t?.title || "A title")}${t?.year ? ` <span class="muted">(${esc(t.year)})</span>` : ""}</span><span class="sub">${esc(sub)}</span></span>
        <span class="mv-badge ${r.status.key}">${esc(r.status.label)}</span>
      </button>`;
  }).join("");
  return `${reqs.error ? errorCard(reqs.error, "retryRequests") : ""}
    <section class="card mv-reqs">
      <div class="card-h"><h2>Your requests</h2><span class="grow"></span>
        <button class="btn ghost small" data-act="retryRequests" ${reqs.loading ? "disabled" : ""}>${reqs.loading ? `<span class="nb-spin small"></span>` : icon("repeat", 15)} Refresh</button></div>
      ${rows || `<div class="empty small">You have not asked for anything yet. Find a film or a series in Discover.</div>`}
    </section>`;
}

function connectForm(c = {}) {
  return `${field("Jellyfin address", input("jellyfin", c.jellyfin || "", 'placeholder="http://homelab:8096" autocomplete="off" spellcheck="false" required'))}
    ${field("Jellyseerr address", input("seerr", c.seerr || "", 'placeholder="http://homelab:5055" autocomplete="off" spellcheck="false"'), "Optional: to find and ask for films and series.")}
    <div class="grid2">
      ${field("Username", input("user", c.user || "", 'autocomplete="username" spellcheck="false" required'))}
      ${field("Password", input("password", c.password || "", 'type="password" autocomplete="current-password"'), "Leave empty if you have none.")}
    </div>`;
}

function setupPage() {
  return `<section class="card mv-setup"><div class="card-b">
      <div class="mv-setup-ic">${icon("film", 30)}</div>
      <h2>Connect your library</h2>
      <p class="muted">Bloom shows the films and series on your Jellyfin, with what you have watched and what you have started, and lets you ask for more through Jellyseerr. Both are reached over Tailscale; Play opens Jellyfin in your browser.</p>
      <form class="mv-form" data-submit="connect">
        ${connectForm(view.draft || cfg() || {})}
        ${view.error ? `<p class="mv-err" role="alert">${esc(view.error)}</p>` : ""}
        <div class="btns end"><button class="btn primary" ${view.connecting ? "disabled" : ""}>${view.connecting ? `<span class="nb-spin small"></span> Connecting…` : "Connect"}</button></div>
      </form>
    </div></section>`;
}

function autoPage() {
  if (auto.state === "failed") {
    return `<section class="card mv-setup"><div class="card-b">
        <div class="mv-setup-ic">${icon("film", 30)}</div>
        <h2>Your library is out of reach</h2>
        <p class="muted">${esc(auto.error)}</p>
        <div class="btns"><button class="btn primary" data-act="retryAuto">Try again</button>
          <button class="btn ghost" data-act="manual">Set it up by hand</button></div>
      </div></section>`;
  }
  return loading("Connecting to your library…");
}

export function render() {
  setTimeout(() => { autoConnect(); ensureLoaded(); hydrate(); }, 0);
  const c = cfg();
  const head = (tabs = "") => `<header class="page-h">
      <div><h1>Movies &amp; series</h1><p class="muted">${c?.token ? `Your Jellyfin${c.seerr ? ", and Jellyseerr to ask for more" : ""}` : "Your films and series, from Jellyfin"}</p></div>
      ${tabs}
    </header>`;
  if (!c?.token) return head() + (auto.state === "done" || auto.manual ? setupPage() : autoPage());
  if (!c.seerr && view.tab !== "library") view.tab = "library";
  const TABS = [["library", "Library"], ...(c.seerr ? [["foryou", "For you"], ["discover", "Discover"], ["requests", "Requests"]] : [])];
  const tabs = `<div class="mv-head-r">
      ${TABS.length > 1 ? `<div class="nb-seg" role="tablist">${TABS.map(([k, l]) => `<button class="nb-seg-b ${view.tab === k ? "on" : ""}" role="tab" aria-selected="${view.tab === k}" data-act="tab" data-k="${k}">${l}</button>`).join("")}</div>` : ""}
      ${view.tab === "library" ? `<button class="iconbtn" data-act="retryLibrary" title="Refresh" aria-label="Refresh" ${lib.loading ? "disabled" : ""}>${lib.loading && lib.cards ? `<span class="nb-spin small"></span>` : icon("repeat", 17)}</button>` : ""}
      <button class="iconbtn" data-act="connection" title="Connection" aria-label="Connection">${icon("gear", 17)}</button>
    </div>`;
  const body = view.tab === "discover" ? discoverTab() : view.tab === "requests" ? requestsTab() : view.tab === "foryou" ? forYouTab() : libraryTab();
  return head(tabs) + body;
}

// ---- details

const facts = list => list.filter(Boolean).map(esc).join(" · ");

function stateLine(c) {
  if (c.type === "series") {
    if (c.state === "watched") return "Watched every episode";
    if (c.state === "started") return `Started${c.unplayed ? ` · ${c.unplayed} episode${c.unplayed === 1 ? "" : "s"} left` : ""}`;
    return "Not started yet";
  }
  if (c.state === "watched") return "Watched";
  if (c.state === "started") return `Started · ${c.pct}%${c.left ? ` · ${c.left} min left` : ""}`;
  return "Not started yet";
}

function seasonsHtml(seasons) {
  if (!seasons.length) return `<p class="muted small">No episodes yet.</p>`;
  return seasons.map((s, i) => {
    const done = s.episodes.filter(e => e.state === "watched").length;
    return `<details class="mv-season" ${s.episodes.some(e => e.state !== "watched") && !seasons.slice(0, i).some(p => p.episodes.some(e => e.state !== "watched")) ? "open" : ""}>
        <summary><b>${esc(s.name)}</b><span class="muted small">${done}/${s.episodes.length} watched</span></summary>
        <ol class="mv-eps">${s.episodes.map(e => `<li class="${e.state}"><button type="button" class="mv-ep" data-ep="${esc(e.id)}" title="Play this episode in Jellyfin"><span class="mv-ep-n">${e.number ?? ""}</span><span class="mv-ep-t">${esc(e.name)}</span>
          ${e.state === "watched" ? `<span class="mv-done in">${icon("check", 12)}</span>` : e.state === "started" ? `<span class="mv-ep-p">${e.pct}%</span>` : ""}<span class="mv-ep-play">${icon("play", 13)}</span></button></li>`).join("")}</ol>
      </details>`;
  }).join("");
}

function openItem(id, fromCont) {
  const c = (fromCont ? lib.cont : lib.cards)?.find(x => x.id === id) || lib.cont.find(x => x.id === id);
  if (!c) return;
  const series = c.type === "series";
  let seasons = null; // a series' episodes, once loaded
  openModal({
    title: c.title,
    wide: true,
    body: `<div class="mv-detail">
        <span class="mv-poster big">${poster(jfPoster(c, 480), c.title)}</span>
        <div class="mv-info">
          ${c.type === "episode" ? `<p class="mv-ep-h">${esc(c.episode)}</p>` : ""}
          <p class="muted">${facts([c.year, series ? "Series" : c.type === "episode" ? "Episode" : "Film", c.minutes && !series ? `${c.minutes} min` : "", c.genres.slice(0, 3).join(", ")])}</p>
          <p class="mv-state ${c.state}">${esc(stateLine(c))}</p>
          ${c.state === "started" ? pct(c.pct) : ""}
          ${c.overview ? `<p class="mv-overview">${esc(c.overview)}</p>` : ""}
          ${series ? `<div id="mv-seasons"><p class="muted small"><span class="nb-spin small"></span> Loading the episodes…</p></div>` : ""}
        </div>
      </div>`,
    submit: "Play in Jellyfin",
    cancel: "Close",
    onSubmit: async (values, form) => ((await play(c, form.querySelector('button[type="submit"]'), seasons)) ? undefined : false),
  });
  hydrate();
  if (series) {
    media.episodes(c.id)
      .then(eps => {
        seasons = bySeason(eps);
        const box = $("#mv-seasons");
        if (!box) return;
        box.innerHTML = seasonsHtml(seasons);
        box.onclick = async e => {
          const b = e.target.closest("[data-ep]");
          const ep = b && seasons.flatMap(x => x.episodes).find(x => x.id === b.dataset.ep);
          if (ep && await play({ ...ep, type: "episode" }, b)) closeModal();
        };
      })
      .catch(e => { const box = $("#mv-seasons"); if (box) box.innerHTML = `<p class="mv-err">${esc(mediaError(e, "your Jellyfin"))}</p>`; });
  }
}

/**
 * Plays `c` in her Jellyfin app: a film or an episode from where she stopped, a series at the
 * episode she is on (episodeToPlay). `btn` shows the wait. Resolves true once Jellyfin plays it.
 */
async function play(c, btn, seasons = null) {
  const before = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = `<span class="nb-spin small"></span> Opening Jellyfin…`; }
  try {
    let target = c;
    if (c.type === "series") {
      target = episodeToPlay(seasons || bySeason(await media.episodes(c.id)));
      if (!target) throw new Error("This series has no episodes yet.");
    }
    await media.playInApp(target.id, target.state === "started" ? target.position : 0);
    toast("Playing in Jellyfin 🌸");
    return true;
  } catch (e) {
    toast(mediaError(e, "your Jellyfin"), "error");
    if (btn) { btn.disabled = false; btn.innerHTML = before; }
    return false;
  }
}

/** Updates the cards that show this title after she asked for it. */
function markRequested(type, tmdb, approved) {
  const status = approved ? { key: "coming", label: "On its way" } : { key: "pending", label: "Waiting for approval" };
  for (const c of disc.results) if (c.type === type && String(c.tmdb) === String(tmdb)) c.status = status;
  const pick = D.mediaPicks.items.find(p => p.key === keyOf(type, tmdb));
  if (pick) { pick.asked = true; save(); }
  reqs.rows = null;
}

function openTitle(type, tmdb) {
  const known = disc.results.find(c => c.type === type && String(c.tmdb) === String(tmdb)) || titles.get(`${type}:${tmdb}`);
  const inLib = tmdbIndex(lib.cards || []).get(`${type}:${tmdb}`);
  let seasons = null; // for a series, once its details are in
  // a series can still be asked for the seasons nobody asked for yet, whatever its status says
  const canAsk = s => !inLib && (type === "tv" ? s.key !== "available" && s.key !== "blocked" : s.canRequest);
  openModal({
    title: known?.title || "Details",
    wide: true,
    body: `<div class="mv-detail">
        <span class="mv-poster big">${poster(known?.poster, known?.title || "")}</span>
        <div class="mv-info" id="mv-title">
          <p class="muted">${facts([known?.year, type === "tv" ? "Series" : "Film"])}</p>
          ${known?.status && known.status.key !== "none" ? `<p class="mv-state">${esc(known.status.label)}</p>` : ""}
          ${inLib ? `<p class="mv-state ok">In your library · ${esc(stateLine(inLib))}</p>` : ""}
          ${known?.overview ? `<p class="mv-overview">${esc(known.overview)}</p>` : ""}
          <div id="mv-ask"><p class="muted small"><span class="nb-spin small"></span> Checking…</p></div>
        </div>
      </div>`,
    submit: inLib ? "Play in Jellyfin" : "Request",
    cancel: "Close",
    onSubmit: async (values, form) => {
      if (inLib) return (await play(inLib, form.querySelector('button[type="submit"]'))) ? undefined : false;
      const picked = type === "tv" ? (seasons || []).map(s => s.number).filter(n => values[`s${n}`]) : [];
      if (type === "tv" && !picked.length) { toast("Tick at least one season."); return false; }
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.innerHTML = `<span class="nb-spin small"></span> Requesting…`;
      try {
        const r = await media.request(type, tmdb, picked);
        markRequested(type, tmdb, r?.status === 2);
        toast(r?.status === 2 ? `${known?.title || "It"} is on its way 🌸` : `Asked for ${known?.title || "it"} 🌸 It waits for approval.`);
        refreshIfHere();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = "Request";
        const box = $("#mv-ask");
        if (box) box.innerHTML = `<p class="mv-err" role="alert">${esc(mediaError(e, "Jellyseerr"))}</p>`;
        return false;
      }
    },
  });
  const submit = () => $('#modal button[type="submit"]');
  if (!inLib) submit().disabled = true;
  hydrate();
  media.details(type, tmdb).then(d => {
    const card = seerrCard({ ...d, mediaType: type });
    titles.set(`${type}:${tmdb}`, card);
    const box = $("#mv-ask");
    if (!box) return;
    const head = $("#modal h2");
    if (head && !known) head.textContent = card.title;
    const overview = !known?.overview && card.overview ? `<p class="mv-overview">${esc(card.overview)}</p>` : "";
    if (inLib) { box.innerHTML = overview; return; }
    if (!canAsk(card.status)) {
      box.innerHTML = `${overview}<p class="muted small">${card.status.key === "available" ? "It is already on Jellyfin." : "It has already been asked for."}</p>`;
      submit()?.remove();
      return;
    }
    if (type === "tv") {
      seasons = requestableSeasons(d);
      if (!seasons.length) {
        box.innerHTML = `${overview}<p class="muted small">Every season is already available or asked for.</p>`;
        submit()?.remove();
        return;
      }
      box.innerHTML = `${overview}<div class="mv-pick"><p class="small"><b>Which seasons?</b></p>
          <div class="mv-seasons-pick">${seasons.map(s => `<label class="switch"><input type="checkbox" name="s${s.number}" checked> ${esc(s.name)}${s.episodes ? ` <span class="muted">(${s.episodes})</span>` : ""}</label>`).join("")}</div></div>`;
    } else box.innerHTML = overview;
    if (submit()) submit().disabled = false;
  }).catch(e => {
    const box = $("#mv-ask");
    if (box) box.innerHTML = `<p class="mv-err" role="alert">${esc(mediaError(e, "Jellyseerr"))}</p>`;
  });
}

function openConnection() {
  openModal({
    title: "Connection",
    body: `${connectForm(cfg() || {})}<p class="mv-err" id="mv-conn-err" role="alert" hidden></p>`,
    submit: "Save and reconnect",
    danger: { label: "Disconnect", onClick: () => { media.disconnect(); resetAll(); app.refresh(); toast("Disconnected from Jellyfin."); } },
    onSubmit: async (values, form) => {
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      const err = await doConnect(values);
      btn.disabled = false;
      if (!err) return;
      const p = $("#mv-conn-err");
      if (p) { p.textContent = err; p.hidden = false; }
      return false;
    },
  });
}

function resetAll() {
  Object.assign(lib, { cards: null, cont: [], loading: false, error: null, at: 0 });
  Object.assign(disc, { key: "", results: [], page: 0, pages: 1, loading: false, error: null });
  Object.assign(reqs, { rows: null, loading: false, error: null, at: 0 });
}

/** Connects with the form's values; returns an error message, or "" when Jellyfin is connected. */
async function doConnect(values) {
  const jellyfin = normUrl(values.jellyfin);
  const seerrUrl = values.seerr?.trim() ? normUrl(values.seerr) : "";
  const user = String(values.user || "").trim();
  if (!jellyfin) return "The Jellyfin address does not look right.";
  if (values.seerr?.trim() && !seerrUrl) return "The Jellyseerr address does not look right.";
  if (!user) return "Your Jellyfin username is needed.";
  try {
    await media.connect({ jellyfin, seerr: seerrUrl, user, password: values.password || "" });
    resetAll();
    toast("Connected to your library 🌸");
    app.refresh();
    return "";
  } catch (e) {
    if (e?.partial) {
      resetAll();
      app.refresh();
      toast("Jellyfin is connected, but " + mediaError(e, "Jellyseerr").replace(/^./, ch => ch.toLowerCase()), "error");
      return "";
    }
    return mediaError(e, "your Jellyfin");
  }
}

export const actions = {
  tab: el => { view.tab = el.dataset.k; app.refresh(); },
  kind: el => { view.kind = el.dataset.k; app.refresh(); },
  state: el => { view.state = el.dataset.k; app.refresh(); },
  sort: el => { view.sort = el.value; app.refresh(); },
  query: el => {
    view.query = el.value;
    const body = $("#mv-body");
    if (body && lib.cards) { body.innerHTML = libraryBody(); hydrate(); }
  },
  list: el => { view.list = el.dataset.k; app.refresh(); },
  search: form => { view.search = form.elements.q.value.trim(); disc.error = null; app.refresh(); },
  clearSearch: () => { view.search = ""; disc.error = null; app.refresh(); },
  more: () => { disc.error = null; loadDiscover(true); },
  retryLibrary: () => { lib.error = null; loadLibrary(); },
  retryDiscover: () => { disc.error = null; disc.key = ""; app.refresh(); },
  retryRequests: () => { reqs.error = null; loadRequests(); },
  retryAuto: () => { auto.state = "idle"; app.refresh(); },
  morePicks: () => makePicks({ more: D.mediaPicks.items.length > 0 }),
  retryPicks: () => makePicks(),
  dismissPick: el => {
    D.mediaPicks = dismiss(D.mediaPicks, el.dataset.key);
    save();
    app.refresh();
  },
  manual: () => { auto.manual = true; app.refresh(); },
  openItem: el => openItem(el.dataset.id, el.dataset.cont === "1"),
  openTitle: el => openTitle(el.dataset.type, el.dataset.tmdb),
  connection: () => openConnection(),
  connect: async form => {
    if (view.connecting) return;
    const values = Object.fromEntries(new FormData(form));
    Object.assign(view, { connecting: true, error: "", draft: values });
    app.refresh();
    const err = await doConnect(values);
    Object.assign(view, { connecting: false, error: err, draft: err ? values : null });
    app.refresh();
  },
};
