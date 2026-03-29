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
const logger = parentLogger.child({module: moduleName})

let mqttDoorState = 'up' // is this a good default?
let doorStateUpdateInProcess = 0

export function getDoorState (callback) {
  const error = ''
  const cacheKey = '__garage_authorizer__' + '/doorState'
  // check to see if we have a cached door state to reduce API calls
  // TODO make door state cache timeout configurable?
  const doorStateCached = cache.get(cacheKey)
  if (doorStateCached) {
    logger.info('getDoorState using cached result [%s]for door state', doorStateCached)
    callback && callback(error, doorStateCached)
  } else {
    if (doorStateUpdateInProcess) {
      logger.info(
        'getDoorState skipped door state due to pending update'
      )
    } else {
      logger.debug('getDoorState door state MQTT call')
      doorStateUpdateInProcess = 1
      // add state to cache for 15 seconds
      cache.put(cacheKey, mqttDoorState, 15000)
      doorStateUpdateInProcess = 0
      // TODO: callback wants an error (from got), but we don't have that here?
      callback(error, mqttDoorState)
    }
  }
}

export function openDoor () {
  logger.debug('opening door')

  mqttClient.publishAsync(config.mqtt.doorMoveTopic, 'move')
    .catch((err) => {
      logger.error('problem moving door: %s', err)
    })
}

mqttClient.on('error', (err) => {
  if (err) logger.error('MQTT error: %s', err)
})

mqttClient.on('connect', () => {
  logger.debug('MQTT connect')
  mqttClient.subscribeAsync(config.mqtt.doorStatusTopic)
    .then((granted) => {
      granted.forEach(subGranted => {
        logger.info('mqttclient door state topic [%s] subscribed QOS [%s]', subGranted.topic, subGranted.qos)
      });
    })
    .catch((err) => {
      logger.error('mqttclient problem subscribing to door topic: %s', err)
    })
})

mqttClient.on('message', (topic, message, packet) => {
  // received update to subscribed door state, update variable
  logger.debug('MQTT topic: %s, message: %s', topic, message)
  if (topic === config.mqtt.doorStatusTopic) {
    mqttDoorState = message.toString()
    logger.info('Setting door state to: %s', mqttDoorState)
  }
})
