// Advarr — outbound fetch wrapper with HTTP(S) proxy support, zero deps.
// * http:// targets: request sent in absolute-form through the proxy socket
// * https:// targets: CONNECT tunnel + TLS over the tunnel socket
// * bypassAddresses: exact hosts, ".suffix" entries and IPv4 CIDR ranges
// Response is a small shim exposing {ok, status, statusText, headers, text(), json(), arrayBuffer()}
import net from 'node:net';
import tls from 'node:tls';
import { PassThrough } from 'node:stream';

/** ip4 CIDR check */
function cidrMatch(ip, range) {
  const [base, bitsRaw] = range.split('/');
  const bits = Number(bitsRaw);
  if (!base || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const toInt = (s) => {
    const p = s.split('.').map(Number);
    if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
    return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
  };
  const a = toInt(ip);
  const b = toInt(base);
  if (a === null || b === null) return false;
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

export function isBypassed(hostname, bypassAddresses = '') {
  const entries = String(bypassAddresses).split(',').map((s) => s.trim()).filter(Boolean);
  if (!entries.length) return false;
  const host = String(hostname).toLowerCase();
  for (const e of entries) {
    const low = e.toLowerCase();
    if (low === '*') return true;
    if (low.startsWith('.')) {
      if (host === low.slice(1) || host.endsWith(low)) return true;
    } else if (low.includes('/')) {
      if (cidrMatch(host, low)) return true;
    } else if (host === low) {
      return true;
    }
  }
  return false;
}

class ProxyResponse {
  constructor(status, statusText, headers, bodyBuf) {
    this.status = status;
    this.statusText = statusText;
    this.ok = status >= 200 && status < 300;
    this.headers = { get: (name) => (headers[String(name).toLowerCase()] ?? null) };
    this._body = bodyBuf;
  }
  async text() { return this._body.toString('utf8'); }
  async json() { return JSON.parse(this._body.toString('utf8')); }
  async arrayBuffer() { return this._body.buffer.slice(this._body.byteOffset, this._body.byteOffset + this._body.byteLength); }
}

function parseHeaders(block) {
  const lines = block.split(/\r?\n/);
  const statusLine = lines.shift() || '';
  const m = /^HTTP\/[\d.]+\s+(\d{3})\s*(.*)$/.exec(statusLine);
  const headers = {};
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { status: m ? Number(m[1]) : 0, statusText: (m ? m[2] : '').trim(), headers };
}

/** read an HTTP body honoring Content-Length / chunked encoding; resolve on EOF */
function readBody(stream, headers) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const te = headers['transfer-encoding'] || '';
    const cl = headers['content-length'] ? Number(headers['content-length']) : null;
    let remaining = cl;
    let chunked = /chunked/i.test(te);
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      err ? reject(err) : resolve(Buffer.concat(chunks));
    };
    stream.on('data', (d) => {
      if (done) return;
      buf = Buffer.concat([buf, d]);
      if (chunked) {
        for (;;) {
          const i = buf.indexOf('\r\n');
          if (i < 0) break;
          const size = parseInt(buf.slice(0, i).toString('utf8').trim(), 16);
          if (!Number.isInteger(size)) break;
          if (size === 0) { finish(); return; }
          if (buf.length < i + 2 + size + 2) break;
          chunks.push(buf.slice(i + 2, i + 2 + size));
          buf = buf.slice(i + 2 + size + 2);
        }
      } else if (remaining !== null) {
        if (buf.length >= remaining) {
          chunks.push(buf.slice(0, remaining));
          finish();
        }
      } else {
        // EOF-delimited body
        chunks.push(buf);
        buf = Buffer.alloc(0);
      }
    });
    stream.on('end', () => { if (!done) finish(); });
    stream.on('error', finish);
  });
}

