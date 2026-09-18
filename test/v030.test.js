// Advarr v0.3.0 — feature tests: proxy, notify, backup, retry cooldown, live general settings.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeOutboundFetch, isBypassed } from '../lib/proxy.js';
import { createNotify } from '../lib/notify.js';
import { createBackupManager } from '../lib/backup.js';
import { createEngine } from '../lib/engine.js';
import { JsonStore } from '../lib/store.js';
import { defaultConfig, applyPatch } from '../lib/config.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'advarr030-')); }
function storeIn(dir, name, def) { const s = new JsonStore(path.join(dir, name), def); s.load(); return s; }
function httpServer(handler) {
  const server = http.createServer(handler);
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server)));
}

/* ---------- proxy ---------- */
describe('proxy', () => {
  test('http target goes through proxy in absolute-form; bypass skips proxy', async () => {
    const target = await httpServer((req, res) => { res.writeHead(200, { 'Content-Length': 7 }); res.end('{"a":1}'); });
    let sawAbsolute = false;
    const proxy = await httpServer((req, res) => {
      if (req.url.startsWith('http://')) sawAbsolute = true;
      res.writeHead(200, { 'Content-Length': 7 }); res.end('{"a":1}');
    });
    try {
      const f = makeOutboundFetch({ proxy: { enabled: true, host: '127.0.0.1', port: proxy.address().port } });
      const res = await f(`http://127.0.0.1:${target.address().port}/x?q=1`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { a: 1 });
      assert.equal(sawAbsolute, true, 'request must use absolute-form via proxy');
    } finally { target.close(); proxy.close(); }
  });

  test('bypass: exact host, suffix, CIDR, wildcard', () => {
    assert.equal(isBypassed('localhost', 'localhost, 127.0.0.1'), true);
    assert.equal(isBypassed('localhost', 'example.com'), false);
    assert.equal(isBypassed('svc.corp.lan', '.corp.lan'), true);
    assert.equal(isBypassed('192.168.1.77', '192.168.1.0/24'), true);
    assert.equal(isBypassed('10.0.0.5', '192.168.1.0/24'), false);
    assert.equal(isBypassed('anything.example', '*'), true);
  });

  test('httpsOnly: plain http targets skip the proxy', async () => {
    let proxied = 0;
    const proxy = await httpServer((req, res) => { proxied += 1; res.writeHead(200); res.end('via-proxy'); });
    const target = await httpServer((req, res) => { res.writeHead(200, { 'Content-Length': 6 }); res.end('direct'); });
    try {
      const f = makeOutboundFetch({ proxy: { enabled: true, host: '127.0.0.1', port: proxy.address().port, httpsOnly: true } });
      const res = await f(`http://127.0.0.1:${target.address().port}/x`);
      assert.equal(await res.text(), 'direct');
      assert.equal(proxied, 0);
    } finally { proxy.close(); target.close(); }
  });

  test('proxy errors surface as thrown errors (status text present)', async () => {
    const proxy = await httpServer((req, res) => { res.writeHead(403, { 'Content-Length': 0 }); res.end(); });
    // CONNECT requests don't hit the request handler — need an explicit listener
    proxy.on('connect', (req, sock) => {
      sock.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      sock.end();
    });
    try {
      const f = makeOutboundFetch({ proxy: { enabled: true, host: '127.0.0.1', port: proxy.address().port }, timeoutMs: 1500 });
      await assert.rejects(() => f('https://example.com/x'), /CONNECT failed: 403/);
    } finally { proxy.close(); }
  });
});

/* ---------- notify ---------- */
describe('notify', () => {
  test('buildRunMessage: success and failure text', () => {
    const cfg = storeIn(tmpDir(), 'c.json', defaultConfig());
    const n = createNotify({ configStore: cfg, logger: { error: () => {}, warn: () => {} } });
    const rep = { dry: false, requested: 1, failed: 1, items: [
      { status: 'requested', mediaType: 'movie', title: 'Foo', year: 2024 },
      { status: 'failed', mediaType: 'tv', title: 'Bar', year: 2023, error: 'boom' },
    ] };
    const { text } = n.buildRunMessage(rep);
    assert.match(text, /запрошено 1/);
    assert.match(text, /Foo \(2024\)/);
    assert.match(text, /Bar \(2023\) — boom/);
  });

  test('telegram URL shape via fetchImpl stub', async () => {
    const cfg = storeIn(tmpDir(), 'c.json', defaultConfig());
    const calls = [];
    const n = createNotify({ configStore: cfg, fetchImpl: async (url, opts) => {
      calls.push([String(url), JSON.parse(opts.body)]);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }, logger: { error: () => {}, warn: () => {} } });
    await n.testProvider({ type: 'telegram', telegram: { botToken: 'T1', chatId: '42' } });
    assert.match(calls[0][0], /api\.telegram\.org\/botT1\/sendMessage/);
    assert.equal(calls[0][1].chat_id, '42');
    assert.match(calls[0][1].text, /Тестовое/);
  });

  test('runFinished respects triggers and enabled flag', async () => {
    const cfg = storeIn(tmpDir(), 'c.json', defaultConfig());
    cfg.data.notify.providers = [
      { id: 'a', type: 'webhook', enabled: true, onRunCompleted: true, onRunFailed: true, webhook: { url: 'http://x/a' } },
      { id: 'b', type: 'webhook', enabled: false, onRunCompleted: true, webhook: { url: 'http://x/b' } },
    ];
    const sent = [];
    const n = createNotify({ configStore: cfg, fetchImpl: async (url, opts) => {
      sent.push([String(url), JSON.parse(opts.body)]);
      return { ok: true, status: 200 };
    }, logger: { error: () => {}, warn: () => {} } });
    await n.runFinished({ requested: 2, failed: 0, items: [{ status: 'requested', mediaType: 'movie', title: 'X' }] });
    assert.equal(sent.length, 1, 'disabled provider must not fire');
    assert.equal(sent[0][0], 'http://x/a');
    assert.equal(sent[0][1].event, 'run_completed');
    await n.runFinished({ requested: 0, failed: 2, items: [{ status: 'failed', mediaType: 'movie', title: 'Y', error: 'e' }] });
    assert.equal(sent.length, 2);
    assert.equal(sent[1][1].event, 'run_failed');
  });
});

