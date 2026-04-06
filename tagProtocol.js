/**
 * Helpers for the RFID reader protocol.
 * Safe to import in tests.
 */

/**
 * Returns true if the line should be skipped as a comment.
 * The reader protocol treats any line containing '#' as a comment.
 */
export function isCommentLine (line) {
  return /(#.*)/.test(line)
}

/**
 * Given a parsed CSV row array and the ISO 8601 timestamp at which the scan
 * was received, returns a tagscan payload object, or null when the row is
 * too short to be a valid reader frame.
 *
 * `receivedAt` is stamped by the caller at the moment the row is parsed so
 * that the outbox can forward the original scan time to Rails even if
 * delivery is delayed.
 *
 * Field positions from the RFID reader protocol:
 *   row[0] = tag_epc
 *   row[1] = rssi
 *   row[5] = antenna
 *   row[6] = tag_pc
 *
 * A minimum of 7 fields are required (indices 0–6).
 */
export function buildTagscan (row, receivedAt) {
  if (!row || row.length < 7) return null
  return {
    tagscan: {
      tag_epc: row[0],
      tag_pc: row[6],
      antenna: row[5],
      rssi: row[1],
      received_at: receivedAt
    }
  }
}
