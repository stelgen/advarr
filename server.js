#!/usr/bin/env node
// Advarr — composition root. Zero runtime deps.
// Passive TMDB discovery radar for Jellyseerr / Overseerr.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { createLogger } from './lib/logs.js';
import { JsonStore } from './lib/store.js';
import { loadConfig, applyPatch, unmaskPatch } from './lib/config.js';
import { createApp } from './lib/http.js';
import { createTmdb } from './lib/tmdb.js';
import { createSeerr, normalizeBaseUrl } from './lib/seerr.js';
import { createEngine } from './lib/engine.js';
import { createScheduler } from './lib/scheduler.js';

const APP_VERSION = '0.2.0';
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PORT = Number(process.env.ADVARR_PORT || 8787);
const HOST = process.env.ADVARR_HOST || '0.0.0.0';
const DATA_DIR = process.env.ADVARR_DATA_DIR || path.join(__dirname, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

const logger = createLogger(800);

// ---------- stores ----------
const { store: configStore } = loadConfig(DATA_DIR, process.env);
const historyStore = new JsonStore(path.join(DATA_DIR, 'history.json'), { items: [] });
historyStore.load();
const runsStore = new JsonStore(path.join(DATA_DIR, 'runs.json'), { runs: [] });
runsStore.load();

// ---------- clients (recreated when settings change) ----------
function buildTmdb() {
  return createTmdb({
    apiKey: configStore.data.tmdb.apiKey,
    language: configStore.data.tmdb.language,
    region: configStore.data.tmdb.region,
    logger,
  });
}
function buildSeerr() {
  return createSeerr({
    baseUrl: configStore.data.seerr.url,
    apiKey: configStore.data.seerr.apiKey,
    logger,
  });
}
const clients = { tmdb: buildTmdb(), seerr: buildSeerr() };

const engine = createEngine({
  configStore, historyStore, runsStore,
  getClients: () => clients,
  logger,
});
const scheduler = createScheduler({ engine, configStore, logger });

// ---------- auth (env-only — secrets never live in data dir) ----------
function buildAuth() {
  const user = process.env.BASIC_AUTH_USER || '';
  const pass = process.env.BASIC_AUTH_PASS || '';
  const key = process.env.ADVARR_API_KEY || '';
  if (user && pass) return { type: 'basic', user, pass };
  if (key) return { type: 'key', key };
  return null;
}

const app = createApp({
  logger,
  staticDir: path.join(__dirname, 'public'),
  auth: buildAuth(),
  // trust X-Forwarded-For ONLY when explicitly running behind a reverse proxy
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
  const clone = structuredClone(cfg);
  clone.tmdb.apiKey = maskSecret(clone.tmdb.apiKey);
  clone.seerr.apiKey = maskSecret(clone.seerr.apiKey);
  return clone;
}

function unmaskOne(oldValue, incoming) {
  return (typeof incoming === 'string' && incoming.startsWith('••••')) ? oldValue : incoming;
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

app.put('/api/v1/settings', (ctx) => {
  const patch = ctx.body || {};
  applyPatch(configStore.data, unmaskPatch(configStore.data, patch, [['tmdb', 'apiKey'], ['seerr', 'apiKey']]));
  configStore.saveNow();
  clients.tmdb = buildTmdb();
  clients.seerr = buildSeerr();
  scheduler.scheduleNext();
  logger.log('settings updated');
  json(ctx, 200, publicConfig(configStore.data));
});

app.post('/api/v1/settings/test-tmdb', async (ctx) => {
  const over = ctx.body || {};
  try {
    const t = createTmdb({
      apiKey: over.apiKey !== undefined ? unmaskOne(configStore.data.tmdb.apiKey, over.apiKey) : configStore.data.tmdb.apiKey,
      language: over.language || configStore.data.tmdb.language,
      region: over.region ?? configStore.data.tmdb.region,
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
      logger,
    });
    const res = await s.test();
    json(ctx, 200, { ok: true, message: `${res.app} v${res.version} — подключено` });
  } catch (err) {
    json(ctx, 200, { ok: false, message: `Seerr: ${err.message}` });
  }
});

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

// poster proxy: /img/poster?path=/abc.jpg&size=w342
const POSTER_SIZES = new Set(['w92', 'w154', 'w185', 'w342', 'w500', 'w780', 'original']);
app.get('/img/poster', async (ctx) => {
  const p = ctx.query.get('path') || '';
  const size = ctx.query.get('size') || 'w342';
  if (!/^\/[\w\-.]+\.(jpg|jpeg|png|webp|svg)$/i.test(p) || !POSTER_SIZES.has(size)) {
    return json(ctx, 400, { error: 'bad poster path' });
  }
  try {
    const upstream = await fetch(`https://image.tmdb.org/t/p/${size}${p}`, { signal: AbortSignal.timeout(10000) });
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
const server = app.listen(PORT, HOST, () => {
  logger.log(`Advarr v${APP_VERSION} → http://${HOST}:${PORT} (data: ${DATA_DIR})`);
  scheduler.start();
});

function shutdown(signal) {
  logger.log(`${signal} received — shutting down`);
  scheduler.stop();
  server.close();
  configStore.close();
  historyStore.close();
  runsStore.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error(`unhandledRejection: ${err?.message}`));
process.on('uncaughtException', (err) => logger.error(`uncaughtException: ${err?.message}`));
