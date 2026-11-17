// "For you" on the Movies page: films and series to propose from what she has watched. TMDB's
// recommendations for what she finished (through Jellyseerr) give real titles she can ask for; Claude
// picks the ones closest to her taste among them, may add a few of its own, and says why. Without
// Claude the best candidates are shown as they are. Requests: media.js; page: views/media.js.
//
// D.mediaPicks (v9):
//   { at: "2026-11-17T12:00:00Z" | null, by: "claude" | "algo" | null,
//     items: [pick],           // what the tab shows, newest batch last
//     shown: [key],            // every title proposed lately (newest last), not proposed again soon
//     dismissed: [key] }       // "Not for me": never proposed again
//   pick = { key: "movie:603", type: "movie" | "tv", tmdb, title, year, poster, overview, genres, why }
import { extractJson } from "./notebook-core.js";
import { seerrCard, isTitle } from "./media-core.js";

export const PICKS = 12;
export const MORE = 8;
export const SEEDS_MAX = 8;
export const CANDIDATES_MAX = 45;
export const IDEAS_MAX = 3;
export const SHOWN_KEPT = 240;
export const DISMISSED_KEPT = 400;
/** Opening Bloom again within this time does not ask Claude again (a restart after an update, say). */
export const AUTO_GAP_MS = 30 * 60_000;

export const keyOf = (type, tmdb) => `${type === "tv" ? "tv" : "movie"}:${tmdb}`;

export const emptyPicks = () => ({ at: null, by: null, items: [], shown: [], dismissed: [] });

/** TMDB genre ids, films and series. */
export const GENRES = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime", 99: "Documentary", 18: "Drama",
  10751: "Family", 14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music", 9648: "Mystery", 10749: "Romance",
  878: "Science Fiction", 10770: "TV Movie", 53: "Thriller", 10752: "War", 37: "Western", 10759: "Action & Adventure",
  10762: "Kids", 10763: "News", 10764: "Reality", 10765: "Sci-Fi & Fantasy", 10766: "Soap", 10767: "Talk",
  10768: "War & Politics",
};
export const genreNames = ids => (Array.isArray(ids) ? ids.map(id => GENRES[id]).filter(Boolean) : []);

const recent = c => c.lastPlayed || c.added || "";
const byRecent = (a, b) => String(recent(b)).localeCompare(String(recent(a)));

/**
 * What the suggestions start from: films she watched, series she finished or is well into (a quarter
 * or more), most recent first. Each with a weight, so the latest count a little more.
 * `cards`: libraryCard()s of her library.
 */
export function seedsFrom(cards, max = SEEDS_MAX) {
  return cards
    .filter(c => c.tmdb && (c.type === "movie" || c.type === "series"))
    .filter(c => c.state === "watched" || (c.type === "series" && c.state === "started" && c.pct >= 25))
    .sort(byRecent)
    .slice(0, max)
    .map((c, i) => ({ key: keyOf(c.type === "series" ? "tv" : "movie", c.tmdb), type: c.type === "series" ? "tv" : "movie", tmdb: c.tmdb, title: c.title, weight: 1 - i * 0.06 }));
}

/** Her taste for the prompt: what she finished, then what she started, most recent first. */
export function tasteOf(cards) {
  const line = c => `- ${c.title}${c.year ? ` (${c.year})` : ""}, ${c.type === "series" ? "series" : "film"}${c.genres?.length ? ` — ${c.genres.slice(0, 3).join(", ")}` : ""}`;
  const finished = cards.filter(c => c.state === "watched" && c.type !== "episode").sort(byRecent).slice(0, 30).map(line);
  const started = cards.filter(c => c.state === "started" && c.type !== "episode").sort(byRecent).slice(0, 12).map(line);
  return { finished, started };
}

/**
 * The candidates, best first. `lists`: [{ seed, results }] with Jellyseerr's recommendations of
 * each seed. A title recommended by several of her favourites, and high in their lists, comes first.
 * `exclude`: keys never to propose (her library, dismissed, already on screen). Titles already
 * available, asked for or blocked in Jellyseerr are left out. Those in `avoid` (proposed lately)
 * go last.
 */
export function rankCandidates(lists, { exclude = new Set(), avoid = new Set(), max = CANDIDATES_MAX } = {}) {
  const found = new Map();
  const seeds = new Set(lists.map(l => l.seed.key)); // what she watched is never proposed back
  for (const { seed, results } of lists) {
    (results || []).filter(isTitle).forEach((r, rank) => {
      const card = seerrCard(r);
      const key = keyOf(card.type, card.tmdb);
      if (seeds.has(key) || exclude.has(key) || card.status.key !== "none") return;
      const gain = seed.weight / (rank + 4);
      const c = found.get(key) || { ...card, key, genres: genreNames(r.genreIds), score: 0, because: [], best: 0 };
      c.score += gain;
      if (!c.because.includes(seed.title)) c.because.push(seed.title);
      if (gain > c.best) { c.best = gain; c.because = [seed.title, ...c.because.filter(t => t !== seed.title)]; }
      found.set(key, c);
    });
  }
  const all = [...found.values()].sort((a, b) => b.score - a.score);
  return [...all.filter(c => !avoid.has(c.key)), ...all.filter(c => avoid.has(c.key))].slice(0, max);
}

