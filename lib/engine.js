// Advarr — discovery engine: collect → filter → dedup → score → request.
import {
  normalizeCandidate, passesFilters, scoreCandidate, rank,
  dedupeCandidates, scoreToDisplay,
} from './scoring.js';
import { ringPush } from './store.js';

const MAX_AVAILABILITY_CHECKS = 60;
const REQUEST_DELAY_MS = 700;

export function createEngine({ configStore, historyStore, runsStore, getClients, notify = null, logger }) {
  const state = { running: false, lastRun: null };

  function seerrConfigured() {
    const s = configStore.data.seerr;
    return Boolean(s.url && s.apiKey);
  }

  /**
   * Known keys from local history. `requested` items are always skipped;
   * `failed` items are re-eligible after schedule.retryCooldownDays (0 = never retry).
   */
  function knownHistoryKeys() {
    const cfg = configStore.data;
    const cooldownMs = Math.max(0, Number(cfg.schedule.retryCooldownDays ?? 7)) * 86400e3;
    const now = Date.now();
    const known = new Set();
    for (const h of historyStore.data.items) {
      const key = `${h.mediaType}:${h.tmdbId}`;
      if (h.status === 'failed') {
        if (cooldownMs <= 0) { known.add(key); continue; } // never retry
        const age = now - Date.parse(h.at || 0);
        if (Number.isFinite(age) && age < cooldownMs) known.add(key); // still cooling down
        // else: cooldown expired → allow retry
      } else {
        known.add(key); // requested or manual → always skip
      }
    }
    return known;
  }

  async function collectCandidates(cfg, tmdb) {
    const { mediaTypes } = cfg.selection;
    const sourcesCfg = cfg.sources;
    const pool = new Map();
    const errors = [];

    for (const mediaType of mediaTypes) {
      for (const sourceId of ['trending_day', 'trending_week', 'popular', 'top_rated', 'now_playing', 'upcoming', 'discover', 'tmdb_export']) {
        const sc = sourcesCfg[sourceId];
        if (!sc?.on) continue;
        try {
          if (sourceId === 'tmdb_export') {
            // official public dumps — works without any TMDB key
            const { exporter } = getClients();
            const raws = await exporter.fetchTop(mediaType, {
              topN: Math.max(20, Math.min(500, sc.topN || 150)),
              includeAdult: Boolean(cfg.filters.includeAdult),
            });
            for (const raw of raws) {
              const c = normalizeCandidate(raw, mediaType);
              if (!c) continue;
              const existing = pool.get(c.key);
              if (existing) existing.sources.add(sourceId);
              else { c.sources.add(sourceId); c.noGenres = true; pool.set(c.key, c); }
            }
            continue;
          }
          const raws = await tmdb.fetchSource(sourceId, mediaType, {
            pages: Math.max(1, Math.min(5, sourcesCfg.pages || 1)),
            perPage: Math.max(20, Math.min(100, sourcesCfg.perPage || 40)),
            discoverParams: sourceId === 'discover' ? String(sc.params || '') : '',
          });
          for (const raw of raws) {
            const c = normalizeCandidate(raw, mediaType);
            if (!c) continue;
            const existing = pool.get(c.key);
            if (existing) existing.sources.add(sourceId);
            else { c.sources.add(sourceId); pool.set(c.key, c); }
          }
        } catch (err) {
          errors.push(`${sourceId}/${mediaType}: ${err.message}`);
        }
      }
    }
    return { candidates: [...pool.values()], errors };
  }

  async function run({ dry = false, limit = null } = {}) {
    if (state.running) throw new Error('run already in progress');
    state.running = true;
    const report = {
      dry, startedAt: new Date().toISOString(), finishedAt: null,
      scanned: 0, passed: 0, skipped: 0, skipReasons: {},
      requested: 0, failed: 0, items: [], errors: [],
    };

    try {
      const cfg = configStore.data;
      const { tmdb, seerr } = getClients();
      logger.log(dry ? 'DRY-RUN discovery started' : 'Discovery run started');

      const { candidates, errors } = await collectCandidates(cfg, tmdb);
      report.errors.push(...errors);
      report.scanned = candidates.length;
      logger.log(`collected ${candidates.length} unique candidates`, { errors: errors.length });

      // known keys: local history + seerr requests
      const known = knownHistoryKeys();
      if (cfg.filters.excludeInSeerr && seerrConfigured()) {
        try {
          const seerrSet = await seerr.existingRequests();
          for (const k of seerrSet) known.add(k);
          logger.log(`seerr: ${seerrSet.size} existing requests loaded`);
        } catch (err) {
          report.errors.push(`seerr existingRequests: ${err.message}`);
          logger.warn(`seerr existingRequests failed: ${err.message}`);
        }
      }

      const { fresh } = dedupeCandidates(candidates, known);
      report.skipped = candidates.length - fresh.length;

      for (const c of fresh) {
        const f = passesFilters(c, cfg.filters);
        if (!f.ok) { c.filterReason = f.reason; continue; }
        c.score = scoreCandidate(c, cfg.scoring);
        c.passed = true;
      }
      const passed = fresh.filter((c) => c.passed);
      report.passed = passed.length;
      const reasons = {};
      for (const c of fresh) if (!c.passed) reasons[c.filterReason] = (reasons[c.filterReason] || 0) + 1;
      report.skipReasons = reasons;

      const ranked = rank(passed).map((c) => ({
        ...c,
        sources: [...c.sources],
        score: scoreToDisplay(c.score),
      }));

      // availability verification in seerr: real run blocks known items;
      // dry run only labels candidates with their status (UI badges)
      const blocked = new Set();
      const availabilityMap = new Map();
      if (cfg.filters.checkAvailability && seerrConfigured()) {
        const scanCount = dry ? (limit || 24) : MAX_AVAILABILITY_CHECKS;
        const toCheck = ranked.slice(0, scanCount);
        const statuses = await Promise.allSettled(toCheck.map((c) => seerr.mediaStatus(c.mediaType, c.id)));
        toCheck.forEach((c, i) => {
          const st = statuses[i].status === 'fulfilled' ? (statuses[i].value?.status ?? 1) : 1;
          availabilityMap.set(c.key, st);
          if (!dry && statuses[i].status === 'fulfilled' && statuses[i].value?.known) blocked.add(c.key);
        });
        if (blocked.size) logger.log(`seerr availability check: ${blocked.size} already handled → skipped`);
      }

      // quota pick
      const quotas = { movie: cfg.selection.moviesPerRun, tv: cfg.selection.showsPerRun };
      const picked = [];
      for (const c of ranked) {
        if (blocked.has(c.key)) continue;
        if ((quotas[c.mediaType] ?? 0) <= 0) continue;
        quotas[c.mediaType] -= 1;
        picked.push(c);
        if (limit && picked.length >= limit) break;
      }
      if (dry) {
        report.items = picked.map((c) => ({ ...c, status: 'dry', mediaStatus: availabilityMap.get(c.key) ?? 1 }));
        report.finishedAt = new Date().toISOString();
        logger.log(`DRY-RUN finished: ${picked.length} would be requested`);
        return report;
      }

      if (!seerrConfigured()) {
        report.errors.push('seerr not configured — nothing requested');
        logger.warn('seerr not configured — run finished without requesting');
        report.finishedAt = new Date().toISOString();
        return report;
      }

      for (const c of picked) {
        try {
          const seasons = cfg.seerr.tvSeasons === 'first' ? [1] : 'all';
          await seerr.request({ mediaType: c.mediaType, tmdbId: c.id, seasons });
          c.status = 'requested';
          report.requested += 1;
          logger.log(`requested ${c.mediaType} "${c.title}" (${c.year || '—'}) tmdb:${c.id}`);
        } catch (err) {
          c.status = 'failed';
          c.error = err.message;
          report.failed += 1;
          logger.error(`request failed ${c.mediaType} "${c.title}": ${err.message}`);
        }
        await sleep(REQUEST_DELAY_MS);
      }

      const now = new Date().toISOString();
      historyStore.update((h) => {
        for (const c of picked) {
          ringPush(h.items, {
            id: `${Date.now()}-${c.key}`,
            at: now,
            tmdbId: c.id,
            mediaType: c.mediaType,
            title: c.title,
            year: c.year,
            posterPath: c.posterPath,
            score: c.score,
            sources: c.sources,
            status: c.status,
            error: c.error || null,
          }, Math.max(100, configStore.data.storage?.historyMaxItems ?? 2000));
        }
      });

      // copies AFTER the request loop → final statuses are captured
      report.items = picked.map((c) => ({ ...c, mediaStatus: availabilityMap.get(c.key) ?? 1 }));
      report.finishedAt = new Date().toISOString();
      state.lastRun = report;
      logger.log(`run finished: requested=${report.requested} failed=${report.failed} (scanned=${report.scanned})`);

      if (notify) {
        try { await notify.runFinished(report); } catch (err) { logger.warn(`notify failed: ${err.message}`); }
      }
      return report;
    } catch (err) {
      report.errors.push(err.message);
      report.finishedAt = new Date().toISOString();
      state.lastRun = report;
      logger.error(`run crashed: ${err.message}`);
      throw err;
    } finally {
      runsStore.update((r) => ringPush(r.runs, summarize(report), 20));
      state.running = false;
    }
  }

  async function requestOne(mediaType, tmdbId, details = {}) {
    const { seerr } = getClients();
    if (!seerrConfigured()) throw new Error('seerr not configured');
    const cfg = configStore.data;
    const seasons = cfg.seerr.tvSeasons === 'first' ? [1] : 'all';
    await seerr.request({ mediaType, tmdbId, seasons });
    historyStore.update((h) => ringPush(h.items, {
      id: `${Date.now()}-${mediaType}:${tmdbId}`,
      at: new Date().toISOString(),
      tmdbId,
      mediaType,
      title: details.title || `tmdb:${tmdbId}`,
      year: details.year || 0,
      posterPath: details.posterPath || '',
      score: null,
      sources: ['manual'],
      status: 'requested',
      error: null,
    }), Math.max(100, configStore.data.storage?.historyMaxItems ?? 2000));
    logger.log(`manual request ${mediaType} tmdb:${tmdbId}`);
    return { ok: true };
  }

  function summarize(r) {
    return {
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      dry: Boolean(r.dry),
      scanned: r.scanned,
      passed: r.passed,
      skipped: r.skipped,
      requested: r.requested,
      failed: r.failed,
      errors: (r.errors || []).slice(0, 5),
      titles: (r.items || []).map((c) => `${c.mediaType === 'tv' ? 'Сериал' : 'Фильм'}: ${c.title}`),
    };
  }

  function status() {
    return {
      running: state.running,
      lastRun: state.lastRun ? summarize(state.lastRun) : runsStore.data.runs.at(-1) || null,
    };
  }

  return { run, requestOne, status, get running() { return state.running; } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
