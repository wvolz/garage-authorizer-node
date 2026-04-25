# Purpose

Sends command to open garage door based on result of http get

# Outbox (durable tagscan delivery)

Tag scans are written to a local SQLite outbox before being sent to the Rails endpoint. A background worker retries delivery with exponential backoff so no scans are lost during endpoint outages.

**Database location:** configured by `outboxDbPath` (default `./outbox.db`).

**Inspect the queue with sqlite3:**
```sh
# Show pending / failed rows
sqlite3 outbox.db "SELECT id, event_id, delivery_state, retry_count, last_error FROM tagscan_outbox WHERE delivery_state != 'delivered';"

# Count per state
sqlite3 outbox.db "SELECT delivery_state, COUNT(*) FROM tagscan_outbox GROUP BY delivery_state;"

# View dead-letter rows
sqlite3 outbox.db "SELECT * FROM tagscan_outbox WHERE delivery_state = 'dead_letter';"
```

**Retry tuning** (in `config.js`):
| Key | Default | Meaning |
|-----|---------|----------|
| `outboxPollIntervalMs` | 30000 | How often the worker polls (ms) |
| `outboxBase` | 2 | Backoff base in seconds |
| `outboxMaxDelay` | 300 | Maximum backoff delay in seconds |
| `outboxMaxAttempts` | 50 | Attempts before moving to dead_letter |
| `outboxAuthRetryThreshold` | 3 | 401/403 retries before dead_letter |

Backoff formula: `delay = min(base × 2^retry_count + jitter(0..base), maxDelay)`

**Schema migrations** are managed automatically via `PRAGMA user_version`. To add a column, append a new entry to the `MIGRATIONS` array in `outbox.js` — never edit existing entries.

# Testing

```sh
mise exec -- npm test
```

Uses Node's built-in `node:test` runner — no extra dependencies.

# Production Docker Deployment

This repository includes a production container build and compose setup.

## Included files

- `Dockerfile` (production image)
- `docker-compose.prod.yml` (single-service production compose file)
- `docker/entrypoint.sh` (startup checks + state directory creation)
- `scripts/docker/build.sh`
- `scripts/docker/up.sh`
- `scripts/docker/down.sh`
- `scripts/docker/logs.sh`
- `config.js.docker.default` (Docker-friendly config template)
- `.env.production.example` (production env template for compose/image/runtime overrides)

## 1) Prepare config

Create `config.js` from `config.js.docker.default` and fill in your environment values:

```sh
cp config.js.docker.default config.js
```

Important defaults in the Docker template:

- `listenAddr: '0.0.0.0'` (required so container port publishing works)
- `outboxDbPath: './state/outbox.db'`
- `photosDir: './state/photos'`

## 2) Prepare production env file (optional, recommended)

Create `.env.production` from the template:

```sh
cp .env.production.example .env.production
```

Set values such as:

- `IMAGE_NAME`
- `IMAGE_TAG`
- `CONTAINER_NAME`
- `LISTEN_PORT`
- `LOG_LEVEL`
- `LOG_TIMESTAMP`

The Docker helper scripts automatically use `.env.production` when present.

## 3) Build and run

Using npm scripts:

```sh
npm run docker:build
npm run docker:up
```

Or directly:

```sh
./scripts/docker/build.sh
./scripts/docker/up.sh
```

## 3) Operate

Tail logs:

```sh
npm run docker:logs
```

Stop service:

```sh
npm run docker:down
```

## 4) Persistence

Compose mounts `./state` into `/app/state` so the outbox DB and photos survive container restarts and image updates.

## 5) Runtime expectations

- `config.js` is mounted read-only to `/app/config.js`.
- Service listens on TCP port `1337` by default (`LISTEN_PORT` can override published host port).
- Restart policy is `unless-stopped`.

**Integration / manual testing:**

1. Setup / run test install of [tag-manager-rails](https://github.com/wvolz/tag-manager-rails)
2. Depending on driver in use:
   - 2a. Setup / run garage-mock-particle-server
   - 2b. Install + start mosquitto (or another mqtt broker)
3. (If using MQTT) publish doorstate to doorstate topic configured
4. Use cat and netcat (nc) to pipe test input into authorizer

**Outage/recovery smoke test:**
1. Stop (or block) the Rails endpoint.
2. Send several scans via netcat — confirm they are queued in the outbox DB.
3. Restart the service — confirm queued rows survive (`delivery_state = 'queued'`).
4. Restore the Rails endpoint — confirm the worker delivers all queued rows.

# Notes

- Pino outputs in JSON, but you can use pino-pretty to format it:
```npm run dev```
- Production run: ```npm start```
- suggest using 'jq' for parsing of output json from production
- Tag format from ALR-9650 (currently supported reader)
   - Using a TagStream custom format: ${TAGID},${RSSI},${TIME1},${TIME2},${TX},${RX},${PCWORD}
   - ${TIME1} = Discovery time of tag, in format hh:mm:ss
   - ${TIME2} = Last-seen time of tag, in format hh:mm:ss
   - ${TX} = TX antenna tag last seen on
   - ${RX} = RX antenna where tag was last seen
