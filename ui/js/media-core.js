// Movies & series: the pure part of the page built on her Jellyfin library and her Jellyseerr
// requests (both on the homelab, over Tailscale). The requests themselves are in media.js.
//
// D.settings.media (absent until she connects; kept only in her data file):
//   { jellyfin: "http://host:8096", seerr: "http://host:5055" | "", user, password,
//     auto,                                       // true when made from the built-in connection
//     deviceId, token, userId, serverId,          // Jellyfin session
//     seerrCookie, seerrUserId }                  // Jellyseerr session (signed in with her Jellyfin account)

export const TMDB_IMG = "https://image.tmdb.org/t/p/";

/** "host:8096/" → "http://host:8096". The Jellyfin web path (/web/...) is dropped. "" when unusable. */
export function normUrl(text) {
  let s = String(text || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  let u;
  try { u = new URL(s); } catch { return ""; }
  if (!u.hostname) return "";
  let path = u.pathname.replace(/\/web(\/.*)?$/i, "").replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

/** The Authorization header Jellyfin expects, with the session token once there is one. */
export function jellyfinAuth(deviceId, token = "") {
  const q = v => String(v).replace(/"/g, "");
  return `MediaBrowser Client="Bloom", Device="Mac", DeviceId="${q(deviceId)}", Version="1.0"${token ? `, Token="${q(token)}"` : ""}`;
}

// ---- Jellyfin

/** What she did with a film or series: "watched", "started" (with pct) or "new". */
export function watchState(item) {
  const u = item?.UserData || {};
  if (u.Played) return { state: "watched", pct: 100 };
  const pct = Math.round(Number(u.PlayedPercentage) || 0);
  if (Number(u.PlaybackPositionTicks) > 0 || pct > 0) return { state: "started", pct: Math.min(99, Math.max(1, pct)) };
  return { state: "new", pct: 0 };
}

const TICKS_PER_MIN = 600_000_000;

/** A Jellyfin film, series or episode as the page shows it. */
export function libraryCard(item) {
  const type = item.Type === "Series" ? "series" : item.Type === "Episode" ? "episode" : "movie";
  const { state, pct } = watchState(item);
  const tmdb = item.ProviderIds?.Tmdb || item.ProviderIds?.tmdb || null;
  return {
    id: item.Id,
    type,
    title: type === "episode" ? item.SeriesName || item.Name : item.Name,
    episode: type === "episode" ? episodeLabel(item) : "",
    year: item.ProductionYear || null,
    overview: item.Overview || "",
    genres: item.Genres || [],
    minutes: item.RunTimeTicks ? Math.round(item.RunTimeTicks / TICKS_PER_MIN) : null,
    left: type !== "series" && item.RunTimeTicks && state === "started"
      ? Math.max(1, Math.round((item.RunTimeTicks - (item.UserData?.PlaybackPositionTicks || 0)) / TICKS_PER_MIN)) : null,
    unplayed: type === "series" ? item.UserData?.UnplayedItemCount ?? null : null,
    state, pct,
    tmdb: tmdb ? String(tmdb) : null,
    // the poster: an episode shows its series'
    imageId: type === "episode" ? (item.SeriesId || item.Id) : item.Id,
    imageTag: type === "episode" ? item.SeriesPrimaryImageTag || null : item.ImageTags?.Primary || null,
    seriesId: item.SeriesId || null,
    added: item.DateCreated || "",
    lastPlayed: item.UserData?.LastPlayedDate || "",
  };
}

export function episodeLabel(ep) {
  const s = ep.ParentIndexNumber, e = ep.IndexNumber;
  const code = s != null && e != null ? `S${s} · E${e}` : e != null ? `E${e}` : "";
  return [code, ep.Name].filter(Boolean).join(" — ");
}

export const STATES = [["all", "Everything"], ["new", "Not started"], ["started", "Started"], ["watched", "Watched"]];
export const KINDS = [["all", "All"], ["movie", "Films"], ["series", "Series"]];

/** The library cards that match the filters, in the asked order ("title" or "added"). */
export function filterLibrary(cards, { kind = "all", state = "all", query = "", sort = "title" } = {}) {
  const q = fold(query);
  const out = cards.filter(c =>
    (kind === "all" || c.type === kind) &&
    (state === "all" || c.state === state) &&
    (!q || fold(c.title).includes(q)));
  if (sort === "added") out.sort((a, b) => String(b.added).localeCompare(String(a.added)));
  return out;
}

/** Counts per state, for the filter chips. */
export function stateCounts(cards, kind = "all") {
  const n = { all: 0, new: 0, started: 0, watched: 0 };
  for (const c of cards) if (kind === "all" || c.type === kind) { n.all++; n[c.state]++; }
  return n;
}

export const fold = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/**
 * "Continue watching": what she paused (newest first), then the next episode of the series she is
 * following, one card per series.
 */
export function continueList(resume, nextUp, max = 12) {
  const out = [], series = new Set();
  for (const it of [...resume, ...nextUp]) {
    const c = libraryCard(it);
    if (c.type === "episode") {
      if (series.has(c.seriesId)) continue;
      series.add(c.seriesId);
    }
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

/** Episodes grouped by season, for a series' details. */
export function bySeason(episodes) {
  const seasons = new Map();
  for (const ep of episodes) {
    const n = ep.ParentIndexNumber ?? 0;
    if (!seasons.has(n)) seasons.set(n, { number: n, name: ep.SeasonName || (n ? `Season ${n}` : "Specials"), episodes: [] });
    seasons.get(n).episodes.push({ id: ep.Id, number: ep.IndexNumber ?? null, name: ep.Name || "", ...watchState(ep) });
  }
  return [...seasons.values()].sort((a, b) => (a.number || 999) - (b.number || 999));
}

export const jellyfinImage = (base, id, tag, height = 330) =>
  `${base}/Items/${encodeURIComponent(id)}/Images/Primary?fillHeight=${height}&quality=85${tag ? `&tag=${encodeURIComponent(tag)}` : ""}`;

/** The page of a film or series in Jellyfin's web app, where Play is. */
export const jellyfinWebUrl = (base, id, serverId) =>
  `${base}/web/#/details?id=${encodeURIComponent(id)}${serverId ? `&serverId=${encodeURIComponent(serverId)}` : ""}`;

/** "movie:603" / "tv:1399" → the Jellyfin card, to show Play on what is already there. */
export function tmdbIndex(cards) {
  const map = new Map();
  for (const c of cards) if (c.tmdb && c.type !== "episode") map.set(`${c.type === "series" ? "tv" : "movie"}:${c.tmdb}`, c);
  return map;
}

// ---- Jellyseerr

/** Jellyseerr's media status: 1 unknown, 2 pending, 3 processing, 4 partly available, 5 available,
 *  6 blocklisted, 7 deleted. `key` drives the badge and whether she can ask for it. */
export function mediaStatus(info) {
  const s = info?.status;
  if (s === 5) return { key: "available", label: "Available" };
  if (s === 4) return { key: "partial", label: "Partly available", canRequest: true };
  if (s === 3) {
    const pct = downloadPct(info);
    return { key: "coming", label: pct != null ? `Downloading · ${pct}%` : "On its way", pct };
  }
  if (s === 2) return { key: "pending", label: "Waiting for approval" };
  if (s === 6) return { key: "blocked", label: "Cannot be requested" };
  return { key: "none", label: "", canRequest: true };
}

/** How far the download is, from Radarr's or Sonarr's queue as Jellyseerr reports it; null when unknown. */
export function downloadPct(info) {
  const list = Array.isArray(info?.downloadStatus) ? info.downloadStatus : [];
  let size = 0, left = 0;
  for (const d of list) { size += Number(d.size) || 0; left += Number(d.sizeLeft) || 0; }
  if (!size) return null;
  return Math.max(0, Math.min(100, Math.round(100 * (1 - left / size))));
}

/** A search or discover result (films and series only; people are dropped by the caller). */
export function seerrCard(r) {
  const type = r.mediaType === "tv" ? "tv" : "movie";
  const date = r.releaseDate || r.firstAirDate || "";
  return {
    tmdb: r.id,
    type,
    title: r.title || r.name || r.originalTitle || r.originalName || "",
    year: date ? date.slice(0, 4) : "",
    overview: r.overview || "",
    poster: r.posterPath ? `${TMDB_IMG}w342${r.posterPath}` : null,
    status: mediaStatus(r.mediaInfo),
  };
}

export const isTitle = r => r && (r.mediaType === "movie" || r.mediaType === "tv");

/**
 * The seasons of a series still worth asking for: not available, not already requested
 * (a declined request does not count). `details` is GET /api/v1/tv/{id}.
 */
export function requestableSeasons(details) {
  const taken = new Set();
  for (const s of details?.mediaInfo?.seasons || []) if (s.status >= 2 && s.status <= 5) taken.add(s.seasonNumber);
  for (const req of details?.mediaInfo?.requests || []) {
    if (req.status === 3) continue; // declined
    for (const s of req.seasons || []) taken.add(s.seasonNumber);
  }
  return (details?.seasons || [])
    .filter(s => s.seasonNumber > 0 && !taken.has(s.seasonNumber))
    .map(s => ({ number: s.seasonNumber, name: s.name || `Season ${s.seasonNumber}`, episodes: s.episodeCount ?? null }));
}

export function requestBody(type, tmdb, seasons = []) {
  return type === "tv"
    ? { mediaType: "tv", mediaId: Number(tmdb), seasons: seasons.map(Number) }
    : { mediaType: "movie", mediaId: Number(tmdb) };
}

/** One of her requests: 1 waiting for approval, 2 approved, 3 declined, 4 failed, 5 completed. */
export function requestRow(req) {
  const media = req.media || {};
  const type = (media.mediaType || req.type) === "tv" ? "tv" : "movie";
  let status;
  if (req.status === 1) status = { key: "pending", label: "Waiting for approval" };
  else if (req.status === 3) status = { key: "declined", label: "Declined" };
  else if (req.status === 4) status = { key: "failed", label: "Failed" };
  else {
    const m = mediaStatus(media);
    status = m.key === "available" || m.key === "partial" || m.key === "coming" ? m : { key: "coming", label: "On its way" };
  }
  return {
    id: req.id,
    tmdb: media.tmdbId,
    type,
    seasons: (req.seasons || []).map(s => s.seasonNumber).filter(n => n > 0).sort((a, b) => a - b),
    date: String(req.createdAt || "").slice(0, 10),
    status,
  };
}

/** "Season 1", "Seasons 1–3", "Seasons 1, 3, 4". */
export function seasonsLabel(list) {
  if (!list.length) return "";
  if (list.length === 1) return `Season ${list[0]}`;
  const run = list.every((n, i) => !i || n === list[i - 1] + 1);
  return `Seasons ${run ? `${list[0]}–${list.at(-1)}` : list.join(", ")}`;
}

/**
 * Whether to connect with the connection built into the app: she has none yet, or hers was made
 * from an older built-in one that has since changed. A connection set by hand is left alone.
 */
export function needsAutoConnect(current, builtIn) {
  if (!builtIn?.jellyfin || !builtIn?.user) return false;
  if (!current?.token) return true;
  if (!current.auto) return false;
  return current.jellyfin !== builtIn.jellyfin || (current.seerr || "") !== (builtIn.seerr || "")
    || String(current.user).toLowerCase() !== String(builtIn.user).toLowerCase();
}

/** The built-in connection from the BLOOM_MEDIA secret's JSON, cleaned; null when unusable. */
export function readBuiltIn(json) {
  let v;
  try { v = typeof json === "string" ? JSON.parse(json) : json; } catch { return null; }
  const jellyfin = normUrl(v?.jellyfin);
  const user = String(v?.user || "").trim();
  if (!jellyfin || !user) return null;
  return { jellyfin, seerr: v.seerr ? normUrl(v.seerr) : "", user, password: String(v.password || "") };
}

/** A failure in her words. `e.code`: "unreachable", "auth", "seerr-auth" or an HTTP status. */
export function mediaError(e, what = "your library") {
  const code = e?.code;
  if (code === "unreachable") return `Bloom cannot reach ${what}. Is Tailscale on?`;
  if (code === "auth") return "Jellyfin did not accept the username or password.";
  if (code === "seerr-auth") return "Jellyseerr did not accept the sign-in.";
  return e?.message || String(e);
}
