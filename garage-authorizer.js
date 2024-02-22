import net from 'node:net'
import { parse } from 'csv-parse'
import cache from 'memory-cache'
import got from 'got'
import pino from 'pino'
import config from './config.js'
import util from 'node:util'

const logger = pino({
  // prettyPrint: {
  //   colorize: true,
  //   translateTime: "SYS:standard",
  // },
  level: process.env.LOG_LEVEL || 'info'
})

let doorStateUpdateInProcess = 0

// TODO: need to make address for auth server configurable
// TODO: what happens when multiple clients connect and send data?
const server = net.createServer(function (socket) {
  logger.info('client connected from %s:%s', socket.remoteAddress, socket.remotePort)
  socket.setEncoding('utf8')
  // below addresses TODO to set a timeout on connections
  // TODO does this address memory / wrong type of client?
  // think web broswer that reconnects over and over
  socket.setTimeout(3000)
  let data = ''
  socket.on('end', function () {
    logger.info('client %s:%s disconnected', socket.remoteAddress, socket.remotePort)
  })
  socket.on('data', function (chunk) {
    // logger.debug(data);
    data += chunk
    // look for NUL to indicate a complete set of data
    // from the reader/end of message from the reader
    // TODO need to timeout connection to avoid using up
    // memory due to connection that never closes + no
    // NUL terminators found
    let dIndex = data.indexOf('\0')
    while (dIndex > -1) {
      try {
        const string = data.substring(0, dIndex)
        // call process function here
        parseInput(string)
        logger.info('Nul terminated input=' + string)
      } catch (error) {
        logger.error('Inbound data parse error: ' + error)
      }
      data = data.substring(dIndex + 1)
      dIndex = data.indexOf('\0') // find next delimiter in buffer
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

function parseInput (data) {
  // end of message = \0 \u0000 or NUL
  const inData = data.split('\0')
  inData.forEach(function (x) {
    // broken out by newlines
    const xLines = x.split('\r\n')
    xLines.forEach(function (line) {
      const hashComment = /(#.*)/
      if (hashComment.test(line)) {
        return
      }
      parse(line, function (err, row) {
        // logger.debug(row);
        if (err) return logger.error('parseInput error %s', err)
        row.forEach(function (y) {
          logger.debug('parseInput = %s', y)
          const tag = { tag_epc: y[0], tag_pc: y[6], antenna: y[5], rssi: y[1] }
          const tagscan = { tagscan: tag }

          // make sure we parsed some data
          // TODO more detailed error checking
          if (y.length < 7) {
            const error = new Error('Invalid protocol input data received')
            // TODO do we need to hangup the connection here?
            // socket.destroy(error);
          } else {
            logger.info('parseInput result %s', JSON.stringify(tagscan))
            postTagscan(tagscan)
            // filter out false readings from antenna 0
            if (tag.antenna == 1) {
              authorizeTag(tag.tag_epc)
            }
            // TODO do we need to hangup the connection here?
            // socket.end();
          }
        })
      })
    })
  })
}

function postTagscan (data) {
  const dataPostUrl = config.tagscanUrl
  const apiToken = config.apiToken

  const gotOptions = {
    json: data,
    headers: {
      Authorization: 'Bearer ' + apiToken
    }
  }

  got
    .post(
      dataPostUrl,
      gotOptions
      /* ).then( (response) => {
        // check for success here?
    } */
    )
    .then((postReply) => {
      logger.info('postTagscan completed successfully')
      logger.debug('postTagscan reply = %s', postReply.body)
    })
    .catch((error) => {
      logger.error(`Problem with post request (${error.code}): ${error}`)
    })
}

function authorizeTag (tag) {
  // note in line below a= is the authorization ie: garage = 1
  // http://localhost:3000/tags/1234566ef/authorize.json?a=1
  const tagauthorizeHost = config.tagauthorizeHost
  const authorizeUrl =
    tagauthorizeHost + '/tags/' + tag + '/authorize.json?a=1'
  const apiToken = config.apiToken
  const cacheKey = '__garage_authorizer__' + '/authorizing/' + tag

  // check cache for key, if present skip authorization/opening
  const result = cache.get(cacheKey)
  logger.info('authorizeTag in process')
  if (result) {
    // value cached so we can assume we don't have to do anything
    logger.info('authorizeTag skipping authorization for ' + tag + ' due to cache hit!')
  } else {
    // cache the fact that we are processing this tag
    // cache for 30 seconds
    cache.put(cacheKey, '1', 30000)
    got(authorizeUrl, {
      headers: {
        Authorization: 'Bearer ' + apiToken
      }
    })
      .json()
      .then((authReply) => {
        logger.debug('authorizeTag auth reply = ' + util.inspect(authReply))
        if (authReply.response === 'authorized') {
          getDoorState(processDoorState)
          logger.info('authorizeTag ' + tag + ' authorized')
        }
      })
      .catch((error) => {
        logger.error('authorizeTag authorization error (' + error.code + '): ' + error)
      })
  }
}

function getDoorState (callback) {
  // check door state
  // TODO reduce number of calls to "callback"
  // TODO below should be configurable
  const apiUrl = config.particle.apiUrl
  const deviceId = config.particle.deviceId
  const accessToken = config.particle.accessToken

  const url = apiUrl + deviceId + '/doorstate?accessToken=' + accessToken

  const error = ''
  let result = 'up' // default to up?
  const cacheKey = '__garage_authorizer__' + '/doorState'
  // check to see if we have a cached door state to reduce API calls
  // TODO make door state cache timeout configurable?
  const doorStateCached = cache.get(cacheKey)
  if (doorStateCached) {
    logger.info('getDoorState using cached result for door state')
    callback && callback(error, doorStateCached)
  } else {
    if (doorStateUpdateInProcess) {
      logger.info('getDoorState skipped door state API call due to pending update')
    } else {
      logger.debug('getDoorState door state API call = %s', url)
      doorStateUpdateInProcess = 1
      // get state from particle API
      got(url)
        .json()
        .then((apiResponse) => {
          // default encoding is utf-8
          logger.debug('getDoorState got door state')
          logger.debug('getDoorState api response = ' + util.inspect(apiResponse))
          result = apiResponse.result // error handling on this?
          // add state to cache for 15 seconds
          cache.put(cacheKey, result, 15000)
          doorStateUpdateInProcess = 0
          callback && callback(error, result)
        })
        .catch((error) => {
          // logger.warn(error);
          // Don't update door state here?
          doorStateUpdateInProcess = 0
          callback && callback(error, result)
        })
    }
  }
}

function processDoorState (error, state) {
  if (error) return logger.error('processDoorState door state error %s', error)
  if (state === 'down') {
    logger.info('processDoorState door down, opening door')
    openDoor(error)
  } else {
    logger.info('processDoorState door up, no action needed')
  }
}

function openDoor (error) {
  if (error) return logger.error('openDoor error %s', error)
  // TODO below should be configurable
  const apiUrl = config.particle.apiUrl
  const deviceId = config.particle.deviceId
  const accessToken = config.particle.accessToken

  const url = apiUrl + deviceId + '/door1move?accessToken=' + accessToken

  logger.debug('openDoor API request URL = %s', url)

  got
    .post(url)
    .json()
    .then((apiResponse) => {
      logger.info('openDoor success')
      logger.debug('openDoor API response = ' + util.inspect(apiResponse))
    })
    .catch((error) => {
      logger.error('openDoor error moving door = ' + error)
    })
}

server.on('error', function (err) {
  throw err
})

server.listen(
  config.listen_port || 1337,
  config.listen_addr || '127.0.0.1',
  function () {
    logger.info('server bound to %s:%s', server.address().address, server.address().port)
  }
)
