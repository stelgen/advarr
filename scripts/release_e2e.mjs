#!/usr/bin/env node
// Advarr — release live-e2e bot (release-gate job 2).
// Probes the REAL artifact (built container) over HTTP: health, security headers,
// UI static, settings roundtrip, config export/import, backups, integrations
// (against local Radarr/Sonarr stubs), live auth switch, traversal, body limit,
// rate limit, and env-seeded Basic-Auth on a second instance.
// Zero deps, no external network — stubs are local HTTP servers.
//
// Modes:
//   node release_e2e.mjs --stub     run Radarr(:9101)/Sonarr(:9102) stubs and block
//   node release_e2e.mjs            run the probe suite
//
// Env:
//   E2E_BASE          target instance (default http://127.0.0.1:8787)
//   E2E_AUTH_BASE     second instance booted with BASIC_AUTH_USER/PASS (optional)
//   E2E_STUB_HOST     hostname the target uses to reach stubs (default 127.0.0.1)
//   E2E_STUB_BIND     bind address for --stub (default 0.0.0.0)
//   E2E_EXPECT_VERSION  expected APP_VERSION (default: package.json version)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const STUB_KEY = 'stub-arr-key';
const STUB_RADARR_PORT = 9101;
const STUB_SONARR_PORT = 9102;

// ---------- stub mode ----------
const STUB_MODE = process.argv.includes('--stub');
if (STUB_MODE) {
  const bind = process.env.E2E_STUB_BIND || '0.0.0.0';
  const stub = (appName) => (req, res) => {
    if ((req.headers['x-api-key'] || '') !== STUB_KEY) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'unauthorized' }));
      return;
    }
    const body = (obj) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url === '/api/v3/system/status') body({ appName, version: '5.0-e2e-stub' });
    else if (req.url === '/api/v3/qualityprofile') body([{ id: 1, name: 'Any' }, { id: 2, name: 'HD-1080p' }, { id: 3, name: 'Ultra-HD' }]);
    else if (req.url === '/api/v3/rootfolder') body([{ id: 1, path: '/movies' }, { id: 2, path: '/tv' }]);
    else if (req.url === '/api/v3/movie' || req.url === '/api/v3/series') body([]);
    else { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: 'not found' })); }
  };
  for (const [name, port] of [['Radarr', STUB_RADARR_PORT], ['Sonarr', STUB_SONARR_PORT]]) {
    http.createServer(stub(name)).listen(port, bind, () => console.log(`stub ${name} listening on ${bind}:${port}`));
  }
  // block forever — probe suite must NOT run in this mode
  setInterval(() => {}, 1 << 30);
}

