// Advarr — Настройки: табы в Radarr-порядке, dirty-state, test-кнопки, сохранение.
import { api, getApiKey } from '../api.js';
import { esc, toast, fmtDate } from '../ui.js';

let cfg = null;
let dirty = new Set();
let genresCache = { movie: null, tv: null };

const TABS = [
  ['seerr', 'Media Server'],
  ['tmdb', 'TMDB'],
  ['schedule', 'Расписание'],
  ['selection', 'Выборка'],
  ['filters', 'Фильтры'],
  ['sources', 'Источники'],
  ['scoring', 'Скоринг'],
  ['metadata', 'Метаданные'],
  ['notify', 'Уведомления'],
  ['backups', 'Бэкапы'],
  ['ui', 'Интерфейс'],
  ['general', 'Общие'],
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
    filters: tabFilters, sources: tabSources, scoring: tabScoring, metadata: tabMetadata,
    notify: tabNotify, backups: tabBackups, ui: tabUi, general: tabGeneral,
  }[id](cfg);
  bind(form, id);
  if (id === 'notify') bindNotify(form);
  if (id === 'backups') loadBackups(form);
  if (id === 'general') bindGeneral(form);
  if (id === 'metadata') bindMetadata(form);
}

/* ---------- существующие табы ---------- */
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
      <div class="field"><label>Ретрай провалов через, дней (0 = никогда)</label><input class="input input-sm" type="number" min="0" max="365" data-path="schedule.retryCooldownDays" value="${c.schedule.retryCooldownDays ?? 7}"></div>
    </div>
    <div class="field"><label class="switch"><input type="checkbox" data-path="schedule.runOnStart" ${c.schedule.runOnStart ? 'checked' : ''}><span class="track"></span>Прогон при старте контейнера</label></div>
  </div>`;

const tabSelection = (c) => `
  <h3>Выборка за прогон</h3>
  <div class="form-grid">
    <div class="field"><label>Типы медиа</label>
      <div class="row">
        <label class="switch"><input type="checkbox" data-mt="movie" ${c.selection.mediaTypes.includes('movie') ? 'checked' : ''}><span class="track"></span>Фильмы</label>
        <label class="switch"><input type="checkbox" data-mt="tv" ${c.selection.mediaTypes.includes('tv') ? 'checked' : ''}><span class="track"></span>Сериалы</label>
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
          <input type="range" min="0" max="1" step="0.1" data-srcw="${s}" value="${c.sources[s].weight}"><span class="range-val">${Number(c.sources[s].weight).toFixed(1)}</span></div>
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
        <span class="range-val" data-val="scoring.${k}">${Number(c.scoring[k]).toFixed(2)}</span></div></div>`).join('')}
    <div class="field"><label>Любимые жанры</label>
      <div class="chips-select" data-genres="favorite">${renderGenreChips(c.scoring.favoriteGenres)}</div></div>
  </div>`;

/* ---------- NEW: Метаданные (обогащение) ---------- */
const ENRICH_PROVIDERS = [
  ['tmdb', 'TMDB (ваш ключ; актёры, режиссёры, external IDs)'],
  ['imdb', 'IMDb suggestion (публичный, без ключа; топ-актёры)'],
  ['tvdb', 'TheTVDB v4 (их ключ + PIN; сериалы — актёры)'],
];

