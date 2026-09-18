// Advarr — tiny UI helpers: toasts, modal, esc, formatting.
export function toast(msg, type = 'ok', ms = 4200) {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, ms);
}

export function openModal(html) {
  const overlay = document.getElementById('modal-overlay');
  const modal = document.getElementById('modal');
  modal.innerHTML = html;
  overlay.classList.remove('hidden');
}
export function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  document.getElementById('modal').innerHTML = '';
}
document.getElementById('modal-overlay')?.addEventListener('click', (e) => {
  if (e.target.id === 'modal-overlay') closeModal();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

export function esc(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function fmtCountdown(nextMs) {
  if (!nextMs) return 'расписание выкл.';
  const diff = nextMs - Date.now();
  if (diff <= 0) return 'скоро…';
  const m = Math.floor(diff / 60000);
  if (m < 60) return `через ${m} мин`;
  const h = Math.floor(m / 60);
  return `через ${h} ч ${m % 60} мин`;
}

export function scoreClass(score) {
  return score >= 75 ? 'score-hi' : score >= 50 ? 'score-mid' : 'score-lo';
}

export const SOURCE_LABELS = {
  trending_day: 'Тренды дня',
  trending_week: 'Тренды нед.',
  popular: 'Популярное',
  top_rated: 'Топ рейтинга',
  now_playing: 'В кинотеатрах',
  upcoming: 'Ожидается',
  discover: 'Discover',
  manual: 'Вручную',
};

const POSTER_FALLBACK = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300">' +
  '<rect width="200" height="300" fill="#232329"/>' +
  '<rect x="84" y="128" width="32" height="44" rx="6" fill="none" stroke="#5b5b6b" stroke-width="4"/>' +
  '<path d="M94 140 L94 160 L112 150 Z" fill="#5b5b6b"/></svg>');

export function posterUrl(path, size = 'w342') {
  if (!path) return POSTER_FALLBACK;
  return `/img/poster?path=${encodeURIComponent(path)}&size=${size}`;
}
