import got from 'got'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ module: 'outboxWorker' })

/**
 * Compute the timestamp (ms since epoch) for the next retry attempt.
 * Formula: delay_seconds = min(base * 2^retryCount + jitter(0..base), maxDelay)
 *
 * @param {number} retryCount   Current retry_count value (after increment).
 * @param {number} base         Base delay in seconds (default 2).
 * @param {number} maxDelay     Maximum delay in seconds (default 300).
 * @param {function} jitterFn   Returns a float in [0,1); defaults to Math.random.
 * @returns {number}            Unix timestamp in milliseconds.
 */
export function computeNextAttemptAt (retryCount, base, maxDelay, jitterFn = Math.random) {
  const delaySecs = Math.min(
    base * Math.pow(2, retryCount) + jitterFn() * base,
    maxDelay
  )
  return Date.now() + Math.round(delaySecs * 1000)
}

/**
 * Classify an HTTP status code into an outbox transition outcome.
 * Network/transport errors (no statusCode) are handled by the caller's catch block.
 *
 * @param {number} statusCode
 * @param {number} retryCount       Current retry_count from the DB row.
 * @param {number} authThreshold    Max retries before 401/403 becomes dead_letter.
 * @param {number} maxAttempts      Max total attempts before any error becomes dead_letter.
 * @returns {'delivered'|'retry_wait'|'dead_letter'}
 */
export function classifyResponse (statusCode, retryCount, authThreshold, maxAttempts) {
  if (statusCode === 200 || statusCode === 201) return 'delivered'

  if (retryCount >= maxAttempts) return 'dead_letter'

  if (statusCode === 429 || statusCode >= 500) return 'retry_wait'

  if (statusCode === 401 || statusCode === 403) {
    return retryCount >= authThreshold ? 'dead_letter' : 'retry_wait'
  }

  // All other 4xx are hard failures.
  return 'dead_letter'
}

/**
 * Run one poll cycle: claim due rows, attempt delivery, apply transitions.
 * Exported so tests can drive it directly without setInterval.
 *
 * @param {OutboxStore} db
 * @param {object}      config
 * @param {object}      logger   Pino logger instance.
 * @param {object}      gotFn    got-compatible HTTP client (injectable for tests).
 */
export async function processOnce (db, config, logger, gotFn = got) {
  const base = config.outboxBase ?? 2
  const maxDelay = config.outboxMaxDelay ?? 300
  const maxAttempts = config.outboxMaxAttempts ?? 50
  const authThreshold = config.outboxAuthRetryThreshold ?? 3

  const rows = db.claimDue(10)

  for (const row of rows) {
    const payload = JSON.parse(row.payload)
    // Attach event_id inside tagscan to match the Rails API contract.
    payload.tagscan = payload.tagscan ?? {}
    payload.tagscan.event_id = row.event_id

    let statusCode
    let responseBody

    try {
      const response = await gotFn.post(config.tagscanUrl, {
        json: payload,
        headers: { Authorization: `Bearer ${config.apiToken}` },
        throwHttpErrors: false
      })
      statusCode = response.statusCode
      responseBody = response.body
    } catch (err) {
      // Transport-level failure (ECONNREFUSED, timeout, DNS, etc.)
      const outcome = row.retry_count >= maxAttempts ? 'dead_letter' : 'retry_wait'
      if (outcome === 'dead_letter') {
        db.markDeadLetter(row.id, err.message)
        logger.error({ event_id: row.event_id, err: err.message }, 'outbox:dead_letter')
      } else {
        const next = computeNextAttemptAt(row.retry_count + 1, base, maxDelay)
        db.markRetryWait(row.id, next, err.message)
        logger.warn(
          { event_id: row.event_id, err: err.message, retry_count: row.retry_count + 1, next },
          'outbox:retry_wait'
        )
      }
      continue
    }

    const outcome = classifyResponse(statusCode, row.retry_count, authThreshold, maxAttempts)

    if (outcome === 'delivered') {
      let railsScanId = null
      try { railsScanId = JSON.parse(responseBody)?.id ?? null } catch {}
      db.markDelivered(row.id, railsScanId != null ? String(railsScanId) : null)
      logger.info({ event_id: row.event_id, statusCode, railsScanId }, 'outbox:delivered')
    } else if (outcome === 'retry_wait') {
      const next = computeNextAttemptAt(row.retry_count + 1, base, maxDelay)
      db.markRetryWait(row.id, next, `HTTP ${statusCode}`)
      logger.warn(
        { event_id: row.event_id, statusCode, retry_count: row.retry_count + 1, next },
        'outbox:retry_wait'
      )
    } else {
      db.markDeadLetter(row.id, `HTTP ${statusCode}`)
      logger.error({ event_id: row.event_id, statusCode }, 'outbox:dead_letter')
    }
  }

  // Emit a periodic queue-depth summary whenever anything is queued.
  const counts = db.counts()
  const pending = (counts.queued ?? 0) + (counts.retry_wait ?? 0) + (counts.dead_letter ?? 0)
  if (pending > 0) {
    logger.info({ counts }, 'outbox:counts')
  }
}

/**
 * Start the background outbox worker.
 * Returns a { stop() } handle for graceful shutdown.
 *
 * @param {OutboxStore} db
 * @param {object}      config
 * @param {object}      logger
 * @param {object}      gotFn    Injected for tests; defaults to real got.
 * @returns {{ stop: function }}
 */
export function startWorker (db, config, logger, gotFn = got) {
  const interval = config.outboxPollIntervalMs ?? 30000
  let timer = null
  let running = true

  async function tick () {
    if (!running) return
    try {
      await processOnce(db, config, logger, gotFn)
    } catch (err) {
      logger.error({ err: err.message }, 'outbox:worker unexpected error')
    }
    if (running) {
      timer = setTimeout(tick, interval)
    }
  }

  // Kick off immediately so there's no 30s wait on startup.
  timer = setTimeout(tick, 0)

  return {
    stop () {
      running = false
      if (timer) clearTimeout(timer)
    }
  }
}