function tabMetadata(c) {
  const e = c.enrich;
  return `
  <h3>Метаданные (обогащение)</h3>
  <div class="muted" style="margin-bottom:12px">Расширяет карточку «Подробнее» в Подборке: актёры, режиссёры, внешние ID.
  Провайдеры опрашиваются в порядке приоритета; последующие дозаполняют только недостающие поля.
  Работает даже без ключа TMDB — достаточно публичного провайдера.</div>
  <div class="form-grid">
    <div class="field"><label class="switch"><input type="checkbox" data-path="enrich.enabled" ${e.enabled ? 'checked' : ''}><span class="track"></span>Включить обогащение</label></div>
    <div class="field"><label>Провайдеры (приоритет сверху вниз)</label>
      <div class="form-grid" id="e-providers">
        ${ENRICH_PROVIDERS.map(([id, label]) => `
          <label class="switch"><input type="checkbox" data-ep="${id}" ${e.providers.includes(id) ? 'checked' : ''}><span class="track"></span>${label}</label>`).join('')}
      </div></div>
    <div class="card" style="box-shadow:none">
      <h3 style="margin-top:0">TheTVDB v4</h3>
      <div class="row">
        <div class="field"><label>API-ключ</label>
          <input class="input" type="password" data-path="enrich.tvdb.apiKey" value="${esc(e.tvdb.apiKey)}"></div>
        <div class="field"><label>PIN (если ключ подписочный)</label>
          <input class="input" type="password" data-path="enrich.tvdb.pin" value="${esc(e.tvdb.pin)}"></div>
      </div>
      <div class="hint">thetvdb.com → API Access. Ключ бесплатный, токен живёт месяц.</div>
    </div>
    <div class="row">
      <div class="field"><label>Пробный запрос</label>
        <input class="input" id="e-test-title" value="Inception" style="width:240px"></div>
      <button class="btn" id="e-test" style="align-self:flex-end">Проверить обогащение</button>
      <span class="test-result" id="e-result"></span>
    </div>
  </div>`;
}

function bindMetadata(form) {
  const canon = ENRICH_PROVIDERS.map(([id]) => id);
  form.querySelectorAll('[data-ep]').forEach((el) => el.addEventListener('change', () => {
    const set = new Set(cfg.enrich.providers.filter((p) => canon.includes(p)));
    el.checked ? set.add(el.dataset.ep) : set.delete(el.dataset.ep);
    cfg.enrich.providers = canon.filter((p) => set.has(p));
    markDirty('metadata');
  }));
  form.querySelector('#e-test').addEventListener('click', async () => {
    const r = form.querySelector('#e-result');
    r.textContent = 'опрашиваем провайдеры…'; r.className = 'test-result';
    const res = await api('/api/v1/enrich/test', { method: 'POST', body: { provider: 'imdb', title: form.querySelector('#e-test-title').value.trim(), mediaType: 'movie', year: 2010 } });
    r.textContent = res.ok ? `Провайдер ответил: актёров — ${res.castCount}${res.imdbId ? `, ID ${res.imdbId}` : ''}` : (res.message || 'ошибка');
    r.className = `test-result ${res.ok ? 'test-ok' : 'test-fail'}`;
  });
}

/* ---------- NEW: Уведомления ---------- */
const PROVIDER_TYPES = { telegram: 'Telegram', webhook: 'Webhook (Discord/ntfy)' };

function tabNotify(c) {
  const list = c.notify?.providers || [];
  return `
    <div class="row" style="justify-content:space-between">
      <h3>Уведомления</h3>
      <button class="btn btn-accent" id="n-add">+ Добавить</button>
    </div>
    <div class="muted" style="margin-bottom:12px">Сводка после каждого прогона: что запрошено, что упало.</div>
    <div id="n-list">${notifyListHtml(list)}</div>
    <div id="n-editor" class="card hidden" style="box-shadow:none"></div>`;
}

function notifyListHtml(list) {
  if (!list.length) return '<div class="empty">Провайдеров нет — добавь Telegram или Webhook.</div>';
  return `
    <div class="table-wrap"><table>
      <thead><tr><th>Имя</th><th>Тип</th><th>Триггеры</th><th>Вкл</th><th></th></tr></thead>
      <tbody>${list.map((p) => `
        <tr>
          <td><b>${esc(p.name || '—')}</b></td>
          <td>${PROVIDER_TYPES[p.type] || esc(p.type)}</td>
          <td>${[p.onRunCompleted ? 'Завершён' : '', p.onRunFailed ? 'С ошибками' : ''].filter(Boolean).map((x) => `<span class="chip-mini">${x}</span>`).join(' ') || '—'}</td>
          <td><label class="switch"><input type="checkbox" data-npen="${esc(p.id)}" ${p.enabled ? 'checked' : ''}><span class="track"></span></label></td>
          <td style="white-space:nowrap">
            <button class="btn btn-sm" data-ntest="${esc(p.id)}">Тест</button>
            <button class="btn btn-sm" data-nedit="${esc(p.id)}">Изменить</button>
            <button class="btn btn-sm btn-danger" data-ndel="${esc(p.id)}">✕</button>
          </td>
        </tr>`).join('')}</tbody>
    </table></div>`;
}

