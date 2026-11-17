// Movies & series: talking to her Jellyfin and Jellyseerr. In the app every request goes through
// the native shell (media_fetch, media_image, open_jellyfin_app in src-tauri/src/lib.rs); in the browser
// preview through scripts/preview.mjs (/api/media, /api/media-image). Pure logic: media-core.js.
import { D, save, uid } from "./store.js";
import { jellyfinAuth, requestBody } from "./media-core.js";

const tauri = window.__TAURI__;

class MediaError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

export const cfg = () => D.settings.media || null;

/** One request: resolves { status, body, cookie }. Throws MediaError("unreachable") when the server cannot be reached. */
async function http(method, url, { headers = {}, body } = {}) {
  const pairs = Object.entries(headers).filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, String(v)]);
  const text = body == null ? null : JSON.stringify(body);
  if (text != null) pairs.push(["Content-Type", "application/json"]);
  pairs.push(["Accept", "application/json"]);
  try {
    if (tauri) return await tauri.core.invoke("media_fetch", { method, url, headers: pairs, body: text });
    const res = await fetch("/api/media", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bloom-Ask": "1" },
      body: JSON.stringify({ method, url, headers: pairs, body: text }),
    });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(r.error || `preview error ${res.status}`);
    return r;
  } catch (e) {
    const msg = e?.message || String(e);
    if (msg.startsWith("unreachable")) throw new MediaError("unreachable", msg);
    throw e;
  }
}

function parse(r) {
  try { return r.body ? JSON.parse(r.body) : null; } catch { return null; }
}

function failed(r, what) {
  const data = parse(r);
  const why = data?.message || data?.error || (typeof r.body === "string" && r.body.length < 200 ? r.body.trim() : "");
  return new MediaError(r.status, `${what} answered ${r.status}${why ? `: ${why}` : ""}`);
}

// ---- Jellyfin

/** Signs in to Jellyfin; returns the session fields to keep. */
async function jellyfinLogin(base, user, password, deviceId) {
  const auth = jellyfinAuth(deviceId);
  const r = await http("POST", `${base}/Users/AuthenticateByName`, {
    headers: { Authorization: auth, "X-Emby-Authorization": auth },
    body: { Username: user, Pw: password || "" },
  });
  if (r.status === 401 || r.status === 403) throw new MediaError("auth");
  if (r.status !== 200) throw failed(r, "Jellyfin");
  const data = parse(r);
  if (!data?.AccessToken || !data?.User?.Id) throw new MediaError("bad", "Jellyfin answered something unexpected. Is this the Jellyfin address?");
  return { token: data.AccessToken, userId: data.User.Id, serverId: data.ServerId || data.User.ServerId || "", user: data.User.Name || user };
}

/** A request to Jellyfin with her session (GET unless `method`); signs in again once if the session was dropped. */
async function jf(path, params = {}, method = "GET") {
  const c = cfg();
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== "")).toString();
  const url = `${c.jellyfin}${path}${qs ? `?${qs}` : ""}`;
  for (let attempt = 0; ; attempt++) {
    const auth = jellyfinAuth(c.deviceId, c.token);
    const r = await http(method, url, { headers: { Authorization: auth, "X-Emby-Authorization": auth } });
    if (r.status === 401 && attempt === 0) {
      Object.assign(c, await jellyfinLogin(c.jellyfin, c.user, c.password, c.deviceId));
      save();
      continue;
    }
    if (r.status < 200 || r.status >= 300) throw failed(r, "Jellyfin");
    return parse(r);
  }
}

const FIELDS = "ProductionYear,Overview,Genres,ProviderIds,DateCreated";

/** Every film and series in her library, with what she watched. */
export async function library() {
  const c = cfg();
  const data = await jf("/Items", {
    userId: c.userId, IncludeItemTypes: "Movie,Series", Recursive: "true", Fields: FIELDS,
    EnableUserData: "true", EnableImageTypes: "Primary", ImageTypeLimit: "1", SortBy: "SortName", SortOrder: "Ascending",
  });
  return data?.Items || [];
}

