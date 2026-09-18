// Advarr — Настройки: табы как в *arr, dirty-state, test-кнопки, сохранение.
import { api } from '../api.js';
import { esc, toast } from '../ui.js';

let cfg = null;
let dirty = new Set();
let genresCache = { movie: null, tv: null };

const TABS = [
  ['seerr', 'Jellyseerr / Overseerr'],
  ['tmdb', 'TMDB'],
  ['schedule', 'Расписание'],
  ['selection', 'Выборка'],
  ['filters', 'Фильтры'],
  ['sources', 'Источники'],
  ['scoring', 'Скоринг'],
  ['ui', 'Интерфейс'],
];

export async function render(view) {
  cfg = await api('/api/v1/settings');
  view.innerHTML = `
    <h1>Настройки</h1>
    <div class="settings-layout">
      <div class="tabs" id="s-tabs">${TABS.map(([id, label], i) =>
        `<button data-tab="${id}" class="${i === 0 ? 'active' : ''}"><span>${label}</span><span class="dirty hidden"></span></button>`).join('')}</div>
      <div>
        <div class="tabs-forms" id="s-form"></div>
        <div class="save-bar">
          <span class="muted" id="s-dirty-note" style="margin-right:auto;align-self:center"></span>
          <button class="btn btn-accent" id="s-save">Сохранить всё</button>
        </div>
      </div>
    </div>
  `;
  view.querySelectorAll('#s-tabs button').forEach((b) => b.addEventListener('click', () => {
    view.querySelectorAll('#s-tabs button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    paintTab(b.dataset.tab);
  }));
  view.querySelector('#s-save').addEventListener('click', saveAll);
  paintTab('seerr');
}

function markDirty(id) {
  dirty.add(id);
  const b = document.querySelector(`#s-tabs button[data-tab="${id}"] .dirty`);
  b?.classList.remove('hidden');
  document.getElementById('s-dirty-note').textContent = 'Есть несохранённые изменения';
}

function paintTab(id) {
  const form = document.getElementById('s-form');
  form.innerHTML = {
    seerr: tabSeerr, tmdb: tabTmdb, schedule: tabSchedule, selection: tabSelection,
    filters: tabFilters, sources: tabSources, scoring: tabScoring, ui: tabUi,
  }[id](cfg);
  bind(form, id);
}

/* ---------- tabs ---------- */
const tabSeerr = (c) => `
  <h3>Jellyseerr / Overseerr</h3>
  <div class="form-grid">
    <div class="field"><label>Базовый URL</label>
      <input class="input" data-path="seerr.url" value="${esc(c.seerr.url)}" placeholder="http://192.168.1.50:5055">
      <div class="hint">Домашний адрес Jellyseerr/Overseerr без слэша на конце</div></div>
    <div class="field"><label>API-ключ</label>
      <div class="row"><input class="input" type="password" data-path="seerr.apiKey" value="${esc(c.seerr.apiKey)}" style="flex:1">
      <button class="btn btn-sm" data-toggle-pw>👁</button></div>
      <div class="hint">Настройки → Общие → API Key</div></div>
    <div class="field"><label>Сезоны сериалов</label>
      <select class="input" data-path="seerr.tvSeasons" style="width:260px">
        <option value="all" ${c.seerr.tvSeasons === 'all' ? 'selected' : ''}>Все сезоны</option>
        <option value="first" ${c.seerr.tvSeasons === 'first' ? 'selected' : ''}>Только 1-й сезон</option>
      </select></div>
    <div class="row"><button class="btn" id="t-seerr">Проверить</button><span class="test-result" id="r-seerr"></span></div>
  </div>`;

const tabTmdb = (c) => `
  <h3>TMDB</h3>
  <div class="form-grid">
    <div class="field"><label>API-ключ (v3)</label>
      <div class="row"><input class="input" type="password" data-path="tmdb.apiKey" value="${esc(c.tmdb.apiKey)}" style="flex:1">
      <button class="btn btn-sm" data-toggle-pw>👁</button></div>
      <div class="hint">themoviedb.org → Настройки → API (ключ типа v3). Маскированное значение меняется только если ввести новое.</div></div>
    <div class="field"><label>Язык контента</label>
      <select class="input" data-path="tmdb.language" style="width:260px">
        ${['ru-RU', 'en-US', 'uk-UA', 'de-DE', 'es-ES', 'ko-KR'].map((l) => `<option ${c.tmdb.language === l ? 'selected' : ''}>${l}</option>`).join('')}
      </select></div>
    <div class="field"><label>Регион</label>
      <input class="input input-sm" data-path="tmdb.region" value="${esc(c.tmdb.region)}" maxlength="2" placeholder="RU"></div>
    <div class="row"><button class="btn" id="t-tmdb">Проверить</button><span class="test-result" id="r-tmdb"></span></div>
  </div>`;

const tabSchedule = (c) => `
  <h3>Расписание</h3>
  <div class="form-grid">
    <div class="field"><label class="switch"><input type="checkbox" data-path="schedule.enabled" ${c.schedule.enabled ? 'checked' : ''}><span class="track"></span>Автопрогоны по таймеру</label></div>
    <div class="row">
      <div class="field"><label>Интервал, часов</label><input class="input input-sm" type="number" min="1" max="168" data-path="schedule.intervalHours" value="${c.schedule.intervalHours}"></div>
      <div class="field"><label>Джиттер, минут (±)</label><input class="input input-sm" type="number" min="0" max="720" data-path="schedule.jitterMinutes" value="${c.schedule.jitterMinutes}"></div>
    </div>
    <div class="field"><label class="switch"><input type="checkbox" data-path="schedule.runOnStart" ${c.schedule.runOnStart ? 'checked' : ''}><span class="track"></span>Прогон при старте контейнера</label></div>
  </div>`;

const tabSelection = (c) => `
  <h3>Выборка за прогон</h3>
  <div class="form-grid">
    <div class="field"><label>Типы медиа</label>
      <div class="row">
        <label class="switch"><input type="checkbox" data-mt="movie" ${c.selection.mediaTypes.includes('movie') ? 'checked' : ''}><span class="track"></span>🎬 Фильмы</label>
        <label class="switch"><input type="checkbox" data-mt="tv" ${c.selection.mediaTypes.includes('tv') ? 'checked' : ''}><span class="track"></span>📺 Сериалы</label>
      </div></div>
    <div class="row">
      <div class="field"><label>Фильмов за прогон</label><input class="input input-sm" type="number" min="0" max="50" data-path="selection.moviesPerRun" value="${c.selection.moviesPerRun}"></div>
      <div class="field"><label>Сериалов за прогон</label><input class="input input-sm" type="number" min="0" max="50" data-path="selection.showsPerRun" value="${c.selection.showsPerRun}"></div>
    </div>
  </div>`;

const tabFilters = (c) => `
  <h3>Фильтры шума</h3>
  <div class="form-grid">
    <div class="field"><label class="switch"><input type="checkbox" data-path="filters.includeAdult" ${c.filters.includeAdult ? 'checked' : ''}><span class="track"></span>Разрешить 18+</label></div>
    <div class="row">
      <div class="field"><label>Мин. голосов</label><input class="input input-sm" type="number" min="0" data-path="filters.minVotes" value="${c.filters.minVotes}"></div>
      <div class="field"><label>Мин. рейтинг</label><input class="input input-sm" type="number" min="0" max="10" step="0.1" data-path="filters.minRating" value="${c.filters.minRating}"></div>
    </div>
    <div class="row">
      <div class="field"><label>Год от (0 = без огранич.)</label><input class="input input-sm" type="number" min="0" max="2100" data-path="filters.yearFrom" value="${c.filters.yearFrom}"></div>
      <div class="field"><label>Год до (0 = сейчас)</label><input class="input input-sm" type="number" min="0" max="2100" data-path="filters.yearTo" value="${c.filters.yearTo}"></div>
    </div>
    <div class="field"><label>Языки оригинала (через запятую, пусто = любые)</label>
      <input class="input" data-path="filters.languages" data-csv value="${esc((c.filters.languages || []).join(', '))}" placeholder="en, ru, ko">
    </div>
    <div class="field"><label>Только жанры (пусто = любые)</label><div class="chips-select" data-genres="include">${renderGenreChips(c.filters.includeGenres)}</div></div>
    <div class="field"><label>Исключить жанры</label><div class="chips-select" data-genres="exclude">${renderGenreChips(c.filters.excludeGenres)}</div></div>
    <div class="field"><label class="switch"><input type="checkbox" data-path="filters.excludeInSeerr" ${c.filters.excludeInSeerr ? 'checked' : ''}><span class="track"></span>Скипать то, что уже запрошено в Seerr</label></div>
    <div class="field"><label class="switch"><input type="checkbox" data-path="filters.checkAvailability" ${c.filters.checkAvailability ? 'checked' : ''}><span class="track"></span>Скипать pending/available (медленнее, точнее)</label></div>
  </div>`;

const tabSources = (c) => `
  <h3>Источники TMDB</h3>
  <div class="form-grid">
    ${['trending_day', 'trending_week', 'popular', 'top_rated', 'now_playing', 'upcoming'].map((s) => `
      <div class="row" style="justify-content:space-between">
        <label class="switch"><input type="checkbox" data-src="${s}" ${c.sources[s].on ? 'checked' : ''}><span class="track"></span>${srcLabel(s)}</label>
        <div class="range-row" style="width:260px"><span class="muted">вес</span>
          <input type="range" min="0" max="1" step="0.1" data-srcw="${s}" value="${c.sources[s].weight}"><span class="range-val">${c.sources[s].weight.toFixed(1)}</span></div>
      </div>`).join('')}
    <div class="card" style="box-shadow:none">
      <div class="field"><label class="switch"><input type="checkbox" data-src="discover" ${c.sources.discover.on ? 'checked' : ''}><span class="track"></span>Discover (свои параметры)</label></div>
      <div class="field"><label>Параметры discover (querystring)</label>
        <input class="input" data-path="sources.discover.params" value="${esc(c.sources.discover.params)}" placeholder="with_genres=878&sort_by=popularity.desc">
        <div class="hint">Подставляется в /movie/discover и /tv/discover</div></div>
    </div>
    <div class="row">
      <div class="field"><label>Страниц на источник</label><input class="input input-sm" type="number" min="1" max="5" data-path="sources.pages" value="${c.sources.pages}"></div>
      <div class="field"><label>Элементов на страницу</label><input class="input input-sm" type="number" min="20" max="100" data-path="sources.perPage" value="${c.sources.perPage}"></div>
    </div>
  </div>`;

const tabScoring = (c) => `
  <h3>Скоринг</h3>
  <div class="form-grid">
    ${[['wRating', 'Рейтинг'], ['wPopularity', 'Популярность'], ['wVotes', 'Число голосов'], ['wFreshness', 'Свежесть'], ['wGenres', 'Любимые жанры']].map(([k, label]) => `
      <div class="field"><label>${label}</label>
        <div class="range-row"><input type="range" min="0" max="1" step="0.05" data-path="scoring.${k}" data-range value="${c.scoring[k]}">
        <span class="range-val" data-val="scoring.${k}">${c.scoring[k].toFixed(2)}</span></div></div>`).join('')}
    <div class="field"><label>Любимые жанры (добавляют до +${Math.round((c.scoring.wGenres || 0) * 100)} к score)</label>
      <div class="chips-select" data-genres="favorite">${renderGenreChips(c.scoring.favoriteGenres)}</div></div>
  </div>`;

const tabUi = (c) => `
  <h3>Интерфейс</h3>
  <div class="form-grid">
    <div class="field"><label>Кандидатов в превью</label><input class="input input-sm" type="number" min="6" max="60" data-path="ui.pageSize" value="${c.ui.pageSize}"></div>
  </div>`;

const SRC_LABELS = {
  trending_day: 'Тренды дня', trending_week: 'Тренды недели', popular: 'Популярное',
  top_rated: 'Топ рейтинга', now_playing: 'В кинотеатрах', upcoming: 'Ожидается',
};
const srcLabel = (s) => SRC_LABELS[s] || s;

function renderGenreChips(selected) {
  return `<div class="chips-select" data-genre-box>${genresLoadingHtml()}</div>
    <div style="display:none" data-selected='["${selected.join('","')}"]'></div>`;
}

function genresLoadingHtml() {
  return '<span class="muted">жанры загружаются…</span>';
}

/* ---------- binding ---------- */
function bind(form, tabId) {
  // inputs with data-path
  form.querySelectorAll('[data-path]').forEach((el) => {
    const path = el.dataset.path;
    if (el.dataset.range !== undefined || el.type === 'range') {
      el.addEventListener('input', () => {
        const valEl = form.querySelector(`[data-val="${path}"]`);
        if (valEl) valEl.textContent = Number(el.value).toFixed(2);
        setPath(path, Number(el.value));
        markDirty(tabId);
      });
    } else if (el.type === 'checkbox') {
      el.addEventListener('change', () => { setPath(path, el.checked); markDirty(tabId); });
    } else if (el.dataset.csv !== undefined) {
      el.addEventListener('input', () => {
        setPath(path, el.value.split(',').map((s) => s.trim()).filter(Boolean));
        markDirty(tabId);
      });
    } else {
      el.addEventListener('input', () => { setPath(path, el.value); markDirty(tabId); });
    }
  });

  // mediaTypes checkboxes
  form.querySelectorAll('[data-mt]').forEach((el) => el.addEventListener('change', () => {
    const set = new Set(cfg.selection.mediaTypes);
    el.checked ? set.add(el.dataset.mt) : set.delete(el.dataset.mt);
    cfg.selection.mediaTypes = [...set];
    markDirty(tabId);
  }));

  // sources toggles & weights
  form.querySelectorAll('[data-src]').forEach((el) => el.addEventListener('change', () => {
    cfg.sources[el.dataset.src].on = el.checked;
    markDirty(tabId);
  }));
  form.querySelectorAll('[data-srcw]').forEach((el) => el.addEventListener('input', () => {
    cfg.sources[el.dataset.srcw].weight = Number(el.value);
    const disp = el.parentElement.querySelector('.range-val');
    if (disp) disp.textContent = Number(el.value).toFixed(1);
    markDirty(tabId);
  }));

  // password visibility
  form.querySelectorAll('[data-toggle-pw]').forEach((b) => b.addEventListener('click', () => {
    const inp = b.parentElement.querySelector('input');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  }));

  // genre chip groups
  form.querySelectorAll('[data-genres]').forEach((box) => {
    const kind = box.dataset.genres;
    const selectedEl = box.querySelector('[data-selected]');
    const selected = JSON.parse(selectedEl.dataset.selected || '[]');
    loadGenres().then((list) => {
      const target = box.querySelector('[data-genre-box]');
      target.innerHTML = list.map((g) => `<span class="opt ${selected.includes(g.id) ? 'on' : ''}" data-gid="${g.id}">${esc(g.name)}</span>`).join('');
      target.querySelectorAll('.opt').forEach((opt) => opt.addEventListener('click', () => {
        const gid = Number(opt.dataset.gid);
        const arr = readGenreArray(kind);
        const i = arr.indexOf(gid);
        if (i >= 0) arr.splice(i, 1); else arr.push(gid);
        writeGenreArray(kind, arr);
        opt.classList.toggle('on');
        markDirty(tabId);
      }));
    });
  });

  // test buttons
  form.querySelector('#t-seerr')?.addEventListener('click', async () => {
    const r = form.querySelector('#r-seerr');
    r.textContent = 'проверяем…'; r.className = 'test-result';
    const res = await api('/api/v1/settings/test-seerr', { method: 'POST', body: { url: cfg.seerr.url, apiKey: cfg.seerr.apiKey } });
    r.textContent = res.message;
    r.className = `test-result ${res.ok ? 'test-ok' : 'test-fail'}`;
  });
  form.querySelector('#t-tmdb')?.addEventListener('click', async () => {
    const r = form.querySelector('#r-tmdb');
    r.textContent = 'проверяем…'; r.className = 'test-result';
    const res = await api('/api/v1/settings/test-tmdb', { method: 'POST', body: { apiKey: cfg.tmdb.apiKey, language: cfg.tmdb.language, region: cfg.tmdb.region } });
    r.textContent = res.message;
    r.className = `test-result ${res.ok ? 'test-ok' : 'test-fail'}`;
  });
}

function readGenreArray(kind) {
  return kind === 'include' ? cfg.filters.includeGenres
    : kind === 'exclude' ? cfg.filters.excludeGenres
    : cfg.scoring.favoriteGenres;
}
function writeGenreArray(kind, arr) {
  if (kind === 'include') cfg.filters.includeGenres = arr;
  else if (kind === 'exclude') cfg.filters.excludeGenres = arr;
  else cfg.scoring.favoriteGenres = arr;
}

function setPath(path, value) {
  const keys = path.split('.');
  let obj = cfg;
  for (let i = 0; i < keys.length - 1; i += 1) obj = obj[keys[i]];
  obj[keys[keys.length - 1]] = value;
}

async function loadGenres() {
  if (genresCache.movie) return genresCache.movie;
  try {
    const [m, tv] = await Promise.all([
      api('/api/v1/genres/movie', { silent: true }),
      api('/api/v1/genres/tv', { silent: true }),
    ]);
    const map = new Map();
    for (const g of [...(m.genres || []), ...(tv.genres || [])]) map.set(g.id, g);
    genresCache.movie = [...map.values()];
  } catch { genresCache.movie = []; }
  return genresCache.movie;
}

async function saveAll() {
  try {
    cfg = await api('/api/v1/settings', { method: 'PUT', body: cfg });
    dirty.clear();
    document.querySelectorAll('#s-tabs .dirty').forEach((d) => d.classList.add('hidden'));
    document.getElementById('s-dirty-note').textContent = '';
    toast('Настройки сохранены');
  } catch { /* toast already */ }
}
