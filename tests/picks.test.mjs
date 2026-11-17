import { test } from "node:test";
import assert from "node:assert/strict";
import {
  seedsFrom, tasteOf, rankCandidates, picksPrompt, parsePicks, algoPicks, toPick, keepBatch, dismiss, autoDue,
  keyOf, emptyPicks, becauseOf, PICKS, AUTO_GAP_MS, SHOWN_KEPT,
} from "../ui/js/picks-core.js";

const card = (over = {}) => ({ id: "x", type: "movie", title: "A", year: 2000, genres: ["Drama"], state: "new", pct: 0, tmdb: "1", lastPlayed: "", added: "", ...over });
const rec = (id, over = {}) => ({ id, mediaType: "movie", title: `T${id}`, releaseDate: "2010-01-01", genreIds: [18, 36], overview: "o", ...over });

test("seedsFrom: films watched and series finished or well into, most recent first", () => {
  const cards = [
    card({ id: "a", tmdb: "10", title: "Old", state: "watched", lastPlayed: "2026-01-01" }),
    card({ id: "b", tmdb: "11", title: "New", state: "watched", lastPlayed: "2026-11-01" }),
    card({ id: "c", tmdb: "12", type: "series", title: "Half", state: "started", pct: 40, lastPlayed: "2026-06-01" }),
    card({ id: "d", tmdb: "13", type: "series", title: "Barely", state: "started", pct: 5 }),
    card({ id: "e", tmdb: "14", state: "started", pct: 90 }), // a film not finished
    card({ id: "f", tmdb: null, state: "watched" }), // unknown to TMDB
  ];
  const s = seedsFrom(cards);
  assert.deepEqual(s.map(x => x.key), ["movie:11", "tv:12", "movie:10"]);
  assert.ok(s[0].weight > s[2].weight);
});

test("tasteOf lists what she finished and started", () => {
  const t = tasteOf([card({ title: "Arrival", state: "watched", year: 2016 }), card({ title: "Dark", type: "series", state: "started" })]);
  assert.deepEqual(t.finished, ["- Arrival (2016), film — Drama"]);
  assert.deepEqual(t.started, ["- Dark (2000), series — Drama"]);
});

test("rankCandidates: shared and high recommendations first, nothing she has or asked for", () => {
  const a = { key: "movie:1", title: "Seed A", weight: 1 }, b = { key: "movie:2", title: "Seed B", weight: 0.9 };
  const lists = [
    { seed: a, results: [rec(100), rec(101), rec(102, { mediaInfo: { status: 5 } }), rec(2), { id: 9, mediaType: "person" }] },
    { seed: b, results: [rec(101), rec(103), rec(104, { mediaInfo: { status: 2 } })] },
  ];
  const c = rankCandidates(lists, { exclude: new Set(["movie:103"]), avoid: new Set(["movie:100"]) });
  // 101 is recommended by both; 100 was shown lately so goes last; 102/104 already there or asked; 2 is a seed; 103 excluded
  assert.deepEqual(c.map(x => x.key), ["movie:101", "movie:100"]);
  assert.deepEqual(c[0].because, ["Seed B", "Seed A"]); // first in B's list, second in A's
  assert.deepEqual(c[0].genres, ["Drama", "History"]);
});

const cands = [
  { key: "movie:101", type: "movie", tmdb: 101, title: "T101", year: "2010", genres: ["Drama"], overview: "x", because: ["Seed A"] },
  { key: "tv:7", type: "tv", tmdb: 7, title: "Show", year: "2019", genres: [], overview: "", because: [] },
];

test("picksPrompt names her taste, every candidate and the JSON answer", () => {
  const p = picksPrompt({ finished: ["- Arrival (2016), film"], started: [] }, cands, 5);
  assert.match(p, /- Arrival \(2016\), film/);
  assert.match(p, /movie:101 \| T101 \| 2010 \| film \| Drama/);
  assert.match(p, /tv:7 \| Show \| 2019 \| series/);
  assert.match(p, /Choose the 5 candidates/);
  assert.match(p, /"picks":\[/);
});

test("parsePicks keeps known candidates once, and up to 3 ideas", () => {
  const reply = '```json\n{"picks":[{"key":"movie:101","why":"Like Arrival."},{"key":"movie:999","why":"made up"},{"key":"movie:101","why":"again"},{"key":"tv:7"}],"ideas":[{"title":"Contact","year":"1997","type":"movie","why":"Space and grief."},{"title":"Dark","type":"tv"},{"title":"X"},{"title":"Y"}]}\n```';
  const r = parsePicks(reply, cands);
  assert.deepEqual(r.picks.map(p => [p.key, p.why]), [["movie:101", "Like Arrival."], ["tv:7", "Close to what you like."]]);
  assert.deepEqual(r.ideas.map(i => [i.title, i.year, i.type]), [["Contact", 1997, "movie"], ["Dark", null, "tv"], ["X", null, "movie"]]);
  assert.throws(() => parsePicks('{"picks":[{"key":"nope"}]}', cands), /could not be read/);
  assert.throws(() => parsePicks("sorry", cands));
});

test("algoPicks and becauseOf", () => {
  assert.equal(becauseOf({ because: ["A", "B", "C"] }), "Because you watched A and B.");
  assert.equal(algoPicks(cands, 1).length, 1);
  assert.equal(algoPicks(cands)[0].why, "Because you watched Seed A.");
});

test("keepBatch replaces or adds, and remembers what was shown", () => {
  const p1 = toPick({ ...cands[0], why: "w", score: 3 });
  assert.equal("score" in p1, false);
  let s = keepBatch(emptyPicks(), [p1], { by: "claude", at: "2026-11-17T10:00:00Z" });
  assert.deepEqual([s.items.length, s.shown, s.by], [1, ["movie:101"], "claude"]);
  const p2 = toPick({ ...cands[1], why: "w" });
  s = keepBatch(s, [p2, p1], { more: true, by: "algo", at: "2026-11-17T11:00:00Z" });
  assert.deepEqual(s.items.map(p => p.key), ["movie:101", "tv:7"]);
  s = keepBatch(s, [p2], { by: "claude", at: "x" });
  assert.deepEqual(s.items.map(p => p.key), ["tv:7"]);
  assert.deepEqual(s.shown, ["movie:101", "tv:7"]);
  const many = Array.from({ length: SHOWN_KEPT + 5 }, (_, i) => toPick({ ...cands[0], key: `movie:${i}` }));
  assert.equal(keepBatch(s, many, { by: "algo", at: "x" }).shown.length, SHOWN_KEPT);
});

test("dismiss removes it for good", () => {
  const s = dismiss({ ...emptyPicks(), items: [toPick(cands[0]), toPick(cands[1])] }, "tv:7");
  assert.deepEqual(s.items.map(p => p.key), ["movie:101"]);
  assert.deepEqual(s.dismissed, ["tv:7"]);
});

test("autoDue: at each start, except right after the last suggestions", () => {
  const now = Date.parse("2026-11-17T12:00:00Z");
  assert.equal(autoDue(emptyPicks(), now), true);
  assert.equal(autoDue({ at: new Date(now - 5 * 60_000).toISOString() }, now), false);
  assert.equal(autoDue({ at: new Date(now - AUTO_GAP_MS).toISOString() }, now), true);
});

test("keyOf and PICKS", () => {
  assert.equal(keyOf("tv", 5), "tv:5");
  assert.equal(keyOf("movie", "5"), "movie:5");
  assert.equal(PICKS, 12);
});
