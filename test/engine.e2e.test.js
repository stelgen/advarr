// Advarr tests — lib/engine.js END-TO-END: real config (JsonStore), real engine, real HTTP clients
// pointed at local mock TMDB + mock Seerr servers. No real network anywhere.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { loadConfig, applyPatch } from '../lib/config.js';
import { JsonStore } from '../lib/store.js';
import { createTmdb } from '../lib/tmdb.js';
import { createSeerr } from '../lib/seerr.js';
import { createEngine } from '../lib/engine.js';
import { mkTmp, movieRaw, tvRaw, daysAgo, silentLogger } from './helpers.js';

// ---------- fixtures: 4 movies + 2 shows with varied votes/ratings/popularity ----------
const MOVIES = [
  movieRaw(1, { title: 'Known Flick',    vote_average: 8.0, vote_count: 5000, popularity: 500, release_date: daysAgo(15), genre_ids: [28, 12] }), // in seerr already
  movieRaw(2, { title: 'Available Flick', vote_average: 7.5, vote_count: 3000, popularity: 300, release_date: daysAgo(40), genre_ids: [28] }),     // seerr status 5
  movieRaw(3, { title: 'Hot Flick',      vote_average: 8.8, vote_count: 2000, popularity: 400, release_date: daysAgo(5),  genre_ids: [28] }),      // requested
  movieRaw(4, { title: 'Sleeper Flick',  vote_average: 6.8, vote_count: 60,   popularity: 100, release_date: '2023-01-01', genre_ids: [878] }),    // requested (thin votes)
];
const SHOWS = [
  tvRaw(101, { name: 'Great Show', vote_average: 8.5, vote_count: 4000, popularity: 600, first_air_date: '2024-03-01' }),            // requested
  tvRaw(102, { name: 'Bad Show',   vote_average: 4.0, vote_count: 1500, popularity: 200, first_air_date: daysAgo(300) }),        // filtered by rating
];
const TMDB_ROUTES = {
  '/3/trending/movie/day': MOVIES,
  '/3/movie/popular': MOVIES,      // same items → cross-source overlap/dedup
  '/3/trending/tv/day': SHOWS,
  '/3/tv/popular': SHOWS,
};

// ---------- mock TMDB server ----------
const tmdbHits = [];
const tmdbServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://mock');
  tmdbHits.push({ path: u.pathname, page: u.searchParams.get('page'), apiKey: u.searchParams.get('api_key') });
  const results = TMDB_ROUTES[u.pathname];
  if (!results) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status_message: 'no such route' })); return; }
  if (u.searchParams.get('api_key') !== 'test') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status_message: 'invalid api key' })); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ page: Number(u.searchParams.get('page')) || 1, results }));
});

// ---------- mock Seerr server ----------
const seerrPosts = []; // { body, headers }
const seerrServer = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://mock');
  const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'POST' && u.pathname === '/api/v1/request') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seerrPosts.push({ body: JSON.parse(raw), headers: req.headers });
      json(201, { id: seerrPosts.length });
    });
    return;
  }
  switch (u.pathname) {
    case '/api/v1/status': return json(200, { version: '1.0', appVersion: 'Overseerr v1.0' });
    case '/api/v1/request': return json(200, { results: [{ id: 1, media: { mediaType: 'movie', tmdbId: 1 } }] });
    default: break;
  }
  const movie = /^\/api\/v1\/movie\/(\d+)$/.exec(u.pathname);
  if (movie) return json(200, { mediaInfo: { status: Number(movie[1]) === 2 ? 5 : 1 } }); // movie 2 = already available
  const tv = /^\/api\/v1\/tv\/(\d+)$/.exec(u.pathname);
  if (tv) return json(200, { mediaInfo: { status: 1 } });
  json(404, { message: 'not found' });
});

// ---------- wiring ----------
const dir = mkTmp('engine');
await new Promise((r) => tmdbServer.listen(0, '127.0.0.1', r));
await new Promise((r) => seerrServer.listen(0, '127.0.0.1', r));
const tmdbBase = `http://127.0.0.1:${tmdbServer.address().port}/3`;
const seerrBase = `http://127.0.0.1:${seerrServer.address().port}`;

const { store: configStore } = loadConfig(dir, {});
applyPatch(configStore.data, {
  tmdb: { apiKey: 'test', language: 'en-US' },
  seerr: { url: seerrBase, apiKey: 'test' },
  selection: { moviesPerRun: 2, showsPerRun: 1 },
  filters: { minVotes: 50, minRating: 6.0, yearFrom: 1950, checkAvailability: true, excludeInSeerr: true },
  sources: {
    // pages:1 — mock always returns non-empty results on any page;
    // real TMDB ends with an empty page (fetchSource stops on it, unit-tested in tmdb.test.js)
    pages: 1,
    trending_week: { on: false }, popular: { on: true }, top_rated: { on: false },
    now_playing: { on: false }, upcoming: { on: false }, discover: { on: false },
  },
});
configStore.saveNow();

const historyStore = new JsonStore(path.join(dir, 'history.json'), { items: [] });
const runsStore = new JsonStore(path.join(dir, 'runs.json'), { runs: [] });
historyStore.load();
runsStore.load();

const tmdb = createTmdb({
  apiKey: 'test', language: 'en-US', timeoutMs: 5000,
  // rewrite TMDB host to the local mock, keep signal/headers intact
  fetchImpl: (u, init) => fetch(String(u).replace('https://api.themoviedb.org/3', tmdbBase), init),
});
const seerr = createSeerr({ baseUrl: seerrBase, apiKey: 'test', fetchImpl: globalThis.fetch, timeoutMs: 5000 });

const engine = createEngine({
  configStore, historyStore, runsStore,
  getClients: () => ({ tmdb, seerr }),
  logger: silentLogger,
});