/** What she paused, newest first, and the next episodes of the series she follows. */
export async function continueWatching() {
  const c = cfg();
  const [resume, next] = await Promise.all([
    jf("/Items", {
      userId: c.userId, Filters: "IsResumable", Recursive: "true", IncludeItemTypes: "Movie,Episode",
      SortBy: "DatePlayed", SortOrder: "Descending", Limit: "12", EnableUserData: "true", Fields: FIELDS,
    }),
    jf("/Shows/NextUp", { userId: c.userId, Limit: "12", EnableUserData: "true", Fields: FIELDS }).catch(() => null),
  ]);
  return { resume: resume?.Items || [], next: next?.Items || [] };
}

/** All episodes of a series, with what she watched. */
export async function episodes(seriesId) {
  const c = cfg();
  const data = await jf(`/Shows/${encodeURIComponent(seriesId)}/Episodes`, { userId: c.userId, EnableUserData: "true" });
  return data?.Items || [];
}

// ---- Jellyseerr

/** Her Jellyseerr session: a cookie from signing in with her Jellyfin account. */
async function seerrLogin(c) {
  const r = await http("POST", `${c.seerr}/api/v1/auth/jellyfin`, { body: { username: c.user, password: c.password || "" } });
  if (r.status === 401 || r.status === 403) throw new MediaError("seerr-auth");
  if (r.status !== 200 || !r.cookie) throw failed(r, "Jellyseerr");
  c.seerrCookie = r.cookie;
  c.seerrUserId = parse(r)?.id ?? null;
}

async function seerr(method, path, body) {
  const c = cfg();
  for (let attempt = 0; ; attempt++) {
    if (!c.seerrCookie) { await seerrLogin(c); save(); }
    const r = await http(method, `${c.seerr}/api/v1${path}`, { headers: { Cookie: c.seerrCookie }, body });
    if ((r.status === 401 || r.status === 403) && attempt === 0) {
      c.seerrCookie = "";
      continue;
    }
    if (r.status < 200 || r.status >= 300) throw failed(r, "Jellyseerr");
    return parse(r);
  }
}

/** Jellyseerr wants spaces as %20 and nothing left raw in the query. */
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());

export const DISCOVER = {
  trending: { label: "Trending", path: "/discover/trending" },
  movies: { label: "Popular films", path: "/discover/movies" },
  tv: { label: "Popular series", path: "/discover/tv" },
};

/** A page of results: a search when `query` is given, else one of DISCOVER. */
export async function discover({ query = "", list = "trending", page = 1 } = {}) {
  const path = query.trim()
    ? `/search?query=${enc(query.trim())}&page=${page}&language=en`
    : `${DISCOVER[list]?.path || DISCOVER.trending.path}?page=${page}&language=en`;
  const data = await seerr("GET", path);
  return { results: data?.results || [], page: data?.page || page, pages: data?.totalPages || 1 };
}

export const details = (type, tmdb) => seerr("GET", `/${type === "tv" ? "tv" : "movie"}/${encodeURIComponent(tmdb)}?language=en`);

/** Asks for a film, or for the given seasons of a series. */
export function request(type, tmdb, seasons = []) {
  return seerr("POST", "/request", requestBody(type, tmdb, seasons));
}

/** Her latest requests. */
export async function myRequests() {
  const c = cfg();
  if (c.seerrUserId == null) {
    const me = await seerr("GET", "/auth/me");
    c.seerrUserId = me?.id ?? null;
    save();
  }
  const data = await seerr("GET", `/request?take=30&skip=0&sort=added&filter=all${c.seerrUserId != null ? `&requestedBy=${c.seerrUserId}` : ""}`);
  return (data?.results || []).filter(r => c.seerrUserId == null || r.requestedBy?.id == null || r.requestedBy.id === c.seerrUserId);
}

// ---- connecting

/**
 * Signs in to Jellyfin (and Jellyseerr when an address is given) and keeps the session in
 * D.settings.media. Nothing is kept when Jellyfin fails; a Jellyseerr failure is thrown after
 * Jellyfin is saved, with `e.partial` set.
 */
export async function connect({ jellyfin, seerr: seerrUrl, user, password, auto = false }) {
  const old = cfg();
  const deviceId = old?.deviceId || "bloom-" + uid();
  const session = await jellyfinLogin(jellyfin, user, password, deviceId);
  const c = { jellyfin, seerr: seerrUrl || "", user: session.user, password: password || "", deviceId, auto, seerrCookie: "", seerrUserId: null, ...session };
  D.settings.media = c;
  save();
  if (c.seerr) {
    try { await seerrLogin(c); save(); }
    catch (e) { e.partial = true; throw e; }
  }
  return c;
}

