// Advarr v0.4.0 — metadata enrichment: providers, merge, fallback, cache, migration.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEnrich } from '../lib/enrich.js';
import { defaultConfig, loadConfig, applyPatch } from '../lib/config.js';
import { JsonStore } from '../lib/store.js';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'advarr040-')); }
function jsonOk(obj) { return { ok: true, status: 200, json: async () => obj }; }

function makeEnrich({ providers = ['imdb'], tmdbKey = '', stub } = {}) {
  const dir = tmpDir();
  const cfg = new JsonStore(path.join(dir, 'config.json'), defaultConfig());
  cfg.load();
  applyPatch(cfg.data, { tmdb: { apiKey: tmdbKey }, enrich: { enabled: true, providers } });
  const fetchCalls = [];
  const fetchImpl = async (url, opts = {}) => {
    fetchCalls.push(String(url));
    if (stub) return stub(String(url), opts);
    throw new Error('no stub for ' + url);
  };
  const logger = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const enrich = createEnrich({ configStore: cfg, fetchImpl, logger });
  return { enrich, fetchCalls };
}

describe('enrich: imdb provider (public, no key)', () => {
  test('parses suggestion payload: cast, imdb id, year match', async () => {
    const { enrich, fetchCalls } = makeEnrich({
      providers: ['imdb'],
      stub: (url) => {
        assert.match(url, /v3\.sg\.media-imdb\.com\/suggestion\/x\/inception\.json/);
        return jsonOk({ d: [
          { l: 'Inception', y: 2010, q: 'feature', id: 'tt1375666', s: 'Leonardo DiCaprio, Joseph Gordon-Levitt', i: { imageUrl: 'https://imdb/img.jpg' } },
          { l: 'Inception: The Cobol Job', y: 2010, q: 'feature', id: 'tt5295894' },
        ] });
      },
    });
    const r = await enrich.enrich({ mediaType: 'movie', tmdbId: 27205, title: 'Inception', year: 2010 });
    assert.equal(r.ok, true);
    assert.equal(r.provider, 'imdb');
    assert.deepEqual(r.cast, ['Leonardo DiCaprio', 'Joseph Gordon-Levitt']);
    assert.equal(r.externalIds.imdbId, 'tt1375666');
    assert.equal(r.year, 2010);
    assert.equal(r.posterUrl, 'https://imdb/img.jpg');
    assert.equal(fetchCalls.length, 1);
  });

  test('falls back to first feature entry when year does not match', async () => {
    const { enrich } = makeEnrich({
      providers: ['imdb'],
      stub: () => jsonOk({ d: [{ l: 'Wrong Year', y: 1999, q: 'feature', id: 'tt0000002' }] }),
    });
    const r = await enrich.enrich({ mediaType: 'movie', tmdbId: 1, title: 'Inception', year: 2010 });
    assert.equal(r.externalIds.imdbId, 'tt0000002');
  });
});

describe('enrich: tmdb provider (credits)', () => {
  test('maps cast, directors and imdb external id', async () => {
    const { enrich, fetchCalls } = makeEnrich({
      providers: ['tmdb'],
      tmdbKey: 'KEY',
      stub: (url) => {
        assert.match(url, /append_to_response=credits,external_ids/);
        assert.match(url, /api_key=KEY/);
        return jsonOk({
          title: 'Inception', release_date: '2010-07-16', overview: 'Dreams.',
          credits: {
            cast: [{ name: 'Leonardo DiCaprio' }, { name: 'Elliot Page' }],
            crew: [{ name: 'Christopher Nolan', job: 'Director' }, { name: 'Someone', job: 'Writer' }],
          },
          external_ids: { imdb_id: 'tt1375666' },
        });
      },
    });
    const r = await enrich.enrich({ mediaType: 'movie', tmdbId: 27205, title: 'Inception', year: 2010 });
    assert.equal(r.provider, 'tmdb');
    assert.deepEqual(r.cast, ['Leonardo DiCaprio', 'Elliot Page']);
    assert.deepEqual(r.directors, ['Christopher Nolan']);
    assert.equal(r.externalIds.imdbId, 'tt1375666');
    assert.equal(fetchCalls.length, 1);
  });
});

