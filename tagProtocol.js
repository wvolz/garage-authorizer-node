/**
 * Helpers for the RFID reader protocol.
 * Safe to import in tests.
 */

/**
 * Returns true if the line should be skipped as a comment.
 * The reader protocol uses lines starting with '#' for metadata headers.
 */
export function isCommentLine (line) {
  return /^\s*#/.test(line ?? '')
}

/**
 * Normalizes MAC addresses to uppercase colon-separated format.
 * Accepts values with or without separators.
 */
export function normalizeMacAddress (value) {
  if (!value) return null

  const cleaned = String(value)
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-F]/g, '')
  if (cleaned.length !== 12) return null

  return cleaned.match(/.{1,2}/g).join(':')
}

/**
 * Parse a potential header block from reader protocol lines.
 * Returns parsed keys and a boolean indicating whether this looks like a
 * header block. A non-header banner line (without ':') is tolerated.
 */
export function parseHeader (lines) {
  const parsed = {}

  for (const rawLine of lines ?? []) {
    const line = String(rawLine).trim().replace(/^#\s*/, '')
    const match = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/)
    if (!match) continue
    parsed[match[1]] = match[2].trim()
  }

  const mac = normalizeMacAddress(parsed.MACAddress)
  const readerName = parsed.ReaderName
  const hostname = parsed.Hostname
  const isHeader = Boolean(mac || readerName || hostname)

  return {
    isHeader,
    mac,
    readerName,
    hostname
  }
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
