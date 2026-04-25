#!/bin/sh
set -eu

ROOT_DIR=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

mkdir -p state/photos

ENV_FILE_ARGS=""
if [ -f .env.production ]; then
	ENV_FILE_ARGS="--env-file .env.production"
fi

docker compose ${ENV_FILE_ARGS} -f docker-compose.prod.yml up -d --build
