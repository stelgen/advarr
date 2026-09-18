// Advarr tests — lib/http.js: routing, bodies, headers, rate limiter, static+traversal, auth.
// Real servers on ephemeral port 0 (e2e fidelity); raw node:http for paths fetch would normalize.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApp, RateLimiter } from '../lib/http.js';
import { mkTmp, startServer, jsonResponder, rawRequest, sleep } from './helpers.js';

const b64 = (s) => Buffer.from(s).toString('base64');
const S = {};

before(async () => {
  const staticDir = mkTmp('http-static');
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<h1>advarr home</h1>');
  fs.writeFileSync(path.join(staticDir, 'app.js'), 'console.log("advarr");');

  const mainApp = createApp({ staticDir });
  mainApp.get('/api/v1/echo/:name', (ctx) => jsonResponder(ctx, 200, { name: ctx.params.name, q: ctx.query.get('q') }));
  mainApp.post('/api/v1/echo', (ctx) => jsonResponder(ctx, 201, { got: ctx.body }));
  mainApp.put('/api/v1/echo', (ctx) => jsonResponder(ctx, 200, { got: ctx.body }));
  S.main = await startServer(mainApp);

  const basicApp = createApp({ auth: { type: 'basic', user: 'admin', pass: 'secret123' } });
  basicApp.get('/api/v1/ping', (ctx) => jsonResponder(ctx, 200, { ok: true }));
  S.basic = await startServer(basicApp);

  const keyApp = createApp({ auth: { type: 'key', key: 'sekret' } });
  keyApp.get('/api/v1/ping', (ctx) => jsonResponder(ctx, 200, { ok: true }));
  S.key = await startServer(keyApp);

  const limitedApp = createApp({ bodyLimit: 64 });
  limitedApp.post('/api/v1/upload', (ctx) => jsonResponder(ctx, 200, { got: ctx.body }));
  S.limited = await startServer(limitedApp);
});

after(async () => {
  for (const s of Object.values(S)) await s.close();
});

test('route matching with :param, query parsing and percent-decoding', async () => {
  const res = await fetch(`${S.main.base}/api/v1/echo/bob?q=42`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { name: 'bob', q: '42' });
  const res2 = await fetch(`${S.main.base}/api/v1/echo/a%20b`);
  assert.equal((await res2.json()).name, 'a b'); // decodeURIComponent applied to params
});

test('unknown /api path → 404 JSON; unknown static path → 404 text', async () => {
  const res = await fetch(`${S.main.base}/api/v1/definitely-not-here`);
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await res.json(), { error: 'not found' });
  const res2 = await fetch(`${S.main.base}/nope.txt`);
  assert.equal(res2.status, 404);
  assert.match(await res2.text(), /Not found/);
});

test('JSON bodies parsed for POST and PUT; non-JSON falls back to Buffer', async () => {
  const post = await fetch(`${S.main.base}/api/v1/echo`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ a: 1, nested: { ok: true } }),
  });
  assert.equal(post.status, 201);
  assert.deepEqual((await post.json()).got, { a: 1, nested: { ok: true } });

  const put = await fetch(`${S.main.base}/api/v1/echo`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"x":5}',
  });
  assert.deepEqual((await put.json()).got, { x: 5 });

  const raw = await fetch(`${S.main.base}/api/v1/echo`, {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello',
  });
  assert.deepEqual((await raw.json()).got, { type: 'Buffer', data: [104, 101, 108, 108, 111] });
});

test('security headers on every response (CSP, nosniff, frame-ancestors, robots)', async () => {
  const res = await fetch(`${S.main.base}/api/v1/echo/x`);
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
});

