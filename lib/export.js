// Advarr — TMDB Daily Export source: official public ID dumps, no API key required.
// https://files.tmdb.org/p/exports/{movie_ids|tv_series_ids}_MM_DD_YYYY.json.gz (JSONL, gzip)
// Fields available: id, title/name, original_title, popularity, vote_average,
// vote_count, release_date/first_air_date, adult. No genres/overview/posters —
// genre-based filters do not apply to candidates from this source.
import zlib from 'node:zlib';

const TTL = 12 * 3600e3;

export function createExporter({ fetchImpl = globalThis.fetch, logger } = {}) {
  const cache = { movie: null, tv: null }; // {at, items}

  function exportUrl(type, date) {
    const p = (d) =>
      `${String(d.getUTCMonth() + 1).padStart(2, '0')}_${String(d.getUTCDate()).padStart(2, '0')}_${d.getUTCFullYear()}`;
    return `https://files.tmdb.org/p/exports/${type === 'tv' ? 'tv_series_ids' : 'movie_ids'}_${p(date)}.json.gz`;
  }

  async function downloadGz(url) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`export ${res.status} (${url})`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** stream-friendly: parse every JSONL line, keep the global top-N by popularity */
  function parseTop(buf, topN, includeAdult) {
    const text = zlib.gunzipSync(buf).toString('utf8');
    const top = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.adult && !includeAdult) continue;
      if (!(o.popularity > 0)) continue;
      top.push(o);
    }
    top.sort((a, b) => b.popularity - a.popularity);
    return top.slice(0, Math.max(1, topN));
  }

  /** yesterday's dump preferred; falls back up to 3 days back (publication lag) */
  async function fetchTop(type, { topN = 150, includeAdult = false } = {}) {
    const hit = cache[type];
    if (hit && Date.now() - hit.at < TTL) return hit.items;

    let lastErr = null;
    for (let back = 1; back <= 3; back += 1) {
      const url = exportUrl(type, new Date(Date.now() - back * 86400e3));
      try {
        const buf = await downloadGz(url);
        const items = parseTop(buf, topN, includeAdult);
        cache[type] = { at: Date.now(), items };
        if (logger) logger.log(`tmdb export ${type}: top ${items.length} of dump (${url.split('/').pop()})`);
        return items;
      } catch (err) {
        lastErr = err;
        if (logger) logger.debug(`tmdb export ${type} attempt -${back}d failed: ${err.message}`);
      }
    }
    throw lastErr || new Error('tmdb export download failed');
  }

  return { fetchTop, exportUrl, _parseTop: parseTop };
}
