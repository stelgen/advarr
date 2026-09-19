// Advarr v0.4.0 — keyless discovery: TMDB Daily Export source, noGenres, full Seerr-only cycle.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createExporter } from '../lib/export.js';
import { createEngine } from '../lib/engine.js';
import { defaultConfig, applyPatch, loadConfig } from '../lib/config.js';
import { JsonStore } from '../lib/store.js';
import { passesFilters } from '../lib/scoring.js';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'advarr040-')); }
function storeIn(dir, name, def) { const s = new JsonStore(path.join(dir, name), def); s.load(); return s; }

function gzFixture(rows) {
  return zlib.gzipSync(rows.map((r) => JSON.stringify(r)).join('\n'));
}

const SAMPLE = [
  { id: 27205, title: 'Inception', original_title: 'Inception', popularity: 55.3, vote_average: 8.4, vote_count: 34000, release_date: '2010-07-16', adult: false },
  { id: 968051, title: 'The Monkey', original_title: 'The Monkey', popularity: 930.2, vote_average: 6.8, vote_count: 700, release_date: '2025-02-20', adult: false },
  { id: 999, title: 'Adult Thing', original_title: 'Adult Thing', popularity: 500.0, vote_average: 5.0, vote_count: 100, release_date: '2024-01-01', adult: true },
  { id: 998, title: 'No Pop', original_title: 'No Pop', popularity: 0, vote_average: 7.0, vote_count: 10, release_date: '2023-01-01', adult: false },
];

describe('tmdb export: parse + date fallback + cache', () => {
  test('streamTop: popularity sort, adult excluded, topN respected', async () => {
    const exporter = createExporter({});
    const top = await exporter._streamTop(gzFixture(SAMPLE), 2, false);
    assert.deepEqual(top.map((x) => x.id), [968051, 27205], 'sorted by popularity, adult dropped');
    const top3 = await exporter._streamTop(gzFixture(SAMPLE), 3, true);
    assert.deepEqual(top3.map((x) => x.id), [968051, 999, 27205], 'includeAdult passes adult rows');
  });

  test('fetchTop: yesterday 404 → day-2 succeeds; cache prevents refetch', async () => {
    const calls = [];
    const exporter = createExporter({
      fetchImpl: async (url) => {
        calls.push(String(url));
        if (calls.length === 1) return { ok: false, status: 404 };
        return { ok: true, status: 200, arrayBuffer: async () => gzFixture(SAMPLE) };
      },
    });
    const items = await exporter.fetchTop('movie', { topN: 10 });
    assert.equal(items.length, 2, 'adult and zero-popularity rows dropped');
    assert.equal(calls.length, 2, 'one 404 fallback');
    await exporter.fetchTop('movie', { topN: 10 });
    assert.equal(calls.length, 2, '12h cache prevents second download');
  });

  test('exportUrl shape (movie vs tv)', () => {
    const exporter = createExporter({});
    const d = new Date('2026-09-18T12:00:00Z');
    assert.match(exporter.exportUrl('movie', d), /movie_ids_09_18_2026\.json\.gz$/);
    assert.match(exporter.exportUrl('tv', d), /tv_series_ids_09_18_2026\.json\.gz$/);
    assert.ok(exporter.exportUrl('movie', d).startsWith('https://files.tmdb.org/p/exports/'));
  });
});

describe('noGenres: export candidates bypass genre filters', () => {
  test('genre filters ignored when candidate has no genre data', () => {
    const c = {
      adult: false, voteCount: 500, voteAverage: 7, year: 2025,
      originalLanguage: 'en', genreIds: [], noGenres: true,
    };
    const strict = { minVotes: 100, minRating: 5, yearFrom: 2000, yearTo: 0, includeGenres: [878], excludeGenres: [27], languages: [] };
    assert.equal(passesFilters(c, strict).ok, true, 'genre include/exclude skipped for export candidates');
    const withGenres = { ...c, noGenres: false, genreIds: [27] };
    assert.equal(passesFilters(withGenres, strict).ok, false, 'regular candidates still filtered');
  });
});

describe('engine no-key cycle (Seerr only)', () => {
  test('tmdb_export source → dedup → request via seerr, no TMDB key anywhere', async () => {
    const dir = tmpDir();
    const cfg = storeIn(dir, 'config.json', defaultConfig());
    applyPatch(cfg.data, {
      seerr: { url: 'http://seerr.mock', apiKey: 'S' },
      // намеренно НЕ задаём tmdb.apiKey
      sources: { pages: 1, trending_day: { on: false }, trending_week: { on: false }, popular: { on: false }, tmdb_export: { on: true, weight: 1, topN: 50 } },
      selection: { mediaTypes: ['movie'], moviesPerRun: 3, showsPerRun: 0 },
      filters: { minVotes: 100, minRating: 5, yearFrom: 0, includeGenres: [28], excludeGenres: [], checkAvailability: false },
    });
    const hist = storeIn(dir, 'history.json', { items: [] });
    const runs = storeIn(dir, 'runs.json', { runs: [] });

    const exporter = createExporter({
      fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => gzFixture(SAMPLE) }),
    });
    const requested = [];
    const seerr = {
      existingRequests: async () => new Set(),
      mediaStatus: async () => ({ status: 1, known: false }),
      request: async (payload) => { requested.push(payload); return { id: 1 }; },
    };
    const logger = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const engine = createEngine({
      configStore: cfg, historyStore: hist, runsStore: runs,
      getClients: () => ({ tmdb: {}, seerr, exporter }), logger,
    });

    const report = await engine.run();
    assert.equal(cfg.data.tmdb.apiKey, '', 'no TMDB key configured');
    assert.equal(report.requested, 2, 'export rows minus adult; zero-popularity dropped by scorer ranking tail');
    assert.deepEqual(requested.map((r) => r.tmdbId).sort((a, b) => b - a), [968051, 27205]);
    assert.ok(requested.every((r) => typeof r.tmdbId === 'number'));
    assert.equal(hist.data.items.length, 2);

    // dedup: second run requests nothing new
    await engine.run();
    assert.equal(requested.length, 2, 'no duplicates on second run');
  });
});

describe('config migration → v4 (tmdb_export + enrich cleanup)', () => {
  test('v2 config migrates to current version (tmdb_export source)', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      version: 2, tmdb: { apiKey: 'K' }, seerr: { url: 'http://x', apiKey: 'S', tvSeasons: 'all' },
      schedule: { enabled: true, intervalHours: 6, jitterMinutes: 5, runOnStart: false, retryCooldownDays: 3 },
      selection: { mediaTypes: ['movie'], moviesPerRun: 1, showsPerRun: 0 },
      filters: {}, sources: {}, scoring: {}, ui: {}, general: {}, notify: { providers: [] }, backups: { maxKeep: 5 },
    }));
    const { cfg } = loadConfig(dir, {});
    assert.equal(cfg.version, 5);
    assert.deepEqual(cfg.sources.tmdb_export, { on: false, weight: 0.9, topN: 150 });
    assert.ok(cfg.storage && 'historyMaxItems' in cfg.storage, 'storage section present');
    assert.equal(cfg.backups.intervalDays, 7);
    assert.deepEqual(cfg.sources.tmdb_export, { on: false, weight: 0.9, topN: 150 });
    assert.equal(cfg.tmdb.apiKey, 'K');
    assert.equal('enrich' in cfg, false, 'experimental enrich section cleaned up');
  });
});
