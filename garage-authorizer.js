import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { parse } from 'csv-parse'
import memCache from 'memory-cache'
import got from 'got'
// import pino from 'pino'
import { logger } from './logger.js'
import config from './config.js'
import util from 'node:util'
// import { getDoorState, openDoor } from './particleDoor.js'
import { getDoorState, openDoor } from './mqttDoor.js'
import {
  isCommentLine,
  buildTagscan,
  parseHeader,
  normalizeMacAddress
} from './tagProtocol.js'
import {
  buildAuthorizeUrl,
  authorizationCacheKey,
  resolveAuthorizationAction
} from './authFlow.js'
import { applyHeaderToSession } from './sessionState.js'
import { openDb } from './outbox.js'
import { startWorker } from './outboxWorker.js'
import { capturePhoto, createCaptureQueue } from './camera.js'

export const cache = memCache

const readerConfigByMac = new Map(
  Object.entries(config.readers ?? {}).map(([rawMac, readerConfig]) => {
    const normalized = normalizeMacAddress(rawMac)
    return [normalized ?? String(rawMac).toUpperCase(), readerConfig]
  })
)

// TODO: need to make address for auth server configurable
// TODO: what happens when multiple clients connect and send data?
const server = net.createServer(function (socket) {
  const session = {
    buffer: '',
    mac: null,
    readerName: null,
    hostname: null,
    readerConfig: null,
    sourceIp: socket.remoteAddress
  }

  logger.info(
    'client connected from %s:%s',
    socket.remoteAddress,
    socket.remotePort
  )
  socket.setEncoding('utf8')
  // below addresses TODO to set a timeout on connections
  // TODO does this address memory / wrong type of client?
  // think web broswer that reconnects over and over
  socket.setTimeout(3000)
  socket.on('end', function () {
    logger.info(
      'client %s:%s disconnected',
      socket.remoteAddress,
      socket.remotePort
    )
  })
  socket.on('data', function (chunk) {
    session.buffer += chunk
    // look for NUL to indicate a complete set of data
    // from the reader/end of message from the reader
    // TODO need to timeout connection to avoid using up
    // memory due to connection that never closes + no
    // NUL terminators found
    let dIndex = session.buffer.indexOf('\0')
    while (dIndex > -1) {
      try {
        const block = session.buffer.substring(0, dIndex)
        handleBlock(block, session, socket)
        logger.info('Nul terminated input=%s', block)
      } catch (error) {
        logger.error('Inbound data parse error: ' + error)
      }
      session.buffer = session.buffer.substring(dIndex + 1)
      dIndex = session.buffer.indexOf('\0') // find next delimiter in buffer
    }
  })
  socket.on('error', function (e) {
    // TODO how do we handle other errors?
    logger.error('Socket error: %s', e.message)
  })
  socket.on('timeout', () => {
    logger.info('socket timeout')
    socket.end()
  })
})

function handleBlock (block, session, socket) {
  const lines = block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length === 0) return

  const parsedHeader = parseHeader(lines)
  if (parsedHeader.isHeader) {
    handleHeader(parsedHeader, session, socket)
    return
  }

  if (!session.mac) {
    logger.warn('Ignoring tag data block before MAC header was established')
    return
  }

  lines.forEach((line) => {
    if (isCommentLine(line)) return
    parseDataLine(line, session)
  })
}

function handleHeader (parsedHeader, session, socket) {
  const result = applyHeaderToSession(session, parsedHeader, readerConfigByMac)
  if (!result.ok) {
    if (result.reason === 'missing_mac') {
      logger.warn('Header block missing MACAddress; skipping block')
      return
    }
    logger.error({ mac: result.mac }, 'unknown_or_unconfigured_reader')
    socket.destroy()
    return
  }

  logger.info(
    {
      mac: session.mac,
      readerName: session.readerName,
      hostname: session.hostname
    },
    'reader_header_established'
  )
}

function parseDataLine (line, session) {
  parse(line, function (err, row) {
    if (err) return logger.error('parseInput error %s', err)

    row.forEach(function (parsedRow) {
      const eventId = randomUUID()
      const eventLogger = logger.child({ event_id: eventId })

      eventLogger.debug('parseInput = %s', parsedRow)
      const tagscan = buildTagscan(parsedRow, new Date().toISOString())

      if (!tagscan) {
        eventLogger.error('Invalid protocol input data received')
        return
      }

      tagscan.tagscan.mac = session.mac
      tagscan.tagscan.source_ip = session.sourceIp
      if (session.readerName) tagscan.tagscan.reader_name = session.readerName
      if (session.hostname) tagscan.tagscan.hostname = session.hostname

      eventLogger.info('parseInput result %s', JSON.stringify(tagscan))
      postTagscan(eventId, tagscan, eventLogger)

      const antenna = Number(tagscan.tagscan.antenna)
      const doorConfig = resolveDoorConfig(session.readerConfig, antenna)
      const cameraConfig = resolveCameraConfig(session.readerConfig, antenna)
      captureAndEnqueuePhoto(eventId, cameraConfig, eventLogger)
      authorizeTag(
        tagscan.tagscan.tag_epc,
        session.mac,
        antenna,
        doorConfig,
        eventLogger
      )
    })
  })
}

