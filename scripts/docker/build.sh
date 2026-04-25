#!/bin/sh
set -eu

ROOT_DIR=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT_DIR"

docker build \
  -t "${IMAGE_NAME:-garage-authorizer-node}:${IMAGE_TAG:-latest}" \
  -f Dockerfile \
  .
