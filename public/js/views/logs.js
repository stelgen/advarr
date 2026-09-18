// Advarr — Логи: живой хвост через polling /api/v1/logs?since=
import { api } from '../api.js';
import { esc } from '../ui.js';

let since = 0;
let level = 'all';
let autoScroll = true;
let timer = null;

export async function render(view) {
  since = 0;
  view.innerHTML = `
    <div class="section-title" style="margin-top:0">
      <h1>Логи</h1>
      <div class="row">
        <select class="input input-sm" id="l-level" style="width:160px">
          <option value="all">Все уровни</option>
          <option value="info">Info</option>
          <option value="warn">Warn</option>
          <option value="error">Error</option>
        </select>
        <label class="switch"><input type="checkbox" id="l-scroll" checked><span class="track"></span>Автоскролл</label>
      </div>
    </div>
    <div class="logs-box" id="l-box"></div>
  `;
  view.querySelector('#l-level').addEventListener('change', (e) => { level = e.target.value; since = 0; document.getElementById('l-box').innerHTML = ''; poll(); });
  view.querySelector('#l-scroll').addEventListener('change', (e) => { autoScroll = e.target.checked; });
  await poll();
  clearInterval(timer);
  timer = setInterval(poll, 5000);
  window.addEventListener('hashchange', () => clearInterval(timer), { once: true });
}

async function poll() {
  const box = document.getElementById('l-box');
  if (!box) { clearInterval(timer); return; }
  let data;
  try {
    data = await api(`/api/v1/logs?since=${since}&level=${level}`, { silent: true });
  } catch { return; }
  if (!data.entries.length) { if (since === 0) box.innerHTML = '<div class="log-line">— пусто —</div>'; return; }
  if (since === 0) box.innerHTML = '';
  for (const e of data.entries) {
    const div = document.createElement('div');
    div.className = `log-line log-${e.level}`;
    div.innerHTML = `<span class="t">${esc(e.t.slice(11, 19))}</span>${esc(e.msg)}${e.extra && Object.keys(e.extra).length ? ` <span class="log-debug">${esc(JSON.stringify(e.extra))}</span>` : ''}`;
    box.appendChild(div);
  }
  since = data.entries[data.entries.length - 1].id;
  if (autoScroll) box.scrollTop = box.scrollHeight;
}
