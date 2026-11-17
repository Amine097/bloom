import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normUrl, jellyfinAuth, watchState, libraryCard, filterLibrary, stateCounts, continueList, bySeason,
  jellyfinImage, episodeToPlay, tmdbIndex, mediaStatus, downloadPct, seerrCard, isTitle,
  requestableSeasons, requestBody, requestRow, seasonsLabel, mediaError, needsAutoConnect, readBuiltIn, looseObject,
} from "../ui/js/media-core.js";

test("normUrl: adds http, drops the trailing slash and Jellyfin's /web path", () => {
  assert.equal(normUrl("homelab:8096"), "http://homelab:8096");
  assert.equal(normUrl(" http://100.64.0.3:8096/ "), "http://100.64.0.3:8096");
  assert.equal(normUrl("https://media.tail1234.ts.net/web/#/home"), "https://media.tail1234.ts.net");
  assert.equal(normUrl("http://host/jellyfin/web/index.html"), "http://host/jellyfin");
  assert.equal(normUrl(""), "");
  assert.equal(normUrl("http://"), "");
});

test("jellyfinAuth: the MediaBrowser header, with the token once signed in", () => {
  assert.equal(jellyfinAuth("bloom-1"), 'MediaBrowser Client="Bloom", Device="Mac", DeviceId="bloom-1", Version="1.0"');
  assert.match(jellyfinAuth("bloom-1", "abc"), /, Token="abc"$/);
  assert.doesNotMatch(jellyfinAuth('x"y', 't"k'), /x"y|t"k/);
});

test("watchState: watched, started with its percentage, or new", () => {
  assert.deepEqual(watchState({ UserData: { Played: true } }), { state: "watched", pct: 100 });
  assert.deepEqual(watchState({ UserData: { PlaybackPositionTicks: 5e9, PlayedPercentage: 42.6 } }), { state: "started", pct: 43 });
  // a series with some episodes watched
  assert.deepEqual(watchState({ UserData: { PlayedPercentage: 30, UnplayedItemCount: 7 } }), { state: "started", pct: 30 });
  assert.deepEqual(watchState({ UserData: { PlaybackPositionTicks: 1 } }), { state: "started", pct: 1 });
  assert.deepEqual(watchState({ UserData: {} }), { state: "new", pct: 0 });
  assert.deepEqual(watchState({}), { state: "new", pct: 0 });
});

const movie = (over = {}) => ({ Id: "m1", Name: "Arrival", Type: "Movie", ProductionYear: 2016, RunTimeTicks: 116 * 600_000_000, ImageTags: { Primary: "t1" }, ProviderIds: { Tmdb: "329865" }, DateCreated: "2026-10-01T00:00:00Z", UserData: {}, ...over });
const series = (over = {}) => ({ Id: "s1", Name: "Severance", Type: "Series", ProductionYear: 2022, ImageTags: { Primary: "t2" }, ProviderIds: { Tmdb: "95396" }, DateCreated: "2026-11-01T00:00:00Z", UserData: { UnplayedItemCount: 10 }, ...over });
const episode = (over = {}) => ({ Id: "e1", Name: "Good News About Hell", Type: "Episode", SeriesName: "Severance", SeriesId: "s1", SeriesPrimaryImageTag: "t2", ParentIndexNumber: 1, IndexNumber: 1, UserData: {}, ...over });

test("libraryCard: films, series and episodes", () => {
  const m = libraryCard(movie({ UserData: { PlaybackPositionTicks: 16 * 600_000_000, PlayedPercentage: 14 } }));
  assert.equal(m.type, "movie");
  assert.equal(m.minutes, 116);
  assert.equal(m.left, 100);
  assert.equal(m.state, "started");
  assert.equal(m.tmdb, "329865");
  const s = libraryCard(series({ UserData: { UnplayedItemCount: 4, PlayedPercentage: 60 } }));
  assert.equal(s.type, "series");
  assert.equal(s.unplayed, 4);
  assert.equal(s.left, null);
  const e = libraryCard(episode());
  assert.equal(e.title, "Severance");
  assert.equal(e.episode, "S1 · E1 — Good News About Hell");
  assert.equal(e.imageId, "s1");
  assert.equal(e.imageTag, "t2");
});

test("filterLibrary and stateCounts", () => {
  const cards = [
    libraryCard(movie()),
    libraryCard(movie({ Id: "m2", Name: "Amélie", DateCreated: "2026-11-10T00:00:00Z", UserData: { Played: true } })),
    libraryCard(series({ UserData: { PlayedPercentage: 20 } })),
  ];
  assert.deepEqual(filterLibrary(cards, { kind: "movie" }).map(c => c.id), ["m1", "m2"]);
  assert.deepEqual(filterLibrary(cards, { state: "watched" }).map(c => c.id), ["m2"]);
  assert.deepEqual(filterLibrary(cards, { query: "ame" }).map(c => c.id), ["m2"]); // accents folded
  assert.deepEqual(filterLibrary(cards, { sort: "added" }).map(c => c.id), ["m2", "s1", "m1"]);
  assert.deepEqual(stateCounts(cards), { all: 3, new: 1, started: 1, watched: 1 });
  assert.deepEqual(stateCounts(cards, "series"), { all: 1, new: 0, started: 1, watched: 0 });
});

