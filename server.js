#!/usr/bin/env node
// Advarr — composition root. Zero runtime deps.
// Passive TMDB discovery radar for Jellyseerr / Overseerr.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import url from 'node:url';

import { createLogger } from './lib/logs.js';
import { JsonStore } from './lib/store.js';
import { loadConfig, applyPatch, unmaskPatch, restoreProviderSecrets } from './lib/config.js';
import { createApp } from './lib/http.js';
import { createTmdb } from './lib/tmdb.js';
import { createSeerr, normalizeBaseUrl } from './lib/seerr.js';
import { createEngine } from './lib/engine.js';
import { createScheduler } from './lib/scheduler.js';
import { createNotify } from './lib/notify.js';
import { createBackupManager } from './lib/backup.js';
import { makeOutboundFetch } from './lib/proxy.js';

const APP_VERSION = '0.3.1';
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const DATA_DIR = process.env.ADVARR_DATA_DIR || path.join(__dirname, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

const logger = createLogger(1000);

// ---------- stores ----------
const { store: configStore } = loadConfig(DATA_DIR, process.env);
const historyStore = new JsonStore(path.join(DATA_DIR, 'history.json'), { items: [] });
historyStore.load();
const runsStore = new JsonStore(path.join(DATA_DIR, 'runs.json'), { runs: [] });
runsStore.load();

logger.setLevel(configStore.data.general.logLevel || 'info');

// ---------- outbound (proxy-aware) ----------
const outboundRef = { fn: null };
function rebuildOutbound() {
  outboundRef.fn = makeOutboundFetch({
    proxy: configStore.data.general.proxy,
    fetchImpl: globalThis.fetch,
  });
}
rebuildOutbound();
const dynamicOutbound = (u, o) => outboundRef.fn(u, o);

// ---------- clients (rebuilt when settings change) ----------
function buildTmdb() {
  return createTmdb({
    apiKey: configStore.data.tmdb.apiKey,
    language: configStore.data.tmdb.language,
    region: configStore.data.tmdb.region,
    fetchImpl: dynamicOutbound,
    logger,
  });
}
function buildSeerr() {
  return createSeerr({
    baseUrl: configStore.data.seerr.url,
    apiKey: configStore.data.seerr.apiKey,
    fetchImpl: dynamicOutbound,
    logger,
  });
}
const clients = { tmdb: buildTmdb(), seerr: buildSeerr() };

const notify = createNotify({ configStore, fetchImpl: dynamicOutbound, logger });
const backup = createBackupManager({
  dataDir: DATA_DIR, configStore, historyStore, runsStore, logger, version: APP_VERSION,
});

const engine = createEngine({
  configStore, historyStore, runsStore,
  getClients: () => clients,
  notify,
  logger,
});
const scheduler = createScheduler({ engine, configStore, logger });

// ---------- live-mutable auth (config-driven) ----------
function buildAuth() {
  const a = configStore.data.general?.authentication;
  if (!a) return null;
  if (a.method === 'basic' && a.username) return { type: 'basic', user: a.username, pass: a.password || '' };
  if (a.method === 'apiKey' && a.apiKey) return { type: 'key', key: a.apiKey };
  return null;
}

const app = createApp({
  logger,
  staticDir: path.join(__dirname, 'public'),
  authProvider: buildAuth,
  trustProxy: process.env.TRUST_PROXY === '1',
});

// ---------- helpers ----------
function json(ctx, status, obj) {
  ctx.res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  ctx.res.end(JSON.stringify(obj));
}

function maskSecret(value = '') {
  if (!value) return '';
  if (value.startsWith('••••')) return value;
  return `••••${value.slice(-4)}`;
}

function publicConfig(cfg) {
  const c = structuredClone(cfg);
  c.tmdb.apiKey = maskSecret(c.tmdb.apiKey);
  c.seerr.apiKey = maskSecret(c.seerr.apiKey);
  c.general.authentication.password = maskSecret(c.general.authentication.password);
  c.general.authentication.apiKey = maskSecret(c.general.authentication.apiKey);
  c.general.proxy.password = maskSecret(c.general.proxy.password);
  for (const p of (c.notify?.providers || [])) {
    if (p.telegram?.botToken) p.telegram.botToken = maskSecret(p.telegram.botToken);
  }
  return c;
}

function unmaskOne(oldValue, incoming) {
  return (typeof incoming === 'string' && incoming.startsWith('••••')) ? oldValue : incoming;
}

const SECRET_PATHS = [
  ['tmdb', 'apiKey'],
  ['seerr', 'apiKey'],
  ['general', 'authentication', 'password'],
  ['general', 'authentication', 'apiKey'],
  ['general', 'proxy', 'password'],
];

function applyLiveEffects() {
  logger.setLevel(configStore.data.general.logLevel || 'info');
  rebuildOutbound();
  clients.tmdb = buildTmdb();
  clients.seerr = buildSeerr();
  scheduler.scheduleNext();
}

// ---------- server binding (live host/port) ----------
function effectiveBinding() {
  return {
    host: configStore.data.general.host || '0.0.0.0',
    port: Number(configStore.data.general.port) || 8787,
  };
}
let currentBinding = effectiveBinding();
let httpServer = null;

function testBind(host, port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (err) => { probe.close(() => reject(err)); });
    probe.listen(port, host, () => probe.close(() => resolve()));
  });
}