const clip = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t; };

export function picksPrompt(taste, candidates, count = PICKS) {
  const cand = candidates.map(c => `${c.key} | ${c.title} | ${c.year || "?"} | ${c.type === "tv" ? "series" : "film"} | ${c.genres.join(", ") || "?"} | ${clip(c.overview, 160)}`);
  return `You suggest films and series to one person, from what she has watched on her home media server.

What she watched to the end, most recent first:
${taste.finished.join("\n") || "- (nothing yet)"}
${taste.started.length ? `\nWhat she has started:\n${taste.started.join("\n")}\n` : ""}
Candidates, from the recommendations of what she watched (key | title | year | type | genres | overview):
${cand.join("\n")}

Choose the ${count} candidates she is most likely to love: the same style, mood and kind of story as what she finished. Favour what matches several of her favourites, mix films and series when both fit, and avoid picking titles too alike each other.
You may also add up to ${IDEAS_MAX} titles that are not candidates but fit her taste very well; only well-known films or series that really exist, none she already watched.
For each, write "why": one short sentence in English (at most 20 words) naming what she watched that it is like and what she will find in it.

Answer with JSON only, no other text:
{"picks":[{"key":"movie:123","why":"..."}],"ideas":[{"title":"...","year":2019,"type":"movie","why":"..."}]}
"type" in ideas is "movie" or "tv".`;
}

/**
 * Claude's answer → { picks: [candidate + why], ideas: [{ title, year, type, why }] }. Keys that are
 * not candidates are dropped; so are repeats. Throws when the answer cannot be read.
 */
export function parsePicks(reply, candidates, count = PICKS) {
  const data = extractJson(reply);
  const byKey = new Map(candidates.map(c => [c.key, c]));
  const picks = [], seen = new Set();
  for (const p of Array.isArray(data.picks) ? data.picks : []) {
    const c = byKey.get(typeof p?.key === "string" ? p.key.trim() : "");
    if (!c || seen.has(c.key)) continue;
    seen.add(c.key);
    picks.push({ ...c, why: clip(p.why, 180) || becauseOf(c) });
    if (picks.length >= count) break;
  }
  const ideas = [];
  for (const i of Array.isArray(data.ideas) ? data.ideas : []) {
    const title = clip(i?.title, 120);
    if (!title || ideas.length >= IDEAS_MAX) continue;
    ideas.push({ title, year: Number(i.year) || null, type: i.type === "tv" ? "tv" : "movie", why: clip(i.why, 180) });
  }
  if (!picks.length && !ideas.length) throw new Error("Claude's suggestions could not be read. Try again.");
  return { picks, ideas };
}

export const becauseOf = c => (c.because?.length ? `Because you watched ${c.because.slice(0, 2).join(" and ")}.` : "Close to what you like.");

/** Without Claude: the best candidates, each with what it comes from. */
export const algoPicks = (candidates, count = PICKS) => candidates.slice(0, count).map(c => ({ ...c, why: becauseOf(c) }));

/** The pick as it is kept in D.mediaPicks (no scores). */
export const toPick = c => ({
  key: c.key, type: c.type, tmdb: c.tmdb, title: c.title, year: c.year || "", poster: c.poster || null,
  overview: clip(c.overview, 600), genres: (c.genres || []).slice(0, 4), why: c.why || "",
});

/** Keeps a new batch: it replaces what was shown, or is added after it (`more`). */
export function keepBatch(state, picks, { more = false, by, at }) {
  const s = { ...emptyPicks(), ...state };
  const items = more ? [...s.items, ...picks.filter(p => !s.items.some(x => x.key === p.key))] : picks;
  const shown = [...s.shown.filter(k => !picks.some(p => p.key === k)), ...picks.map(p => p.key)].slice(-SHOWN_KEPT);
  return { ...s, items, shown, at, by };
}

export function dismiss(state, key) {
  const s = { ...emptyPicks(), ...state };
  return { ...s, items: s.items.filter(p => p.key !== key), dismissed: [...s.dismissed.filter(k => k !== key), key].slice(-DISMISSED_KEPT) };
}

/** Whether opening Bloom should ask for new suggestions now. */
export const autoDue = (state, now = Date.now()) => !state?.at || now - Date.parse(state.at) >= AUTO_GAP_MS;