// ---------- probe mode ----------
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8787';
const AUTH_BASE = process.env.E2E_AUTH_BASE || '';
const STUB_HOST = process.env.E2E_STUB_HOST || '127.0.0.1';
const EXPECT_VERSION = process.env.E2E_EXPECT_VERSION
  || JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${detail ? `: ${detail}` : ''}`);
}

function rawRequest({ base = BASE, path: reqPath, method = 'GET', headers = {}, body = null }) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve) => {
    const req = http.request({ host: hostname, port, path: reqPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', (err) => resolve({ status: 0, headers: {}, text: `ERR ${err.message}` }));
    req.end(body === null ? undefined : body);
  });
}

async function api(method, reqPath, { headers = {}, body = null, base = BASE } = {}) {
  const h = { ...(body !== null ? { 'Content-Type': 'application/json' } : {}), ...headers };
  const res = await rawRequest({ base, path: reqPath, method, headers: h, body: body !== null ? JSON.stringify(body) : null });
  let json = null;
  try { json = JSON.parse(res.text); } catch { /* non-json */ }
  return { status: res.status, headers: res.headers, text: res.text, json };
}

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

async function expect(name, promise, fn) {
  try {
    const outcome = fn(await promise);
    record(name, outcome === true || outcome === undefined, outcome === true ? '' : String(outcome));
  } catch (err) {
    record(name, false, `exception: ${err.message}`);
  }
}

// ---------- instance probe suite ----------
async function probeInstance({ label, base, authUser = '', authPass = '', apiKey = '' }) {
  console.log(`\n== ${label} (${base}) ==`);
  const h = {};
  if (authUser) h.Authorization = basic(authUser, authPass);
  if (apiKey) h['X-Api-Key'] = apiKey;

  await expect(`${label}: health ok + version`, api('GET', '/api/v1/health', { headers: h }),
    (r) => (r.status === 200 && r.json?.ok === true && r.json?.version === EXPECT_VERSION
      ? true : `status=${r.status} version=${r.json?.version} expected=${EXPECT_VERSION}`));

  await expect(`${label}: security headers on /`, api('GET', '/', { headers: h }),
    (r) => (r.status === 200
      && (r.headers['content-security-policy'] || '').includes("default-src 'self'")
      && r.headers['x-frame-options'] === 'DENY'
      && r.headers['x-content-type-options'] === 'nosniff'
      && (r.headers['x-robots-tag'] || '').includes('noindex')
      ? true : `status=${r.status} csp=${r.headers['content-security-policy']}`));

  await expect(`${label}: UI served (index.html)`, api('GET', '/', { headers: h }),
    (r) => (r.status === 200 && r.headers['content-type']?.includes('text/html') && r.text.includes('радар трендов')
      ? true : `status=${r.status}`));

  const settingsRes = await api('GET', '/api/v1/settings', { headers: h });
  await expect(`${label}: settings readable`, Promise.resolve(settingsRes),
    (r) => (r.status === 200 && r.json?.tmdb && r.json?.seerr ? true : `status=${r.status}`));
  await expect(`${label}: secrets masked in settings`, Promise.resolve(settingsRes),
    (r) => (!r.json?.tmdb?.apiKey || String(r.json.tmdb.apiKey).startsWith('••••')
      ? true : `apiKey exposed: "${r.json.tmdb.apiKey}"`));

  // live settings roundtrip (logLevel flip is harmless and reversible)
  await expect(`${label}: PUT settings applies live`, api('PUT', '/api/v1/settings', { headers: h, body: { general: { logLevel: 'debug' } } }),
    (r) => (r.status === 200 && r.json?.general?.logLevel === 'debug' ? true : `status=${r.status} body=${r.text.slice(0, 120)}`));
  await expect(`${label}: logLevel persisted`, api('GET', '/api/v1/settings', { headers: h }),
    (r) => (r.json?.general?.logLevel === 'debug' ? true : `got ${r.json?.general?.logLevel}`));
  await api('PUT', '/api/v1/settings', { headers: h, body: { general: { logLevel: 'info' } } });

  // config export → import roundtrip (Radarr-style)
  const exportRes = await api('GET', '/api/v1/system/config/download', { headers: h });
  await expect(`${label}: config export`, Promise.resolve(exportRes),
    (r) => (r.status === 200 && r.json?.version && r.headers['content-disposition']?.includes('attachment')
      ? true : `status=${r.status}`));
  await expect(`${label}: config import roundtrip`, api('POST', '/api/v1/system/config/import', { headers: h, body: exportRes.json }),
    (r) => (r.status === 200 && r.json?.ok === true ? true : `status=${r.status} body=${r.text.slice(0, 120)}`));
  await expect(`${label}: import rejects non-config`, api('POST', '/api/v1/system/config/import', { headers: h, body: { foo: 1 } }),
    (r) => (r.status === 400 ? true : `status=${r.status}`));

  // backups: create → list → restore → delete
  const created = await api('POST', '/api/v1/backup', { headers: h, body: null });
  await expect(`${label}: backup create`, Promise.resolve(created), (r) => (r.status === 201 && r.json?.id ? true : `status=${r.status}`));
  const backupId = created.json?.id;
  if (backupId) {
    await expect(`${label}: backup listed`, api('GET', '/api/v1/backup', { headers: h }),
      (r) => (Array.isArray(r.json?.items) && r.json.items.some((b) => b.id === backupId) ? true : `id ${backupId} not listed`));
    await expect(`${label}: backup restore`, api('POST', `/api/v1/backup/${backupId}/restore`, { headers: h, body: null }),
      (r) => (r.status === 200 && r.json?.ok === true ? true : `status=${r.status}`));
    await expect(`${label}: backup delete`, api('DELETE', `/api/v1/backup/${backupId}`, { headers: h }),
      (r) => (r.status === 200 ? true : `status=${r.status}`));
  }

  // integrations against local stubs
  const intReq = (type, port, key = STUB_KEY) => api('POST', '/api/v1/integrations/test', {
    headers: h,
    body: { type, url: `http://${STUB_HOST}:${port}`, apiKey: key },
  });
  await expect(`${label}: Radarr integration test`, intReq('radarr', STUB_RADARR_PORT),
    (r) => (r.status === 200 && r.json?.ok === true && r.json?.profiles?.length >= 2 && r.json?.roots?.length >= 1
      ? true : `status=${r.status} body=${r.text.slice(0, 160)}`));
  await expect(`${label}: Sonarr integration test`, intReq('sonarr', STUB_SONARR_PORT),
    (r) => (r.status === 200 && r.json?.ok === true ? true : `status=${r.status} body=${r.text.slice(0, 160)}`));
  await expect(`${label}: integration rejects bad key`, intReq('radarr', STUB_RADARR_PORT, 'wrong-key'),
    (r) => (r.status === 200 && r.json?.ok === false ? true : `status=${r.status} body=${r.text.slice(0, 120)}`));

  // live auth switch (config-driven auth is re-read per request)
  if (!authUser && !apiKey) {
    await expect(`${label}: switch to apiKey auth`, api('PUT', '/api/v1/settings', { body: { general: { authentication: { method: 'apiKey', apiKey: 'e2e-live-key' } } } }),
      (r) => (r.status === 200 ? true : `status=${r.status} body=${r.text.slice(0, 120)}`));
    await expect(`${label}: no-credential request → 401`, api('GET', '/api/v1/settings'),
      (r) => (r.status === 401 ? true : `status=${r.status}`));
    await expect(`${label}: wrong key → 401`, api('GET', '/api/v1/settings', { headers: { 'X-Api-Key': 'nope' } }),
      (r) => (r.status === 401 ? true : `status=${r.status}`));
    await expect(`${label}: correct key → 200`, api('GET', '/api/v1/settings', { headers: { 'X-Api-Key': 'e2e-live-key' } }),
      (r) => (r.status === 200 ? true : `status=${r.status}`));
    await expect(`${label}: switch back to none`, api('PUT', '/api/v1/settings', { headers: { 'X-Api-Key': 'e2e-live-key' }, body: { general: { authentication: { method: 'none' } } } }),
      (r) => (r.status === 200 ? true : `status=${r.status} body=${r.text.slice(0, 120)}`));
    await expect(`${label}: unauthenticated again → 200`, api('GET', '/api/v1/settings'),
      (r) => (r.status === 200 ? true : `status=${r.status}`));
  }
}

