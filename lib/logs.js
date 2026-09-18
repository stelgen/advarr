// Advarr — in-memory ring logger. Never logs secrets: long tokens are masked.
export function createLogger(max = 800) {
  const buf = [];

  function mask(str) {
    return String(str)
      .replace(/([?&](?:api_key|apikey|token)=)[\w-]{8,}/gi, '$1***')
      .replace(/\b([\w-]{32,})\b/g, (m) => `${m.slice(0, 4)}…${m.slice(-4)}`);
  }

  function push(level, msg, extra) {
    const entry = {
      id: buf.length ? buf[buf.length - 1].id + 1 : 1,
      t: new Date().toISOString(),
      level,
      msg: mask(String(msg)),
      ...(extra !== undefined ? { extra: safeJson(mask(JSON.stringify(extra))) } : {}),
    };
    buf.push(entry);
    if (buf.length > max) buf.splice(0, buf.length - max);
    const line = `${entry.t} ${level.toUpperCase().padEnd(5)} ${entry.msg}`;
    if (level === 'error') console.error(line, extra ? safeExtra(extra) : '');
    else if (level === 'warn') console.warn(line, extra ? safeExtra(extra) : '');
    else console.log(line, extra ? safeExtra(extra) : '');
    return entry;
  }

  function safeExtra(extra) {
    try { return JSON.stringify(extra); } catch { return ''; }
  }

  function safeJson(str) {
    try { return JSON.parse(str); } catch { return String(str).slice(0, 500); }
  }

  return {
    log: (msg, extra) => push('info', msg, extra),
    warn: (msg, extra) => push('warn', msg, extra),
    error: (msg, extra) => push('error', msg, extra),
    debug: (msg, extra) => push('debug', msg, extra),
    entries({ since = 0, level = null, limit = 500 } = {}) {
      let out = buf.filter((e) => e.id > since);
      if (level && level !== 'all') out = out.filter((e) => e.level === level);
      return out.slice(-limit);
    },
    lastId: () => (buf.length ? buf[buf.length - 1].id : 0),
  };
}