test("continueList: paused first, then next episodes, one card per series", () => {
  const resume = [episode({ Id: "e3", UserData: { PlaybackPositionTicks: 9, PlayedPercentage: 50 } }), movie()];
  const next = [episode({ Id: "e4" }), episode({ Id: "x1", SeriesId: "s9", SeriesName: "Other" })];
  assert.deepEqual(continueList(resume, next).map(c => c.id), ["e3", "m1", "x1"]);
  assert.equal(continueList(resume, next, 2).length, 2);
});

test("bySeason: episodes grouped and ordered, specials last", () => {
  const eps = [
    episode({ Id: "a", ParentIndexNumber: 2, IndexNumber: 1, SeasonName: "Season 2" }),
    episode({ Id: "b", ParentIndexNumber: 1, IndexNumber: 1, SeasonName: "Season 1", UserData: { Played: true } }),
    episode({ Id: "c", ParentIndexNumber: 0, IndexNumber: 1, SeasonName: "Specials" }),
  ];
  const s = bySeason(eps);
  assert.deepEqual(s.map(x => x.name), ["Season 1", "Season 2", "Specials"]);
  assert.equal(s[0].episodes[0].state, "watched");
});

test("Jellyfin links", () => {
  assert.equal(jellyfinImage("http://h:8096", "abc", "t 1", 300), "http://h:8096/Items/abc/Images/Primary?fillHeight=300&quality=85&tag=t%201");
  const idx = tmdbIndex([libraryCard(movie()), libraryCard(series()), libraryCard(episode())]);
  assert.equal(idx.get("movie:329865").id, "m1");
  assert.equal(idx.get("tv:95396").id, "s1");
  assert.equal(idx.size, 2);
});

test("mediaStatus and downloadPct", () => {
  assert.equal(mediaStatus(undefined).key, "none");
  assert.equal(mediaStatus(undefined).canRequest, true);
  assert.equal(mediaStatus({ status: 2 }).key, "pending");
  assert.equal(mediaStatus({ status: 3 }).label, "On its way");
  assert.equal(mediaStatus({ status: 3, downloadStatus: [{ size: 1000, sizeLeft: 250 }] }).label, "Downloading · 75%");
  assert.equal(mediaStatus({ status: 4 }).canRequest, true);
  assert.equal(mediaStatus({ status: 5 }).key, "available");
  assert.equal(mediaStatus({ status: 6 }).key, "blocked");
  assert.equal(mediaStatus({ status: 7 }).canRequest, true); // deleted: can be asked for again
  assert.equal(downloadPct({ downloadStatus: [] }), null);
});

test("seerrCard and isTitle", () => {
  const c = seerrCard({ id: 603, mediaType: "movie", title: "The Matrix", releaseDate: "1999-03-31", posterPath: "/p.jpg", mediaInfo: { status: 5 } });
  assert.deepEqual([c.tmdb, c.type, c.title, c.year, c.poster, c.status.key], [603, "movie", "The Matrix", "1999", "https://image.tmdb.org/t/p/w342/p.jpg", "available"]);
  const t = seerrCard({ id: 1, mediaType: "tv", name: "Dark", firstAirDate: "2017-12-01" });
  assert.deepEqual([t.type, t.title, t.year, t.poster], ["tv", "Dark", "2017", null]);
  assert.equal(isTitle({ mediaType: "person" }), false);
  assert.equal(isTitle({ mediaType: "tv" }), true);
});

test("requestableSeasons: leaves out specials, available and already asked seasons", () => {
  const details = {
    seasons: [0, 1, 2, 3, 4].map(n => ({ seasonNumber: n, name: n ? `Season ${n}` : "Specials", episodeCount: 8 })),
    mediaInfo: {
      seasons: [{ seasonNumber: 1, status: 5 }],
      requests: [{ status: 2, seasons: [{ seasonNumber: 2 }] }, { status: 3, seasons: [{ seasonNumber: 3 }] }],
    },
  };
  assert.deepEqual(requestableSeasons(details).map(s => s.number), [3, 4]);
  assert.deepEqual(requestableSeasons({ seasons: [{ seasonNumber: 1 }] }).map(s => s.number), [1]);
});

test("requestBody", () => {
  assert.deepEqual(requestBody("movie", "603"), { mediaType: "movie", mediaId: 603 });
  assert.deepEqual(requestBody("tv", 1, ["2", 3]), { mediaType: "tv", mediaId: 1, seasons: [2, 3] });
});

