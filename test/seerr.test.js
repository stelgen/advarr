// Advarr tests — lib/seerr.js: ping, pagination, request payload shape, mediaStatus, base url, errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeerr, SeerrError, normalizeBaseUrl } from '../lib/seerr.js';
import { makeFetch } from './helpers.js';

const mkClient = (handler, over = {}) => {
  const f = makeFetch(handler);
  return { f, client: createSeerr({ baseUrl: 'http://seerr.test:5055/', apiKey: 'sk-test', fetchImpl: f, timeoutMs: 1000, ...over }) };
};

test('ping parses /api/v1/status and detects overseerr; X-Api-Key header sent', async () => {
  const { f, client } = mkClient(() => ({ status: 200, body: { version: '2.4.1', appVersion: 'Overseerr v2.4.1' } }));
  const info = await client.ping();
  assert.equal(info.ok, true);
  assert.equal(info.version, '2.4.1');
  assert.equal(info.app, 'overseerr');
  const call = f.calls[0];
  assert.equal(call.url, 'http://seerr.test:5055/api/v1/status'); // trailing slash stripped
  assert.equal(call.init.headers['X-Api-Key'], 'sk-test');
  assert.equal(call.init.method, 'GET');
});

test('ping detects jellyseerr via appVersion', async () => {
  const { client } = mkClient(() => ({ status: 200, body: { version: '1.30.0', appVersion: 'Jellyseerr v1.30.0' } }));
  const info = await client.ping();
  assert.equal(info.version, '1.30.0');
  assert.equal(info.app, 'jellyseerr');
});

test('existingRequests paginates (take=250&skip=…) and builds a Set of "type:id"', async () => {
  const { f, client } = mkClient((href) => {
    const skip = Number(new URL(href).searchParams.get('skip'));
    if (skip === 0) {
      return { status: 200, body: { results: Array.from({ length: 250 }, (_, i) => ({ id: i + 1, media: { mediaType: 'movie', tmdbId: i + 1 } })) } };
    }
    return { status: 200, body: { results: [{ id: 900, media: { mediaType: 'tv', tmdbId: 9001 } }, ...Array.from({ length: 4 }, (_, i) => ({ id: 901 + i, media: { mediaType: 'movie', tmdbId: 8000 + i } }))] } };
  });
  const set = await client.existingRequests();
  assert.equal(set.size, 255);
  assert.equal(set.has('movie:123'), true);
  assert.equal(set.has('tv:9001'), true);
  assert.equal(f.calls.length, 2); // second page short → stop
  assert.ok(f.calls[0].url.endsWith('/api/v1/request?take=250&skip=0'));
  assert.ok(f.calls[1].url.endsWith('/api/v1/request?take=250&skip=250'));
});

test('request(): POST /api/v1/request with {mediaType, mediaId}; "all" omits seasons, [1] sends them', async () => {
  const { f, client } = mkClient(() => ({ status: 201, body: { id: 42 } }));

  await client.request({ mediaType: 'movie', tmdbId: 123 });
  let call = f.calls[0];
  assert.equal(call.url, 'http://seerr.test:5055/api/v1/request');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['X-Api-Key'], 'sk-test');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(call.init.body), { mediaType: 'movie', mediaId: 123 });
  assert.ok(!('seasons' in JSON.parse(call.init.body)));

  await client.request({ mediaType: 'tv', tmdbId: 555, seasons: 'all' }); // tvSeasons 'all' → omit
  call = f.calls[1];
  assert.deepEqual(JSON.parse(call.init.body), { mediaType: 'tv', mediaId: 555 });
  assert.ok(!('seasons' in JSON.parse(call.init.body)));

  await client.request({ mediaType: 'tv', tmdbId: 555, seasons: [1] }); // 'first' → seasons:[1]
  call = f.calls[2];
  assert.deepEqual(JSON.parse(call.init.body), { mediaType: 'tv', mediaId: 555, seasons: [1] });
});

test('mediaStatus maps /movie/:id and /tv/:id, known = status ≥ 2, missing mediaInfo → 1', async () => {
  const { f, client } = mkClient((href) => {
    const path = new URL(href).pathname;
    if (path === '/api/v1/movie/9') return { status: 200, body: { mediaInfo: { status: 5 } } };
    if (path === '/api/v1/movie/10') return { status: 200, body: { mediaInfo: { status: 1 } } };
    if (path === '/api/v1/tv/7') return { status: 200, body: { mediaInfo: { status: 2 } } };
    return { status: 200, body: {} }; // no mediaInfo at all
  });
  assert.deepEqual(await client.mediaStatus('movie', 9), { status: 5, known: true });
  assert.deepEqual(await client.mediaStatus('movie', 10), { status: 1, known: false });
  assert.deepEqual(await client.mediaStatus('tv', 7), { status: 2, known: true });
  assert.deepEqual(await client.mediaStatus('movie', 999), { status: 1, known: false });
  assert.equal(new URL(f.calls[3].url).pathname, '/api/v1/movie/999');
});

test('SeerrError carries HTTP status; unconfigured client fails fast', async () => {
  const { client } = mkClient(() => ({ status: 500, body: { message: 'boom' } }));
  await assert.rejects(
    () => client.ping(),
    (err) => err instanceof SeerrError && err.status === 500 && /boom/.test(err.message) && err.name === 'SeerrError',
  );
  const unconfigured = createSeerr({ baseUrl: '', apiKey: 'k', fetchImpl: async () => { throw new Error('must not be called'); } });
  await assert.rejects(() => unconfigured.ping(), /not configured/);
});

test('normalizeBaseUrl strips trailing slashes and whitespace', () => {
  assert.equal(normalizeBaseUrl(' http://x/ '), 'http://x');
  assert.equal(normalizeBaseUrl('http://y:5055///'), 'http://y:5055');
  assert.equal(normalizeBaseUrl('http://z'), 'http://z');
  const c = createSeerr({ baseUrl: 'http://slash.test///', apiKey: 'k', fetchImpl: makeFetch(() => ({ status: 200, body: { version: '1' } })) });
  assert.equal(c._base, 'http://slash.test');
});
