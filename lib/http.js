// Advarr — minimal HTTP framework (zero deps):
// routing with :params, JSON bodies (size-capped), static files (traversal-safe),
// security headers, per-IP rate limit for /api, basic-auth / X-Api-Key.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; " +
    "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // still burn comparable time
    crypto.timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

export class RateLimiter {
  constructor({ capacity = 120, refillPerSec = 2 } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.buckets = new Map();
  }
  take(key) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.capacity, at: now }; this.buckets.set(key, b); }
    const elapsed = (now - b.at) / 1000;
    b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSec);
    b.at = now;
    if (this.buckets.size > 5000) this.buckets.clear(); // hard cap memory
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}

export function createApp({ logger, staticDir = null, auth = null, bodyLimit = 256 * 1024 } = {}) {
  const routes = [];
  const limiter = new RateLimiter({});

  function add(method, pattern, ...handlers) {
    routes.push({
      method,
      segments: pattern.split('/').filter(Boolean).map((s) =>
        s.startsWith(':') ? { name: s.slice(1), param: true } : { name: s, param: false }),
      handlers,
    });
  }

  const app = {
    get: (p, ...h) => add('GET', p, ...h),
    post: (p, ...h) => add('POST', p, ...h),
    put: (p, ...h) => add('PUT', p, ...h),
    delete: (p, ...h) => add('DELETE', p, ...h),
    use: (fn) => { app._middleware = fn; },
    _middleware: null,
  };

  function match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    for (const r of routes) {
      if (r.method !== method) continue;
      if (r.segments.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < parts.length; i += 1) {
        const seg = r.segments[i];
        if (seg.param) params[seg.name] = decodeURIComponent(parts[i]);
        else if (seg.name !== parts[i]) { ok = false; break; }
      }
      if (ok) return { route: r, params };
    }
    return null;
  }

  function checkAuth(ctx) {
    if (!auth) return true;
    const headerKey = ctx.headers['x-api-key'];
    const queryKey = ctx.query.get('apikey');
    if (auth.type === 'key' && auth.key) {
      const provided = headerKey || queryKey;
      return provided ? safeEqual(provided, auth.key) : false;
    }
    if (auth.type === 'basic' && auth.user && auth.pass) {
      const h = ctx.headers.authorization || '';
      const m = /^Basic (.+)$/.exec(h);
      if (!m) return false;
      let decoded;
      try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch { return false; }
      const idx = decoded.indexOf(':');
      if (idx < 0) return false;
      return safeEqual(decoded.slice(0, idx), auth.user) && safeEqual(decoded.slice(idx + 1), auth.pass);
    }
    return true;
  }

  function sendJson(ctx, status, obj) {
    const body = JSON.stringify(obj);
    ctx.res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    ctx.res.end(body);
  }

  function serveStatic(ctx, urlPath) {
    if (!staticDir) return false;
    let rel = decodeURIComponent(urlPath);
    if (rel === '/' || rel === '') rel = '/index.html';
    const target = path.resolve(staticDir, `.${path.posix.normalize(`/${rel}`)}`);
    if (!target.startsWith(path.resolve(staticDir))) return notFound(ctx); // traversal guard
    let stat;
    try { stat = fs.statSync(target); } catch { return notFound(ctx); }
    if (stat.isDirectory()) return notFound(ctx);
    const ext = path.extname(target).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const cache = ext === '.html' ? 'no-cache' : 'public, max-age=300';
    ctx.res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
    fs.createReadStream(target).pipe(ctx.res);
    return true;
  }

  function notFound(ctx) {
    if (ctx.pathname.startsWith('/api/')) {
      sendJson(ctx, 404, { error: 'not found' });
    } else {
      ctx.res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      ctx.res.end('Not found');
    }
    return true;
  }

  async function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0;
      let rejected = false;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          // keep draining so the socket stays usable → we can send a clean 413
          if (!rejected) { rejected = true; reject(new Error('body too large')); }
          return;
        }
        if (!rejected) chunks.push(chunk);
      });
      req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks)); });
      req.on('error', (err) => { if (!rejected) reject(err); });
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const ctx = {
      req, res,
      headers: req.headers,
      pathname: url.pathname,
      query: url.searchParams,
      params: {},
      body: null,
      ip: (req.headers['x-forwarded-for']?.split(',')[0]?.trim()) || req.socket.remoteAddress || '?',
    };

    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');

    try {
      if (ctx.pathname.startsWith('/api/') || ctx.pathname.startsWith('/img/')) {
        if (!limiter.take(ctx.ip)) {
          return sendJson(ctx, 429, { error: 'rate limited' });
        }
        if (!checkAuth(ctx)) {
          if (auth?.type === 'basic') res.setHeader('WWW-Authenticate', 'Basic realm="advarr", charset="UTF-8"');
          return sendJson(ctx, 401, { error: 'unauthorized' });
        }
      }

      const found = match(req.method, ctx.pathname);
      if (found) {
        ctx.params = found.params;
        if (req.method !== 'GET' && req.method !== 'DELETE') {
          const raw = await readBody(req, bodyLimit);
          if (raw.length) {
            const type = req.headers['content-type'] || '';
            if (type.includes('application/json')) {
              ctx.body = JSON.parse(raw.toString('utf8'));
            } else {
              ctx.body = raw;
            }
          }
        }
        let i = 0;
        const next = async () => {
          const h = found.route.handlers[i];
          i += 1;
          if (!h) return;
          await h(ctx, next);
        };
        await next();
        return true;
      }

      if (req.method === 'GET' && staticDir && serveStaticSafe(ctx)) return true;
      return notFound(ctx);
    } catch (err) {
      if (logger) logger.error(`http ${req.method} ${ctx.pathname} → 500: ${err.message}`);
      if (!res.headersSent) sendJson(ctx, err.message === 'body too large' ? 413 : 500, { error: err.message });
      else res.destroy();
      return true;
    }
  }

  function serveStaticSafe(ctx) {
    let rel = ctx.pathname;
    if (rel === '/' || rel === '') rel = '/index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const target = path.resolve(staticDir, `.${path.posix.normalize(`/${rel}`)}`);
    if (!target.startsWith(path.resolve(staticDir) + path.sep) && target !== path.resolve(staticDir)) return false;
    let stat;
    try { stat = fs.statSync(target); } catch { return false; }
    if (!stat.isFile()) return false;
    const ext = path.extname(target).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const cache = ext === '.html' ? 'no-cache' : 'public, max-age=300';
    ctx.res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
    fs.createReadStream(target).pipe(ctx.res);
    return true;
  }

  app._handle = handle;
  app.listen = (port, host = '0.0.0.0', cb) => {
    const server = http.createServer((req, res) => { handle(req, res); });
    server.keepAliveTimeout = 5000;
    server.headersTimeout = 10000;
    server.requestTimeout = 60000;
    return server.listen(port, host, cb);
  };

  return app;
}