test("requestRow: her request's state in words", () => {
  const r = (status, media = {}, extra = {}) => requestRow({ id: 9, status, createdAt: "2026-11-16T10:00:00Z", media: { tmdbId: 5, mediaType: "tv", ...media }, ...extra });
  assert.equal(r(1).status.label, "Waiting for approval");
  assert.equal(r(3).status.key, "declined");
  assert.equal(r(2, { status: 3 }).status.label, "On its way");
  assert.equal(r(2, { status: 5 }).status.key, "available");
  assert.equal(r(5, { status: 5 }).status.key, "available");
  assert.equal(r(2, { status: 1 }).status.key, "coming");
  const row = r(1, {}, { seasons: [{ seasonNumber: 3 }, { seasonNumber: 1 }, { seasonNumber: 0 }] });
  assert.deepEqual([row.type, row.tmdb, row.date, row.seasons], ["tv", 5, "2026-11-16", [1, 3]]);
});

test("seasonsLabel", () => {
  assert.equal(seasonsLabel([]), "");
  assert.equal(seasonsLabel([2]), "Season 2");
  assert.equal(seasonsLabel([1, 2, 3]), "Seasons 1–3");
  assert.equal(seasonsLabel([1, 3, 4]), "Seasons 1, 3, 4");
});

test("mediaError: in her words", () => {
  assert.equal(mediaError({ code: "unreachable" }, "Jellyseerr"), "Bloom cannot reach Jellyseerr. Is Tailscale on?");
  assert.match(mediaError({ code: "auth" }), /Jellyfin did not accept/);
  assert.equal(mediaError(new Error("boom")), "boom");
});

test("readBuiltIn: the build's BLOOM_MEDIA JSON, cleaned", () => {
  assert.deepEqual(readBuiltIn('{"jellyfin":"10.0.0.1:8096/","seerr":"10.0.0.1:5055","user":" her "}'),
    { jellyfin: "http://10.0.0.1:8096", seerr: "http://10.0.0.1:5055", user: "her", password: "" });
  assert.equal(readBuiltIn('{"jellyfin":"10.0.0.1:8096"}'), null); // no user
  assert.equal(readBuiltIn("not json"), null);
  assert.equal(readBuiltIn({ jellyfin: "h:1", user: "u" }).seerr, "");
});

test("needsAutoConnect: only when she has none, or hers came from an older built-in one", () => {
  const built = { jellyfin: "http://h:8096", seerr: "http://h:5055", user: "her" };
  assert.equal(needsAutoConnect(null, built), true);
  assert.equal(needsAutoConnect({ jellyfin: "http://h:8096" }, built), true); // never signed in
  assert.equal(needsAutoConnect(null, null), false); // nothing built in: she sets it up by hand
  const mine = { token: "t", auto: true, jellyfin: "http://h:8096", seerr: "http://h:5055", user: "Her" };
  assert.equal(needsAutoConnect(mine, built), false);
  assert.equal(needsAutoConnect({ ...mine, jellyfin: "http://old:8096" }, built), true);
  assert.equal(needsAutoConnect({ ...mine, auto: false, jellyfin: "http://other:8096" }, built), false); // set by hand
});

test("readBuiltIn forgives what copy and paste does to the secret", () => {
  const want = { jellyfin: "http://10.0.0.1:8096", seerr: "http://10.0.0.1:5055", user: "her", password: "" };
  assert.deepEqual(readBuiltIn(`'{"jellyfin":"http://10.0.0.1:8096","seerr":"http://10.0.0.1:5055","user":"her"}'`), want);
  assert.deepEqual(readBuiltIn("{\u201Cjellyfin\u201D:\u201Chttp://10.0.0.1:8096\u201D,\u201Cseerr\u201D:\u201Chttp://10.0.0.1:5055\u201D,\u201Cuser\u201D:\u201Cher\u201D}"), want);
  assert.deepEqual(readBuiltIn("jellyfin=http://10.0.0.1:8096\nseerr=http://10.0.0.1:5055\nuser=her"), want);
  assert.deepEqual(readBuiltIn("{jellyfin: http://10.0.0.1:8096, seerr: http://10.0.0.1:5055, user: her}"), want);
  assert.equal(looseObject("   "), null);
});

test("episodeToPlay: the one she is in, else the first not watched, else the first", () => {
  const ep = (id, state) => ({ id, state });
  const seasons = st => [{ number: 1, episodes: st.slice(0, 2).map((x, i) => ep(`1-${i}`, x)) }, { number: 2, episodes: st.slice(2).map((x, i) => ep(`2-${i}`, x)) }];
  assert.equal(episodeToPlay(seasons(["watched", "watched", "new", "started"])).id, "2-1");
  assert.equal(episodeToPlay(seasons(["watched", "new", "new"])).id, "1-1");
  assert.equal(episodeToPlay(seasons(["watched", "watched", "watched"])).id, "1-0");
  assert.equal(episodeToPlay([]), null);
});

test("libraryCard keeps where she stopped, for Play", () => {
  assert.equal(libraryCard(movie({ UserData: { PlaybackPositionTicks: 123 } })).position, 123);
  assert.equal(libraryCard(movie()).position, 0);
  assert.equal(bySeason([episode({ UserData: { PlaybackPositionTicks: 9 } })])[0].episodes[0].position, 9);
});
