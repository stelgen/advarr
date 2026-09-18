# syntax=docker/dockerfile:1.7
##############################################################################
# Advarr — hardened image. Zero runtime npm deps → single runtime stage,
# no build toolchain, no package installation from npm registry at all.
#   - non-root user (uid 10001)
#   - tini as PID 1 (correct signal forwarding, zombie reaping)
#   - read-only rootfs compatible (writes only to /app/data and /tmp)
#   - no-new-privileges & cap_drop ALL in docker-compose.yml
##############################################################################

FROM node:22.14.0-alpine3.21

LABEL org.opencontainers.image.title="Advarr" \
      org.opencontainers.image.description="Passive TMDB discovery radar for Jellyseerr/Overseerr" \
      org.opencontainers.image.source="https://github.com/stelgen/advarr" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="0.1.0"

ENV NODE_ENV=production \
    NODE_OPTIONS="--disable-proto=throw --insecure-http-parser=false" \
    ADVARR_PORT=8787 \
    ADVARR_DATA_DIR=/app/data \
    TZ=UTC

# tini: signal handling; ca-certificates: TMDB/seerr TLS
RUN apk add --no-cache tini ca-certificates \
    && addgroup -g 10001 -S advarr \
    && adduser -u 10001 -S -D -H -G advarr -s /sbin/nologin advarr

WORKDIR /app

# app code (tiny; copied as-is, owner root, world-readable)
COPY --chown=root:advarr --chmod=0640 server.js package.json LICENSE ./
COPY --chown=root:advarr --chmod=0640 lib/ ./lib/
COPY --chown=root:advarr --chmod=0640 public/ ./public/

RUN mkdir -p /app/data && chown advarr:advarr /app/data

USER advarr

EXPOSE 8787

VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- --no-verbose http://127.0.0.1:${ADVARR_PORT}/api/v1/health >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