function resolveDoorConfig (readerConfig, antenna) {
  if (!readerConfig?.antennas) return null

  return (
    readerConfig.antennas[antenna] ??
    readerConfig.antennas[String(antenna)] ??
    null
  )
}

function resolveCameraConfig (readerConfig, antenna) {
  const antennaConfig =
    readerConfig?.antennas?.[antenna] ??
    readerConfig?.antennas?.[String(antenna)]
  const cameraName = antennaConfig?.camera
  if (!cameraName) return null

  return config.cameras?.[cameraName] ?? null
}

function postTagscan (eventId, data, eventLogger = logger) {
  try {
    outboxStore.enqueue(eventId, data)
    eventLogger.info('postTagscan enqueued')
  } catch (err) {
    eventLogger.error({ err: err.message }, 'postTagscan enqueue failed')
  }
}

function authorizeTag (tag, mac, antenna, doorConfig, eventLogger = logger) {
  if (!mac || Number.isNaN(antenna)) {
    eventLogger.warn(
      { tag, mac, antenna },
      'authorizeTag missing required context'
    )
    return
  }

  const tagauthorizeHost = config.tagauthorizeHost
  const authorizeUrl = buildAuthorizeUrl(tagauthorizeHost, tag, mac, antenna)
  const apiToken = config.apiToken
  const cacheKey = authorizationCacheKey(mac, antenna, tag)

  // check cache for key, if present skip authorization/opening
  const result = cache.get(cacheKey)
  eventLogger.info('authorizeTag in process')
  if (result) {
    // value cached so we can assume we don't have to do anything
    eventLogger.info(
      'authorizeTag skipping authorization for %s (%s) due to cache hit!',
      tag,
      mac
    )
  } else {
    // cache the fact that we are processing this tag
    // cache for 30 seconds
    // TODO below needs error handling
    cache.put(cacheKey, '1', 30000)

    got(authorizeUrl, {
      headers: {
        Authorization: 'Bearer ' + apiToken
      }
    })
      .json()
      .then((authReply) => {
        eventLogger.debug(
          'authorizeTag auth reply = ' + util.inspect(authReply)
        )
        const action = resolveAuthorizationAction(
          authReply.response,
          doorConfig
        )
        if (action === 'open_door') {
          getDoorState(
            doorConfig,
            (error, state) =>
              processDoorState(error, state, doorConfig, eventLogger),
            eventLogger
          )
          eventLogger.info(
            'authorizeTag %s authorized for %s antenna %s',
            tag,
            mac,
            antenna
          )
        } else if (action === 'misconfigured') {
          eventLogger.warn(
            { mac, antenna, tag },
            'authorized_but_no_door_config_for_antenna'
          )
        } else if (action === 'record_only') {
          eventLogger.info(
            'authorizeTag record_only for %s on %s antenna %s',
            tag,
            mac,
            antenna
          )
        } else {
          eventLogger.info(
            'authorizeTag %s denied for %s antenna %s',
            tag,
            mac,
            antenna
          )
        }
      })
      .catch((error) => {
        eventLogger.error(
          'authorizeTag authorization error (' + error.code + '): ' + error
        )
      })
  }
}

function processDoorState (error, state, doorConfig, eventLogger = logger) {
  eventLogger.debug('doorState = %s', state)
  if (error) {
    return eventLogger.error('processDoorState door state error %s', error)
  }
  if (state === 'down') {
    eventLogger.info('processDoorState door down, opening door')
    openDoor(doorConfig, eventLogger)
  } else {
    // TODO: handle nonsense values here
    // console.log(state)
    eventLogger.info('processDoorState door up, no action needed')
  }
}

server.on('error', function (err) {
  throw err
})

// Initialise outbox before the server starts accepting connections.
const outboxStore = openDb(config.outboxDbPath ?? './outbox.db')
logger.info({ path: config.outboxDbPath ?? './outbox.db' }, 'outbox:opened')
const worker = startWorker(outboxStore, config, logger)

// Set up photo capture if any cameras are configured.
const captureQueue = createCaptureQueue()
const photosDir =
  Object.keys(config.cameras ?? {}).length > 0
    ? path.resolve(config.photosDir ?? './photos')
    : null
if (photosDir) {
  fs.mkdirSync(photosDir, { recursive: true })
  logger.info({ photosDir }, 'photos:dir')
}

async function captureAndEnqueuePhoto (
  eventId,
  cameraConfig,
  eventLogger = logger
) {
  if (!photosDir || !cameraConfig) return
  captureQueue.enqueue(async () => {
    const filePath = path.join(photosDir, `${eventId}.jpg`)
    try {
      const { data, contentType } = await capturePhoto(cameraConfig)
      await fs.promises.writeFile(filePath, data)
      outboxStore.enqueuePhoto(eventId, filePath, contentType)
      eventLogger.info({ filePath }, 'photo:captured')
    } catch (err) {
      eventLogger.warn({ err: err.message }, 'photo:capture_failed')
    }
  })
}

function shutdown () {
  logger.info('shutting down')
  worker.stop()
  outboxStore.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

server.listen(
  config.listenPort || 1337,
  config.listenAddr || '127.0.0.1',
  function () {
    logger.info(
      'server bound to %s:%s',
      server.address().address,
      server.address().port
    )
  }
)
