# Changelog

## 0.4.0 — 2026-09-19

### Added
- **Обогащение метаданными (плагинная архитектура провайдеров)**: расширяет карточку «Подробнее»
  актёрами, режиссёрами и внешними ID
  - `imdb` — публичный suggestion-эндпоинт, **работает без ключа** (неофициальный, best-effort)
  - `tmdb` — полный credits + external_ids (ваш ключ TMDB)
  - `tvdb` — TheTVDB API v4 (их apikey + опциональный PIN, токен на месяц)
  - режим приоритетов: провайдеры опрашиваются по порядку, последующие дозаполняют только недостающие поля
  - кэш результатов (30 мин), настройка и тест в разделе «Метаданные»
- Роуты: `GET /api/v1/enrich`, `POST /api/v1/enrich/test`
- Миграция конфига v2 → v3 (секция `enrich`)

### Tests
- 91 тест (+9): провайдеры, merge/fallback, кэш, миграция конфига

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
