# Changelog

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
