import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseHeader } from '../tagProtocol.js'
import { applyHeaderToSession } from '../sessionState.js'

test('applyHeaderToSession rejects unknown MACs', () => {
  const session = {}
  const parsedHeader = parseHeader([
    '#ReaderName: RFID Reader',
    '#Hostname: BEEF-unknown',
    '#MACAddress: 00:AA:BB:CC:DD:EE'
  ])
  const readerConfigByMac = new Map()

  const result = applyHeaderToSession(session, parsedHeader, readerConfigByMac)

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'unknown_mac')
  assert.equal(session.mac, undefined)
})

test('applyHeaderToSession updates session across repeated headers', () => {
  const session = {}
  const readerConfig = { antennas: { 1: { driver: 'mqtt' } } }
  const readerConfigByMac = new Map([['00:DE:AD:BE:EF:11', readerConfig]])

  const first = applyHeaderToSession(
    session,
    parseHeader([
      '#ReaderName: RFID Reader',
      '#Hostname: BEEF11',
      '#MACAddress: 00:DE:AD:BE:EF:11'
    ]),
    readerConfigByMac
  )

  const second = applyHeaderToSession(
    session,
    parseHeader([
      '#ReaderName: RFID Reader v2',
      '#Hostname: BEEF11-new',
      '#MACAddress: 00:DE:AD:BE:EF:11'
    ]),
    readerConfigByMac
  )

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(session.mac, '00:DE:AD:BE:EF:11')
  assert.equal(session.hostname, 'BEEF11-new')
  assert.equal(session.readerName, 'RFID Reader v2')
})