/* ---------- backup ---------- */
describe('backup manager', () => {
  test('create → list → rotate → restore', () => {
    const dir = tmpDir();
    const cfg = storeIn(dir, 'config.json', defaultConfig());
    applyPatch(cfg.data, { filters: { minRating: 9.9 } });
    const hist = storeIn(dir, 'history.json', { items: [{ id: 'h1', tmdbId: 1, mediaType: 'movie', status: 'requested', at: new Date().toISOString() }] });
    const runs = storeIn(dir, 'runs.json', { runs: [] });
    const bm = createBackupManager({ dataDir: dir, configStore: cfg, historyStore: hist, runsStore: runs, logger: { log: () => {}, error: () => {} }, version: '0.3.0-test' });

    const b1 = bm.create();                       // snapshot: minRating 9.9
    applyPatch(cfg.data, { filters: { minRating: 1.0 } });
    bm.create();                                  // snapshot: 1.0
    applyPatch(cfg.data, { filters: { minRating: 5.5 } });
    bm.restore(b1.id);
    assert.equal(cfg.data.filters.minRating, 9.9, 'restore rolls config back to snapshot');
    assert.deepEqual(hist.data.items.map((i) => i.id), ['h1']);
    assert.throws(() => bm.restore('../escape'), /bad backup id/);

    // rotation with maxKeep=2
    cfg.data.backups = { maxKeep: 2 };
    bm.create(); bm.create(); bm.create(); bm.create();
    assert.equal(bm.list().length, 2, 'rotation keeps maxKeep=2');
  });
});

/* ---------- engine: retry cooldown + dry mediaStatus ---------- */
describe('engine v0.3', () => {
  function makeEnv({ history = [], cooldown = 7 } = {}) {
    const dir = tmpDir();
    const cfg = storeIn(dir, 'config.json', defaultConfig());
    applyPatch(cfg.data, {
      tmdb: { apiKey: 'k' },
      seerr: { url: 'http://seerr.mock', apiKey: 'k' },
      sources: { pages: 1, trending_day: { on: true, weight: 1 } },
      selection: { mediaTypes: ['movie'], moviesPerRun: 5, showsPerRun: 0 },
      schedule: { retryCooldownDays: cooldown },
      filters: { minVotes: 0, minRating: 0, checkAvailability: false },
    });
    const hist = storeIn(dir, 'history.json', { items: history });
    const runs = storeIn(dir, 'runs.json', { runs: [] });
    const requestCalls = [];
    const tmdb = { fetchSource: async () => [{ id: 42, title: 'Retry Me', vote_average: 7, vote_count: 500, popularity: 100, release_date: '2025-01-01', genre_ids: [] }] };
    const seerr = {
      existingRequests: async () => new Set(),
      mediaStatus: async () => ({ status: 1, known: false }),
      request: async ({ tmdbId }) => { requestCalls.push(tmdbId); throw new Error('seerr down'); },
    };
    const logs = [];
    const logger = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    const engine = createEngine({ configStore: cfg, historyStore: hist, runsStore: runs, getClients: () => ({ tmdb, seerr }), logger });
    return { cfg, hist, engine, requestCalls, logs };
  }

  test('failed item is retried only after cooldown expires', async () => {
    const a = makeEnv({ history: [{ id: 'f1', tmdbId: 42, mediaType: 'movie', status: 'failed', at: new Date().toISOString(), title: 'R' }], cooldown: 7 });
    await a.engine.run();
    await a.engine.run();
    assert.equal(a.requestCalls.length, 0, 'fresh failure is not retried while cooling down');

    const b = makeEnv({ history: [{ id: 'f1', tmdbId: 42, mediaType: 'movie', status: 'failed', at: new Date(Date.now() - 8 * 86400e3).toISOString(), title: 'R' }], cooldown: 7 });
    await b.engine.run();
    assert.equal(b.requestCalls.length, 1, 'expired cooldown → retried');
  });

  test('requested items are never retried regardless of cooldown', async () => {
    const env = makeEnv({ history: [{ id: 'r1', tmdbId: 42, mediaType: 'movie', status: 'requested', at: new Date(Date.now() - 40 * 86400e3).toISOString(), title: 'R' }], cooldown: 7 });
    const rep = await env.engine.run();
    assert.equal(rep.scanned, 1);
    assert.equal(rep.requested, 0, 'already requested stays skipped');
  });
});

