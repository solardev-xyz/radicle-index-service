# radicle-index-service — radicle-node + radicle-httpd + indexer worker.
# The node's RAD_HOME lives on a volume at /data/radicle (identity, storage,
# gossip db). Publishes through an external bee node (BEE_API_URL).

FROM node:22-alpine AS base

# xz for the radicle release tarballs; git is required by radicle tooling.
RUN apk add --no-cache curl xz git bash

# Radicle binaries (musl builds run natively on alpine).
ARG RADICLE_TARGET=x86_64-unknown-linux-musl
RUN set -eux; \
    cd /tmp; \
    curl -fsSL "https://files.radicle.xyz/releases/latest/radicle-${RADICLE_TARGET}.tar.xz" -o radicle.tar.xz; \
    curl -fsSL "https://files.radicle.xyz/releases/radicle-httpd/latest/radicle-httpd-${RADICLE_TARGET}.tar.xz" -o httpd.tar.xz; \
    mkdir radicle httpd; \
    tar -xJf radicle.tar.xz -C radicle --strip-components=1; \
    tar -xJf httpd.tar.xz -C httpd --strip-components=1; \
    install radicle/bin/* /usr/local/bin/; \
    install httpd/bin/* /usr/local/bin/; \
    rm -rf /tmp/radicle* /tmp/httpd*; \
    rad --version && radicle-httpd --version

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY docs ./docs
COPY bin/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV RAD_HOME=/data/radicle \
    RAD_PASSPHRASE= \
    RADICLE_HTTPD_URL=http://127.0.0.1:8780 \
    OUT_DIR=/data/out \
    STATE_FILE=/data/state.json \
    CACHE_FILE=/data/records.json

VOLUME /data

ENTRYPOINT ["/entrypoint.sh"]
