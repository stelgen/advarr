// Advarr — backups in *arr style: named snapshots of config+history+runs,
// list/create/delete/restore/download, rotation (keep last N),
// optional custom folder and scheduled creation (Radarr parity).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { deepMerge, defaultConfig, applyPatch, CONFIG_VERSION } from './config.js';

const NAME_RE = /^advarr_backup_[\w.\-]+\.json$/;

export function createBackupManager({ dataDir, configStore, historyStore, runsStore, logger, version = '0.0.0' }) {
  /** Radarr-style: optional custom backup folder, default <data>/backups */
  function currentDir() {
    const custom = String(configStore.data.backups?.folder || '').trim();
    const dir = custom || path.join(dataDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function safePath(id) {
    if (!NAME_RE.test(id)) throw new Error('bad backup id');
    const dir = currentDir();
    const p = path.join(dir, id);
    if (!p.startsWith(dir + path.sep)) throw new Error('bad backup id'); // traversal guard
    return p;
  }

  function list() {
    const dir = currentDir();
    const items = [];
    for (const name of fs.readdirSync(dir)) {
      if (!NAME_RE.test(name)) continue;
      try {
        const st = fs.statSync(path.join(dir, name));
        items.push({ id: name, name, size: st.size, modifiedAt: st.mtime.toISOString() });
      } catch { /* raced file — skip */ }
    }
    // name embeds a millisecond timestamp → lexicographic desc is deterministic
    items.sort((a, b) => b.name.localeCompare(a.name) || b.modifiedAt.localeCompare(a.modifiedAt));
    return items;
  }

  function stamp() {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    // milliseconds keep rapid successive backups from colliding on one filename
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}__${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  }

  function rotate() {
    const max = Number(configStore.data.backups?.maxKeep) || 30;
    const all = list();
    for (const item of all.slice(max)) {
      try { fs.rmSync(safePath(item.id)); } catch { /* noop */ }
    }
  }

  function create() {
    const dir = currentDir();
    // random suffix: even two backups within the same millisecond never collide
    const suffix = crypto.randomBytes(2).toString('hex');
    const name = `advarr_backup_v${version}_${stamp()}-${suffix}.json`;
    const payload = {
      advarrBackup: { version, createdAt: new Date().toISOString() },
      config: configStore.data,
      history: historyStore.data,
      runs: runsStore.data,
    };
    const p = path.join(dir, name);
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, p);
    const st = fs.statSync(p);          // stat BEFORE rotation — rotation may delete this file
    rotate();
    logger.log(`backup created: ${name}`);
    return { id: name, name, size: st.size, modifiedAt: st.mtime.toISOString() };
  }

  function remove(id) {
    const p = safePath(id);
    if (!fs.existsSync(p)) throw new Error('backup not found');
    fs.rmSync(p);
    logger.log(`backup deleted: ${id}`);
    return { ok: true };
  }

  function readFile(id) {
    const p = safePath(id);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  /**
   * Restore in place (no app restart needed):
   * config migrates to current version via defaults-merge,
   * history/runs replaced wholesale.
   */
  function restore(id) {
    const data = readFile(id);
    if (!data.config) throw new Error('backup has no config');
    const migrated = deepMerge(defaultConfig(), data.config);
    migrated.version = CONFIG_VERSION;
    applyPatch(configStore.data, migrated);
    configStore.saveNow();
    if (data.history && Array.isArray(data.history.items)) {
      applyPatch(historyStore.data, { items: data.history.items });
      historyStore.saveNow();
    }
    if (data.runs) {
      applyPatch(runsStore.data, { runs: data.runs.runs || [] });
      runsStore.saveNow();
    }
    logger.log(`backup restored: ${id}`);
    return { ok: true };
  }

  return { list, create, remove, restore, readFile, safePath };
}
