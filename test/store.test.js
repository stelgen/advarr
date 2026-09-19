// Advarr tests — lib/store.js: JsonStore (load/defaults/atomic persist/corrupt fallback) + ringPush.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JsonStore, ringPush } from '../lib/store.js';
import { mkTmp, sleep } from './helpers.js';

const dir = mkTmp('store');

test('load(): missing file → defaults returned AND defaults file created on disk', () => {
  const file = path.join(dir, 'missing.json');
  const s = new JsonStore(file, { a: 1, items: [] });
  assert.deepEqual(s.load(), { a: 1, items: [] });
  assert.ok(fs.existsSync(file));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1, items: [] });
});

test('load(): stored keys override defaults, defaults merged under stored', () => {
  const file = path.join(dir, 'merged.json');
  fs.writeFileSync(file, JSON.stringify({ a: 42, extra: 'keep-me' }));
  const s = new JsonStore(file, { a: 1, b: 'default-b' });
  assert.deepEqual(s.load(), { a: 42, b: 'default-b', extra: 'keep-me' });
});

test('update() mutates and persists through the debounce', async () => {
  const file = path.join(dir, 'debounce.json');
  const s = new JsonStore(file, { n: 0, tags: [] }, { debounceMs: 120, skipUnchanged: false });
  s.load();
  const returned = s.update((d) => { d.n = 7; d.tags.push('ok'); });
  assert.deepEqual(returned, { n: 7, tags: ['ok'] });          // in-memory immediately
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, 0); // not yet flushed
  await sleep(200); // > debounce
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.n, 7);
  assert.deepEqual(onDisk.tags, ['ok']);
});

test('saveNow() is synchronous, atomic — no .tmp leftovers in the directory', () => {
  const file = path.join(dir, 'atomic.json');
  const s = new JsonStore(file, { v: 1 });
  s.load();
  s.update((d) => { d.v = 2; d.blob = 'x'.repeat(5000); });
  s.saveNow();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).v, 2);
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, [], `leftover tmp files: ${leftovers}`);
});

test('close() flushes a pending debounced write immediately', () => {
  const file = path.join(dir, 'close-flush.json');
  const s = new JsonStore(file, { v: 0 });
  s.load();
  s.update((d) => { d.v = 9; });
  s.close(); // no sleep — must hit the disk synchronously
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).v, 9);
});

test('corrupt file → falls back to defaults and rewrites valid JSON', () => {
  const file = path.join(dir, 'corrupt.json');
  fs.writeFileSync(file, '{corrupt!! not json at all');
  const s = new JsonStore(file, { ok: true, items: [] });
  assert.deepEqual(s.load(), { ok: true, items: [] });
  const repaired = JSON.parse(fs.readFileSync(file, 'utf8')); // rewritten as valid defaults
  assert.deepEqual(repaired, { ok: true, items: [] });
});

test('data getter lazily loads', () => {
  const file = path.join(dir, 'lazy.json');
  const s = new JsonStore(file, { lazy: true });
  assert.deepEqual(s.data, { lazy: true }); // no explicit load() call
  assert.ok(fs.existsSync(file));
});

test('ringPush: caps length, drops oldest, returns same array reference', () => {
  const arr = ringPush([], 'a', 2);
  ringPush(arr, 'b', 2);
  assert.deepEqual(arr, ['a', 'b']);
  assert.equal(ringPush(arr, 'c', 2), arr);
  assert.deepEqual(arr, ['b', 'c']);
  const big = Array.from({ length: 10 }, (_, i) => i);
  assert.deepEqual(ringPush(big, 10, 5), [6, 7, 8, 9, 10]);
});
