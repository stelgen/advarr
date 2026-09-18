// Advarr — API wrapper: JSON fetch, error toasts, optional API-key auth.
import { toast } from './ui.js';

const KEY_STORAGE = 'advarr.apikey';

export function getApiKey() { return localStorage.getItem(KEY_STORAGE) || ''; }
export function setApiKey(k) { localStorage.setItem(KEY_STORAGE, k); }

export async function api(path, { method = 'GET', body = null, silent = false } = {}) {
  const headers = { Accept: 'application/json' };
  const key = getApiKey();
  if (key) headers['X-Api-Key'] = key;
  if (body !== null) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, body: body !== null ? JSON.stringify(body) : undefined });
  } catch (err) {
    if (!silent) toast(`Сеть недоступна: ${err.message}`, 'err');
    throw err;
  }
  if (res.status === 401) {
    showKeyPrompt();
    const err = new Error('unauthorized');
    err.status = 401;
    throw err;
  }
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const msg = data?.error || `HTTP ${res.status}`;
    if (!silent) toast(`Ошибка: ${msg}`, 'err');
    const err = new Error(msg);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

export function showKeyPrompt() {
  const overlay = document.getElementById('keyprompt-overlay');
  overlay.classList.remove('hidden');
  document.getElementById('keyprompt-input').focus();
}

document.getElementById('keyprompt-save')?.addEventListener('click', () => {
  const v = document.getElementById('keyprompt-input').value.trim();
  if (v) setApiKey(v);
  document.getElementById('keyprompt-overlay').classList.add('hidden');
  window.dispatchEvent(new Event('advarr:auth'));
});
document.getElementById('keyprompt-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('keyprompt-save').click();
  if (e.key === 'Escape') document.getElementById('keyprompt-overlay').classList.add('hidden');
});
