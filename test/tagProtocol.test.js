import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  isCommentLine,
  buildTagscan,
  parseHeader,
  normalizeMacAddress
} from '../tagProtocol.js'

// ---------------------------------------------------------------------------
// isCommentLine
// ---------------------------------------------------------------------------

test('isCommentLine', async (t) => {
  await t.test('returns true for a line that starts with #', () => {
    assert.equal(isCommentLine('# this is a comment'), true)
  })

  await t.test('returns false when # appears later in a data line', () => {
    assert.equal(isCommentLine('some,data#comment'), false)
  })

  await t.test('returns false for a normal CSV data line', () => {
    assert.equal(
      isCommentLine('E0DEADBEEF0002DEADBEEF11,-55,0,0,0,1,3400'),
      false
    )
  })

  await t.test('returns false for an empty string', () => {
    assert.equal(isCommentLine(''), false)
  })

  await t.test('returns false for whitespace-only line', () => {
    assert.equal(isCommentLine('   '), false)
  })
})

// ---------------------------------------------------------------------------
// MAC / Header parsing
// ---------------------------------------------------------------------------

test('normalizeMacAddress normalizes mixed-format input', () => {
  assert.equal(normalizeMacAddress('00-de-ad-be-ef-11'), '00:DE:AD:BE:EF:11')
  assert.equal(normalizeMacAddress('00DEADBEEF11'), '00:DE:AD:BE:EF:11')
  assert.equal(normalizeMacAddress('invalid'), null)
})

test('parseHeader extracts MACAddress, ReaderName, and Hostname', () => {
  const header = parseHeader([
    '#RFID Reader Tag Stream',
    '#ReaderName: RFID Reader',
    '#Hostname: rfid-BEEF11',
    '#MACAddress: 00:DE:AD:BE:EF:11'
  ])

  assert.equal(header.isHeader, true)
  assert.equal(header.readerName, 'RFID Reader')
  assert.equal(header.hostname, 'rfid-BEEF11')
  assert.equal(header.mac, '00:DE:AD:BE:EF:11')
})

test('parseHeader works with known sample header blocks', async () => {
  const samplePath = path.resolve('reader_sample_data-sanitize.txt')
  const sample = await fs.readFile(samplePath, 'utf8')
  const [headerBlock] = sample.split('\u0000')
  const lines = headerBlock.split(/\r?\n/)
  const parsed = parseHeader(lines)

  assert.equal(parsed.isHeader, true)
  assert.equal(parsed.readerName, 'RFID Reader')
  assert.equal(parsed.hostname, 'rfid-BEEF11')
  assert.equal(parsed.mac, '00:DE:AD:BE:EF:11')
})

test('known sample contains multi-tag data block lines', async () => {
  const samplePath = path.resolve('reader_sample_data-sanitize.txt')
  const sample = await fs.readFile(samplePath, 'utf8')
  const blocks = sample.split('\u0000').filter(Boolean)
  const firstDataBlock = blocks.find((block) =>
    block.includes('E80000BEEFDEADBEEFDEAD4D')
  )

  const dataLines = firstDataBlock
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !isCommentLine(line))

  assert.equal(dataLines.length, 3)
})

// ---------------------------------------------------------------------------
// buildTagscan — field mapping
// ---------------------------------------------------------------------------

// A representative row from the reader protocol.
// Indices: 0=epc  1=rssi  2=? 3=? 4=? 5=antenna  6=pc
const VALID_ROW = [
  'E0DEADBEEF0002DEADBEEF11',
  '-55',
  '0',
  '0',
  '0',
  '1',
  '3400'
]
const FIXED_TS = '2026-04-01T12:00:00.000Z'

test('buildTagscan returns correct tagscan shape for a valid row', () => {
  const result = buildTagscan(VALID_ROW, FIXED_TS)
  assert.deepEqual(result, {
    tagscan: {
      tag_epc: 'E0DEADBEEF0002DEADBEEF11',
      tag_pc: '3400',
      antenna: '1',
      rssi: '-55',
      received_at: FIXED_TS
    }
  })
})

test('buildTagscan maps the correct column positions', () => {
  // Use sentinel values at each position so any swap is immediately visible.
  const row = ['EPC', 'RSSI', 'C2', 'C3', 'C4', 'ANTENNA', 'PC']
  const { tagscan } = buildTagscan(row, FIXED_TS)
  assert.equal(tagscan.tag_epc, 'EPC', 'row[0] → tag_epc')
  assert.equal(tagscan.rssi, 'RSSI', 'row[1] → rssi')
  assert.equal(tagscan.antenna, 'ANTENNA', 'row[5] → antenna')
  assert.equal(tagscan.tag_pc, 'PC', 'row[6] → tag_pc')
  assert.equal(
    tagscan.received_at,
    FIXED_TS,
    'received_at forwarded from caller'
  )
})

test('buildTagscan accepts a row with exactly 7 fields (minimum valid)', () => {
  const row = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
  assert.notEqual(buildTagscan(row, FIXED_TS), null)
})

test('buildTagscan accepts rows with more than 7 fields', () => {
  const row = [...VALID_ROW, 'extra1', 'extra2']
  assert.deepEqual(
    buildTagscan(row, FIXED_TS),
    buildTagscan(VALID_ROW, FIXED_TS)
  )
})

// ---------------------------------------------------------------------------
// buildTagscan — invalid / short rows
// ---------------------------------------------------------------------------

test('buildTagscan returns null for a row with 6 fields', () => {
  assert.equal(buildTagscan(['A', 'B', 'C', 'D', 'E', 'F']), null)
})

test('buildTagscan returns null for an empty array', () => {
  assert.equal(buildTagscan([]), null)
})

test('buildTagscan returns null for null input', () => {
  assert.equal(buildTagscan(null), null)
})

test('buildTagscan returns null for undefined input', () => {
  assert.equal(buildTagscan(undefined), null)
})
