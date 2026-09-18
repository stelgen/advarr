// Advarr — Подборка: dry-run превью кандидатов, карточки с постерами.
import { api } from '../api.js';
import { esc, openModal, closeModal, scoreClass, posterUrl, SOURCE_LABELS, toast } from '../ui.js';

const genreCache = {};

async function genres(type) {
  if (!genreCache[type]) {
    try {
      const { genres: g } = await api(`/api/v1/genres/${type}`, { silent: true });
      genreCache[type] = Object.fromEntries(g.map((x) => [x.id, x.name]));
    } catch { genreCache[type] = {}; }
  }
  return genreCache[type];
}

export async function render(view) {
  view.innerHTML = `
    <div class="section-title" style="margin-top:0">
      <h1>Подборка</h1>
      <div class="row">
        <span class="muted">dry-run превью — запросы создаются кнопкой или по таймеру</span>
        <button class="btn btn-accent" id="d-refresh">⟳ Обновить подборку</button>
      </div>
    </div>
    <div id="d-grid"><div class="spin-wrap"><span class="spinner"></span>Собираем кандидатов из TMDB…</div></div>
  `;
  view.querySelector('#d-refresh').addEventListener('click', load);
  await load();
}

async function load() {
  const grid = document.getElementById('d-grid');
  grid.innerHTML = '<div class="spin-wrap"><span class="spinner"></span>Собираем кандидатов из TMDB…</div>';
  let report;
  try {
    ({ report } = await api('/api/v1/discover/preview?limit=24'));
  } catch (err) {
    grid.innerHTML = `<div class="empty">${esc(err.message)}<br><br>Проверь настройки TMDB.</div>`;
    return;
  }
  const items = report.items || [];
  if (!items.length) {
    grid.innerHTML = `<div class="empty">Кандидатов нет. Scanned: ${report.scanned}, passed: ${report.passed}, skipped: ${report.skipped}.
      ${report.errors?.length ? `<br><br>Ошибки: ${report.errors.map(esc).join('; ')}` : ''}</div>`;
    return;
  }
  grid.innerHTML = `<div class="grid-cards">${items.map(card).join('')}</div>`;

  grid.querySelectorAll('[data-req]').forEach((btn) => btn.addEventListener('click', async () => {
    const { type, id, title } = btn.dataset;
    btn.disabled = true;
    try {
      await api('/api/v1/request', { method: 'POST', body: { mediaType: type, tmdbId: Number(id), title } });
      toast(`Запрос создан: ${title}`);
      btn.textContent = '✓ Запрошено';
    } catch { btn.disabled = false; }
  }));
  grid.querySelectorAll('[data-more]').forEach((btn) => btn.addEventListener('click', () => {
    const item = items.find((c) => `${c.mediaType}:${c.id}` === btn.dataset.more);
    if (item) showDetails(item);
  }));
}

function card(c) {
  const type = c.mediaType === 'tv' ? 'Сериал' : 'Фильм';
  return `
  <div class="pcard">
    <img class="poster" loading="lazy" src="${posterUrl(c.posterPath)}" alt="${esc(c.title)}">
    <div class="score ${scoreClass(c.score)}">${c.score}</div>
    <div class="pcard-body">
      <div class="title" title="${esc(c.overview)}">${esc(c.title)}</div>
      <div class="meta">
        <span class="badge ${c.mediaType === 'tv' ? 'badge-tv' : 'badge-movie'}">${type}</span>
        <span class="muted" style="font-size:12px">${c.year || '—'}</span>
      </div>
      <div class="meta">
        ${c.sources.map((s) => `<span class="chip-mini">${SOURCE_LABELS[s] || s}</span>`).join('')}
      </div>
    </div>
    <div class="pcard-actions">
      <button class="btn btn-accent" data-req data-type="${c.mediaType}" data-id="${c.id}" data-title="${esc(c.title)}">Запросить</button>
      <button class="btn" data-more="${c.mediaType}:${c.id}">Детали</button>
    </div>
  </div>`;
}

async function showDetails(c) {
  const g = await genres(c.mediaType);
  const names = c.genreIds.map((id) => g[id]).filter(Boolean);
  openModal(`
    <div class="modal-head">
      <h3 style="margin:0">${esc(c.title)} <span class="muted" style="font-weight:400">(${c.year || '—'})</span></h3>
      <button class="modal-x" type="button">✕</button>
    </div>
    <div class="detail">
      <img src="${posterUrl(c.posterPath, 'w500')}" alt="${esc(c.title)}">
      <div>
        <div class="kv">
          <b>Рейтинг</b><span>⭐ ${c.voteAverage} (${c.voteCount} голосов)</span>
          <b>Advarr score</b><span><span class="score ${scoreClass(c.score)}" style="position:static;display:inline-flex;width:30px;height:30px;min-width:30px">${c.score}</span></span>
          <b>Популярность</b><span>${Math.round(c.popularity)}</span>
          <b>Язык</b><span>${esc(c.originalLanguage)}</span>
          <b>Жанры</b><span>${names.length ? names.map(esc).join(', ') : '—'}</span>
          <b>Источники</b><span>${c.sources.map((s) => SOURCE_LABELS[s] || s).join(', ')}</span>
          <b>TMDB</b><span><a href="https://www.themoviedb.org/${c.mediaType}/${c.id}" target="_blank" rel="noopener noreferrer">открыть ↗</a></span>
        </div>
        <p class="muted" style="font-size:13px">${esc(c.overview || 'Описание отсутствует.')}</p>
        <button class="btn btn-accent" data-req data-type="${c.mediaType}" data-id="${c.id}" data-title="${esc(c.title)}">Запросить в Seerr</button>
      </div>
    </div>
  `);
  document.querySelector('#modal .modal-x')?.addEventListener('click', closeModal);
  document.querySelectorAll('#modal [data-req]').forEach((btn) => btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await api('/api/v1/request', { method: 'POST', body: { mediaType: btn.dataset.type, tmdbId: Number(btn.dataset.id), title: btn.dataset.title } });
      toast(`Запрос создан: ${btn.dataset.title}`);
    } catch { btn.disabled = false; }
  }));
}
