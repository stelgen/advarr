# Advarr за reverse-proxy (nginx)

Advarr — стандартное Node HTTP-приложение без WebSocket-соединений и требований
к sticky-сессиям, поэтому корректно работает за nginx, Traefik или Caddy.
Стоит учесть два момента.

## 1. TRUST_PROXY

Rate-limiter идентифицирует клиентов по IP. По умолчанию Advarr **не доверяет**
заголовку `X-Forwarded-For` — иначе любой клиент может подменить его и обойти
ограничение. За доверенным прокси укажите:

```yaml
environment:
  TRUST_PROXY: "1"
```

и передавайте в nginx реальный IP-адрес клиента:

```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

## 2. Таймауты

Синхронный dry-run (`POST /api/v1/run {"dry":true}`) может выполняться 30–60 секунд
(сбор кандидатов + проверка доступности в Seerr). Значение по умолчанию
`proxy_read_timeout 60s` способно оборвать ответ — увеличьте его:

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    client_max_body_size 1m;   # Advarr самостоятельно ограничивает тела запросов 256KB
}
```

## Особенности

- **Basic Auth**: если включён одновременно в nginx и в Advarr
  (`BASIC_AUTH_USER`/`BASIC_AUTH_PASS`), браузер запросит пароль дважды —
  используйте один уровень аутентификации.
- **HTTPS**: TLS терминируется на прокси; Advarr не формирует абсолютных URL,
  поэтому `X-Forwarded-Proto` носит информационный характер.
- **Кэш постеров**: `/img/poster` отдаёт `Cache-Control: immutable, max-age=604800` —
  nginx проксирует эти ответы без дополнительной настройки.
- **`?apikey=`**: удобно для автоматизации, но ключ попадает в access-логи прокси.
  Для интерактивного доступа предпочтительнее Basic Auth; query-параметр
  оставьте для скриптов.
