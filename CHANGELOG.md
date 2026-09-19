# Changelog

## 0.6.0 — 2026-09-19

### Added
- **Прямая интеграция с Radarr / Sonarr (в обход Seerr)** — управление подключениями
  как в \*arr-приложениях: раздел «Настройки → Radarr / Sonarr» со списком инстансов,
  добавлением через форму (тип, URL, API-ключ), кнопкой «Проверить и загрузить профили»
  (тянет профили качества и корневые папки из инстанса), per-instance включателем
  - движок рассылает запросы во все настроенные цели (Seerr + Radarr + Sonarr);
    история хранит, через какие цели прошёл каждый запрос (`via`)
  - дедупликация против библиотек: ID, уже присутствующие в Radarr/Sonarr, в подборку не попадают
  - Sonarr: tvdbId резолвится автоматически (lookup `tmdb:`-префиксом, фолбэк — поиск по названию)
- **Источник «TMDB-списки»**: публичные списки TMDB (`/list/{id}`) по ID через запятую —
  watchlist-коллекции, подборки наград и премий; элементы нормализуются по `media_type`;
  требует ключ TMDB; настраивается в «Источниках» (ID списков + вес)
- API: `POST /api/v1/integrations/test` (проверка связи + профили + корневые папки);
  маскирование `integrations[].apiKey` в API-ответах (маска переживает сохранение)
- Миграция конфига v5 → v6 (`integrations`, `sources.tmdb_list`)