function providerEditorForm(p) {
  return `
    <h3 style="margin-top:0">${p.id ? 'Изменить' : 'Добавить'} провайдера</h3>
    <div class="form-grid">
      <div class="row">
        <div class="field"><label>Имя</label><input class="input" id="nf-name" value="${esc(p.name || '')}" placeholder="Моя телега"></div>
        <div class="field"><label>Тип</label>
          <select class="input" id="nf-type" style="width:220px">
            ${Object.entries(PROVIDER_TYPES).map(([k, v]) => `<option value="${k}" ${p.type === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select></div>
        <div class="field"><label>Включён</label>
          <label class="switch"><input type="checkbox" id="nf-enabled" ${p.enabled ? 'checked' : ''}><span class="track"></span></label></div>
      </div>
      <div class="row">
        <div class="field"><label class="switch"><input type="checkbox" id="nf-onrun" ${p.onRunCompleted ? 'checked' : ''}><span class="track"></span>Триггер: прогон завершён</label></div>
        <div class="field"><label class="switch"><input type="checkbox" id="nf-onfail" ${p.onRunFailed ? 'checked' : ''}><span class="track"></span>Триггер: есть ошибки</label></div>
      </div>
      <div id="nf-tg" class="form-grid">
        <div class="field"><label>Bot Token</label>
          <input class="input" type="password" id="nf-token" value="${esc(p.telegram?.botToken || '')}" placeholder="123456:ABC-DEF...">
          <div class="hint">@BotFather → /newbot</div></div>
        <div class="field"><label>Chat ID</label>
          <input class="input" id="nf-chatid" value="${esc(p.telegram?.chatId || '')}" placeholder="-1001234567890">
          <div class="hint">@userinfobot или id чата</div></div>
      </div>
      <div id="nf-wh" class="form-grid">
        <div class="field"><label>Webhook URL</label>
          <input class="input" id="nf-url" value="${esc(p.webhook?.url || '')}" placeholder="https://discord.com/api/webhooks/...">
          <div class="hint">POST JSON {content, event} — Discord/ntfy/generic</div></div>
      </div>
      <div class="row"><button class="btn" id="nf-test">Тест</button><span class="test-result" id="nf-result"></span></div>
      <div class="row-end">
        <button class="btn" id="nf-cancel">Отмена</button>
        <button class="btn btn-accent" id="nf-save">Готово</button>
      </div>
    </div>`;
}

function bindNotify(form) {
  const refresh = () => { form.querySelector('#n-list').innerHTML = notifyListHtml(cfg.notify.providers || []); hookList(); };

  function hookList() {
    form.querySelectorAll('[data-npen]').forEach((el) => el.addEventListener('change', () => {
      const p = cfg.notify.providers.find((x) => x.id === el.dataset.npen);
      if (p) p.enabled = el.checked;
      markDirty('notify');
    }));
    form.querySelectorAll('[data-ntest]').forEach((b) => b.addEventListener('click', async () => {
      const p = cfg.notify.providers.find((x) => x.id === b.dataset.ntest);
      if (!p) return;
      b.disabled = true;
      const res = await api('/api/v1/notify/test', { method: 'POST', body: { provider: structuredClone(p) } });
      b.disabled = false;
      toast(res.message, res.ok ? 'ok' : 'err');
    }));
    form.querySelectorAll('[data-nedit]').forEach((b) => b.addEventListener('click', () => {
      const p = cfg.notify.providers.find((x) => x.id === b.dataset.nedit);
      if (p) openEditor(structuredClone(p));
    }));
    form.querySelectorAll('[data-ndel]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Удалить провайдера?')) return;
      cfg.notify.providers = cfg.notify.providers.filter((x) => x.id !== b.dataset.ndel);
      markDirty('notify');
      refresh();
    }));
  }

  function openEditor(p) {
    const ed = form.querySelector('#n-editor');
    ed.classList.remove('hidden');
    ed.innerHTML = providerEditorForm(p);
    const typeSel = ed.querySelector('#nf-type');
    const syncType = () => {
      ed.querySelector('#nf-tg').classList.toggle('hidden', typeSel.value !== 'telegram');
      ed.querySelector('#nf-wh').classList.toggle('hidden', typeSel.value !== 'webhook');
    };
    typeSel.addEventListener('change', syncType);
    syncType();

    ed.querySelector('#nf-cancel').addEventListener('click', () => ed.classList.add('hidden'));
    ed.querySelector('#nf-save').addEventListener('click', () => {
      const out = {
        ...p,
        name: ed.querySelector('#nf-name').value.trim() || 'Без имени',
        type: typeSel.value,
        enabled: ed.querySelector('#nf-enabled').checked,
        onRunCompleted: ed.querySelector('#nf-onrun').checked,
        onRunFailed: ed.querySelector('#nf-onfail').checked,
        telegram: { botToken: ed.querySelector('#nf-token')?.value || (p.telegram?.botToken || ''), chatId: ed.querySelector('#nf-chatid')?.value || (p.telegram?.chatId || '') },
        webhook: { url: ed.querySelector('#nf-url')?.value || (p.webhook?.url || '') },
      };
      if (!out.id) out.id = `p${Date.now()}`;
      const i = cfg.notify.providers.findIndex((x) => x.id === out.id);
      if (i >= 0) cfg.notify.providers[i] = out; else cfg.notify.providers.push(out);
      markDirty('notify');
      ed.classList.add('hidden');
      refresh();
      toast('Провайдер сохранён локально — не забудь «Сохранить всё»');
    });
    ed.querySelector('#nf-test').addEventListener('click', async () => {
      const r = ed.querySelector('#nf-result');
      r.textContent = 'отправляем…'; r.className = 'test-result';
      const probe = {
        ...p,
        name: ed.querySelector('#nf-name').value,
        type: typeSel.value,
        telegram: { botToken: ed.querySelector('#nf-token')?.value || (p.telegram?.botToken || ''), chatId: ed.querySelector('#nf-chatid')?.value || (p.telegram?.chatId || '') },
        webhook: { url: ed.querySelector('#nf-url')?.value || (p.webhook?.url || '') },
      };
      const res = await api('/api/v1/notify/test', { method: 'POST', body: { provider: probe } });
      r.textContent = res.message;
      r.className = `test-result ${res.ok ? 'test-ok' : 'test-fail'}`;
    });
  }

  form.querySelector('#n-add').addEventListener('click', () => {
    openEditor({ name: '', type: 'telegram', enabled: true, onRunCompleted: true, onRunFailed: true, telegram: { botToken: '', chatId: '' }, webhook: { url: '' } });
  });
  hookList();
}

/* ---------- NEW: Бэкапы ---------- */
function tabBackups(c) {
  return `
    <div class="row" style="justify-content:space-between">
      <h3>Бэкапы</h3>
      <button class="btn btn-accent" id="b-now">Сделать бэкап</button>
    </div>
    <div class="muted" style="margin-bottom:12px">Снапшот настроек, истории и прогонов. Восстановление применяется на лету, без перезапуска. Хранится максимум ${c.backups?.maxKeep ?? 30} шт.</div>
    <div id="b-list"><div class="spin-wrap"><span class="spinner"></span>Загрузка…</div></div>`;
}

async function loadBackups(form) {
  const box = form.querySelector('#b-list');
  let data;
  try {
    data = await api('/api/v1/backup');
  } catch {
    box.innerHTML = '<div class="empty">Не удалось загрузить список</div>';
    return;
  }
  if (!data.items.length) { box.innerHTML = '<div class="empty">Бэкапов ещё нет.</div>'; return; }
  box.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr><th>Имя</th><th>Размер</th><th>Изменён</th><th></th></tr></thead>
      <tbody>${data.items.map((b) => `
        <tr>
          <td><b>${esc(b.name)}</b></td>
          <td>${(b.size / 1024).toFixed(1)} KB</td>
          <td class="muted">${fmtDate(b.modifiedAt)}</td>
          <td style="white-space:nowrap">
            <button class="btn btn-sm" data-bres="${esc(b.id)}">Восстановить</button>
            <a class="btn btn-sm" data-bdl="${esc(b.id)}" href="/api/v1/backup/${encodeURIComponent(b.id)}/download${getApiKey() ? `?apikey=${encodeURIComponent(getApiKey())}` : ''}">Скачать</a>
            <button class="btn btn-sm btn-danger" data-bdel="${esc(b.id)}">✕</button>
          </td>
        </tr>`).join('')}</tbody>
    </table></div>`;

  form.querySelector('#b-now').onclick = async () => {
    await api('/api/v1/backup', { method: 'POST', body: {} });
    toast('Бэкап создан');
    loadBackups(form);
  };
  box.querySelectorAll('[data-bres]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Восстановить бэкап? Текущие настройки/история будут заменены.')) return;
    await api(`/api/v1/backup/${encodeURIComponent(b.dataset.bres)}/restore`, { method: 'POST', body: {} });
    toast('Бэкап восстановлен — настройки применены');
    cfg = await api('/api/v1/settings');
    loadBackups(form);
  }));
  box.querySelectorAll('[data-bdel]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Удалить бэкап?')) return;
    await api(`/api/v1/backup/${encodeURIComponent(b.dataset.bdel)}`, { method: 'DELETE' });
    loadBackups(form);
  }));
}

