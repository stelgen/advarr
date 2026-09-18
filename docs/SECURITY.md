# Security Policy — Advarr

## Модель угроз и принятые меры

Advarr — локальный сервис для домашней сети. Hardening-подход:

- **Образ**: non-root (uid 10001), tini как PID 1, read-only rootfs (запись только в `/app/data` и tmpfs `/tmp`), `cap_drop: ALL` + `no-new-privileges` в compose, Trivy-скан в CI (fail на HIGH/CRITICAL).
- **Supply chain**: **ноль** npm-зависимостей в рантайме. Node stdlib only. Базовый образ пинится по версии.
- **HTTP**: строгий CSP (`default-src 'self'`, без внешних CDN), `X-Content-Type-Options`, `frame-ancestors 'none'`, `noindex`, rate-limit на `/api` и `/img`, ограничение тела запроса, защита от path traversal.
- **Аутентификация**: опционально Basic-Auth или API-ключ (`X-Api-Key`), сравнение `timingSafeEqual`. Секреты только через env — никогда не в `data/`.
- **Секреты**: ключи TMDB/Seerr никогда не попадают в логи (маскирование) и отдаются UI только в маскированном виде (`••••1234`).

## Рекомендации по эксплуатации

1. Не выставляй порт наружу интернета напрямую; если нужно — только за reverse-proxy с TLS.
2. Задай `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` или `ADVARR_API_KEY`, если к порту имеют доступ не только ты.
3. Держи образ обновлённым: `docker compose pull && docker compose up -d`.

## Как сообщить об уязвимости

Создай GitHub issue с меткой `security` или напиши мейнтейнеру напрямую. Не публикуй детали эксплойта до фикса.