### Tests
- 104 теста (+10): клиенты Radarr/Sonarr (эндпоинты, payload'ы, tvdbId-resolution),
  мульти-цельная рассылка движка, дедуп по библиотекам, источник списков,
  маскирование ключей интеграций, миграция конфига

## 0.5.0 — 2026-09-19

### Added
- **Экспорт/импорт конфигурации в стиле Radarr**: один файл со всеми настройками
  (`GET /api/v1/system/config/download` — значения ключей в файле не маскируются, как
  `config.xml` у Radarr; импорт `POST /api/v1/system/config/import` применяет их на лету).
  UI: Настройки → Общие → «Экспорт / импорт конфигурации»
- **Автобэкапы по расписанию** (Radarr parity): интервал в днях (по умолчанию 7, 0 = выкл.),
  кастомная папка (`backups.folder`, должна быть смонтирована в контейнер), проверка раз в час
- **Настройки потребления ресурсов** (Настройки → Общие → «Ресурсы»):
  `storage.historyMaxItems` (размер истории), `storage.logBuffer` (строк логов в памяти),
  `storage.posterCacheHours` (Cache-Control прокси постеров)
- Docker: `--max-old-space-size=256` (кап heap Node), `mem_limit: 512m` в compose-примере

### Changed
- **SSD**: сторы пишут компактный JSON (вместо pretty-print) и пропускают запись при
  неизменённом состоянии; дебаунс записи поднят до 1 с — меньше циклов перезаписи
- **RAM**: выгрузка TMDB Daily Export парсится потоково через gunzip с удержанием только
  топ-N по популярности (ранее весь дамп ~1 млн строк читался в память целиком);
  постер-прокси стримит ответ без буферизации; буфер логов 1000 → 500; лимит истории 5000 → 2000

### Fixed
- rotation бэкапов мог упасть (потерянная ссылка на папку) — silent no-op, теперь работает

### Tests
- 94 теста (+6): no-op запись стора, семантический baseline после перезагрузки,
  потоковый top-N (50000 строк), расписание/папка бэкапов, export/import цикл (live)

## 0.4.0 — 2026-09-19

### Added
- **Режим работы без ключа TMDB**: новый источник «TMDB Daily Export» — официальные публичные
  ежедневные выгрузки (files.tmdb.org), без API-ключа. Поля: ID, название, популярность,
  рейтинг, голоса, дата, adult. Достаточно ключа Seerr — обнаружение, фильтры, скоринг,
  дедупликация и автозапросы работают в полном объёме
  - отбор топ-N по популярности из выгрузки (по умолчанию 150), кэш загрузки 12 часов,
    автоматический перебор дат на 3 дня назад (задержка публикации)
  - жанровые фильтры к этому источнику не применяются (в выгрузке нет жанров);
    остальные фильтры (рейтинг, голоса, годы, языки, adult) работают
- Миграция конфига v3 → v4 (`sources.tmdb_export`)

### Removed
- Экспериментальное обогащение метаданными (актёры) — не вошло в релиз

### Tests
- 88 тестов (+6): парсер выгрузки (сортировка, adult, topN), фолбэк по датам, кэш,
  noGenres-филтры, полный no-key цикл движка (export → фильтры → дедуп → Seerr-запрос),
  миграция конфига

## 0.3.1 — 2026-09-19

### Documentation
- Вычитка README, SECURITY.md, REVERSE-PROXY.md и текстов интерфейса — нейтральный профессиональный тон
- Roadmap актуализирован (добавлен учёт просмотренного в Jellyfin)

## 0.3.0 — 2026-09-18

### Added
- **Общие настройки (как General в Radarr)**: привязка адрес/порт (применяется живьём, с откатом при занятом порте), Security (Basic / API-ключ, генерация ключа из UI), **исходящий прокси** (HTTP/HTTPS + CONNECT-туннель, авторизация, bypass-лист: хосты/.суффиксы/IPv4 CIDR), уровень логов
- **Бэкапы в стиле \*arr**: снапшоты config+history+runs, список/создать/скачать/удалить/восстановить на лету, ротация (max 30)
- **Уведомления**: Telegram + Webhook (Discord/ntfy-совместимый), триггеры «прогон завершён»/«есть ошибки», тест из UI
- **Ретрай-политика**: провалившиеся запросы повторяются после `retryCooldownDays` (по умолчанию 7; 0 = никогда)
- **Статусы Seerr в UI**: бейджи «В ожидании / Обрабатывается / Частично / Доступно» в Подборке и деталях
- UI-таб: плотность сетки, показ score-бейджей; API-ключ виден в General → Security

### Fixed
- deadlock при смене порта из UI (rebind изнутри keep-alive-соединения) — ответ уходит первым, rebind следом + closeAllConnections

### Dev
- 82 теста (+11): прокси-туннель, bypass/CIDR, notify-триггеры, backup lifecycle/rotation/restore, retry-cooldown, live auth/port rebind, конфликт занятого порта

## 0.2.0 — 2026-09-18 (re-released: CI fix)

### CI
- `aquasecurity/trivy-action@0.28.0` больше не резолвится → пин по SHA `v0.36.0` (верифицированный коммит); `ubuntu-24.04` вместо мигрирующего `ubuntu-latest`
- образ: вырезаны npm/yarn/corepack (в их транзитивных пакетах trivy находил CRITICAL/HIGH — tar CVE-2026-59873, pacote, picomatch, sigstore, brace-expansion); openssl обновлён до фикса CVE-2026-14456/45447 → скан образа чист

### Fixed
- `discover` source: raw querystring was spread as a string → garbage params; now parsed via `URLSearchParams`
- CSP: details-modal close button used inline `onclick` (blocked by strict CSP) → event binding
- CSP: style-атрибуты серверных шаблонов блокировались `style-src 'self'` → добавлен `style-src-attr 'unsafe-inline'` (скрипты по-прежнему строго 'self'); найдено визуальным прогоном в headless Chrome
- UI: эмодзи в типах/плейсхолдерах → текстовые бейджи и SVG (нет зависимости от шрифтов); версия в сайдбаре берётся из API
- brand assets: removed radial banding in radar sweep, removed bright grid artifact on social card, subtitle overflow
- dead code cleanup: unused `serveStatic`, `_middleware`, ghost `scheduleInfo` field, duplicate status interval

### Security
- `deepMerge`/`applyPatch`: prototype-pollution guard (`__proto__`/`constructor`/`prototype`)
- `X-Forwarded-For` is now trusted only with `TRUST_PROXY=1` (default: socket address → XFF spoofing can't bypass rate-limit)
- base image pinned to `node:22.22-alpine3.22` + manifest digest (reproducible, multi-arch)

### Added
- `docs/REVERSE-PROXY.md` — nginx/traefik guidance (timeouts, XFF, basic-auth layering)
- regression tests for all of the above (`test/audit-fixes.test.js`)

## 0.1.0 — 2026-09-18
- First release: TMDB discovery engine, Seerr integration, *arr-style UI, hardened Docker image, CI with Trivy.