/* ---------- NEW: Интерфейс ---------- */
const tabUi = (c) => `
  <h3>Интерфейс</h3>
  <div class="form-grid">
    <div class="field"><label>Кандидатов в превью</label><input class="input input-sm" type="number" min="6" max="60" data-path="ui.pageSize" value="${c.ui.pageSize}"></div>
    <div class="field"><label>Плотность сетки постеров</label>
      <select class="input" data-path="ui.gridDensity" style="width:260px">
        <option value="normal" ${c.ui.gridDensity === 'normal' ? 'selected' : ''}>Обычная</option>
        <option value="compact" ${c.ui.gridDensity === 'compact' ? 'selected' : ''}>Компактная</option>
      </select></div>
    <div class="field"><label class="switch"><input type="checkbox" data-path="ui.showScores" ${c.ui.showScores ? 'checked' : ''}><span class="track"></span>Показывать score-бейджи</label></div>
  </div>`;

/* ---------- NEW: Общие (как General в Radarr) ---------- */
function tabGeneral(c) {
  const g = c.general;
  const a = g.authentication;
  return `
  <h3>Общие</h3>
  <div class="form-grid">
    <div class="card" style="box-shadow:none">
      <h3 style="margin-top:0">Хост и порт</h3>
      <div class="row">
        <div class="field"><label>Адрес привязки</label>
          <input class="input" data-path="general.host" value="${esc(g.host)}" placeholder="0.0.0.0"></div>
        <div class="field"><label>Порт</label>
          <input class="input input-sm" type="number" min="1" max="65535" data-path="general.port" value="${g.port}"></div>
      </div>
      <div class="hint">Применяется сразу после сохранения. В Docker порт должен совпадать с опубликованным (ports:), иначе контейнер будет отвечать на старом.</div>
    </div>

    <div class="card" style="box-shadow:none">
      <h3 style="margin-top:0">Безопасность</h3>
      <div class="field"><label>Аутентификация</label>
        <select class="input" data-path="general.authentication.method" id="g-auth" style="width:260px">
          <option value="none" ${a.method === 'none' ? 'selected' : ''}>Нет</option>
          <option value="basic" ${a.method === 'basic' ? 'selected' : ''}>Basic (логин + пароль)</option>
          <option value="apiKey" ${a.method === 'apiKey' ? 'selected' : ''}>API-ключ</option>
        </select></div>
      <div class="row" id="g-basic" class="row">
        <div class="field"><label>Имя пользователя</label>
          <input class="input" data-path="general.authentication.username" value="${esc(a.username)}"></div>
        <div class="field"><label>Пароль</label>
          <input class="input" type="password" data-path="general.authentication.password" value="${esc(a.password)}"></div>
      </div>
      <div class="row" id="g-apikey-row">
        <div class="field" style="flex:1"><label>API-ключ (X-Api-Key / ?apikey=)</label>
          <input class="input" type="password" data-path="general.authentication.apiKey" value="${esc(a.apiKey)}"></div>
        <button class="btn" id="g-genkey" style="align-self:flex-end">Сгенерировать</button>
      </div>
      <div class="hint">ENV-переменные BASIC_AUTH_* / ADVARR_API_KEY засеиваются только при первом старте; дальше — как здесь.</div>
    </div>

    <div class="card" style="box-shadow:none">
      <h3 style="margin-top:0">Прокси</h3>
      <div class="field"><label class="switch"><input type="checkbox" data-path="general.proxy.enabled" ${g.proxy.enabled ? 'checked' : ''}><span class="track"></span>Использовать прокси для исходящих (TMDB, Seerr, Telegram)</label></div>
      <div class="row">
        <div class="field"><label>Хост</label><input class="input" data-path="general.proxy.host" value="${esc(g.proxy.host)}" placeholder="proxy.local"></div>
        <div class="field"><label>Порт</label><input class="input input-sm" type="number" min="1" max="65535" data-path="general.proxy.port" value="${g.proxy.port}"></div>
      </div>
      <div class="field"><label class="switch"><input type="checkbox" data-path="general.proxy.httpsOnly" ${g.proxy.httpsOnly ? 'checked' : ''}><span class="track"></span>Проксировать только HTTPS-запросы</label></div>
      <div class="row">
        <div class="field"><label>Имя пользователя</label><input class="input" data-path="general.proxy.username" value="${esc(g.proxy.username)}"></div>
        <div class="field"><label>Пароль</label><input class="input" type="password" data-path="general.proxy.password" value="${esc(g.proxy.password)}"></div>
      </div>
      <div class="field"><label>Обход прокси (через запятую: хосты, .суффиксы, IPv4 CIDR)</label>
        <input class="input" data-path="general.proxy.bypassAddresses" value="${esc(g.proxy.bypassAddresses)}" placeholder="localhost, 127.0.0.1, .internal, 192.168.1.0/24"></div>
    </div>

    <div class="card" style="box-shadow:none">
      <h3 style="margin-top:0">Логирование</h3>
      <div class="field"><label>Уровень логов</label>
        <select class="input" data-path="general.logLevel" style="width:260px">
          ${['debug', 'info', 'warn', 'error'].map((l) => `<option ${g.logLevel === l ? 'selected' : ''}>${l}</option>`).join('')}
        </select></div>
    </div>
  </div>`;
}

