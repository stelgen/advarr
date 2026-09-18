// Advarr tests — lib/config.js: defaults shape, deepMerge, env seeding, applyPatch, unmaskPatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaultConfig, deepMerge, applyPatch, loadConfig, unmaskPatch } from '../lib/config.js';
import { mkTmp } from './helpers.js';

// ---------- defaultConfig ----------

test('defaultConfig: all sections and key fields exist', () => {
  const cfg = defaultConfig();
  for (const section of ['version', 'tmdb', 'seerr', 'schedule', 'selection', 'filters', 'sources', 'scoring', 'ui']) {
    assert.ok(section in cfg, `missing section: ${section}`);
  }
  assert.equal(cfg.version, 1);
  assert.deepEqual(Object.keys(cfg.tmdb).sort(), ['apiKey', 'language', 'region']);
  assert.deepEqual(Object.keys(cfg.seerr).sort(), ['apiKey', 'tvSeasons', 'url']);
  assert.deepEqual(cfg.selection.mediaTypes, ['movie', 'tv']);
  assert.deepEqual(Object.keys(cfg.filters).sort(), [
    'checkAvailability', 'excludeGenres', 'excludeInSeerr', 'includeAdult', 'includeGenres',
    'languages', 'minRating', 'minVotes', 'yearFrom', 'yearTo',
  ]);
  assert.deepEqual(cfg.scoring.favoriteGenres, []);
  for (const s of ['trending_day', 'trending_week', 'popular', 'top_rated', 'now_playing', 'upcoming']) {
    assert.ok('on' in cfg.sources[s] && 'weight' in cfg.sources[s], `source ${s} shape`);
  }
  assert.equal(cfg.sources.discover.on, false);
});

// ---------- deepMerge ----------

test('deepMerge: arrays are replaced wholesale, not merged', () => {
  const out = deepMerge({ tags: [1, 2, 3], deep: { list: ['a'] } }, { tags: [9], deep: { list: ['b', 'c'] } });
  assert.deepEqual(out.tags, [9]);
  assert.deepEqual(out.deep.list, ['b', 'c']);
});

test('deepMerge: nested objects merged, scalars overridden, base untouched', () => {
  const base = { a: { x: 1, y: 2 }, s: 'old', n: 1 };
  const snapshot = JSON.stringify(base);
  const out = deepMerge(base, { a: { y: 3 }, s: 'new', added: 'later' });
  assert.deepEqual(out.a, { x: 1, y: 3 });
  assert.equal(out.s, 'new');
  assert.equal(out.n, 1);           // scalar untouched when not in patch
  assert.equal(out.added, 'later'); // new key added
  assert.equal(JSON.stringify(base), snapshot); // base not mutated
  assert.deepEqual(deepMerge(base, {}), base);  // empty patch → unchanged
});

// ---------- loadConfig ----------

test('loadConfig: env seeds empty secrets and creates config.json in the data dir', () => {
  const dir = mkTmp('cfg-env');
  const { store, cfg } = loadConfig(dir, { TMDB_API_KEY: 'env-key-abc', SEERR_URL: 'http://seerr.lan:5055' });
  assert.equal(cfg.tmdb.apiKey, 'env-key-abc');
  assert.equal(cfg.seerr.url, 'http://seerr.lan:5055');
  assert.equal(cfg.tmdb.language, 'ru-RU'); // non-secret defaults untouched
  store.saveNow(); // flush seeded value to disk
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(onDisk.tmdb.apiKey, 'env-key-abc');
  assert.equal(onDisk.seerr.url, 'http://seerr.lan:5055');
});

test('loadConfig: env does NOT overwrite an existing (user-set) key', () => {
  const dir = mkTmp('cfg-keep');
  const first = loadConfig(dir, { TMDB_API_KEY: 'user-set-key' });
  first.store.saveNow(); // ensure the value is on disk before re-loading
  assert.equal(first.cfg.tmdb.apiKey, 'user-set-key');
  const { cfg } = loadConfig(dir, { TMDB_API_KEY: 'env-tries-to-win' });
  assert.equal(cfg.tmdb.apiKey, 'user-set-key'); // UI/disk wins over env
  const { cfg: cfg2 } = loadConfig(dir, {});     // no env at all → stays
  assert.equal(cfg2.tmdb.apiKey, 'user-set-key');
});

// ---------- applyPatch ----------

test('applyPatch: deep partial update in place, siblings and other sections preserved', () => {
  const cfg = defaultConfig();
  const out = applyPatch(cfg, { filters: { minVotes: 999 }, seerr: { tvSeasons: 'first' } });
  assert.equal(out, cfg); // mutates in place and returns the same object
  assert.equal(cfg.filters.minVotes, 999);
  assert.equal(cfg.filters.minRating, 6.5); // sibling kept
  assert.equal(cfg.seerr.tvSeasons, 'first');
  assert.equal(cfg.seerr.url, '');
  assert.equal(cfg.tmdb.apiKey, '');
  assert.deepEqual(cfg.selection.mediaTypes, ['movie', 'tv']);
  applyPatch(cfg, { selection: { mediaTypes: ['movie'] } }); // array patch replaces array
  assert.deepEqual(cfg.selection.mediaTypes, ['movie']);
});

// ---------- unmaskPatch ----------

test('unmaskPatch: masked ••••xxxx values replaced by stored old values; real values kept', () => {
  const oldCfg = { tmdb: { apiKey: 'real-tmdb-1234' }, seerr: { apiKey: 'real-seerr-9999' } };
  const patch = {
    tmdb: { apiKey: '••••1234' },        // user did not touch it (masked echo)
    seerr: { apiKey: 'brand-new-key' },  // user typed a new key
    filters: { minVotes: 5 },            // unrelated section rides along
  };
  unmaskPatch(oldCfg, patch, [['tmdb', 'apiKey'], ['seerr', 'apiKey']]);
  assert.equal(patch.tmdb.apiKey, 'real-tmdb-1234');
  assert.equal(patch.seerr.apiKey, 'brand-new-key');
  assert.deepEqual(patch.filters, { minVotes: 5 });
});

test('unmaskPatch: empty stored value → masked replaced with ""; tolerant of null nodes', () => {
  const p2 = { tmdb: { apiKey: '••••' } };
  unmaskPatch({ tmdb: { apiKey: '' } }, p2, [['tmdb', 'apiKey']]);
  assert.equal(p2.tmdb.apiKey, '');
  assert.doesNotThrow(() => unmaskPatch({ tmdb: { apiKey: 'x' } }, { tmdb: null }, [['tmdb', 'apiKey']]));
  assert.doesNotThrow(() => unmaskPatch({}, {}, [['seerr', 'apiKey']]));
});
