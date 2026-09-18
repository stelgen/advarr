import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { deepMerge, applyPatch } from '../lib/config.js';
import { createTmdb } from '../lib/tmdb.js';
import { createApp } from '../lib/http.js';

// ---- regression: prototype pollution guard (audit v0.2.0) ----
test('deepMerge skips __proto__/constructor/prototype keys', () => {
  const base = { nested: { x: 1 }, ok: 1 };
  const patch = JSON.parse('{"nested":{"__proto__":{"polluted":true}},"__proto__":{"admin":true},"constructor":{"name":"pwn"}}');
  const out = deepMerge(base, patch);
  assert.equal({}.polluted, undefined);
  assert.equal({}.admin, undefined);
  assert.equal(Object.getPrototypeOf(out.nested), Object.prototype);
  assert.equal(out.nested.x, 1);
});

test('applyPatch cannot poison prototypes', () => {
  const cfg = { nested: { ok: 1 } };
  applyPatch(cfg, JSON.parse('{"nested":{"__proto__":{"isAdmin":true}}}'));
  assert.equal({}.isAdmin, undefined);
});

// ---- regression: discover querystring parsing (was string-spread) ----
test('discover source parses raw params into query args', async () => {
  const calls = [];
  const tmdb = createTmdb({
    apiKey: 'k',
    fetchImpl: async (url) => {
      calls.push(String(url));
      return { ok: true, text: async () => '{"results":[]}' };
    },
  });
  await tmdb.fetchSource('discover', 'movie', { pages: 1, discoverParams: 'with_genres=878&sort_by=popularity.desc' });
  assert.equal(calls.length, 1);
  const u = new URL(calls[0]);
  assert.equal(u.pathname, '/3/movie/discover');
  assert.equal(u.searchParams.get('with_genres'), '878');
  assert.equal(u.searchParams.get('sort_by'), 'popularity.desc');
  assert.equal(u.searchParams.get('page'), '1');
});

// ---- regression: X-Forwarded-For trusted only behind TRUST_PROXY ----
async function listen(app) {
  const server = http.createServer((req, res) => { app._handle(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

test('client ip: XFF ignored by default, honored with trustProxy', async (t) => {
  const servers = [];
  t.after(() => { for (const s of servers) s.close(); });
  for (const [trustProxy, expected] of [[false, '127.0.0.1'], [true, '9.9.9.9']]) {
    const app = createApp({ trustProxy });
    app.get('/api/v1/whoami', (ctx) => json(ctx, { ip: ctx.ip }));
    const server = await listen(app);
    servers.push(server);
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/whoami`, {
      headers: { 'X-Forwarded-For': '9.9.9.9, 10.0.0.1' },
    });
    const body = await res.json();
    assert.equal(body.ip, expected);
  }
});

function json(ctx, obj) {
  ctx.res.writeHead(200, { 'Content-Type': 'application/json' });
  ctx.res.end(JSON.stringify(obj));
}
