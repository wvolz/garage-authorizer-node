#!/bin/sh
set -eu

if [ ! -f /app/config.js ]; then
  cat >&2 <<'EOF'
Missing /app/config.js.
Mount your production config into the container, for example:
  -v ./config.js:/app/config.js:ro
EOF
  exit 1
fi

mkdir -p /app/state /app/state/photos

exec "$@"
