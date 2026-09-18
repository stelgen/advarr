// Advarr — hash router + status polling + topbar actions.
import { api } from './api.js';
import { toast, fmtCountdown, esc } from './ui.js';
import { render as overviewView } from './views/overview.js';
import { render as discoveryView } from './views/discovery.js';
import { render as historyView } from './views/history.js';
import { render as settingsView } from './views/settings.js';
import { render as logsView } from './views/logs.js';
import { render as aboutView } from './views/about.js';

const routes = {
  overview: overviewView,
  discovery: discoveryView,
  history: historyView,
  settings: settingsView,
  logs: logsView,
  about: aboutView,
};

let statusCache = null;

export async function refreshStatus(silent = true) {
  try {
    statusCache = await api('/api/v1/status', { silent });
  } catch { /* toasts already handled */ }
  paintStatus();
}

function paintStatus() {
  const s = statusCache;
  if (!s) return;
  const tmdb = document.getElementById('chip-tmdb');
  const seerr = document.getElementById('chip-seerr');
  const next = document.getElementById('chip-next');
  const run = document.getElementById('chip-running');

  tmdb.textContent = 'TMDB: ' + (s.tmdb.connected === true ? 'ок' : s.tmdb.connected === false ? 'ошибка' : 'не задан');
  tmdb.className = 'chip ' + (s.tmdb.connected === true ? 'chip-ok' : s.tmdb.connected === false ? 'chip-err' : 'chip-idle');

  seerr.textContent = 'Seerr: ' + (s.seerr.connected ? `${s.seerr.app || ''} ок` : 'нет связи');
  seerr.className = 'chip ' + (s.seerr.connected ? 'chip-ok' : 'chip-err');

  next.textContent = s.running ? 'прогон идёт' : 'след. прогон ' + fmtCountdown(s.nextRunAt);
  run.classList.toggle('hidden', !s.running);
  document.getElementById('btn-run').disabled = Boolean(s.running);
  document.getElementById('btn-dry').disabled = Boolean(s.running);
}

function currentRoute() {
  const h = location.hash.replace(/^#\//, '') || 'overview';
  return routes[h] ? h : 'overview';
}

async function renderRoute() {
  const route = currentRoute();
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === route));
  const view = document.getElementById('view');
  view.innerHTML = '<div class="spin-wrap"><span class="spinner"></span>Загрузка…</div>';
  try {
    await routes[route](view, statusCache, { refreshStatus, rerender: renderRoute });
  } catch (err) {
    view.innerHTML = `<div class="empty">Не удалось отрисовать раздел: ${esc(err.message)}</div>`;
  }
}

window.addEventListener('hashchange', renderRoute);
window.addEventListener('advarr:auth', renderRoute);

// topbar actions
document.getElementById('btn-run')?.addEventListener('click', async () => {
  try {
    await api('/api/v1/run', { method: 'POST', body: {} });
    toast('Прогон запущен — результаты в «Истории»');
    await refreshStatus();
  } catch { /* handled */ }
});
document.getElementById('btn-dry')?.addEventListener('click', async () => {
  toast('Пробный прогон: собираем кандидатов…');
  try {
    const { report } = await api('/api/v1/run', { method: 'POST', body: { dry: true } });
    toast(report.items.length
      ? `Пробный прогон: ${report.items.length} кандидатов (запросов не будет). Смотри «Подборку».`
      : `Пробный прогон: кандидатов нет (scanned=${report.scanned})`, report.items.length ? 'ok' : 'err');
    location.hash = '#/discovery';
  } catch { /* handled */ }
});

// boot
await refreshStatus();
await renderRoute();
setInterval(() => { refreshStatus(true); }, 30000);
setInterval(() => { if (statusCache) paintStatus(); }, 30000);