test('static serving: / → index.html with no-cache, assets with mime type', async () => {
  const home = await fetch(`${S.main.base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.equal(home.headers.get('cache-control'), 'no-cache');
  assert.match(await home.text(), /advarr home/);
  const js = await fetch(`${S.main.base}/app.js`);
  assert.match(js.headers.get('content-type'), /text\/javascript/);
  assert.match(await js.text(), /console\.log/);
});

test('traversal guard: dot-dot and encoded traversal never serve files outside staticDir', async () => {
  // raw http.request — fetch/WHATWG would normalize the path client-side and hide the attack
  for (const attack of ['/../../etc/passwd', '/..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd']) {
    const res = await rawRequest({ port: S.main.port, path: attack });
    assert.equal(res.status, 404, `attack path ${attack}`);
    assert.ok(!res.body.includes('root:'), `leaked passwd content for ${attack}`);
  }
});

test('RateLimiter: capacity exhausts to false, per-key isolation, refill restores tokens', async () => {
  const rl = new RateLimiter({ capacity: 3, refillPerSec: 0 });
  assert.equal(rl.take('ip1'), true);
  assert.equal(rl.take('ip1'), true);
  assert.equal(rl.take('ip1'), true);
  assert.equal(rl.take('ip1'), false); // bucket empty → would be a 429 in the app
  assert.equal(rl.take('ip2'), true);  // separate bucket

  const refill = new RateLimiter({ capacity: 1, refillPerSec: 100000 });
  assert.equal(refill.take('k'), true);
  assert.equal(refill.take('k'), false);
  await sleep(10); // 10ms × 100000/s → refill above capacity → capped back to 1 token
  assert.equal(refill.take('k'), true);
});

test('basic auth: no/wrong credentials → 401 + WWW-Authenticate; correct → 200', async () => {
  const no = await fetch(`${S.basic.base}/api/v1/ping`);
  assert.equal(no.status, 401);
  assert.match(no.headers.get('www-authenticate') || '', /^Basic /);
  assert.deepEqual(await no.json(), { error: 'unauthorized' });

  const wrong = await fetch(`${S.basic.base}/api/v1/ping`, {
    headers: { authorization: `Basic ${b64('admin:WRONG')}` },
  });
  assert.equal(wrong.status, 401);

  const malformed = await fetch(`${S.basic.base}/api/v1/ping`, {
    headers: { authorization: 'Basic %%%not-base64%%%' },
  });
  assert.equal(malformed.status, 401);

  const good = await fetch(`${S.basic.base}/api/v1/ping`, {
    headers: { authorization: `Basic ${b64('admin:secret123')}` },
  });
  assert.equal(good.status, 200);
  assert.deepEqual(await good.json(), { ok: true });
});

test('X-Api-Key auth: header and ?apikey= query both accepted, wrong key rejected', async () => {
  const no = await fetch(`${S.key.base}/api/v1/ping`);
  assert.equal(no.status, 401);

  const bad = await fetch(`${S.key.base}/api/v1/ping`, { headers: { 'x-api-key': 'nope' } });
  assert.equal(bad.status, 401);

  const header = await fetch(`${S.key.base}/api/v1/ping`, { headers: { 'X-Api-Key': 'sekret' } });
  assert.equal(header.status, 200);
  assert.deepEqual(await header.json(), { ok: true });

  const query = await fetch(`${S.key.base}/api/v1/ping?apikey=sekret`);
  assert.equal(query.status, 200);
});

test('small body passes bodyLimit', async () => {
  const body = '{"tiny":1}';
  const res = await rawRequest({
    port: S.limited.port, method: 'POST', path: '/api/v1/upload',
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }, body,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { got: { tiny: 1 } });
});

test('exposes BUG #1: oversized body → client gets ECONNRESET instead of 413 (lib/http.js readBody)', async () => {
  // Contract: readBody rejects 'body too large' → handle() catch → sendJson(ctx, 413, …).
  // Reality: readBody calls req.destroy() BEFORE the catch runs → socket killed → 413 never sent.
  const res = await rawRequest({
    port: S.limited.port, method: 'POST', path: '/api/v1/upload',
    headers: { 'content-type': 'application/json', 'content-length': '500' }, body: 'x'.repeat(500),
  });
  assert.equal(res.status, 413);               // ← FAILS today: res is { error: 'ECONNRESET' }
  assert.deepEqual(JSON.parse(res.body), { error: 'body too large' });
});
