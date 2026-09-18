// Advarr — История: что уже было запрошено, повторы, удаление.
import { api } from '../api.js';
import { esc, fmtDate, posterUrl, SOURCE_LABELS, toast } from '../ui.js';

let filter = { mediaType: '', search: '' };

export async function render(view) {
  view.innerHTML = `
    <div class="section-title" style="margin-top:0">
      <h1>История запросов</h1>
      <div class="row">
        <select class="input input-sm" id="h-type" style="width:150px">
          <option value="">Все типы</option>
          <option value="movie" ${filter.mediaType === 'movie' ? 'selected' : ''}>Фильмы</option>
          <option value="tv" ${filter.mediaType === 'tv' ? 'selected' : ''}>Сериалы</option>
        </select>
        <input class="input" id="h-search" placeholder="Поиск…" style="width:200px" value="${esc(filter.search)}">
      </div>
    </div>
    <div id="h-list"><div class="spin-wrap"><span class="spinner"></span>Загрузка…</div></div>
  `;
  view.querySelector('#h-type').addEventListener('change', (e) => { filter.mediaType = e.target.value; load(); });
  let t = null;
  view.querySelector('#h-search').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { filter.search = e.target.value.trim(); load(); }, 350);
  });
  await load();
}

async function load() {
  const box = document.getElementById('h-list');
  const q = new URLSearchParams({ limit: 100 });
  if (filter.mediaType) q.set('mediaType', filter.mediaType);
  if (filter.search) q.set('search', filter.search);
  let data;
  try {
    data = await api(`/api/v1/history?${q}`);
  } catch {
    box.innerHTML = '<div class="empty">Не удалось загрузить историю</div>';
    return;
  }
  if (!data.items.length) {
    box.innerHTML = '<div class="empty">История пуста — либо прогонов ещё не было, либо всё отфильтровано.</div>';
    return;
  }
  box.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr><th>Постер</th><th>Название</th><th>Тип</th><th>Score</th><th>Источники</th><th>Статус</th><th>Дата</th><th></th></tr></thead>
      <tbody>${data.items.map(row).join('')}</tbody>
    </table></div>
    <div class="muted" style="margin-top:10px">Всего: ${data.total}</div>
  `;
  box.querySelectorAll('[data-del]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('Удалить из истории? Advarr сможет запросить это повторно.')) return;
    await api(`/api/v1/history/${encodeURIComponent(btn.dataset.del)}`, { method: 'DELETE' });
    toast('Удалено из истории');
    load();
  }));
  box.querySelectorAll('[data-re]').forEach((btn) => btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await api('/api/v1/request', {
        method: 'POST',
        body: { mediaType: btn.dataset.type, tmdbId: Number(btn.dataset.id), title: btn.dataset.title, year: Number(btn.dataset.year), posterPath: btn.dataset.poster },
      });
      toast(`Повторный запрос: ${btn.dataset.title}`);
    } catch { btn.disabled = false; }
  }));
}

function row(h) {
  return `<tr>
    <td><img class="thumb" loading="lazy" src="${posterUrl(h.posterPath, 'w92')}" alt=""></td>
    <td><b>${esc(h.title)}</b> <span class="muted">${h.year || ''}</span></td>
    <td><span class="badge ${h.mediaType === 'tv' ? 'badge-tv' : 'badge-movie'}">${h.mediaType === 'tv' ? 'Сериал' : 'Фильм'}</span></td>
    <td>${h.score ?? '—'}</td>
    <td>${(h.sources || []).map((s) => `<span class="chip-mini">${SOURCE_LABELS[s] || s}</span>`).join(' ')}</td>
    <td class="${h.status === 'requested' ? 'status-ok' : 'status-err'}" title="${esc(h.error || '')}">${h.status === 'requested' ? 'Запрошено' : 'Ошибка'}</td>
    <td class="muted">${fmtDate(h.at)}</td>
    <td style="white-space:nowrap">
      <button class="btn btn-sm" data-re data-type="${h.mediaType}" data-id="${h.tmdbId}" data-title="${esc(h.title)}" data-year="${h.year || 0}" data-poster="${esc(h.posterPath)}">Повторить</button>
      <button class="btn btn-sm btn-danger" data-del="${esc(h.id)}">✕</button>
    </td>
  </tr>`;
}
