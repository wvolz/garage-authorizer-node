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
  (db) =>
    db.exec(`
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
  `),

  // v2 — photo outbox (stores file path on disk rather than blob)
  (db) =>
    db.exec(`
    CREATE TABLE photo_outbox (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id        TEXT    NOT NULL,
      file_path       TEXT    NOT NULL,
      content_type    TEXT    NOT NULL DEFAULT 'image/jpeg',
      delivery_state  TEXT    NOT NULL DEFAULT 'queued',
      retry_count     INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      last_attempt_at INTEGER,
      delivered_at    INTEGER,
      last_error      TEXT,
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX idx_photo_outbox_claim
      ON photo_outbox (next_attempt_at)
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
    `),

    enqueuePhoto: db.prepare(`
      INSERT INTO photo_outbox (event_id, file_path, content_type, delivery_state, next_attempt_at, created_at)
      VALUES (?, ?, ?, 'queued', 0, ?)
    `),

    claimDuePhotos: db.prepare(`
      UPDATE photo_outbox
      SET delivery_state = 'sending', last_attempt_at = ?
      WHERE id IN (
        SELECT id FROM photo_outbox
        WHERE delivery_state IN ('queued','retry_wait') AND next_attempt_at <= ?
        ORDER BY next_attempt_at ASC
        LIMIT ?
      )
      RETURNING *
    `),

    markPhotoDelivered: db.prepare(`
      UPDATE photo_outbox
      SET delivery_state = 'delivered', delivered_at = ?
      WHERE id = ?
    `),

    markPhotoRetryWait: db.prepare(`
      UPDATE photo_outbox
      SET delivery_state  = 'retry_wait',
          retry_count     = retry_count + 1,
          next_attempt_at = ?,
          last_error      = ?
      WHERE id = ?
    `),

    markPhotoDeadLetter: db.prepare(`
      UPDATE photo_outbox
      SET delivery_state = 'dead_letter', last_error = ?
      WHERE id = ?
    `),

    photoCounts: db.prepare(`
      SELECT delivery_state, COUNT(*) as count
      FROM photo_outbox
      GROUP BY delivery_state
    `),

    // Returns rows with file_path for delivered photos older than cutoffMs,
    // then deletes them. Dead-lettered photos are retained for manual review.
    selectPurgablePhotos: db.prepare(`
      SELECT id, file_path FROM photo_outbox
      WHERE delivery_state = 'delivered' AND delivered_at < ?
    `),

    deletePurgablePhotos: db.prepare(`
      DELETE FROM photo_outbox
      WHERE delivery_state = 'delivered' AND delivered_at < ?
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

    /** Insert a new photo into the photo outbox as 'queued'. */
    enqueuePhoto (eventId, filePath, contentType = 'image/jpeg') {
      stmts.enqueuePhoto.run(eventId, filePath, contentType, Date.now())
    },

    /** Atomically claim up to `limit` due photo rows and transition them to 'sending'. */
    claimDuePhotos (limit = 10) {
      const now = Date.now()
      return stmts.claimDuePhotos.all(now, now, limit)
    },

    /** Transition a photo row to 'delivered'. */
    markPhotoDelivered (id) {
      stmts.markPhotoDelivered.run(Date.now(), id)
    },

    /** Transition a photo row to 'retry_wait', incrementing retry_count. */
    markPhotoRetryWait (id, nextAttemptAt, error) {
      stmts.markPhotoRetryWait.run(nextAttemptAt, String(error), id)
    },

    /** Transition a photo row to 'dead_letter'. */
    markPhotoDeadLetter (id, error) {
      stmts.markPhotoDeadLetter.run(String(error), id)
    },

    /** Return a {state: count} map for photo outbox states. */
    photoCounts () {
      return Object.fromEntries(
        stmts.photoCounts.all().map((r) => [r.delivery_state, r.count])
      )
    },

    /**
     * Return file_path values for delivered photos older than cutoffMs,
     * then delete those rows. Dead-lettered photos are NOT purged.
     * @param {number} cutoffMs  Unix timestamp in ms; rows with delivered_at < this are purged.
     * @returns {string[]}  Array of file paths to delete from disk.
     */
    purgablePhotos (cutoffMs) {
      const rows = stmts.selectPurgablePhotos.all(cutoffMs)
      stmts.deletePurgablePhotos.run(cutoffMs)
      return rows.map((r) => r.file_path)
    },

    close () {
      db.close()
    }
  }
}