function bindGeneral(form) {
  const authSel = form.querySelector('#g-auth');
  const syncAuth = () => {
    const m = authSel.value;
    form.querySelector('#g-basic').style.display = m === 'basic' ? '' : 'none';
    form.querySelector('#g-apikey-row').style.display = m === 'apiKey' ? '' : 'none';
  };
  authSel.addEventListener('change', syncAuth);
  syncAuth();
  form.querySelector('#g-genkey').addEventListener('click', () => {
    const hex = Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, '0')).join('');
    const inp = form.querySelector('[data-path="general.authentication.apiKey"]');
    inp.value = hex;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/* ---------- binding ---------- */
function bind(form, tabId) {
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

  form.querySelectorAll('[data-mt]').forEach((el) => el.addEventListener('change', () => {
    const set = new Set(cfg.selection.mediaTypes);
    el.checked ? set.add(el.dataset.mt) : set.delete(el.dataset.mt);
    cfg.selection.mediaTypes = [...set];
    markDirty(tabId);
  }));

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

  form.querySelectorAll('[data-toggle-pw]').forEach((b) => b.addEventListener('click', () => {
    const inp = b.parentElement.querySelector('input');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  }));

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
    const res = await api('/api/v1/settings', { method: 'PUT', body: cfg });
    cfg = res;
    dirty.clear();
    document.querySelectorAll('#s-tabs .dirty').forEach((d) => d.classList.add('hidden'));
    document.getElementById('s-dirty-note').textContent = '';
    toast('Настройки сохранены');
    if (res.rebound?.changed) {
      toast(`Сервер перезапущен на ${res.rebound.host}:${res.rebound.port} — переключаюсь…`, 'ok', 6000);
      setTimeout(() => {
        location.href = `${location.protocol}//${location.hostname}:${res.rebound.port}/#/settings`;
      }, 1500);
    }
  } catch { /* toast already */ }
}
