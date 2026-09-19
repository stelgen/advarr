// Advarr v0.6.0 — TMDB lists source, direct Radarr/Sonarr integrations, masking, migration.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createArrClient } from '../lib/radarr.js';
import { createEngine } from '../lib/engine.js';
import { defaultConfig, applyPatch, loadConfig, restoreIntegrationsSecrets } from '../lib/config.js';
import { JsonStore } from '../lib/store.js';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'advarr060-')); }
function storeIn(dir, name, def) { const s = new JsonStore(path.join(dir, name), def); s.load(); return s; }
function jsonOk(obj) { const t = JSON.stringify(obj); return { ok: true, status: 200, json: async () => obj, text: async () => t }; }

/* ---------- radarr client ---------- */
describe('radarr client (direct, X-Api-Key)', () => {
  test('status/profiles/roots hit /api/v3 with X-Api-Key', async () => {
    const calls = [];
    const c = createArrClient({
      type: 'radarr', url: 'http://r:7878/', apiKey: 'K',
      fetchImpl: async (url, opts = {}) => {
        calls.push([String(url), opts.headers?.['X-Api-Key']]);
        if (String(url).endsWith('/system/status')) return jsonOk({ appName: 'Radarr', version: '5.0.0' });
        if (String(url).endsWith('/qualityprofile')) return jsonOk([{ id: 1, name: 'HD' }, { id: 2, name: 'UHD' }]);
        if (String(url).endsWith('/rootfolder')) return jsonOk([{ path: '/movies' }]);
        throw new Error('unexpected ' + url);
      },
    });
    const t = await c.test();
    assert.equal(t.ok, true);
    assert.equal(t.version, '5.0.0');
    assert.deepEqual(t.profiles.map((p) => p.name), ['HD', 'UHD']);
    assert.deepEqual(t.roots.map((r) => r.path), ['/movies']);
    assert.ok(calls.every(([, key]) => key === 'K'));
  });

  test('request posts movie with profile, root folder and search flag', async () => {
    const bodies = [];
    const c = createArrClient({
      type: 'radarr', url: 'http://r:7878', apiKey: 'K', qualityProfileId: 2, rootFolderPath: '/movies',
      fetchImpl: async (url, opts = {}) => {
        if (String(url).endsWith('/api/v3/movie') && opts.method === 'POST') {
          bodies.push(JSON.parse(opts.body));
          return jsonOk({ id: 10 });
        }
        throw new Error('unexpected ' + url);
      },
    });
    await c.request({ mediaType: 'movie', tmdbId: 27205, title: 'Inception' });
    assert.equal(bodies[0].tmdbId, 27205);
    assert.equal(bodies[0].qualityProfileId, 2);
    assert.equal(bodies[0].rootFolderPath, '/movies');
    assert.equal(bodies[0].monitored, true);
    assert.equal(bodies[0].minimumAvailability, 'released');
    assert.equal(bodies[0].addOptions.searchForMovie, true);
  });

  test('existingTmdbIds(movie) maps library to tmdbIds', async () => {
    const c = createArrClient({
      type: 'radarr', url: 'http://r', apiKey: 'K',
      fetchImpl: async () => jsonOk([{ tmdbId: 1 }, { tmdbId: 2 }, {}]),
    });
    const ids = await c.existingTmdbIds('movie');
    assert.deepEqual([...ids].sort(), [1, 2]);
  });
});

/* ---------- sonarr client ---------- */
describe('sonarr client (tvdbId resolution)', () => {
  test('lookup by tmdb: prefix → POST /api/v3/series with tvdbId + monitor all', async () => {
    const calls = [];
    const c = createArrClient({
      type: 'sonarr', url: 'http://s:8989', apiKey: 'K', qualityProfileId: 1, rootFolderPath: '/tv',
      fetchImpl: async (url, opts = {}) => {
        calls.push(String(url));
        if (String(url).includes('/series/lookup')) {
          assert.ok(String(url).includes('term=tmdb%3A94605'), 'lookup uses tmdb: prefix');
          return jsonOk([{ tvdbId: 389657, title: 'Arcane', year: 2021 }]);
        }
        if (String(url).endsWith('/api/v3/series') && opts.method === 'POST') {
          return jsonOk({ id: 3 });
        }
        throw new Error('unexpected ' + url);
      },
    });
    await c.request({ mediaType: 'tv', tmdbId: 94605, title: 'Arcane', year: 2021 });
    assert.equal(calls.length, 2);
  });

  test('request rejects movie mediaType', async () => {
    const c = createArrClient({ type: 'sonarr', url: 'http://s', apiKey: 'K', fetchImpl: async () => jsonOk({}) });
    await assert.rejects(() => c.request({ mediaType: 'movie', tmdbId: 1 }), /только сериалы/);
  });
});