async function rebindServer() {
  const target = effectiveBinding();
  if (target.host === currentBinding.host && target.port === currentBinding.port) {
    return { changed: false, ...target };
  }
  const prev = { ...currentBinding };
  // closeAllConnections: kill keep-alive sockets, otherwise close() waits for them
  httpServer.closeAllConnections();
  await new Promise((res) => httpServer.close(res));
  await new Promise((res, rej) => {
    httpServer = app.listen(target.port, target.host, () => res());
    httpServer.once('error', rej);
  }).catch(async (err) => {
    // roll back to the previous binding so the app never ends up dead
    await new Promise((r) => { httpServer = app.listen(prev.port, prev.host, r); });
    throw err;
  });
  currentBinding = target;
  logger.log(`server rebound → ${target.host}:${target.port}`);
  return { changed: true, ...target };
}

/** rebind AFTER the current response is flushed (see DEADLOCK GUARD above) */
function scheduleRebind() {
  const target = effectiveBinding();
  setTimeout(() => {
    rebindServer().catch((err) => logger.error(`rebind failed: ${err.message}`));
  }, 60);
  return { changed: true, ...target };
}

// ---------- routes ----------
app.get('/api/v1/health', (ctx) => json(ctx, 200, { ok: true, uptime: process.uptime(), version: APP_VERSION }));

app.get('/api/v1/status', async (ctx) => {
  let tmdbOk = null;
  let seerrInfo = null;
  if (configStore.data.tmdb.apiKey) {
    try { await clients.tmdb.test(); tmdbOk = true; } catch { tmdbOk = false; }
  }
  if (configStore.data.seerr.url && configStore.data.seerr.apiKey) {
    try { seerrInfo = await clients.seerr.test(); } catch { seerrInfo = null; }
  }
  json(ctx, 200, {
    version: APP_VERSION,
    running: engine.running,
    nextRunAt: scheduler.nextRunAt,
    tmdb: { connected: tmdbOk, language: configStore.data.tmdb.language },
    seerr: seerrInfo ? { connected: true, ...seerrInfo } : { connected: false },
    lastRun: engine.status().lastRun,
    historyCount: historyStore.data.items.length,
  });
});

app.get('/api/v1/settings', (ctx) => json(ctx, 200, publicConfig(configStore.data)));

app.put('/api/v1/settings', async (ctx) => {
  const oldCfg = structuredClone(configStore.data);
  const patch = ctx.body || {};

  // validate general binding before applying anything
  const newHost = (patch.general?.host ?? oldCfg.general.host ?? '').trim();
  const newPort = Number(patch.general?.port ?? oldCfg.general.port ?? 8787);
  if (!Number.isInteger(newPort) || newPort < 1 || newPort > 65535) {
    return json(ctx, 400, { error: 'порт должен быть целым числом 1–65535' });
  }
  const bindingChanged = newHost !== currentBinding.host || newPort !== currentBinding.port;
  if (bindingChanged) {
    try { await testBind(newHost, newPort); } catch (err) {
      return json(ctx, 409, { error: `не удалось занять ${newHost}:${newPort} — ${err.message}` });
    }
  }

  applyPatch(configStore.data, unmaskPatch(configStore.data, patch, SECRET_PATHS));
  restoreProviderSecrets(oldCfg, configStore.data);
  configStore.saveNow();

  applyLiveEffects();

  // DEADLOCK GUARD: we are answering on the very socket a rebind would close.
  // Respond first, rebind a tick later.
  const rebound = bindingChanged
    ? scheduleRebind()
    : { changed: false, ...currentBinding };

  logger.log('settings updated');
  json(ctx, 200, { ...publicConfig(configStore.data), rebound });
});

