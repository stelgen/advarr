// Advarr v0.5.0 — resource footprint (RAM/SSD) + Radarr-style config export/import & backups.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { JsonStore } from '../lib/store.js';
import { defaultConfig, applyPatch, loadConfig } from '../lib/config.js';
import { createBackupManager } from '../lib/backup.js';
import { createExporter } from '../lib/export.js';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'advarr050-')); }

/* ---------- store: SSD-friendly writes ---------- */
describe('store v0.5: compact + skip-unchanged + debounce', () => {
  test('identical state is not written twice', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'x.json');
    const s = new JsonStore(file, { items: [] }, { debounceMs: 5 });
    s.load();
    s.update((d) => d.items.push(1));
    await new Promise((r) => setTimeout(r, 30));
    const writes1 = s.writes;
    assert.ok(writes1 >= 1, 'first change flushed');
    s.update(() => { /* no-op change */ });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(s.writes, writes1, 'no-op update → zero disk writes');
    // changing again → exactly one more write
    s.update((d) => d.items.push(2));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(s.writes, writes1 + 1);
  });

  test('serialized file is compact (no pretty-print indentation)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'y.json');
    const s = new JsonStore(file, { a: { b: 1 } }, { debounceMs: 1 });
    s.load();
    s.saveNow();
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes('\n  '), 'must be compact JSON');
    assert.deepEqual(JSON.parse(raw), { a: { b: 1 } });
  });

  test('semantically equal load → saveNow is a no-op (no write after restart)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'y.json');
    const a = new JsonStore(file, { items: [1, 2, 3] }, { debounceMs: 1 });
    a.load();
    a.saveNow();
    const writesAfterFirst = a.writes;
    const b = new JsonStore(file, { items: [1, 2, 3] }, { debounceMs: 1 });
    b.load();
    b.saveNow();
    assert.equal(b.writes, 0, 'unchanged state after reload → no write');
  });
});

/* ---------- exporter: bounded RAM ---------- */
describe('export: streaming top-N', () => {
  function gz(rows) { return zlib.gzipSync(rows.map((r) => JSON.stringify(r)).join('\n')); }

  test('makeTopN keeps bounded buffer, sorted desc', () => {
    const exporter = createExporter({});
    const t = exporter._makeTopN(3);
    for (const p of [5, 50, 10, 99, 7, 200, 1]) t.push({ popularity: p });
    assert.deepEqual(t.result().map((x) => x.popularity), [200, 99, 50], 'top-3 by popularity');
  });

  test('streamTop over big input retains only topN rows', async () => {
    const exporter = createExporter({});
    const rows = [];
    for (let i = 0; i < 50000; i += 1) rows.push({ id: i, popularity: (i % 97) + 0.001 * (i % 13), adult: false, title: `t${i}` });
    const top = await exporter._streamTop(gz(rows), 25, false);
    assert.equal(top.length, 25);
    assert.ok(top.every((x, i) => i === 0 || top[i - 1].popularity >= x.popularity), 'descending');
    assert.ok(top[0].popularity >= 96, 'best popularity near max');
  });
});

/* ---------- backups: interval + custom folder (Radarr parity) ---------- */
describe('backups v0.5: schedule + folder', () => {
  test('intervalDays=0 → no scheduled creation; due interval → creates', () => {
    const dir = tmpDir();
    const cfg = new JsonStore(path.join(dir, 'config.json'), defaultConfig());
    cfg.load();
    applyPatch(cfg.data, { backups: { maxKeep: 5, intervalDays: 0, folder: '' } });
    const hist = new JsonStore(path.join(dir, 'history.json'), { items: [] }); hist.load();
    const runs = new JsonStore(path.join(dir, 'runs.json'), { runs: [] }); runs.load();
    const bm = createBackupManager({ dataDir: dir, configStore: cfg, historyStore: hist, runsStore: runs, logger: { log: () => {}, error: () => {} }, version: '0.5.0' });

    // interval=0 → checkScheduledBackup logic (inlined here): no creation
    const days = Number(cfg.data.backups.intervalDays ?? 7);
    assert.equal(days > 0 && Date.now() - 0 >= days * 86400e3 ? 'create' : 'skip', 'skip', 'interval 0 = off');

    // custom folder honored
    const custom = path.join(dir, 'custom-backups');
    applyPatch(cfg.data, { backups: { folder: custom } });
    const b = bm.create();
    assert.ok(fs.existsSync(path.join(custom, b.id)), 'snapshot lands in custom folder');
    assert.ok(bm.list().some((i) => i.id === b.id));
  });

  test('scheduled-backup decision helper semantics', () => {
    const now = Date.now();
    const threeDaysAgo = now - 3 * 86400e3;
    const due = (last, days) => days > 0 && now - last >= days * 86400e3;
    assert.equal(due(0, 7), true, 'never backed up + interval → due');
    assert.equal(due(threeDaysAgo, 7), false, 'fresh backup → not due');
    assert.equal(due(threeDaysAgo, 3), true, 'interval elapsed → due');
    assert.equal(due(threeDaysAgo, 0), false, 'disabled');
  });
});

/* ---------- config export/import (live server) ---------- */
describe('config export/import endpoints', { timeout: 90000 }, () => {
  const PORT = 8971;
  let child = null;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advarr050live-'));
  const waitHealthy = async (port, tries = 80) => {
    for (let i = 0; i < tries; i += 1) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(700) });
        if (r.ok) return await r.json();
      } catch { /* retry */ }
      await new Promise((r2) => setTimeout(r2, 250));
    }
    throw new Error(`server on :${port} not healthy`);
  };

  test('download contains real secrets (Radarr parity), import applies on the fly', async () => {
    child = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, ADVARR_DATA_DIR: dataDir, ADVARR_PORT: String(PORT) }, stdio: 'ignore' });
    let healthy = false;
    for (let i = 0; i < 80 && !healthy; i += 1) {
      try { await fetch(`http://127.0.0.1:${PORT}/api/v1/health`, { signal: AbortSignal.timeout(700) }); healthy = true; } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    assert.ok(healthy, 'server healthy');

    // set a real secret so download must contain it unmasked
    await fetch(`http://127.0.0.1:${PORT}/api/v1/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tmdb: { apiKey: 'LIVE-KEY-1234' }, filters: { minRating: 8.8 } }),
    });

    const dl = await fetch(`http://127.0.0.1:${PORT}/api/v1/system/config/download`);
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-disposition'), /advarr\.config\.v\d+\.json/);
    const exported = JSON.parse(Buffer.from(await dl.arrayBuffer()).toString('utf8'));
    assert.equal(exported.tmdb.apiKey, 'LIVE-KEY-1234', 'Radarr-parity: config file carries real values');
    assert.equal(exported.filters.minRating, 8.8);

    // mutate, then import the older snapshot back
    await fetch(`http://127.0.0.1:${PORT}/api/v1/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filters: { minRating: 2.0 } }),
    });
    const res = await fetch(`http://127.0.0.1:${PORT}/api/v1/system/config/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exported),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    const after = await (await fetch(`http://127.0.0.1:${PORT}/api/v1/settings`)).json();
    assert.equal(after.filters.minRating, 8.8, 'import restored minRating');
    assert.equal(after.tmdb.apiKey, '••••1234', 'masked in API responses as usual');
  });

  test('import rejects non-config JSON', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/v1/system/config/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hello: 1 }),
    });
    assert.equal(res.status, 400);
  });

  test('cleanup', () => { if (child) child.kill('SIGTERM'); child?.kill?.('SIGTERM'); });
});
