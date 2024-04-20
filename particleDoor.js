// Particle door driver
// api should provide two functions:
// - getDoorState
// - moveDoor

import got from 'got'
import util from 'node:util'
import config from './config.js'
import { logger } from './logger.js'
import { cache } from './garage-authorizer.js'

let doorStateUpdateInProcess = 0

export function getDoorState (callback) {
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
      logger.info(
        'getDoorState skipped door state API call due to pending update'
      )
    } else {
      logger.debug('getDoorState door state API call = %s', url)
      doorStateUpdateInProcess = 1
      // get state from particle API
      got(url)
        .json()
        .then((apiResponse) => {
          // default encoding is utf-8
          logger.debug('getDoorState got door state')
          logger.debug(
            `getDoorState api response = ${util.inspect(apiResponse)}`
          )
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

export function openDoor (error) {
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