/* ---------- live server e2e: auth switch, port rebind, notify test, backup lifecycle ---------- */
describe('live server v0.3', { timeout: 60000 }, () => {
  const PORT = 8931;
  let child = null;
  const dataDir = tmpDir();

  const waitHealthy = async (port, tries = 40) => {
    for (let i = 0; i < tries; i += 1) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(700) });
        if (r.ok) return await r.json();
      } catch { /* retry */ }
      await new Promise((r2) => setTimeout(r2, 250));
    }
    throw new Error(`server on :${port} never became healthy`);
  };
  const put = async (port, patch, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(patch),
    });
    return { status: res.status, body: await res.json() };
  };

  test('boots, switches auth live, rebinds port live, notify test hits webhook, backup lifecycle', async () => {
    child = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, ADVARR_DATA_DIR: dataDir, ADVARR_PORT: String(PORT) }, stdio: 'ignore' });
    await waitHealthy(PORT);

    // --- auth switch live ---
    let r = await fetch(`http://127.0.0.1:${PORT}/api/v1/status`);
    assert.equal(r.status, 200, 'no auth by default');
    const s = await put(PORT, { general: { authentication: { method: 'basic', username: 'admin', password: 'secret' } } });
    assert.equal(s.status, 200);
    r = await fetch(`http://127.0.0.1:${PORT}/api/v1/status`);
    assert.equal(r.status, 401, 'basic auth now required');
    r = await fetch(`http://127.0.0.1:${PORT}/api/v1/status`, { headers: { Authorization: `Basic ${Buffer.from('admin:secret').toString('base64')}` } });
    assert.equal(r.status, 200, 'correct creds accepted');
    const basic = { Authorization: `Basic ${Buffer.from('admin:secret').toString('base64')}` };
    const off = await put(PORT, { general: { authentication: { method: 'none' } } }, basic);
    assert.equal(off.status, 200, 'disable PUT accepted with credentials');
    r = await fetch(`http://127.0.0.1:${PORT}/api/v1/status`);
    assert.equal(r.status, 200, 'auth disabled again');

    // --- port rebind live ---
    const PORT2 = PORT + 1;
    const p2 = await put(PORT, { general: { port: PORT2 } });
    assert.equal(p2.status, 200);
    await waitHealthy(PORT2);
    const occupied = net.createServer();
    await new Promise((res) => occupied.listen(PORT, '0.0.0.0', res));
    const conflict = await put(PORT2, { general: { port: PORT } });
    assert.equal(conflict.status, 409, 'occupied port must be rejected with 409');
    occupied.close();

    // --- notify test endpoint hits webhook ---
    const seen = [];
    const hook = await httpServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => { seen.push(JSON.parse(b || '{}')); res.writeHead(200); res.end('ok'); });
    });
    const hres = await fetch(`http://127.0.0.1:${PORT2}/api/v1/notify/test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: { id: 'n1', type: 'webhook', enabled: true, webhook: { url: `http://127.0.0.1:${hook.address().port}/hook` } } }),
    });
    const hbody = await hres.json();
    assert.equal(hbody.ok, true);
    await new Promise((r2) => setTimeout(r2, 200));
    assert.equal(seen.length, 1);
    assert.match(seen[0].content, /Тестовое/);
    hook.close();

    // --- backup lifecycle ---
    const created = await (await fetch(`http://127.0.0.1:${PORT2}/api/v1/backup`, { method: 'POST' })).json();
    assert.ok(created.id.startsWith('advarr_backup_'));
    const list = await (await fetch(`http://127.0.0.1:${PORT2}/api/v1/backup`)).json();
    assert.ok(list.items.some((i) => i.id === created.id));
    const dl = await fetch(`http://127.0.0.1:${PORT2}/api/v1/backup/${encodeURIComponent(created.id)}/download`);
    assert.equal(dl.status, 200);
    const snap = await dl.json();
    await put(PORT2, { filters: { minRating: 1.5 } });
    const res2 = await fetch(`http://127.0.0.1:${PORT2}/api/v1/backup/${encodeURIComponent(created.id)}/restore`, { method: 'POST' });
    assert.equal((await res2.json()).ok, true);
    const after = await (await fetch(`http://127.0.0.1:${PORT2}/api/v1/settings`)).json();
    assert.equal(after.filters.minRating, snap.config.filters.minRating, 'restore returned minRating');
  });

  after(() => { if (child) child.kill('SIGTERM'); });
});
