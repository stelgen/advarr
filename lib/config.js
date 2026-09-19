// Advarr — config: defaults, env seeding, deep merge, migrations.
import path from 'node:path';
import { JsonStore } from './store.js';

export const CONFIG_VERSION = 5;

export function defaultConfig() {
  return {
    version: 2,
    general: {
      host: '',          // '' → 0.0.0.0 (seeded from env/defaults on first boot)
      port: 0,           // 0 → seeded from env/8787
      logLevel: 'info',  // debug | info | warn | error
      authentication: {
        method: 'none',  // none | basic | apiKey
        username: '',
        password: '',
        apiKey: '',
        envSeeded: false, // env vars seed credentials only on first boot
      },
      proxy: {
        enabled: false,
        host: '',
        port: 8080,
        httpsOnly: false,  // proxy only https:// requests
        username: '',
        password: '',
        bypassAddresses: '', // "localhost,127.0.0.1,.corp.lan,192.168.1.0/24"
      },
    },
    tmdb: {
      apiKey: '',
      language: 'ru-RU',
      region: 'RU',
    },
    seerr: {
      url: '',
      apiKey: '',
      tvSeasons: 'all', // all | first
    },
    schedule: {
      enabled: true,
      intervalHours: 12,
      jitterMinutes: 30,
      runOnStart: false,
      retryCooldownDays: 7, // failed requests are retried after N days (0 = never retry)
    },
    selection: {
      mediaTypes: ['movie', 'tv'],
      moviesPerRun: 3,
      showsPerRun: 2,
    },
    filters: {
      includeAdult: false,
      minVotes: 200,
      minRating: 6.5,
      yearFrom: 2015, // 0 = disabled
      yearTo: 0,      // 0 = now
      languages: [],  // original_language whitelist, empty = any ('en','ru','ko'…)
      includeGenres: [],
      excludeGenres: [],
      excludeInSeerr: true,     // skip items already requested in Seerr
      checkAvailability: true,  // skip items already pending/available (extra API calls)
    },
    sources: {
      pages: 2,
      perPage: 40,
      tmdb_export: { on: false, weight: 0.9, topN: 150 }, // public daily dumps, no API key
      trending_day: { on: true, weight: 1.0 },
      trending_week: { on: true, weight: 1.0 },
      popular: { on: true, weight: 0.9 },
      top_rated: { on: false, weight: 0.7 },
      now_playing: { on: false, weight: 0.8 },
      upcoming: { on: false, weight: 0.8 },
      discover: {
        on: false,
        weight: 0.6,
        params: '', // raw TMDB discover querystring, e.g. with_genres=878&sort_by=popularity.desc
      },
    },
    scoring: {
      wRating: 0.35,
      wPopularity: 0.25,
      wVotes: 0.15,
      wFreshness: 0.15,
      wGenres: 0.10,
      favoriteGenres: [], // genre ids, adds up to +1 * wGenres
    },
    notify: {
      providers: [], // {id, type:'telegram'|'webhook', name, enabled, onRunCompleted, onRunFailed, telegram:{botToken,chatId}, webhook:{url}}
    },
    backups: {
      maxKeep: 30,
      intervalDays: 7,  // scheduled backup cadence; 0 = off (Radarr-style)
      folder: '',       // custom absolute path; empty = <data>/backups
    },
    storage: {
      // resource-footprint controls (RAM / SSD wear)
      historyMaxItems: 2000, // ring size of request history
      logBuffer: 500,        // in-memory log lines
      writeDebounceMs: 1000, // coalesce store writes
      posterCacheHours: 168, // Cache-Control on proxied posters (default 7 days)
    },
    ui: {
      pageSize: 24,
      gridDensity: 'normal', // normal | compact
      showScores: true,
    },
  };
}