// ---------- hardening probes (main instance, no auth) ----------
async function probeHardening() {
  console.log(`\n== hardening (${BASE}) ==`);
  await expect('traversal /../../etc/passwd → 404', rawRequest({ path: '/../../etc/passwd' }),
    (r) => (r.status === 404 && !r.text.includes('root:') ? true : `status=${r.status}`));
  await expect('traversal /..%2f..%2fetc%2fpasswd → 404', rawRequest({ path: '/..%2f..%2fetc%2fpasswd' }),
    (r) => (r.status === 404 && !r.text.includes('root:') ? true : `status=${r.status}`));
  await expect('unknown API route → 404 json', api('GET', '/api/v1/definitely-missing'),
    (r) => (r.status === 404 && r.json?.error ? true : `status=${r.status}`));
  await expect('oversized body → 413', rawRequest({
    path: '/api/v1/settings', method: 'PUT',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(300 * 1024) }),
  }), (r) => (r.status === 413 ? true : `status=${r.status}`));

  // rate limit: bucket capacity 120, refill 2/s → 160 fast requests must produce a 429
  let limited = 0;
  for (let i = 0; i < 160; i += 1) {
    const r = await api('GET', '/api/v1/health');
    if (r.status === 429) limited += 1;
  }
  record('rate limit kicks in under burst (≥1×429 of 160)', limited > 0, `${limited} of 160 responses were 429`);
}

// ---------- env-seeded Basic-Auth instance ----------
async function probeAuthInstance() {
  if (!AUTH_BASE) return;
  console.log(`\n== basic-auth instance (${AUTH_BASE}) ==`);
  await expect('auth: unauthenticated → 401 + WWW-Authenticate', api('GET', '/api/v1/settings', { base: AUTH_BASE }),
    (r) => (r.status === 401 && (r.headers['www-authenticate'] || '').includes('Basic')
      ? true : `status=${r.status} www=${r.headers['www-authenticate']}`));
  await expect('auth: wrong password → 401', api('GET', '/api/v1/settings', { base: AUTH_BASE, headers: { Authorization: basic('e2e-user', 'wrong') } }),
    (r) => (r.status === 401 ? true : `status=${r.status}`));
  await expect('auth: correct credentials → 200 health', api('GET', '/api/v1/health', { base: AUTH_BASE, headers: { Authorization: basic('e2e-user', 'e2e-pass-9') } }),
    (r) => (r.status === 200 && r.json?.ok === true ? true : `status=${r.status}`));
  await expect('auth: settings readable with credentials, password masked', api('GET', '/api/v1/settings', { base: AUTH_BASE, headers: { Authorization: basic('e2e-user', 'e2e-pass-9') } }),
    (r) => (r.status === 200 && (!r.json?.general?.authentication?.password || String(r.json.general.authentication.password).startsWith('••••'))
      ? true : `status=${r.status}`));
}

// ---------- main ----------
if (!STUB_MODE) {
  console.log(`Advarr release e2e → ${BASE} (expected v${EXPECT_VERSION})`);
  await probeInstance({ label: 'instance', base: BASE });
  await probeHardening();
  await probeAuthInstance();

  const failed = results.filter((r) => !r.ok);
  console.log(`\nrelease e2e: ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    for (const f of failed) console.error(`::error::e2e failed — ${f.name}`);
    process.exit(1);
  }
}