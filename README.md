<div align="center">

<img src="assets/brand/social-1280x640.png" alt="Advarr" width="640"/>

# Advarr

**Пассивный радар трендов для \*arr-стека.** По расписанию сканирует TMDB
(тренды, популярное, топ-рейтинг), отбирает кандидатов по настраиваемым правилам
и автоматически создаёт запросы в **Jellyseerr / Overseerr** через API.
Достаточно один раз настроить фильтры — очередь запросов пополняется сама.

`docker` · `zero npm-deps` · `Node 22` · `MIT`

[Быстрый старт](#быстрый-старт) · [Как это работает](#как-это-работает) · [Настройка](#настройка) · [Hardening](#безопасностьhardening)

</div>

---

## Что это

Advarr работает между TMDB и Seerr и решает одну задачу: **регулярно находить актуальное и отправлять в очередь**.

- ⏱ **Расписание**: раз в N часов (с джиттером ±M минут, чтобы не создавать пиковую нагрузку на API).
- 🌍 **Источники**: `trending/day`, `trending/week`, `popular`, `top_rated`, `now_playing`, `upcoming`, `discover` (свои параметры) — у каждого тумблер и вес.
- 🎚 **Фильтры**: минимальный рейтинг и число голосов, годы, языки оригинала, включённые/исключённые жанры, 18+.
- 🧮 **Скоринг**: настраиваемые веса (рейтинг / популярность / голоса / свежесть / любимые жанры) — критерии «нашумевшего» определяются вашими правилами, а не глобальными алгоритмами TMDB.
- 🔁 **Без повторов**: дедуп по локальной истории + всем существующим запросам в Seerr + опциональная проверка статуса медиа (pending/available → исключение).
- 🔔 **Уведомления**: Telegram и Webhook (Discord/ntfy) — сводка после каждого прогона.
- ♻️ **Ретрай-политика**: неудавшиеся запросы повторяются после cooldown (настраивается).
- 🧮 **Статусы Seerr в интерфейсе**: бейджи «В ожидании / Обрабатывается / Доступно» у кандидатов.
- 💾 **Бэкапы в стиле \*arr**: снапшоты настроек и истории, восстановление на лету без перезапуска.
- ⚙️ **Общие настройки как в Radarr**: адрес/порт (применяются без перезапуска), Basic/API-ключ, **исходящий прокси** (CONNECT-туннель + список исключений), уровень логов.
- 🖥 **Интерфейс в стиле Radarr**: сайдбар, карточки с постерами и score-бейджами, история, логи, все настройки в UI.
- 🐳 **Docker**: zero-deps образ, non-root, read-only rootfs, healthcheck, GHCR multi-arch.

## Как это работает

```text
┌────────────┐  каждые N часов   ┌────────────────────────────────────┐
│  Scheduler │──────────────────▶│ 1. TMDB: тренды/популяр/топ/…      │
└────────────┘                   │ 2. фильтры + скоринг + ранжирование │
                                 │ 3. дедуп: история + запросы Seerr  │
      ┌────────────────┐         │ 4. топ M фильмов + K сериалов      │
      │ Jellyseerr /   │◀────────│ 5. POST /api/v1/request            │
      │ Overseerr      │         └────────────────────────────────────┘
      └───────┬────────┘
              ▼
        Radarr / Sonarr
```

## Быстрый старт

### Docker Compose (рекомендуется)

```bash
mkdir advarr && cd advarr
curl -O https://raw.githubusercontent.com/stelgen/advarr/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/stelgen/advarr/main/.env.example
# укажите TMDB_API_KEY (themoviedb.org → Settings → API) и SEERR_URL/SEERR_API_KEY
docker compose up -d
```

Откройте `http://localhost:8787` → **Настройки** → проверьте TMDB и Seerr кнопками
**Проверить** → **Сохранить** → **Подборка** → **Обновить подборку** (пробный прогон).

> 💡 Ключи можно не вводить вручную: `TMDB_API_KEY`, `SEERR_URL`,
> `SEERR_API_KEY` из env переносятся в конфиг при первом старте (в дальнейшем изменения в UI имеют приоритет).

### docker run

```bash
docker run -d --name advarr \
  -p 8787:8787 \
  -v ./data:/app/data \
  -e TMDB_API_KEY=your_key \
  -e SEERR_URL=http://192.168.1.50:5055 \
  -e SEERR_API_KEY=your_seerr_key \
  ghcr.io/stelgen/advarr:latest
```

## Скриншоты

| Обзор | Подборка (dry-run) | Общие (как в Radarr) |
|---|---|---|
| ![Обзор](docs/screenshots/overview.png) | ![Подборка](docs/screenshots/discovery.png) | ![Общие](docs/screenshots/settings-general.png) |

| Уведомления | Бэкапы | Источники |
|---|---|---|
| ![Уведомления](docs/screenshots/settings-notifications.png) | ![Бэкапы](docs/screenshots/settings-backups.png) | ![Источники](docs/screenshots/settings-sources.png) |

## Reverse-proxy (nginx/traefik)

Advarr не использует WebSocket-соединения и не требует sticky-сессий, поэтому корректно
работает за обратным прокси. Увеличьте `proxy_read_timeout` до 300s для продолжительных
dry-run-прогонов и задайте `TRUST_PROXY=1`, чтобы rate-limit видел реальные IP-адреса —
подробности в [docs/REVERSE-PROXY.md](docs/REVERSE-PROXY.md).

## Настройка

Все параметры — в веб-интерфейсе (разделы по образцу \*arr): **Media Server · TMDB · Расписание · Выборка · Фильтры · Источники · Скоринг · Уведомления · Бэкапы · Интерфейс · Общие**.

| Env (первичный сид/секреты) | По умолчанию | Описание |
|---|---|---|
| `ADVARR_PORT` | `8787` | Порт |
| `ADVARR_DATA_DIR` | `/app/data` | Каталог данных (`config/history/runs.json`) |
| `TMDB_API_KEY` | — | Ключ TMDB v3 |
| `SEERR_URL` | — | Базовый URL Jellyseerr/Overseerr |
| `SEERR_API_KEY` | — | API-ключ Seerr |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` | — | Basic-Auth для веб-интерфейса |
| `ADVARR_API_KEY` | — | Альтернатива Basic: `X-Api-Key` |
| `TRUST_PROXY` | — | `1` = доверять `X-Forwarded-For` (только за доверенным прокси) |

Логика выборки: пул кандидатов со включённых источников → фильтры → дедуп
(история + `GET /api/v1/request` в Seerr) → скоринг → квота `moviesPerRun`/`showsPerRun` →
`POST /api/v1/request` (сериалы: все сезоны или только первый — настройка `tvSeasons`).

## Безопасность / Hardening

- Ноль npm-зависимостей — минимальная поверхность атаки; базовый образ `node:22-alpine` зафиксирован по digest.
- Non-root (uid 10001), `tini`, совместимость с `read_only: true` + `tmpfs` для `/tmp`.
- `cap_drop: ALL`, `no-new-privileges`, ограничение логов — включены в `docker-compose.yml`.
- Строгий CSP без внешних CDN; постеры проксируются через `/img/poster` — ключи не раскрываются, IP клиента не публикуется.
- Rate-limit, ограничение размера тела запроса, `timingSafeEqual` при проверке секретов.
- Trivy в CI прерывает сборку при HIGH/CRITICAL. Подробнее: [docs/SECURITY.md](docs/SECURITY.md).

## Разработка

```bash
git clone git@github.com:stelgen/advarr.git && cd advarr
node server.js            # запуск в dev-режиме: http://localhost:8787
npm test                  # unit + e2e (node:test, без внешней сети)
python3 scripts/gen_brand.py   # перегенерация логотипа и баннера
```

API-контракт: [docs/API.md](docs/API.md) · Дизайн-референс: Radarr/Sonarr.

## Roadmap

- [ ] Учёт просмотренного в Jellyfin при дедупликации
- [ ] Trakt.tv как дополнительный источник
- [ ] Прямая интеграция с API Radarr/Sonarr (в обход Seerr)
- [ ] Списки TMDB (watchlist, награды и премии)
- [ ] Экспорт/импорт конфигурации (JSON)

## Лицензия

MIT — см. [LICENSE](LICENSE).

---

<div align="center"><sub>Разработано для домашнего медиа-стека. TMDB — сторонний сервис; Advarr не аффилирован с TMDB, Overseerr или Jellyseerr.</sub></div>