describe('enrich: tvdb provider (v4 login → search → extended)', () => {
  test('series: token cached, remote imdb id and characters mapped', async () => {
    const { enrich, fetchCalls } = makeEnrich({
      providers: ['tvdb'],
      stub: (url, opts = {}) => {
        if (url.includes('/v4/login')) {
          assert.deepEqual(JSON.parse(opts.body), { apikey: 'TVDBKEY', pin: '1234' });
          return jsonOk({ data: { token: 'T0K3N' } });
        }
        if (url.includes('/v4/search')) {
          assert.equal(opts.headers.Authorization, 'Bearer T0K3N');
          return jsonOk({ data: [
            { type: 'series', tvdbId: 73739, name: 'Severance', year: '2022', remote_ids: [{ sourceName: 'IMDb', id: 'tt11280740' }] },
            { type: 'movie', tvdbId: 1, name: 'x' },
          ] });
        }
        if (url.includes('/v4/series/73739/extended')) {
          return jsonOk({ data: { overview: 'Lumon.', characters: [{ name: 'Mark S.', personName: 'Adam Scott' }, { name: 'Helly R.', personName: 'Britt Lower' }] } });
        }
        throw new Error('unexpected url ' + url);
      },
    });
    // pin configured
    const dir = tmpDir();
    const cfg = new JsonStore(path.join(dir, 'config.json'), defaultConfig());
    cfg.load();
    applyPatch(cfg.data, { enrich: { enabled: true, providers: ['tvdb'], tvdb: { apiKey: 'TVDBKEY', pin: '1234' } } });
    const n = createEnrich({ configStore: cfg, fetchImpl: async (u, o) => {
      if (String(u).includes('/v4/login')) return jsonOk({ data: { token: 'T0K3N' } });
      if (String(u).includes('/v4/search')) return jsonOk({ data: [{ type: 'series', tvdbId: 73739, name: 'Severance', year: '2022', remote_ids: [{ sourceName: 'IMDb', id: 'tt11280740' }] }] });
      if (String(u).includes('/extended')) return jsonOk({ data: { overview: 'Lumon.', characters: [{ personName: 'Adam Scott' }, { personName: 'Britt Lower' }] } });
      throw new Error('unexpected ' + u);
    }, logger: { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} } });
    const r = await n.enrich({ mediaType: 'tv', tmdbId: 9, title: 'Severance', year: 2022 });
    assert.equal(r.provider, 'tvdb');
    assert.deepEqual(r.cast, ['Adam Scott', 'Britt Lower']);
    assert.equal(r.externalIds.imdbId, 'tt11280740');
    assert.equal(r.externalIds.tvdbId, 73739);
  });
});

describe('enrich: merge, fallback, cache, disable', () => {
  test('later provider fills only missing fields', async () => {
    const { enrich, fetchCalls } = makeEnrich({
      providers: ['tmdb', 'imdb'],
      tmdbKey: 'KEY',
      stub: (url) => {
        if (url.includes('api.themoviedb.org')) {
          return jsonOk({ title: 'T', overview: 'From TMDB', credits: { cast: [], crew: [] }, external_ids: {} });
        }
        return jsonOk({ d: [{ l: 'T', y: 2020, q: 'feature', id: 'tt111', s: 'Actor A, Actor B' }] });
      },
    });
    const r = await enrich.enrich({ mediaType: 'movie', tmdbId: 5, title: 'T', year: 2020 });
    assert.equal(r.provider, 'tmdb');
    assert.equal(r.overview, 'From TMDB');
    assert.deepEqual(r.cast, ['Actor A', 'Actor B'], 'empty tmdb cast filled from imdb');
    assert.equal(r.externalIds.imdbId, 'tt111');
    assert.equal(fetchCalls.length, 2);
  });

  test('all providers failed → ok:false with attempts', async () => {
    const { enrich, fetchCalls } = makeEnrich({
      providers: ['imdb', 'tvdb'],
      stub: () => { throw new Error('network down'); },
    });
    const r = await enrich.enrich({ mediaType: 'movie', tmdbId: 5, title: 'T', year: 2020 });
    assert.equal(r.ok, false);
    assert.equal(r.attempts.length, 2, 'both providers attempted');
    assert.ok(r.attempts.every((a) => a.ok === false));
    // imdb fails during fetch (1 call); tvdb fails at login (no key configured) before any fetch
    assert.equal(fetchCalls.length, 1);
  });

  test('cache: second call performs no fetches', async () => {
    let calls = 0;
    const { enrich } = makeEnrich({
      providers: ['imdb'],
      stub: () => { calls += 1; return jsonOk({ d: [{ l: 'T', y: 2020, q: 'feature', id: 'tt1' }] }); },
    });
    await enrich.enrich({ mediaType: 'movie', tmdbId: 9, title: 'T', year: 2020 });
    const r2 = await enrich.enrich({ mediaType: 'movie', tmdbId: 9, title: 'T', year: 2020 });
    assert.equal(r2.cached, true);
    assert.equal(calls, 1);
  });

  test('disabled → ok:false with reason; unknown provider ignored', async () => {
    const dir = tmpDir();
    const cfg = new JsonStore(path.join(dir, 'config.json'), defaultConfig());
    cfg.load();
    applyPatch(cfg.data, { enrich: { enabled: false } });
    const n = createEnrich({ configStore: cfg, fetchImpl: async () => { throw new Error('must not be called'); }, logger: { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} } });
    const r = await n.enrich({ mediaType: 'movie', tmdbId: 1, title: 'T' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'disabled');
  });
});

describe('config migration v2 → v3 (enrich section)', () => {
  test('old config file gains enrich defaults', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      version: 2, tmdb: { apiKey: 'K' }, seerr: { url: 'http://x', apiKey: 'S', tvSeasons: 'all' },
      schedule: { enabled: true, intervalHours: 6, jitterMinutes: 5, runOnStart: false, retryCooldownDays: 3 },
      selection: { mediaTypes: ['movie'], moviesPerRun: 1, showsPerRun: 0 },
      filters: {}, sources: {}, scoring: {}, ui: {}, general: {}, notify: { providers: [] }, backups: { maxKeep: 5 },
    }));
    const { cfg } = loadConfig(dir, {});
    assert.equal(cfg.version, 3);
    assert.deepEqual(cfg.enrich.providers, ['tmdb', 'imdb', 'tvdb']);
    assert.equal(cfg.enrich.enabled, true);
    assert.equal(cfg.tmdb.apiKey, 'K', 'existing values preserved');
  });
});
