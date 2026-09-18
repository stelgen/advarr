// Advarr — Обзор: статистика, последний прогон, быстрые действия.
import { api } from '../api.js';
import { esc, fmtDate, toast } from '../ui.js';

export async function render(view, status) {
  const s = status || await api('/api/v1/status');
  const last = s.lastRun;
  const okRuns = last ? last.requested : '—';

  view.innerHTML = `
    <h1>Обзор</h1>
    <div class="stats">
      <div class="stat"><div class="label">Всего в истории</div><div class="value">${s.historyCount}</div><div class="sub">фильмов и сериалов</div></div>
      <div class="stat"><div class="label">Последний прогон</div><div class="value">${okRuns}</div><div class="sub">${last ? esc(fmtDate(last.startedAt)) : 'ещё не было'}</div></div>
      <div class="stat"><div class="label">Следующий запуск</div><div class="value">${s.running ? '⟳ идёт' : 'по расписанию'}</div><div class="sub">${s.scheduleInfo || ''}</div></div>
      <div class="stat"><div class="label">Интеграции</div><div class="value">${(s.tmdb.connected === true ? 'TMDB ✓' : 'TMDB ✗')} ${(s.seerr.connected ? '· Seerr ✓' : '· Seerr ✗')}</div><div class="sub">статус подключений</div></div>
    </div>

    <div class="card">
      <h3>Быстрые действия</h3>
      <div class="row">
        <button class="btn btn-accent" id="ov-run">▶ Запустить прогон</button>
        <button class="btn" id="ov-dry">Пробный прогон (dry-run)</button>
        <a class="btn btn-ghost" href="#/discovery">К подборке →</a>
      </div>
    </div>

    <div class="section-title"><h3>Последний прогон</h3></div>
    ${last ? lastRunCard(last) : '<div class="empty">Пока пусто — настрой TMDB и Seerr в «Настройках», затем запусти прогон.</div>'}
  `;

  view.querySelector('#ov-run')?.addEventListener('click', async () => {
    await api('/api/v1/run', { method: 'POST', body: {} });
    toast('Прогон запущен');
  });
  view.querySelector('#ov-dry')?.addEventListener('click', async () => {
    toast('Пробный прогон выполняется…');
    const { report } = await api('/api/v1/run', { method: 'POST', body: { dry: true } });
    toast(`Кандидатов: ${report.items.length}, прошло фильтры: ${report.passed} из ${report.scanned}`);
  });
}

function lastRunCard(r) {
  const rows = r.errors?.length ? `
    <div class="field" style="margin-top:12px"><label>Ошибки</label>
      <div class="muted" style="font-size:13px">${r.errors.map((e) => esc(e)).join('<br>')}</div>
    </div>` : '';
  return `
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <div class="muted">${esc(fmtDate(r.startedAt))} → ${esc(fmtDate(r.finishedAt))} ${r.dry ? '· <b>dry-run</b>' : ''}</div>
        <div class="row">
          <span class="chip chip-ok">scanned ${r.scanned}</span>
          <span class="chip">passed ${r.passed}</span>
          <span class="chip">skipped ${r.skipped}</span>
          <span class="chip chip-ok">requested ${r.requested}</span>
          ${r.failed ? `<span class="chip chip-err">failed ${r.failed}</span>` : ''}
        </div>
      </div>
      ${(r.titles || []).length ? `<div class="row" style="margin-top:12px">${r.titles.map((t) => `<span class="chip-mini">${esc(t)}</span>`).join('')}</div>` : ''}
      ${rows}
    </div>`;
}
