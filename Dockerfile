# syntax=docker/dockerfile:1

FROM node:25-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# tini ensures proper signal handling (clean shutdown on SIGTERM/SIGINT)
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    g++ \
    make \
    python3 \
    tini \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  && npm rebuild better-sqlite3 --build-from-source \
  && npm cache clean --force

COPY . .
COPY docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /app/state/photos \
  && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 1337/tcp

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "garage-authorizer.js"]
