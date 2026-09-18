# Security Policy — Advarr

## Модель угроз и принятые меры

Advarr — локальный сервис для домашней сети. Hardening-подход:

- **Образ**: non-root (uid 10001), tini как PID 1, read-only rootfs (запись только в `/app/data` и tmpfs `/tmp`), `cap_drop: ALL` + `no-new-privileges` в compose, Trivy-скан в CI (fail на HIGH/CRITICAL).
- **Supply chain**: **ноль** npm-зависимостей в рантайме. Node stdlib only. Базовый образ пинится по версии.
- **HTTP**: CSP `script-src 'self'` (без unsafe-inline для скриптов; для style-атрибутов серверных шаблонов — `style-src-attr 'unsafe-inline'`), `X-Content-Type-Options`, `frame-ancestors 'none'`, `noindex`, rate-limit на `/api` и `/img`, ограничение тела запроса, защита от path traversal, `X-Forwarded-For` учитывается только при `TRUST_PROXY=1`.
- **Аутентификация**: опционально Basic-Auth или API-ключ (`X-Api-Key`), сравнение `timingSafeEqual`. Секреты только через env — никогда не в `data/`.
- **Секреты**: ключи TMDB/Seerr никогда не попадают в логи (маскирование) и отдаются UI только в маскированном виде (`••••1234`).

## Рекомендации по эксплуатации

1. Не публикуйте порт напрямую в интернет; при необходимости — только за reverse-proxy с TLS.
2. Установите `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` или `ADVARR_API_KEY`, если доступ к порту не ограничен доверенной сетью.
3. Поддерживайте образ актуальным: `docker compose pull && docker compose up -d`.

## Как сообщить об уязвимости

Создайте GitHub issue с меткой `security` или свяжитесь с мейнтейнером напрямую.
Пожалуйста, не публикуйте детали эксплойта до выпуска исправления.
