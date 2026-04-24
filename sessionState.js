export function applyHeaderToSession (session, parsedHeader, readerConfigByMac) {
  if (!parsedHeader?.mac) {
    return { ok: false, reason: 'missing_mac' }
  }

  const readerConfig = readerConfigByMac.get(parsedHeader.mac)
  if (!readerConfig) {
    return { ok: false, reason: 'unknown_mac', mac: parsedHeader.mac }
  }

  session.mac = parsedHeader.mac
  session.readerName = parsedHeader.readerName ?? session.readerName
  session.hostname = parsedHeader.hostname ?? session.hostname
  session.readerConfig = readerConfig

  return { ok: true }
}
