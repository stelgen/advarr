// Advarr — О приложении.
const ENV_ROWS = [
  ['ADVARR_PORT', '8787', 'Порт веб-морды'],
  ['ADVARR_DATA_DIR', '/app/data', 'Каталог данных (config/history/runs.json)'],
  ['TMDB_API_KEY', '—', 'Ключ TMDB v3 (первичный сид)'],
  ['SEERR_URL', '—', 'URL Jellyseerr/Overseerr'],
  ['SEERR_API_KEY', '—', 'API-ключ Seerr'],
  ['BASIC_AUTH_USER / BASIC_AUTH_PASS', '—', 'Basic-Auth на веб-морду'],
  ['ADVARR_API_KEY', '—', 'API-ключ вместо Basic-Auth (X-Api-Key)'],
];

export async function render(view, status) {
  const s = status || { version: '0.1.0' };
  view.innerHTML = `
    <h1>О приложении</h1>
    <div class="card">
      <div class="row" style="gap:16px;align-items:flex-start">
        <img src="/logo.svg" width="64" height="64" alt="Advarr" style="border-radius:14px">
        <div>
          <h3 style="margin:0">Advarr <span class="muted">${esc(s.version || '')}</span></h3>
          <p class="muted" style="max-width:640px">Пассивный радар трендов: по расписанию сканирует TMDB, отбирает и оценивает кандидатов
          по настраиваемым правилам, исключает уже запрошенное (история + Seerr) и автоматически создаёт
          запросы в Jellyseerr/Overseerr. Правила задаёте вы — очередь пополняется сама.</p>
          <div class="row">
            <a class="btn" href="https://github.com/stelgen/advarr" target="_blank" rel="noopener noreferrer">GitHub ↗</a>
            <a class="btn" href="https://developer.themoviedb.org/reference/getting-started" target="_blank" rel="noopener noreferrer">TMDB API ↗</a>
            <a class="btn" href="https://api-docs.overseerr.dev/" target="_blank" rel="noopener noreferrer">Overseerr API ↗</a>
          </div>
        </div>
      </div>
    </div>

    <div class="section-title"><h3>Переменные окружения (Docker)</h3></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Переменная</th><th>По умолчанию</th><th>Описание</th></tr></thead>
      <tbody>${ENV_ROWS.map(([k, d, desc]) => `<tr><td><b>${k}</b></td><td class="muted">${d}</td><td class="muted">${desc}</td></tr>`).join('')}</tbody>
    </table></div>

    <div class="muted" style="margin-top:18px;font-size:12.5px">
      MIT License · TMDB и Seerr — сторонние сервисы, Advarr с ними не аффилирован.
      Безопасность: docs/SECURITY.md.
    </div>
  `;
}