function getIn(obj, keys) {
  return keys.reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setIn(obj, keys, value) {
  const last = keys.pop();
  const target = keys.reduce((o, k) => {
    if (typeof o[k] !== 'object' || o[k] === null) o[k] = {};
    return o[k];
  }, obj);
  target[last] = value;
}

// keys that must never be merged from user input (prototype pollution)
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function deepMerge(base, over) {
  if (Array.isArray(base) || Array.isArray(over)) return over !== undefined ? structuredClone(over) : base;
  if (typeof base === 'object' && base !== null && typeof over === 'object' && over !== null) {
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) {
      if (UNSAFE_KEYS.has(k)) continue;
      out[k] = k in base ? deepMerge(base[k], v) : v;
    }
    return out;
  }
  return over !== undefined ? over : base;
}

/** deep-merge `patch` into cfg in place, arrays replaced wholesale */
export function applyPatch(cfg, patch) {
  const merged = deepMerge(cfg, patch);
  Object.keys(cfg).forEach((k) => { delete cfg[k]; });
  Object.assign(cfg, merged);
  return cfg;
}

/**
 * @returns {{store: JsonStore, cfg: object}}
 */
export function loadConfig(dataDir, env = process.env) {
  const store = new JsonStore(path.join(dataDir, 'config.json'), defaultConfig());
  const cfg = store.load();

  // migrate older versions (missing keys filled from defaults)
  if (cfg.version !== CONFIG_VERSION) {
    const migrated = deepMerge(defaultConfig(), cfg);
    migrated.version = CONFIG_VERSION;
    delete migrated.enrich; // experimental v0.4.0-draft section, never shipped
    Object.keys(cfg).forEach((k) => { delete cfg[k]; });
    Object.assign(cfg, migrated);
    store.save();
  }

  // seed secrets from env on first boot (empty target only — UI edits win afterwards)
  const seeds = {
    TMDB_API_KEY: ['tmdb', 'apiKey'],
    SEERR_URL: ['seerr', 'url'],
    SEERR_API_KEY: ['seerr', 'apiKey'],
  };
  let seeded = false;
  for (const [envName, keys] of Object.entries(seeds)) {
    const v = env[envName];
    if (v && !getIn(cfg, keys)) { setIn(cfg, keys, v); seeded = true; }
  }

  // seed network/auth basics once (before user touches them in UI)
  const g = cfg.general;
  if (!g.host) { g.host = env.ADVARR_HOST || '0.0.0.0'; seeded = true; }
  if (!g.port) { g.port = Number(env.ADVARR_PORT || 8787); seeded = true; }

  const auth = g.authentication;
  if (!auth.envSeeded) {
    if (env.BASIC_AUTH_USER && env.BASIC_AUTH_PASS) {
      auth.method = 'basic';
      auth.username = env.BASIC_AUTH_USER;
      auth.password = env.BASIC_AUTH_PASS;
    } else if (env.ADVARR_API_KEY) {
      auth.method = 'apiKey';
      auth.apiKey = env.ADVARR_API_KEY;
    }
    auth.envSeeded = true;
    seeded = true;
  }
  if (seeded) store.save();

  return { store, cfg };
}

export function maskSecret(value = '') {
  if (!value) return '';
  if (value.startsWith('••••')) return value; // already masked
  const tail = value.slice(-4);
  return `••••${tail}`;
}

/** replace masked fields with existing stored values before saving */
export function unmaskPatch(oldCfg, patch, secretPaths) {
  for (const keys of secretPaths) {
    let node = patch;
    for (let i = 0; i < keys.length - 1; i += 1) {
      if (node == null || typeof node[keys[i]] !== 'object') { node = null; break; }
      node = node[keys[i]];
    }
    if (node && typeof node[keys[keys.length - 1]] === 'string' && node[keys[keys.length - 1]].startsWith('••••')) {
      node[keys[keys.length - 1]] = getIn(oldCfg, keys) ?? '';
    }
  }
  return patch;
}

/** masked secrets in dynamic provider list (notify providers) */
export function restoreProviderSecrets(oldCfg, newCfg) {
  const oldList = oldCfg?.notify?.providers || [];
  for (const p of (newCfg?.notify?.providers || [])) {
    const old = oldList.find((x) => x.id === p.id);
    if (!old) continue;
    if (typeof p.telegram?.botToken === 'string' && p.telegram.botToken.startsWith('••••')) {
      p.telegram.botToken = old.telegram?.botToken || '';
    }
  }
  return newCfg;
}
