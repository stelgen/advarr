// Advarr — direct Radarr / Sonarr API client (v3 API, X-Api-Key).
// Lets Advarr add movies/series bypassing Seerr, Radarr-style.
import { normalizeBaseUrl } from './seerr.js';

export class ArrError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'ArrError'; this.status = status; }
}

/**
 * @param {object} cfg { type:'radarr'|'sonarr', url, apiKey, qualityProfileId, rootFolderPath, tmdbApiKey? }
 */
export function createArrClient({ type = 'radarr', url, apiKey, qualityProfileId, rootFolderPath, tmdbApiKey = '', fetchImpl = globalThis.fetch, timeoutMs = 12000, logger = null } = {}) {
  const base = normalizeBaseUrl(url);
  const isSonarr = type === 'sonarr';

  async function call(path, { method = 'GET', body = null } = {}) {
    if (!base || !apiKey) throw new ArrError(`${type} не настроен (url/apiKey)`);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(base + path, {
        method,
        headers: { 'X-Api-Key': apiKey, accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      if (!res.ok) throw new ArrError(`${type} ${res.status}: ${data?.message || res.statusText}`, res.status);
      return data;
    } catch (err) {
      if (err?.name === 'AbortError') throw new ArrError(`${type} timeout`);
      throw err;
    } finally { clearTimeout(t); }
  }

  async function status() {
    const s = await call('/api/v3/system/status');
    return { ok: true, appName: s?.appName || type, version: s?.version || 'unknown' };
  }

  const profiles = () => call('/api/v3/qualityprofile');
  const roots = () => call('/api/v3/rootfolder');

  /** existing library items by TMDB id (Radarr movie / Sonarr series both expose tmdbId) */
  async function existingTmdbIds(mediaType) {
    const path = mediaType === 'tv' ? '/api/v3/series' : '/api/v3/movie';
    const arr = await call(path);
    return new Set((Array.isArray(arr) ? arr : []).map((x) => x.tmdbId).filter(Boolean));
  }

  async function resolveTvdb(tmdbId, title, year) {
    if (apiKey && url) {
      try {
        const found = await call(`/api/v3/series/lookup?term=${encodeURIComponent(`tmdb:${tmdbId}`)}`);
        if (Array.isArray(found) && found[0]?.tvdbId) return { tvdbId: found[0].tvdbId, title: found[0].title || title };
      } catch { /* fall through */ }
    }
    if (title) {
      try {
        const res = await call(`/api/v3/series/lookup?term=${encodeURIComponent(title)}`);
        const hit = (res || []).find((x) => !year || Number(String(x.year || '').slice(0, 4)) === Number(year)) || (res || [])[0];
        if (hit?.tvdbId) return { tvdbId: hit.tvdbId, title: hit.title || title };
      } catch { /* fall through */ }
    }
    throw new ArrError('tvdbId не найден в Sonarr lookup');
  }

  async function request({ mediaType, tmdbId, title, year }) {
    if (!isSonarr) {
      if (mediaType !== 'movie') throw new ArrError('Radarr принимает только фильмы');
      return call('/api/v3/movie', {
        method: 'POST',
        body: {
          title: title || `tmdb:${tmdbId}`,
          tmdbId,
          qualityProfileId: Number(qualityProfileId) || 1,
          rootFolderPath: rootFolderPath || '',
          monitored: true,
          minimumAvailability: 'released',
          addOptions: { searchForMovie: true },
          images: [],
        },
      });
    }
    // Sonarr: series by tvdbId
    if (mediaType !== 'tv') throw new ArrError('Sonarr принимает только сериалы');
    const resolved = await resolveTvdb(tmdbId, title, year);
    return call('/api/v3/series', {
      method: 'POST',
      body: {
        title: resolved.title || title || `tmdb:${tmdbId}`,
        tvdbId: resolved.tvdbId,
        tmdbId,
        qualityProfileId: Number(qualityProfileId) || 1,
        rootFolderPath: rootFolderPath || '',
        monitored: true,
        seasonFolder: true,
        addOptions: { monitor: 'all', searchForMissingEpisodes: true },
      },
    });
  }

  async function test() {
    const s = await status();
    const [p, r] = await Promise.all([profiles().catch(() => []), roots().catch(() => [])]);
    return { ok: true, version: s.version, profiles: p, roots: r };
  }

  return { status, profiles, roots, existingTmdbIds, request, test, _call: call };
}
