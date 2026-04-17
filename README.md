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
