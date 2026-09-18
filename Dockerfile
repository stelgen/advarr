# syntax=docker/dockerfile:1.7
##############################################################################
# Advarr — hardened image. Zero runtime npm deps → single runtime stage,
# no build toolchain, no package installation from npm registry at all.
#   - non-root user (uid 10001)
#   - tini as PID 1 (correct signal forwarding, zombie reaping)
#   - read-only rootfs compatible (writes only to /app/data and /tmp)
#   - no-new-privileges & cap_drop ALL in docker-compose.yml
##############################################################################

# base pinned to tag + index digest (reproducible, multi-arch)
FROM node:22.22-alpine3.22@sha256:cd7807368cf24826297cbad5dca1a44972ccfd770647db52a8c7589eb4599ac8

LABEL org.opencontainers.image.title="Advarr" \
      org.opencontainers.image.description="Passive TMDB discovery radar for Jellyseerr/Overseerr" \
      org.opencontainers.image.source="https://github.com/stelgen/advarr" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="0.2.0"

ENV NODE_ENV=production \
    NODE_OPTIONS="--disable-proto=throw --insecure-http-parser=false" \
    ADVARR_PORT=8787 \
    ADVARR_DATA_DIR=/app/data \
    TZ=UTC

# tini: signal handling; ca-certificates: TMDB/seerr TLS;
# libcrypto3/libssl3: bump openssl to latest repo version (CVE-2026-14456/45447)
RUN apk add --no-cache tini ca-certificates libcrypto3 libssl3 \
    && addgroup -g 10001 -S advarr \
    && adduser -u 10001 -S -D -H -G advarr -s /sbin/nologin advarr \
    # app is zero-deps: npm/yarn/corepack never run in production —
    # strip them along with npm's own vulnerable transitive packages
    # (pacote/tar/picomatch/sigstore/brace-expansion flagged by trivy)
    && rm -rf /usr/local/lib/node_modules/npm \
              /usr/local/lib/node_modules/corepack \
              /opt/yarn* \
              /usr/local/bin/npm /usr/local/bin/npx \
              /usr/local/bin/yarn /usr/local/bin/yarnpkg \
              /usr/local/bin/corepack

WORKDIR /app

# app code (tiny, no secrets inside; owner root, group advarr)
COPY --chown=root:advarr server.js package.json LICENSE ./
COPY --chown=root:advarr lib/ ./lib/
COPY --chown=root:advarr public/ ./public/

RUN mkdir -p /app/data && chown advarr:advarr /app/data

USER advarr

EXPOSE 8787

VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- --no-verbose http://127.0.0.1:${ADVARR_PORT}/api/v1/health >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