/**
 * The connection built into the app: ui/js/media-defaults.js, written by the build from the repo
 * secret BLOOM_MEDIA (scripts/media-defaults.mjs) and never committed. null when absent.
 */
let builtIn;
export async function builtInConnection() {
  if (builtIn === undefined) {
    builtIn = await import("./media-defaults.js").then(m => m.default || null, () => null);
  }
  return builtIn;
}

export function disconnect() {
  delete D.settings.media;
  save();
}

// ---- posters and links

const images = new Map(); // url → blob: URL, for the session
const waiting = new Map(); // url → promise
const MAX_IMAGES = 1500;

export const cachedImage = url => images.get(url) || null;

/** A Jellyfin poster as a blob: URL (the app's CSP only shows images it holds itself). */
export function loadImage(url) {
  if (images.has(url)) return Promise.resolve(images.get(url));
  if (waiting.has(url)) return waiting.get(url);
  const p = (async () => {
    let data;
    if (tauri) data = await tauri.core.invoke("media_image", { url });
    else {
      const res = await fetch("/api/media-image", { method: "POST", headers: { "Content-Type": "application/json", "X-Bloom-Ask": "1" }, body: JSON.stringify({ url }) });
      if (!res.ok) throw new Error("no image");
      data = await res.blob();
    }
    const blobUrl = URL.createObjectURL(data instanceof Blob ? data : new Blob([data]));
    if (images.size >= MAX_IMAGES) {
      const [oldest, old] = images.entries().next().value;
      images.delete(oldest);
      URL.revokeObjectURL(old);
    }
    images.set(url, blobUrl);
    return blobUrl;
  })().finally(() => waiting.delete(url));
  waiting.set(url, p);
  return p;
}

// ---- Play: her Jellyfin app (Jellyfin Media Player, or Jellyfin Desktop) is started, then told
// through the server to play, as Jellyfin's own "play on" remote control does.

const DESKTOP_APP = /jellyfin (media player|desktop)/i;
const APP_WAIT_MS = 30_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Her Jellyfin app's session on the server, the most recently active; null when it is not running. */
async function appSession() {
  const c = cfg();
  const list = await jf("/Sessions", { controllableByUserId: c.userId });
  return (Array.isArray(list) ? list : [])
    .filter(s => DESKTOP_APP.test(s.Client || "") && s.SupportsRemoteControl !== false)
    .sort((a, b) => String(b.LastActivityDate || "").localeCompare(String(a.LastActivityDate || "")))[0] || null;
}

/**
 * Plays `itemId` (a film or an episode) in her Jellyfin app from `position` (ticks; 0 = the start),
 * opening the app first. Throws MediaError("no-app") when it is not on this Mac, ("no-session")
 * when it did not show up on the server in time.
 */
export async function playInApp(itemId, position = 0) {
  if (tauri) {
    try { await tauri.core.invoke("open_jellyfin_app"); }
    catch (e) { throw new MediaError("no-app", e?.message || String(e)); }
  }
  let s = await appSession();
  for (const until = Date.now() + APP_WAIT_MS; !s && Date.now() < until;) {
    await sleep(1500);
    s = await appSession();
  }
  if (!s) throw new MediaError("no-session");
  await jf(`/Sessions/${encodeURIComponent(s.Id)}/Playing`, {
    playCommand: "PlayNow", itemIds: itemId, startPositionTicks: position > 0 ? Math.floor(position) : "",
  }, "POST");
}

// ---- For you: TMDB's recommendations for a title, through Jellyseerr

export async function recommendations(type, tmdb) {
  const data = await seerr("GET", `/${type === "tv" ? "tv" : "movie"}/${encodeURIComponent(tmdb)}/recommendations?page=1&language=en`);
  return data?.results || [];
}

/** The best match for a title Claude suggested; null when Jellyseerr does not know it. */
export async function findTitle(title, year, type) {
  const data = await seerr("GET", `/search?query=${enc(title)}&page=1&language=en`);
  const list = (data?.results || []).filter(r => r.mediaType === (type === "tv" ? "tv" : "movie"));
  const y = Number(year) || 0;
  const near = r => Math.abs(Number(String(r.releaseDate || r.firstAirDate || "").slice(0, 4)) - y) <= 1;
  return (y ? list.find(near) : null) || list[0] || null;
}
