import Database from 'better-sqlite3'

/**
 * Schema migrations — append-only.
 * Each entry is run inside a transaction that also bumps PRAGMA user_version.
 * Never edit an existing entry; only add new ones.
 *
 * Rules for future migrations:
 *   - Additive (new column/index): ALTER TABLE … ADD COLUMN
 *   - Structural (rename/retype): CREATE new table → INSERT SELECT → DROP old → ALTER RENAME
 *   - Raw SQL only — no application code inside migrations
 */
const MIGRATIONS = [
  // v1 — initial schema
  (db) => db.exec(`
    CREATE TABLE tagscan_outbox (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id        TEXT    UNIQUE NOT NULL,
      payload         TEXT    NOT NULL,
      delivery_state  TEXT    NOT NULL DEFAULT 'queued',
      retry_count     INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      last_attempt_at INTEGER,
      delivered_at    INTEGER,
      rails_scan_id   TEXT,
      last_error      TEXT,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX idx_outbox_claim
      ON tagscan_outbox (next_attempt_at)
      WHERE delivery_state IN ('queued','retry_wait');
  `)
]

/**
 * Open (or create) the outbox database, run any pending migrations,
 * and return a store object exposing all outbox operations.
 *
 * @param {string} dbPath  Filesystem path or ':memory:' for tests.
 * @returns {OutboxStore}
 */
export function openDb (dbPath) {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  // Run any migrations that haven't been applied yet.
  const version = db.pragma('user_version', { simple: true })
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      MIGRATIONS[i](db)
      db.pragma(`user_version = ${i + 1}`)
    })()
  }

  // Prepare all statements once at open time.
  const stmts = {
    enqueue: db.prepare(`
      INSERT INTO tagscan_outbox (event_id, payload, delivery_state, next_attempt_at, created_at)
      VALUES (?, ?, 'queued', 0, ?)
    `),

    claimDue: db.prepare(`
      UPDATE tagscan_outbox
      SET delivery_state = 'sending', last_attempt_at = ?
      WHERE id IN (
        SELECT id FROM tagscan_outbox
        WHERE delivery_state IN ('queued','retry_wait') AND next_attempt_at <= ?
        ORDER BY next_attempt_at ASC
        LIMIT ?
      )
      RETURNING *
    `),

    markDelivered: db.prepare(`
      UPDATE tagscan_outbox
      SET delivery_state = 'delivered', delivered_at = ?, rails_scan_id = ?
      WHERE id = ?
    `),

    markRetryWait: db.prepare(`
      UPDATE tagscan_outbox
      SET delivery_state  = 'retry_wait',
          retry_count     = retry_count + 1,
          next_attempt_at = ?,
          last_error      = ?
      WHERE id = ?
    `),

    markDeadLetter: db.prepare(`
      UPDATE tagscan_outbox
      SET delivery_state = 'dead_letter', last_error = ?
      WHERE id = ?
    `),

    counts: db.prepare(`
      SELECT delivery_state, COUNT(*) as count
      FROM tagscan_outbox
      GROUP BY delivery_state
    `)
  }

  return {
    /** Insert a new scan into the outbox as 'queued'. */
    enqueue (eventId, payload) {
      stmts.enqueue.run(eventId, JSON.stringify(payload), Date.now())
    },

    /**
     * Atomically claim up to `limit` due rows (queued or retry_wait
     * with next_attempt_at <= now) and transition them to 'sending'.
     * Returns the claimed rows.
     */
    claimDue (limit = 10) {
      const now = Date.now()
      return stmts.claimDue.all(now, now, limit)
    },

    /** Transition a row to 'delivered', recording the Rails-assigned id. */
    markDelivered (id, railsScanId) {
      stmts.markDelivered.run(Date.now(), railsScanId ?? null, id)
    },

    /** Transition a row to 'retry_wait', incrementing retry_count. */
    markRetryWait (id, nextAttemptAt, error) {
      stmts.markRetryWait.run(nextAttemptAt, String(error), id)
    },

    /** Transition a row to 'dead_letter'. */
    markDeadLetter (id, error) {
      stmts.markDeadLetter.run(String(error), id)
    },

    /** Return a {state: count} map for all non-zero states. */
    counts () {
      return Object.fromEntries(
        stmts.counts.all().map((r) => [r.delivery_state, r.count])
      )
    },

    close () {
      db.close()
    }
  }
}
