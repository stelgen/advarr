// Advarr — TMDB Daily Export source: official public ID dumps, no API key required.
// https://files.tmdb.org/p/exports/{movie_ids|tv_series_ids}_MM_DD_YYYY.json.gz (JSONL, gzip)
// RAM-aware: the dump (~1M lines) is streamed through gunzip line-by-line; only the
// global top-N by popularity is retained in memory.
import { createGunzip } from 'node:zlib';

const TTL = 12 * 3600e3;

export function createExporter({ fetchImpl = globalThis.fetch, logger } = {}) {
  const cache = { movie: null, tv: null }; // {at, items}

  function exportUrl(type, date) {
    const p = (d) =>
      `${String(d.getUTCMonth() + 1).padStart(2, '0')}_${String(d.getUTCDate()).padStart(2, '0')}_${d.getUTCFullYear()}`;
    return `https://files.tmdb.org/p/exports/${type === 'tv' ? 'tv_series_ids' : 'movie_ids'}_${p(date)}.json.gz`;
  }

  /** keep a bounded top-N buffer: on each line, push if it beats the current minimum */
  function makeTopN(topN) {
    const top = []; // ascending by popularity: [worst … best]
    const LIMIT = Math.max(1, topN);
    return {
      push(row) {
        if (top.length >= LIMIT && row.popularity <= top[0].popularity) return;
        // insert sorted (binary search from the end is fine at this scale)
        let i = top.length;
        top.push(row);
        while (i > 0 && top[i - 1].popularity > row.popularity) {
          top[i] = top[i - 1];
          i -= 1;
        }
        top[i] = row;
        if (top.length > LIMIT) top.shift();
      },
      result: () => [...top].reverse(), // descending
    };
  }

  /** stream the gzip through gunzip, split on newline, retain only top-N rows */
  async function streamTop(buf, topN, includeAdult) {
    return new Promise((resolve, reject) => {
      const rows = makeTopN(topN);
      const gz = createGunzip();
      let line = '';
      gz.on('data', (chunk) => {
        line += chunk.toString('utf8');
        let idx;
        while ((idx = line.indexOf('\n')) >= 0) {
          const raw = line.slice(0, idx);
          line = line.slice(idx + 1);
          if (!raw) continue;
          try {
            const o = JSON.parse(raw);
            if (o.adult && !includeAdult) continue;
            if (!(o.popularity > 0)) continue;
            rows.push(o);
          } catch { /* malformed line — skip */ }
        }
      });
      gz.on('end', () => resolve(rows.result()));
      gz.on('error', () => reject(new Error('export gunzip failed')));
      gz.end(buf);
    });
  }

  async function download(url) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`export ${res.status} (${url})`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** yesterday's dump preferred; falls back up to 3 days back (publication lag) */
  async function fetchTop(type, { topN = 150, includeAdult = false } = {}) {
    const hit = cache[type];
    if (hit && Date.now() - hit.at < TTL) return hit.items;

    let lastErr = null;
    for (let back = 1; back <= 3; back += 1) {
      const url = exportUrl(type, new Date(Date.now() - back * 86400e3));
      try {
        const buf = await download(url);
        const items = await streamTop(buf, topN, includeAdult);
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

  return { fetchTop, exportUrl, _streamTop: streamTop, _makeTopN: makeTopN };
}