app.post('/api/v1/settings/test-tmdb', async (ctx) => {
  const over = ctx.body || {};
  try {
    const t = createTmdb({
      apiKey: over.apiKey !== undefined ? unmaskOne(configStore.data.tmdb.apiKey, over.apiKey) : configStore.data.tmdb.apiKey,
      language: over.language || configStore.data.tmdb.language,
      region: over.region ?? configStore.data.tmdb.region,
      fetchImpl: dynamicOutbound,
      logger,
    });
    await t.test();
    json(ctx, 200, { ok: true, message: 'TMDB: подключение успешно' });
  } catch (err) {
    json(ctx, 200, { ok: false, message: `TMDB: ${err.message}` });
  }
});

app.post('/api/v1/settings/test-seerr', async (ctx) => {
  const over = ctx.body || {};
  try {
    const s = createSeerr({
      baseUrl: over.url !== undefined ? normalizeBaseUrl(over.url) : configStore.data.seerr.url,
      apiKey: over.apiKey !== undefined ? unmaskOne(configStore.data.seerr.apiKey, over.apiKey) : configStore.data.seerr.apiKey,
      fetchImpl: dynamicOutbound,
      logger,
    });
    const res = await s.test();
    json(ctx, 200, { ok: true, message: `${res.app} v${res.version} — подключено` });
  } catch (err) {
    json(ctx, 200, { ok: false, message: `Seerr: ${err.message}` });
  }
});

// ---------- notifications ----------
app.post('/api/v1/notify/test', async (ctx) => {
  const provider = ctx.body?.provider;
  if (!provider || !provider.type) return json(ctx, 400, { error: 'provider required' });
  if (provider.type === 'telegram' && typeof provider.telegram?.botToken === 'string') {
    const old = (configStore.data.notify?.providers || []).find((p) => p.id === provider.id);
    provider.telegram.botToken = unmaskOne(old?.telegram?.botToken || '', provider.telegram.botToken);
  }
  try {
    await notify.testProvider(provider);
    json(ctx, 200, { ok: true, message: 'Тестовое уведомление отправлено' });
  } catch (err) {
    json(ctx, 200, { ok: false, message: err.message });
  }
});

// ---------- backups ----------
app.get('/api/v1/backup', (ctx) => json(ctx, 200, { items: backup.list() }));
app.post('/api/v1/backup', (ctx) => {
  try { json(ctx, 201, backup.create()); } catch (err) { json(ctx, 500, { error: err.message }); }
});
app.delete('/api/v1/backup/:id', (ctx) => {
  try { json(ctx, 200, backup.remove(ctx.params.id)); } catch (err) { json(ctx, 404, { error: err.message }); }
});
app.post('/api/v1/backup/:id/restore', (ctx) => {
  try {
    backup.restore(ctx.params.id);
    applyLiveEffects();
    const target = effectiveBinding();
    const rebound = (target.host !== currentBinding.host || target.port !== currentBinding.port)
      ? scheduleRebind()
      : { changed: false, ...currentBinding };
    json(ctx, 200, { ok: true, rebound });
  } catch (err) {
    json(ctx, 400, { error: err.message });
  }
});
app.get('/api/v1/backup/:id/download', (ctx) => {
  try {
    const p = backup.safePath(ctx.params.id);
    if (!fs.existsSync(p)) return json(ctx, 404, { error: 'not found' });
    const buf = fs.readFileSync(p);
    ctx.res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${ctx.params.id}"`,
      'Content-Length': buf.length,
    });
    ctx.res.end(buf);
  } catch (err) {
    json(ctx, 400, { error: err.message });
  }
});

// ---------- discovery / run / history / logs ----------
app.get('/api/v1/genres/:type', async (ctx) => {
  const type = ctx.params.type === 'tv' ? 'tv' : 'movie';
  try {
    const genres = await clients.tmdb.genres(type);
    json(ctx, 200, { type, genres });
  } catch (err) {
    json(ctx, 502, { error: err.message });
  }
});

