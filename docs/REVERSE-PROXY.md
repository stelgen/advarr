# Advarr за reverse-proxy (nginx)

Advarr — pure Node HTTP, без sticky-сессий и вебсокетов, так что за nginx/traefik/caddy
чувствует себя нормально. Два правила, чтобы всё было честно:

## 1. TRUST_PROXY

Rate-limiter ключует клиентов по IP. По умолчанию Advarr **не доверяет**
`X-Forwarded-For` (иначе любой может подменить заголовок и обойти лимит).
За прокси выставь:

```yaml
environment:
  TRUST_PROXY: "1"
```

и в nginx передавай реальный IP:

```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

## 2. Таймауты

Синхронный dry-run (`POST /api/v1/run {"dry":true}`) может идти ~30–60 сек
(сбор кандидатов + проверка доступности в Seerr). Дефолтный
`proxy_read_timeout 60s` может оборвать ответ — подними:

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
    client_max_body_size 1m;   # Advarr сам режет тела >256KB
}
```

## Нюансы

- **Basic Auth**: если включён и в nginx, и в Advarr (`BASIC_AUTH_USER/PASS`) —
  браузер спросит пароль дважды. Выбери один слой.
- **HTTPS**: терминируй TLS на прокси; Advarr не генерирует абсолютных URL,
  так что `X-Forwarded-Proto` носит информативный характер.
- **Кэш постеров**: `/img/poster` отдаёт `Cache-Control: immutable, max-age=604800` —
  nginx может проксировать как есть, дополнительно ничего включать не нужно.
- **`?apikey=`**: удобно для скриптов, но ключ попадает в access-логи прокси.
  Для UI-доступа лучше Basic Auth; query-ключ оставь для автоматизации.
