// Advarr tests — lib/tmdb.js: source→path mapping, paging, cache, errors, timeout. All via fetchImpl stubs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTmdb, TmdbError } from '../lib/tmdb.js';
import { makeFetch, movieRaw } from './helpers.js';

const okJson = (body) => ({ status: 200, body });

test('fetchSource maps source ids to correct TMDB paths and auth params', async () => {
  const f = makeFetch(() => okJson({ results: [movieRaw(1)] }));
  const t = createTmdb({ apiKey: 'testkey', fetchImpl: f });

  await t.fetchSource('trending_week', 'movie');
  let url = new URL(f.calls[0].url);
  assert.equal(url.pathname, '/3/trending/movie/week');
  assert.equal(url.searchParams.get('api_key'), 'testkey');
  assert.equal(url.searchParams.get('page'), '1');
  assert.ok(url.searchParams.has('language'));

  await t.fetchSource('popular', 'tv');
  url = new URL(f.calls[1].url);
  assert.equal(url.pathname, '/3/tv/popular');
});

test('exposes BUG #3: route.only never filters — now_playing accepts tv (lib/tmdb.js fetchSource)', async () => {
  // Contract (SOURCE_ROUTES.now_playing = { only: ['movie'] }): tv must be skipped without any HTTP call.
  // Reality: fetchSource checks `route.only` on the FACTORY FUNCTION (SOURCE_ROUTES[sourceId] is a fn),
  // so route.only is always undefined → tv fetches /movie/now_playing and gets movie rows labeled as tv.
  const f = makeFetch(() => okJson({ results: [movieRaw(1)] }));
  const t = createTmdb({ apiKey: 'testkey', fetchImpl: f });
  const items = await t.fetchSource('now_playing', 'tv');
  assert.deepEqual(items, []);            // ← FAILS today: returns [movie 1] mislabeled as tv
  assert.equal(f.calls.length, 0);        // ← FAILS today: 1 call to /3/movie/now_playing for tv
  const movies = await t.fetchSource('now_playing', 'movie'); // movie path itself works
  assert.equal(movies.length, 1);
});

test('fetchSource: multi-page fetch stops at `pages` bound', async () => {
  const f = makeFetch((href) => {
    const page = Number(new URL(href).searchParams.get('page'));
    return okJson({ results: Array.from({ length: 40 }, (_, i) => movieRaw(page * 1000 + i)) });
  });
  const t = createTmdb({ apiKey: 'testkey', fetchImpl: f });
  const items = await t.fetchSource('popular', 'movie', { pages: 2, perPage: 40 });
  assert.equal(items.length, 80);
  assert.equal(f.calls.length, 2);
  assert.equal(new URL(f.calls[0].url).searchParams.get('page'), '1');
  assert.equal(new URL(f.calls[1].url).searchParams.get('page'), '2');
});

test('cached(): second identical call is served from cache (1 fetch, same array)', async () => {
  const f = makeFetch(() => okJson({ results: [movieRaw(7)] }));
  const t = createTmdb({ apiKey: 'testkey', fetchImpl: f });
  const first = await t.fetchSource('trending_day', 'movie');
  const second = await t.fetchSource('trending_day', 'movie'); // same source/type/page → cache key hit
  assert.equal(f.calls.length, 1);
  // cache stores the HTTP response body; fetchSource re-assembles an equal items array per call
  assert.deepEqual(second, first);
  // different page key → new fetch
  await t.fetchSource('trending_day', 'movie', { page: 2 });
  assert.equal(f.calls.length, 2);
  assert.ok(t._cache.size >= 2);
});

test('non-200 → TmdbError carrying status and upstream message', async () => {
  const f = makeFetch(() => ({ status: 401, body: { status_message: 'Invalid API key' } }));
  const t = createTmdb({ apiKey: 'bad', fetchImpl: f });
  await assert.rejects(
    () => t.call('/trending/movie/day'),
    (err) => err instanceof TmdbError && err.status === 401 && /Invalid API key/.test(err.message),
  );
  await assert.rejects(() => t.fetchSource('popular', 'movie'), TmdbError);
});

test('timeout aborts the request and throws TmdbError (no hang)', async () => {
  // stub that never resolves on its own but honors the abort signal like real fetch would
  const hanging = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => {
      const e = new Error('This operation was aborted');
      e.name = 'AbortError';
      reject(e);
    });
  });
  const t = createTmdb({ apiKey: 'testkey', timeoutMs: 30, fetchImpl: hanging });
  const started = Date.now();
  await assert.rejects(
    () => t.call('/x'),
    (err) => err instanceof TmdbError && /timeout after 30ms/.test(err.message),
  );
  assert.ok(Date.now() - started < 1000, 'timeout must fire ≈30ms, not hang');
});

test('missing api key → TmdbError before any HTTP call; unknown source id → TmdbError', async () => {
  const f = makeFetch(() => okJson({ results: [] }));
  const t = createTmdb({ apiKey: '', fetchImpl: f });
  await assert.rejects(() => t.call('/x'), (e) => e instanceof TmdbError && /not configured/.test(e.message));
  assert.equal(f.calls.length, 0);
  const t2 = createTmdb({ apiKey: 'k', fetchImpl: f });
  await assert.rejects(() => t2.fetchSource('bogus_source', 'movie'), /unknown source/);
});