app.get('/api/v1/discover/preview', async (ctx) => {
  const limit = Math.max(1, Math.min(60, Number(ctx.query.get('limit') || 24)));
  try {
    const report = await engine.run({ dry: true, limit });
    json(ctx, 200, { report });
  } catch (err) {
    json(ctx, 409, { error: err.message });
  }
});

app.post('/api/v1/run', async (ctx) => {
  const dry = Boolean(ctx.body?.dry);
  try {
    if (dry) return json(ctx, 200, { report: await engine.run({ dry: true }) });
    if (engine.running) return json(ctx, 409, { error: 'run already in progress' });
    engine.run().catch(() => { /* logged inside engine */ });
    json(ctx, 202, { started: true });
  } catch (err) {
    json(ctx, 409, { error: err.message });
  }
});

app.get('/api/v1/runs/last', (ctx) => json(ctx, 200, { run: engine.status().lastRun }));

app.get('/api/v1/history', (ctx) => {
  const q = ctx.query;
  let items = historyStore.data.items;
  const type = q.get('mediaType');
  const search = (q.get('search') || '').toLowerCase();
  if (type === 'movie' || type === 'tv') items = items.filter((h) => h.mediaType === type);
  if (search) items = items.filter((h) => h.title.toLowerCase().includes(search));
  const limit = Math.max(1, Math.min(500, Number(q.get('limit') || 100)));
  const offset = Math.max(0, Number(q.get('offset') || 0));
  const page = items.slice(-(offset + limit)).reverse().slice(0, limit);
  json(ctx, 200, { total: items.length, items: page });
});

app.delete('/api/v1/history/:id', (ctx) => {
  let removed = null;
  historyStore.update((h) => {
    const idx = h.items.findIndex((x) => x.id === ctx.params.id);
    if (idx >= 0) removed = h.items.splice(idx, 1)[0];
  });
  if (!removed) return json(ctx, 404, { error: 'not found' });
  json(ctx, 200, { ok: true, removed });
});

app.post('/api/v1/request', async (ctx) => {
  const { mediaType, tmdbId, title, year, posterPath } = ctx.body || {};
  if (!mediaType || !tmdbId) return json(ctx, 400, { error: 'mediaType and tmdbId required' });
  try {
    await engine.requestOne(mediaType, Number(tmdbId), { title, year, posterPath });
    json(ctx, 200, { ok: true });
  } catch (err) {
    json(ctx, 502, { error: err.message });
  }
});

app.get('/api/v1/logs', (ctx) => {
  const since = Number(ctx.query.get('since') || 0);
  const level = ctx.query.get('level') || 'all';
  json(ctx, 200, { entries: logger.entries({ since, level, limit: 400 }) });
});

// ---------- poster proxy ----------
const POSTER_SIZES = new Set(['w92', 'w154', 'w185', 'w342', 'w500', 'w780', 'original']);
app.get('/img/poster', async (ctx) => {
  const p = ctx.query.get('path') || '';
  const size = ctx.query.get('size') || 'w342';
  if (!/^\/[\w\-.]+\.(jpg|jpeg|png|webp|svg)$/i.test(p) || !POSTER_SIZES.has(size)) {
    return json(ctx, 400, { error: 'bad poster path' });
  }
  try {
    const upstream = await dynamicOutbound(`https://image.tmdb.org/t/p/${size}${p}`, { signal: AbortSignal.timeout(10000) });
    if (!upstream.ok) return json(ctx, 502, { error: `upstream ${upstream.status}` });
    const buf = Buffer.from(await upstream.arrayBuffer());
    ctx.res.writeHead(200, {
      'Content-Type': upstream.headers.get('content-type') || 'image/jpeg',
      'Cache-Control': 'public, max-age=604800, immutable',
    });
    ctx.res.end(buf);
  } catch (err) {
    json(ctx, 504, { error: `poster fetch failed: ${err.message}` });
  }
});

// ---------- boot ----------
httpServer = app.listen(currentBinding.port, currentBinding.host, () => {
  logger.log(`Advarr v${APP_VERSION} → http://${currentBinding.host}:${currentBinding.port} (data: ${DATA_DIR})`);
  scheduler.start();
});

function shutdown(signal) {
  logger.log(`${signal} received — shutting down`);
  scheduler.stop();
  httpServer.close();
  configStore.close();
  historyStore.close();
  runsStore.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error(`unhandledRejection: ${err?.message}`));
process.on('uncaughtException', (err) => logger.error(`uncaughtException: ${err?.message}`));