/* ---------- engine: multi-target + library dedup + lists source ---------- */
function makeEnv({ integrations = [], listItems = null } = {}) {
  const dir = tmpDir();
  const cfg = storeIn(dir, 'config.json', defaultConfig());
  applyPatch(cfg.data, {
    seerr: { url: 'http://seerr.mock', apiKey: 'S' },
    integrations: { clients: integrations },
    sources: { pages: 1, popular: { on: true, weight: 1 }, tmdb_list: listItems ? { on: true, weight: 1, ids: '777' } : { on: false } },
    selection: { mediaTypes: listItems ? ['movie', 'tv'] : ['movie'], moviesPerRun: 5, showsPerRun: 5 },
    filters: { minVotes: 0, minRating: 0, yearFrom: 0, checkAvailability: false },
  });
  const hist = storeIn(dir, 'history.json', { items: [] });
  const runs = storeIn(dir, 'runs.json', { runs: [] });
  const tmdb = {
    fetchSource: async () => [{ id: 100, title: 'Pop Movie', vote_average: 7, vote_count: 500, popularity: 100, release_date: '2025-01-01', genre_ids: [] }],
    list: async (id) => ({ items: listItems || [] }),
  };
  const requested = [];
  const seerr = {
    existingRequests: async () => new Set(),
    mediaStatus: async () => ({ status: 1, known: false }),
    request: async ({ tmdbId }) => { requested.push(['seerr', tmdbId]); return { id: 1 }; },
  };
  const logger = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const engine = createEngine({ configStore: cfg, historyStore: hist, runsStore: runs, getClients: () => ({ tmdb, seerr }), logger });
  return { cfg, hist, engine, requested, seerr };
}

describe('engine v0.6: direct radarr target', () => {
  test('request dispatched to seerr AND radarr; history records via', async () => {
    const stubClient = {
      request: async () => ({ id: 5 }),
      existingTmdbIds: async () => new Set([999]),
    };
    const env = makeEnv({
      integrations: [{ id: 'r1', type: 'radarr', name: 'R', url: 'http://r', apiKey: 'K', qualityProfileId: 1, rootFolderPath: '/m', enabled: true }],
    });
    // inject stub factory
    const engine = createEngine({
      configStore: env.cfg, historyStore: env.hist, runsStore: storeIn(path.dirname(env.hist.file), 'runs.json', { runs: [] }),
      getClients: () => ({ tmdb: { fetchSource: async () => [{ id: 42, title: 'Keyless', vote_average: 7, vote_count: 500, popularity: 100, release_date: '2025-01-01', genre_ids: [] }] }, seerr: { existingRequests: async () => new Set(), mediaStatus: async () => ({ status: 1 }) } }),
      arrFactory: () => stubClient,
      logger: { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });
    const rep = await engine.run();
    assert.equal(rep.requested, 1);
    const viaTargets = rep.items[0].via.map((v) => v.target);
    assert.ok(viaTargets.includes('radarr:R'), 'radarr target dispatched');
    assert.ok(viaTargets.includes('seerr'), 'seerr target dispatched (configured)');
    assert.ok(rep.items[0].via.find((v) => v.target === 'radarr:R').ok === true, 'radarr ok');
    assert.ok(env.hist.data.items.length >= 1);
  });

  test('library dedup: tmdbId already in radarr is skipped', async () => {
    const seen = [];
    const factory = (inst) => ({
      request: async () => { throw new Error('must not be called'); },
      existingTmdbIds: async () => new Set([42]),
    });
    const dir = tmpDir();
    const cfg = storeIn(dir, 'config.json', defaultConfig());
    applyPatch(cfg.data, {
      integrations: { clients: [{ id: 'r1', type: 'radarr', name: 'R', url: 'http://r', apiKey: 'K', enabled: true }] },
      sources: { pages: 1, popular: { on: true, weight: 1 }, tmdb_export: { on: false } },
      selection: { mediaTypes: ['movie'], moviesPerRun: 5, showsPerRun: 0 },
      filters: { minVotes: 0, minRating: 0, yearFrom: 0, checkAvailability: false },
    });
    const hist = storeIn(dir, 'history.json', { items: [] });
    const runs = storeIn(dir, 'runs.json', { runs: [] });
    const tmdb = { fetchSource: async () => [{ id: 42, title: 'Already There', vote_average: 8, vote_count: 900, popularity: 500, release_date: '2025-01-01', genre_ids: [] }] };
    const seerr = { existingRequests: async () => new Set(), mediaStatus: async () => ({ status: 1, known: false }), request: async () => { throw new Error('no'); } };
    const engine = createEngine({ configStore: cfg, historyStore: hist, runsStore: runs, getClients: () => ({ tmdb, seerr }), arrFactory: factory, logger: { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} } });
    const rep = await engine.run();
    assert.equal(rep.requested, 0, 'candidate already in radarr library');
    assert.equal(rep.skipped, 1);
  });
});

