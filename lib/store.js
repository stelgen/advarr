// Advarr — tiny atomic JSON store (zero deps).
// Writes are debounced; every flush is atomic (tmp file + rename).
import fs from 'node:fs';
import path from 'node:path';

export class JsonStore {
  /**
   * @param {string} file absolute path to json file
   * @param {object} defaults merged under stored data (defaults lose to file on conflict)
   */
  constructor(file, defaults = {}) {
    this.file = file;
    this.defaults = defaults;
    this._data = null;
    this._timer = null;
    this._debounceMs = 300;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this._data = { ...structuredClone(this.defaults), ...parsed };
    } catch {
      this._data = structuredClone(this.defaults);
      this.saveNow();
    }
    return this._data;
  }

  get data() {
    if (this._data === null) this.load();
    return this._data;
  }

  /** mutate data via fn, then persist (debounced) */
  update(fn) {
    fn(this.data);
    this.save();
    return this.data;
  }

  save() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this.saveNow();
    }, this._debounceMs);
  }

  /** synchronous atomic write; safe to call in exit handlers */
  saveNow() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._data === null) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`[store] failed to persist ${this.file}: ${err.message}`);
      try { fs.rmSync(`${this.file}.tmp-${process.pid}`, { force: true }); } catch { /* noop */ }
    }
  }

  close() {
    this.saveNow();
  }
}

/** push into ring buffer, keep last `max` items, return the array */
export function ringPush(arr, item, max) {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
  return arr;
}
