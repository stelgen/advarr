// Advarr — TMDB API client (v3), injectable fetch for tests, small TTL cache.
// Endpoints reference: https://developer.themoviedb.org/reference
export class TmdbError extends Error {
  constructor(message, status = 0, body = null) {
    super(message);
    this.name = 'TmdbError';
    this.status = status;
    this.body = body;
  }
}

export const SOURCE_ROUTES = {
  trending_day: (t) => ({ path: `/trending/${t}/day` }),
  trending_week: (t) => ({ path: `/trending/${t}/week` }),
  popular: (t) => ({ path: `/${t}/popular` }),
  top_rated: (t) => ({ path: `/${t}/top_rated` }),
  now_playing: (t) => ({ path: `/movie/now_playing`, only: ['movie'] }),
  upcoming: (t) => ({ path: `/movie/upcoming`, only: ['movie'] }),
  discover: (t, params) => ({ path: `/${t}/discover`, params, only: ['movie', 'tv'] }),
};

export function createTmdb({ apiKey, language = 'ru-RU', region = '', timeoutMs = 12000, fetchImpl = globalThis.fetch, logger = null } = {}) {
  const base = 'https://api.themoviedb.org/3';
  const cache = new Map(); // key → {expires, value}

  async function call(path, params = {}) {
    if (!apiKey) throw new TmdbError('TMDB api key is not configured');
    const url = new URL(base + path);
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('language', language);
    if (region) url.searchParams.set('region', region);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 200) }; }
      if (!res.ok) {
        throw new TmdbError(`TMDB ${res.status} ${body?.status_message || res.statusText}`, res.status, body);
      }
      return body;
    } catch (err) {
      if (err.name === 'AbortError') throw new TmdbError(`TMDB timeout after ${timeoutMs}ms`);
      if (err instanceof TmdbError) throw err;
      throw new TmdbError(`TMDB request failed: ${err.message}`);
    } finally {
      clearTimeout(t);
    }
  }

  async function cached(key, ttlMs, fn) {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.expires > now) return hit.value;
    const value = await fn();
    cache.set(key, { expires: now + ttlMs, value });
    return value;
  }

  async function fetchSource(sourceId, mediaType, { page = 1, pages = 1, perPage = 40, discoverParams = '' } = {}) {
    const items = [];
    for (let p = page; p < page + pages; p += 1) {
      const route = SOURCE_ROUTES[sourceId];
      if (!route) throw new TmdbError(`unknown source: ${sourceId}`);
      const r = route(mediaType, discoverParams);
      if (r.only && !r.only.includes(mediaType)) break;
      const params = { page: p, ...(r.params || {}) };
      let body;
      try {
        body = await cached(`src:${sourceId}:${mediaType}:${p}:${discoverParams}`, 15 * 60e3, () =>
          call(r.path, params));
      } catch (err) {
        if (logger) logger.warn(`tmdb source ${sourceId}/${mediaType} p${p} failed: ${err.message}`);
        if (p === page && items.length === 0) throw err; // nothing at all → propagate
        break; // partial results are fine
      }
      const results = Array.isArray(body?.results) ? body.results : [];
      items.push(...results);
      if (results.length < (perPage || 20)) break; // last page
      if (items.length >= perPage * pages) break;
    }
    return items;
  }

  async function genres(mediaType) {
    return cached(`genres:${mediaType}:${language}`, 24 * 3600e3, async () => {
      const body = await call(`/genre/${mediaType}/list`);
      return body?.genres || [];
    });
  }

  async function details(mediaType, id) {
    return call(`/${mediaType}/${id}`);
  }

  async function test() {
    const body = await call('/configuration');
    return { ok: true, images: body?.images?.secure_base_url || 'https://image.tmdb.org/t/p' };
  }

  return { call, fetchSource, genres, details, test, _cache: cache };
}
