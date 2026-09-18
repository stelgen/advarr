// Advarr — Jellyseerr / Overseerr API client.
// API docs: https://api-docs.overseerr.dev/ (auth via X-Api-Key header)
export class SeerrError extends Error {
  constructor(message, status = 0, body = null) {
    super(message);
    this.name = 'SeerrError';
    this.status = status;
    this.body = body;
  }
}

export function normalizeBaseUrl(url = '') {
  return String(url).trim().replace(/\/+$/, '');
}

export function createSeerr({ baseUrl, apiKey, timeoutMs = 10000, fetchImpl = globalThis.fetch, logger = null } = {}) {
  const base = normalizeBaseUrl(baseUrl);

  async function call(path, { method = 'GET', body = null } = {}) {
    if (!base || !apiKey) throw new SeerrError('Seerr is not configured (url/apiKey missing)');
    const url = base + path;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method,
        signal: ctrl.signal,
        headers: {
          'X-Api-Key': apiKey,
          'Accept': 'application/json',
          ...(body !== null ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== null ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 200) }; }
      if (!res.ok) {
        throw new SeerrError(`Seerr ${res.status}: ${parsed?.message || res.statusText}`, res.status, parsed);
      }
      return parsed;
    } catch (err) {
      if (err.name === 'AbortError') throw new SeerrError(`Seerr timeout after ${timeoutMs}ms`);
      if (err instanceof SeerrError) throw err;
      throw new SeerrError(`Seerr request failed: ${err.message}`);
    } finally {
      clearTimeout(t);
    }
  }

  /** connection check → { ok, version, app } */
  async function ping() {
    const status = await call('/api/v1/status');
    return {
      ok: true,
      version: status?.version || 'unknown',
      app: /jellyseerr/i.test(status?.appVersion || status?.repository || '') ? 'jellyseerr' : 'overseerr',
      raw: status,
    };
  }

  /** Set of "movie:123" / "tv:456" for everything already requested */
  async function existingRequests({ maxItems = 3000, pageSize = 250 } = {}) {
    const set = new Set();
    let skip = 0;
    for (;;) {
      const body = await call(`/api/v1/request?take=${pageSize}&skip=${skip}`);
      const results = Array.isArray(body?.results) ? body.results : [];
      for (const r of results) {
        const type = r?.media?.mediaType || r?.mediaType;
        const id = r?.media?.tmdbId ?? r?.mediaId;
        if (type && id) set.add(`${type}:${id}`);
      }
      if (results.length < pageSize || set.size >= maxItems || skip > maxItems) break;
      skip += pageSize;
    }
    return set;
  }

  /**
   * mediaInfo.status per Overseerr: 1 unknown, 2 pending, 3 processing,
   * 4 partially available, 5 available. Anything ≥2 = "already handled".
   */
  async function mediaStatus(mediaType, tmdbId) {
    const path = mediaType === 'tv' ? `/api/v1/tv/${tmdbId}` : `/api/v1/movie/${tmdbId}`;
    const body = await call(path);
    const status = body?.mediaInfo?.status ?? 1;
    return { status, known: status >= 2 };
  }

  /** create request; seasons: 'all' (omit) | [1,2,…] */
  async function request({ mediaType, tmdbId, seasons = 'all' }) {
    const payload = { mediaType, mediaId: Number(tmdbId) };
    if (mediaType === 'tv') {
      if (Array.isArray(seasons)) payload.seasons = seasons;
      // 'all' → omit seasons field, seerr requests all (current + future)
    }
    return call('/api/v1/request', { method: 'POST', body: payload });
  }

  async function test() {
    const info = await ping();
    return { ok: true, version: info.version, app: info.app };
  }

  return { call, ping, existingRequests, mediaStatus, request, test, _base: base };
}