describe('engine v0.6: tmdb_list source', () => {
  test('list items normalized by media_type and requested', async () => {
    const items = [
      { id: 1, media_type: 'movie', title: 'List Movie', popularity: 300, vote_average: 7, vote_count: 800, release_date: '2024-05-01', adult: false },
      { id: 2, name: 'List Show', first_air_date: '2023-10-01', popularity: 400, vote_average: 8, vote_count: 500, adult: false },
    ];
    const env = makeEnv({ listItems: items });
    const rep = await env.engine.run();
    assert.ok(rep.scanned >= 2, `scanned=${rep.scanned}`);
    const kinds = rep.items.map((i) => i.mediaType);
    assert.ok(kinds.includes('movie') && kinds.includes('tv'), 'mixed list handled');
  });
});

/* ---------- masking roundtrip ---------- */
describe('integrations apiKey masking', () => {
  test('restoreIntegrationsSecrets restores masked values by id', () => {
    const oldCfg = { integrations: { clients: [{ id: 'a', apiKey: 'REAL-KEY' }] } };
    const newCfg = { integrations: { clients: [{ id: 'a', apiKey: '••••-KEY' }, { id: 'b', apiKey: 'NEW' }] } };
    restoreIntegrationsSecrets(oldCfg, newCfg);
    assert.equal(newCfg.integrations.clients[0].apiKey, 'REAL-KEY');
    assert.equal(newCfg.integrations.clients[1].apiKey, 'NEW');
  });
});

/* ---------- migration v5 → v6 ---------- */
describe('config migration → v6 (integrations + tmdb_list)', () => {
  test('v5 config gains integrations and tmdb_list defaults', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      version: 5, tmdb: { apiKey: 'K' }, seerr: { url: 'http://x', apiKey: 'S', tvSeasons: 'all' },
      schedule: { enabled: true, intervalHours: 6, jitterMinutes: 5, runOnStart: false, retryCooldownDays: 3 },
      selection: { mediaTypes: ['movie'], moviesPerRun: 1, showsPerRun: 0 },
      filters: {}, sources: {}, scoring: {}, ui: {}, general: {}, notify: { providers: [] }, backups: { maxKeep: 5 },
      storage: { historyMaxItems: 2000, logBuffer: 500, writeDebounceMs: 1000, posterCacheHours: 168 },
    }));
    const { cfg } = loadConfig(dir, {});
    assert.equal(cfg.version, 6);
    assert.deepEqual(cfg.integrations.clients, []);
    assert.deepEqual(cfg.sources.tmdb_list, { on: false, weight: 1.0, ids: '' });
    assert.equal(cfg.tmdb.apiKey, 'K');
  });
});
