// mqtt door driver
// api should provide two functions:
// - getDoorState
// - moveDoor

import mqtt from 'mqtt'
import config from './config.js'
import { logger as parentLogger } from './logger.js'
import { cache } from './garage-authorizer.js'

const mqttClient = mqtt.connect(config.mqtt.broker)
const moduleName = 'MQTTDriver'
const logger = parentLogger.child({ module: moduleName })

const mqttDoorStates = new Map()
const doorStateUpdateInProcess = new Set()
const subscribedTopics = new Set()

function configuredDoorStatusTopics () {
  const topics = new Set()

  for (const readerConfig of Object.values(config.readers ?? {})) {
    for (const antennaConfig of Object.values(readerConfig?.antennas ?? {})) {
      if (antennaConfig?.doorStatusTopic) {
        topics.add(antennaConfig.doorStatusTopic)
      }
    }
  }

  return topics
}

function cacheKeyForTopic (topic) {
  return `__garage_authorizer__/doorState/${topic}`
}

function ensureSubscribed (doorStatusTopic) {
  if (!doorStatusTopic || subscribedTopics.has(doorStatusTopic)) return

  mqttClient
    .subscribeAsync(doorStatusTopic)
    .then((granted) => {
      subscribedTopics.add(doorStatusTopic)
      granted.forEach((subGranted) => {
        logger.info(
          'mqttclient door state topic [%s] subscribed QOS [%s]',
          subGranted.topic,
          subGranted.qos
        )
      })
    })
    .catch((err) => {
      logger.error('mqttclient problem subscribing to door topic: %s', err)
    })
}

export function getDoorState (doorConfig, callback, log = logger) {
  const error = ''
  const doorStatusTopic = doorConfig?.doorStatusTopic
  if (!doorStatusTopic) {
    callback && callback(new Error('doorStatusTopic is required'))
    return
  }

  ensureSubscribed(doorStatusTopic)

  const cacheKey = cacheKeyForTopic(doorStatusTopic)
  // check to see if we have a cached door state to reduce API calls
  // TODO make door state cache timeout configurable?
  const doorStateCached = cache.get(cacheKey)
  if (doorStateCached) {
    log.info(
      'getDoorState using cached result [%s]for door state',
      doorStateCached
    )
    callback && callback(error, doorStateCached)
  } else {
    if (doorStateUpdateInProcess.has(doorStatusTopic)) {
      log.info('getDoorState skipped door state due to pending update')
    } else {
      log.debug('getDoorState door state MQTT call')
      doorStateUpdateInProcess.add(doorStatusTopic)
      const currentState = mqttDoorStates.get(doorStatusTopic) ?? 'up'
      // add state to cache for 15 seconds
      cache.put(cacheKey, currentState, 15000)
      doorStateUpdateInProcess.delete(doorStatusTopic)
      // TODO: callback wants an error (from got), but we don't have that here?
      callback(error, currentState)
    }
  }
}

export function openDoor (doorConfig, log = logger) {
  const doorMoveTopic = doorConfig?.doorMoveTopic
  if (!doorMoveTopic) {
    log.error('openDoor missing doorMoveTopic')
    return
  }

  log.debug('opening door')

  mqttClient.publishAsync(doorMoveTopic, 'OPEN').catch((err) => {
    log.error('problem moving door: %s', err)
  })
}

mqttClient.on('error', (err) => {
  if (err) logger.error('MQTT error: %s', err)
})

mqttClient.on('connect', () => {
  logger.debug('MQTT connect')
  for (const topic of configuredDoorStatusTopics()) {
    ensureSubscribed(topic)
  }
})

mqttClient.on('message', (topic, message, packet) => {
  // received update to subscribed door state, update variable
  logger.debug('MQTT topic: %s, message: %s', topic, message)
  const previousState = mqttDoorStates.get(topic)
  const newState = message.toString()
  // filters out duplicate status
  if (newState !== previousState) {
    mqttDoorStates.set(topic, newState)
    logger.info('Setting [%s] door state to: %s', topic, newState)
  }
})
