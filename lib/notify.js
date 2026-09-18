// Advarr — run notifications: Telegram + generic webhook (Discord-compatible).
// Providers live in config.notify.providers; secrets masked in API responses.
const TELEGRAM_TEXT_LIMIT = 3900;
const WEBHOOK_TEXT_LIMIT = 1900;

export function createNotify({ configStore, fetchImpl = globalThis.fetch, logger }) {
  const providers = () => configStore.data.notify?.providers || [];

  function buildRunMessage(report) {
    const type = report.dry ? 'DRY-RUN' : 'Прогон';
    const lines = [];
    const ok = report.requested > 0 && report.failed === 0;
    lines.push(ok
      ? `📡 Advarr: ${type} завершён — запрошено ${report.requested}:`
      : `⚠️ Advarr: ${type} завершён с проблемами (запрошено ${report.requested}, ошибок ${report.failed}):`);
    for (const c of (report.items || [])) {
      const mark = c.status === 'requested' ? '✅' : c.status === 'failed' ? '❌' : '•';
      lines.push(`${mark} ${c.mediaType === 'tv' ? 'Сериал' : 'Фильм'}: ${c.title}${c.year ? ` (${c.year})` : ''}${c.error ? ` — ${c.error}` : ''}`);
    }
    if (!(report.items || []).length) lines.push('(кандидатов не было)');
    return { ok, text: lines.join('\n') };
  }

  async function sendTelegram(p, text) {
    const t = p.telegram || {};
    const url = `https://api.telegram.org/bot${t.botToken}/sendMessage`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: t.chatId, text: text.slice(0, TELEGRAM_TEXT_LIMIT), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(12000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Telegram ${res.status}: ${body?.description || res.statusText}`);
    return body;
  }

  async function sendWebhook(p, text, event) {
    const res = await fetchImpl(p.webhook?.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `content` → Discord-compatible; extra fields for generic consumers
      body: JSON.stringify({ content: text.slice(0, WEBHOOK_TEXT_LIMIT), event, ts: new Date().toISOString() }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`Webhook ${res.status}: ${res.statusText}`);
    return null;
  }

  async function send(provider, text, event = 'test') {
    if (provider.type === 'telegram') return sendTelegram(provider, text);
    if (provider.type === 'webhook') return sendWebhook(provider, text, event);
    throw new Error(`unknown provider type: ${provider.type}`);
  }

  async function testProvider(provider) {
    await send(provider, 'Тестовое уведомление Advarr ✅', 'test');
    return { ok: true };
  }

  /** called by engine after every real run */
  async function runFinished(report) {
    for (const p of providers()) {
      if (!p.enabled) continue;
      const { ok, text } = buildRunMessage(report);
      try {
        if (p.onRunFailed && !ok && report.failed > 0) {
          await send(p, text, 'run_failed');
        } else if (p.onRunCompleted && report.requested > 0) {
          await send(p, text, 'run_completed');
        }
      } catch (err) {
        logger.error(`notify "${p.name || p.type}" failed: ${err.message}`);
      }
    }
  }

  return { runFinished, testProvider, buildRunMessage };
}
