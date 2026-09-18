// Advarr — metadata enrichment with pluggable providers.
// Providers (tried in configured order; later ones only fill missing fields):
//   tmdb  — TMDB v3 details + credits (requires the already-configured TMDB key)
//   imdb  — public IMDb suggestion endpoint (no key; unofficial, best-effort)
//   tvdb  — TheTVDB API v4 (requires their apikey, optional pin)
// Result: { title, year, overview, cast[], directors[], externalIds{}, posterPath, provider, attempts[] }
import crypto from 'node:crypto';

const CAST_LIMIT = 12;
const CACHE_TTL = 30 * 60e3;
const CACHE_MAX = 300;

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, '-').slice(0, 60);
}

export function createEnrich({ configStore, fetchImpl = globalThis.fetch, logger }) {
  const cache = new Map(); // key: `${type}:${tmdbId}` → {expires, value}

  // --- provider: TMDB (uses existing key; richest data) ---
  async function tmdb(c, params) {
    const apiKey = configStore.data.tmdb.apiKey;
    if (!apiKey) throw new Error('TMDB key not configured');
    const lang = configStore.data.tmdb.language || 'en-US';
    const url = `https://api.themoviedb.org/3/${c.mediaType}/${c.tmdbId}?api_key=${apiKey}&language=${lang}&append_to_response=credits,external_ids`;
    const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    const body = await res.json();
    if (!res.ok) throw new Error(`TMDB ${res.status}`);
    const cast = (body?.credits?.cast || []).slice(0, CAST_LIMIT).map((x) => x.name).filter(Boolean);
    const directors = (body?.credits?.crew || []).filter((x) => x.job === 'Director').map((x) => x.name);
    return {
      title: body?.title || body?.name || c.title,
      year: Number(String(body?.release_date || body?.first_air_date || '').slice(0, 4)) || c.year || 0,
      overview: body?.overview || '',
      cast,
      directors,
      externalIds: { imdbId: body?.external_ids?.imdb_id || '', tmdbId: c.tmdbId },
      posterPath: body?.poster_path || '',
    };
  }

  // --- provider: IMDb public suggestion endpoint (no key) ---
  async function imdb(c) {
    const q = slugify(c.title || '');
    if (!q) throw new Error('empty title');
    const url = `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(q)}.json`;
    const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    const body = await res.json();
    if (!res.ok || !Array.isArray(body?.d)) throw new Error(`IMDb ${res.status}`);
    let pick = null;
    if (c.year) pick = body.d.find((x) => Number(x.y) === Number(c.year));
    pick = pick || body.d.find((x) => ['feature', 'tv series'].includes(String(x.q))) || body.d[0];
    if (!pick?.id) throw new Error('IMDb: no match');
    return {
      title: pick.l || c.title,
      year: Number(pick.y) || c.year || 0,
      overview: '',
      cast: String(pick.s || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, CAST_LIMIT),
      directors: [],
      externalIds: { imdbId: pick.id || '' },
      posterPath: '',
      posterUrl: pick.i?.imageUrl || '',
    };
  }

  // --- provider: TheTVDB API v4 ---
  let tvdbToken = null;
  let tvdbTokenAt = 0;
  async function tvdbLogin() {
    const { apiKey, pin } = configStore.data.enrich.tvdb || {};
    if (!apiKey) throw new Error('TVDb key not configured');
    if (tvdbToken && Date.now() - tvdbTokenAt < 20 * 86400e3) return tvdbToken;
    const res = await fetchImpl('https://api4.thetvdb.com/v4/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pin ? { apikey: apiKey, pin } : { apikey: apiKey }),
      signal: AbortSignal.timeout(12000),
    });
    const body = await res.json();
    if (!res.ok || !body?.data?.token) throw new Error(`TVDb login ${res.status}`);
    tvdbToken = body.data.token;
    tvdbTokenAt = Date.now();
    return tvdbToken;
  }
  async function tvdb(c) {
    const token = await tvdbLogin();
    const q = encodeURIComponent(c.title || '');
    const sr = await fetchImpl(`https://api4.thetvdb.com/v4/search?query=${q}`, {
      headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    const sb = await sr.json();
    if (!sr.ok) throw new Error(`TVDb search ${sr.status}`);
    const type = c.mediaType === 'tv' ? 'series' : 'movie';
    let hit = (sb?.data || []).find((x) => x.type === type && (!c.year || Number(String(x.year || '').slice(0, 4)) === Number(c.year)));
    hit = hit || (sb?.data || []).find((x) => x.type === type);
    if (!hit?.tvdbId) throw new Error('TVDb: no match');
    const imdbId = (hit.remote_ids || []).find((r) => /imdb/i.test(r.sourceName || ''))?.id || '';
    let cast = [];
    let overview = hit.overview || '';
    if (type === 'series') {
      const er = await fetchImpl(`https://api4.thetvdb.com/v4/series/${hit.tvdbId}/extended?short=true`, {
        headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(12000),
      });
      const eb = await er.json();
      if (er.ok) {
        cast = (eb?.data?.characters || []).map((ch) => ch?.personName || ch?.name).filter(Boolean).slice(0, CAST_LIMIT);
        overview = overview || eb?.data?.overview || '';
      }
    }
    return {
      title: hit.name || c.title,
      year: Number(String(hit.year || '').slice(0, 4)) || c.year || 0,
      overview,
      cast,
      directors: [],
      externalIds: { imdbId, tvdbId: hit.tvdbId },
      posterPath: '',
    };
  }

  const PROVIDERS = { tmdb, imdb, tvdb };

  /** merge: first successful provider fills the base, later ones only fill missing fields */
  function merge(results, attempts) {
    const out = { title: '', year: 0, overview: '', cast: [], directors: [], externalIds: {}, posterPath: '', posterUrl: '', provider: null };
    for (const r of results) {
      if (!r.value) continue;
      out.provider = out.provider || r.provider;
      for (const k of ['title', 'overview', 'posterPath', 'posterUrl']) if (!out[k] && r.value[k]) out[k] = r.value[k];
      if (!out.year && r.value.year) out.year = r.value.year;
      if (!out.cast.length && r.value.cast?.length) out.cast = r.value.cast;
      if (!out.directors.length && r.value.directors?.length) out.directors = r.value.directors;
      // fill-in only: an empty value from an earlier provider must not overwrite a real one
      for (const [k, v] of Object.entries(r.value.externalIds || {})) {
        if (v && !out.externalIds[k]) out.externalIds[k] = v;
      }
    }
    out.attempts = attempts; // [{provider, ok, error?}]
    return out;
  }

  async function enrich({ mediaType, tmdbId, title, year }) {
    const cfg = configStore.data.enrich;
    if (!cfg?.enabled) return { ok: false, reason: 'disabled', attempts: [] };
    const enabled = (cfg.providers || []).filter((p) => PROVIDERS[p]);
    if (!enabled.length) return { ok: false, reason: 'no providers', attempts: [] };

    const key = `${mediaType}:${tmdbId}`;
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return { ...hit.value, cached: true };

    const c = { mediaType, tmdbId, title: title || '', year: year || 0 };
    const results = [];
    const attempts = [];
    for (const p of enabled) {
      try {
        const value = await PROVIDERS[p](c, configStore.data);
        results.push({ provider: p, value });
        attempts.push({ provider: p, ok: true });
      } catch (err) {
        attempts.push({ provider: p, ok: false, error: err.message });
        if (logger) logger.debug(`enrich ${p} failed: ${err.message}`);
      }
    }
    const merged = merge(results, attempts);
    const ok = Boolean(merged.provider);
    const value = { ok, ...merged };
    if (ok) {
      cache.set(key, { expires: Date.now() + CACHE_TTL, value });
      if (cache.size > CACHE_MAX) {
        for (const k of cache.keys()) { cache.delete(k); if (cache.size <= CACHE_MAX - 50) break; }
      }
    }
    return value;
  }

  async function testProvider(providerId, probe) {
    const p = PROVIDERS[providerId];
    if (!p) throw new Error(`unknown provider: ${providerId}`);
    const value = await p({ mediaType: probe.mediaType || 'movie', tmdbId: 0, title: probe.title, year: probe.year || 0 }, configStore.data);
    return { ok: true, castCount: value.cast?.length || 0, imdbId: value.externalIds?.imdbId || '' };
  }

  function testCacheKey(_type, _id) { return crypto.createHash('md5').update(`${_type}:${_id}`).digest('hex'); }

  return { enrich, testProvider, _cache: cache, _testKey: testCacheKey };
}