after(async () => {
  historyStore.close();
  runsStore.close();
  tmdbServer.closeAllConnections?.();
  seerrServer.closeAllConnections?.();
  await Promise.all([new Promise((r) => tmdbServer.close(r)), new Promise((r) => seerrServer.close(r))]);
});

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));

// ---------- dry run ----------
test('dry run: scans pool, picks quota, status "dry", zero seerr writes', async () => {
  const rep = await engine.run({ dry: true });
  assert.equal(rep.dry, true);
  assert.equal(rep.scanned, 6);                 // 4 movies + 2 shows, cross-source deduped
  assert.equal(rep.requested, 0);
  assert.equal(rep.items.length, 3);            // 2 movies + 1 show quota
  assert.ok(rep.items.every((i) => i.status === 'dry'));
  assert.ok(rep.items.some((i) => i.mediaType === 'tv' && i.id === 101));
  assert.equal(seerrPosts.length, 0);           // nothing requested in dry mode
  assert.equal(historyStore.data.items.length, 0);
  assert.deepEqual(rep.skipReasons, { rating: 1 }); // filters DO run in dry: t2 (rating 4.0) excluded
  assert.equal(rep.skipped, 1);                     // m1 dropped earlier, at the dedup stage (seerr already has it)
});

// ---------- real run ----------
let realReport = null; // captured for the BUG #2 exposure test below
test('real run: requested === 3, POST payloads exact, history.json persisted', async () => {
  const rep = realReport = await engine.run();
  assert.equal(rep.dry, false);
  assert.equal(rep.scanned, 6);
  assert.equal(rep.passed, 4);                  // m2, m3, m4, t1 (t2 fails rating, m1 already-known)
  assert.equal(rep.skipped, 1);                 // movie:1 in seerr
  assert.equal(rep.requested, 3);
  assert.equal(rep.failed, 0);
  assert.deepEqual(rep.errors, []);
  assert.deepEqual(rep.skipReasons, { rating: 1 });

  // TMDB wiring: 4 endpoints hit once each, page 1, api key forwarded
  assert.equal(tmdbHits.length, 4);
  assert.deepEqual(
    tmdbHits.map((h) => h.path).sort(),
    ['/3/movie/popular', '/3/trending/movie/day', '/3/trending/tv/day', '/3/tv/popular'],
  );
  assert.ok(tmdbHits.every((h) => h.apiKey === 'test' && h.page === '1'));

  // seerr POST bodies: exactly {mediaType, mediaId} — no seasons for "all", no dupes
  const keys = seerrPosts.map((p) => `${p.body.mediaType}:${p.body.mediaId}`).sort();
  assert.deepEqual(keys, ['movie:3', 'movie:4', 'tv:101']);
  for (const p of seerrPosts) {
    assert.deepEqual(Object.keys(p.body).sort(), ['mediaId', 'mediaType']); // tvSeasons 'all' → no seasons field
    assert.equal(p.headers['x-api-key'], 'test');
    assert.match(p.headers['content-type'], /application\/json/);
  }
  // movie 2 was blocked by the availability check (seerr status 5) and never requested
  assert.ok(!keys.includes('movie:2'));
  assert.ok(seerrPosts.length >= 2 && Object.keys(seerrPosts[0].body).includes('mediaId'));

  // history persisted on disk (flush debounced write)
  historyStore.close();
  const history = readJson('history.json');
  assert.equal(history.items.length, 3);
  for (const h of history.items) {
    assert.equal(h.status, 'requested');
    assert.ok(Array.isArray(h.sources) && h.sources.includes('trending_day'));
    assert.ok(h.score > 0 && h.score <= 100);
  }
  const hot = history.items.find((h) => h.tmdbId === 3 && h.mediaType === 'movie');
  assert.equal(hot.title, 'Hot Flick');
  assert.deepEqual(hot.sources, ['trending_day', 'popular']); // seen in both sources → deduped into one candidate
});

test('exposes BUG #2: report.items[].status stays "pending" after successful requests (lib/engine.js)', () => {
  // run()'s report.items are {...} copies made BEFORE the request loop; the loop mutates the originals
  // (c.status = 'requested'), so the returned report never reflects 'requested'/'failed' — history does.
  assert.ok(realReport && realReport.items.length > 0);
  for (const it of realReport.items) assert.equal(it.status, 'requested'); // ← FAILS today: all say 'pending'
});

// ---------- manual request ----------
test('requestOne: POSTs to seerr and appends manual history entry with sources ["manual"]', async () => {
  const before = historyStore.data.items.length;
  await engine.requestOne('movie', 777, { title: 'Manual Movie', year: 2020 });
  const post = seerrPosts[seerrPosts.length - 1];
  assert.deepEqual(post.body, { mediaType: 'movie', mediaId: 777 });

  historyStore.close();
  const history = readJson('history.json');
  assert.equal(history.items.length, before + 1);
  const entry = history.items.at(-1);
  assert.equal(entry.tmdbId, 777);
  assert.equal(entry.mediaType, 'movie');
  assert.equal(entry.title, 'Manual Movie');
  assert.equal(entry.year, 2020);
  assert.equal(entry.score, null);
  assert.equal(entry.status, 'requested');
  assert.deepEqual(entry.sources, ['manual']);
});

// ---------- runs ledger ----------
test('runs.json records both runs (dry + real) via ringPush', () => {
  runsStore.close();
  const runs = readJson('runs.json').runs;
  assert.equal(runs.length, 2);
  assert.equal(runs[0].dry, true);
  assert.equal(runs[0].requested, 0);
  assert.equal(runs[1].dry, false);
  assert.equal(runs[1].requested, 3);
  assert.equal(runs[1].titles.length, 3);
});
