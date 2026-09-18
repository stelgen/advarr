// Advarr test helpers — shared fixtures & utilities. NOT a test file (no *.test.js name).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** deterministic temp dir per test file */
export function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `advarr-${prefix}-`));
}

/** start createApp() server on ephemeral port */
export function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server, port, base: `http://127.0.0.1:${port}`,
        async close() { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); },
      });
    });
  });
}

export function jsonResponder(ctx, status, obj) {
  ctx.res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  ctx.res.end(JSON.stringify(obj));
}

/** raw HTTP request — bypasses fetch/WHATWG URL path normalization (needed for traversal tests) */
export function rawRequest({ port, path, method = 'GET', headers = {}, body = null }) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', (err) => resolve({ error: err.code || err.message, status: null, body: '', headers: {} }));
    req.end(body === null ? undefined : body);
  });
}

/** raw TMDB list item (movie shape) */
export function movieRaw(id, over = {}) {
  return {
    id, title: `Movie ${id}`, original_title: `Original Movie ${id}`,
    release_date: '2024-01-01', poster_path: `/p${id}.jpg`, backdrop_path: `/b${id}.jpg`,
    overview: `Overview ${id}`, vote_average: 7, vote_count: 1000, popularity: 100,
    original_language: 'en', genre_ids: [28], adult: false, ...over,
  };
}

/** raw TMDB list item (tv shape) */
export function tvRaw(id, over = {}) {
  return {
    id, name: `Show ${id}`, original_name: `Original Show ${id}`,
    first_air_date: '2024-01-01', poster_path: `/p${id}.jpg`, backdrop_path: '',
    overview: `Overview ${id}`, vote_average: 7, vote_count: 1000, popularity: 100,
    original_language: 'en', genre_ids: [18], adult: false, ...over,
  };
}

/** injectable fetch stub: records every call, handler(url, init) → {status, body} */
export function makeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const href = typeof url === 'string' ? url : String(url);
    calls.push({ url: href, init });
    const out = await handler(href, init);
    const status = out.status ?? 200;
    return {
      ok: status >= 200 && status < 300, status, statusText: out.statusText ?? '',
      text: async () => (typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? null)),
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** date N days ago as YYYY-MM-DD */
export const daysAgo = (n) => new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10);

/** silent logger for engine */
export const silentLogger = { log() {}, warn() {}, error() {}, entries: () => [] };
