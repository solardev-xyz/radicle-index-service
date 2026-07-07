#!/bin/bash
# Boot order: identity → node config → radicle-node → radicle-httpd → worker.
set -euo pipefail

: "${RAD_HOME:=/data/radicle}"
: "${INDEXER_ALIAS:=freedom-radicle-index}"
: "${PREFERRED_SEED:=z6MksmpU5b1dS7oaqF2bHXhQi1DWy2hB7Mh9CuN7y1DN6QSz@seed.radicle.xyz:8776}"

mkdir -p "$RAD_HOME"

if [ ! -f "$RAD_HOME/keys/radicle" ]; then
  echo "[entrypoint] creating radicle identity ($INDEXER_ALIAS)"
  RAD_PASSPHRASE='' rad auth --alias "$INDEXER_ALIAS"
fi

# Reliable seed (the default iris/rosa seeds reset handshakes, July 2026).
CONFIG="$RAD_HOME/config.json"
node -e "
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync('$CONFIG', 'utf8'));
  cfg.preferredSeeds = ['$PREFERRED_SEED'];
  cfg.node.alias = '$INDEXER_ALIAS';
  fs.writeFileSync('$CONFIG', JSON.stringify(cfg, null, 2));
"

# Stale socket from an unclean shutdown blocks node start.
rm -f "$RAD_HOME/node/control.sock"

echo '[entrypoint] starting radicle-node'
RAD_PASSPHRASE='' radicle-node &
NODE_PID=$!

for i in $(seq 1 30); do
  [ -S "$RAD_HOME/node/control.sock" ] && break
  sleep 1
done

echo '[entrypoint] starting radicle-httpd'
RAD_PASSPHRASE='' radicle-httpd --listen 127.0.0.1:8780 &
HTTPD_PID=$!

trap 'kill $HTTPD_PID $NODE_PID 2>/dev/null' TERM INT

echo '[entrypoint] starting indexer worker'
node --experimental-strip-types /app/src/index.ts &
WORKER_PID=$!

wait -n $NODE_PID $HTTPD_PID $WORKER_PID
echo '[entrypoint] a process exited — shutting down'
kill $HTTPD_PID $NODE_PID $WORKER_PID 2>/dev/null
exit 1