function connectTunnel(proxy, host, port, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; socket.destroy(); reject(err); } };
    const onAbort = () => fail(new Error('aborted by signal'));
    if (signal) {
      if (signal.aborted) return fail(new Error('aborted by signal'));
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => fail(new Error(`proxy connect timeout after ${timeoutMs}ms`)), timeoutMs);
    const cleanup = () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); };
    socket.on('error', fail);
    socket.on('connect', () => {
      let req = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`;
      if (proxy.username) {
        const cred = Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
        req += `Proxy-Authorization: Basic ${cred}\r\n`;
      }
      req += '\r\n';
      socket.write(req);
    });
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      if (settled) return;
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = parseHeaders(buf.slice(0, idx).toString('utf8'));
      if (head.status !== 200) { fail(new Error(`proxy CONNECT failed: ${head.status} ${head.statusText}`)); return; }
      settled = true;
      cleanup();
      socket.removeAllListeners('data');
      socket.removeListener('error', fail);
      // re-attach remaining bytes consumer: socket contains no body for CONNECT
      resolve(socket);
    });
  });
}

/**
 * Build a fetch-like function that honors proxy settings.
 * Returns native fetchImpl when proxy is disabled or target is bypassed.
 */
export function makeOutboundFetch({ proxy = null, fetchImpl = globalThis.fetch, timeoutMs = 30000, insecureTls = false } = {}) {
  if (!proxy || !proxy.enabled || !proxy.host || !proxy.port) return fetchImpl;

  const httpsOnly = Boolean(proxy.httpsOnly);

  return async function proxiedFetch(url, opts = {}) {
    const target = new URL(String(url instanceof URL ? url : url.url || url));
    const isHttps = target.protocol === 'https:';
    if (!isHttps && httpsOnly) return fetchImpl(url, opts);
    if (isBypassed(target.hostname, proxy.bypassAddresses)) return fetchImpl(url, opts);

    const method = (opts.method || 'GET').toUpperCase();
    const headers = { ...(opts.headers || {}) };
    const body = opts.body != null ? Buffer.from(String(opts.body)) : null;
    if (body && !headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';

    const timeoutMs2 = Number(opts._timeoutMs || timeoutMs);
    const ctrl = opts.signal;

    const pathAndQuery = `${target.pathname}${target.search}`;
    const hostHeader = `${target.hostname}${target.port ? `:${target.port}` : ''}`;
    let requestTarget = pathAndQuery;
    const connectPort = target.port ? Number(target.port) : (isHttps ? 443 : 80);

    if (isHttps) {
      // CONNECT tunnel, then TLS, then plain HTTP/1.1 inside
      const raw = await connectTunnel(proxy, target.hostname, connectPort, ctrl, timeoutMs2);
      const tlsSock = tls.connect({
        socket: raw,
        servername: target.hostname,
        rejectUnauthorized: !insecureTls,
      });
      await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('tls handshake timeout')), timeoutMs2);
        tlsSock.once('secureConnect', () => { clearTimeout(t); res(); });
        tlsSock.once('error', rej);
      });
      return sendOverSocket(tlsSock, requestTarget, hostHeader, { method, headers, body }, ctrl, timeoutMs2);
    }
    // http:// via proxy: absolute-form request line per RFC 7230 §5.3.2
    requestTarget = `${target.protocol}//${hostHeader}${pathAndQuery}`;
    const raw = await new Promise((resolve, reject) => {
      const sock = net.connect({ host: proxy.host, port: proxy.port });
      const fail = (err) => { sock.destroy(); reject(err); };
      sock.on('error', fail);
      const t = setTimeout(() => fail(new Error('proxy connect timeout')), timeoutMs2);
      sock.on('connect', () => { clearTimeout(t); resolve(sock); });
    });
    return sendOverSocket(raw, requestTarget, hostHeader, { method, headers, body }, ctrl, timeoutMs2, false);
  };
}

function sendOverSocket(sock, requestTarget, hostHeader, { method, headers, body }, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let head = `${method} ${requestTarget} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n`;
    for (const [k, v] of Object.entries(headers)) head += `${k}: ${v}\r\n`;
    if (body) head += `Content-Length: ${body.length}\r\n`;
    head += '\r\n';

    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; try { sock.destroy(); } catch { /* noop */ } reject(err); } };
    const onAbort = () => fail(new Error('aborted by signal'));
    if (signal) {
      if (signal.aborted) return fail(new Error('aborted by signal'));
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => fail(new Error(`proxy request timeout after ${timeoutMs}ms`)), timeoutMs);

    let buf = Buffer.alloc(0);
    let headerDone = false;
    let parsed = null;
    sock.on('error', fail);
    sock.on('data', (d) => {
      if (headerDone) return;
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      parsed = parseHeaders(buf.slice(0, idx).toString('utf8'));
      headerDone = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      const rest = buf.slice(idx + 4);
      const bodyStream = new PassThrough();
      if (rest.length) bodyStream.write(rest);
      sock.removeAllListeners('data');
      sock.pipe(bodyStream);
      readBody(bodyStream, parsed.headers).then(
        (bodyBuf) => {
          settled = true;
          try { sock.end(); } catch { /* noop */ }
          resolve(new ProxyResponse(parsed.status, parsed.statusText, parsed.headers, bodyBuf));
        },
        fail,
      );
    });
    sock.write(head);
    if (body) sock.write(body);
  });
}

export const _internals = { parseHeaders, readBody, cidrMatch, ProxyResponse };
