import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { jetstream } from '@nats-io/jetstream'
import { connectBroker, isBrokerServer, natsName } from './jetstream.js'
import { SubscriberJournalError } from './journal.js'
import { DeliveryError, deliverMate, deliverWebhook, mateDestination, webhookDestination } from './subscriber-destinations.js'

export class SubscriberConfigurationError extends Error {}

const idPattern = /^[a-zA-Z0-9:_-]{1,256}$/
const topicToken = /^[^\s.*>\u0000-\u001f\u007f]+$/u
const flavors = {
  mate: { destination: mateDestination, deliver: deliverMate },
  webhook: { destination: webhookDestination, deliver: deliverWebhook },
}

function validTopicFilter(filter) {
  if (typeof filter !== 'string') return false
  const tokens = filter.split('.')
  return tokens.every((token, index) => topicToken.test(token) || token === '*' ||
    (token === '>' && index === tokens.length - 1))
}

function matchesTopic(filter, topic) {
  const tokens = topic.split('.')
  const pattern = filter.split('.')
  const multi = pattern.at(-1) === '>'
  if (multi ? tokens.length < pattern.length : tokens.length !== pattern.length) return false
  return pattern.every((part, index) => part === '*' || part === '>' || part === tokens[index])
}

export async function readSubscriberConfig(path) {
  if (!path) throw new SubscriberConfigurationError('set --config for the subscriber')
  let config
  try {
    config = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new SubscriberConfigurationError('cannot read the subscriber configuration as JSON')
  }
  const { name, flavor, stream, server, topics } = config ?? {}
  if (![name, stream].every(value => typeof value === 'string' && natsName.test(value))) {
    throw new SubscriberConfigurationError('name and stream must use letters, digits, hyphens or underscores')
  }
  if (!isBrokerServer(server)) throw new SubscriberConfigurationError('server must be a NATS URL without credentials or a path')
  if (!Array.isArray(topics) || topics.length === 0 || !topics.every(validTopicFilter)) {
    throw new SubscriberConfigurationError('topics must list NATS subject filters')
  }
  if (!Object.hasOwn(flavors, flavor)) throw new SubscriberConfigurationError('flavor must be mate or webhook')
  if (flavor === 'mate' && (topics.length !== 1 || !/^inbox\.mate\.[a-zA-Z0-9_-]+$/.test(topics[0]))) {
    throw new SubscriberConfigurationError('mate subscribers require one exact inbox.mate.<home> topic')
  }
  let destination
  try {
    destination = flavors[flavor].destination(config.destination)
  } catch (error) {
    throw new SubscriberConfigurationError(error.message)
  }
  return { name, flavor, stream, server, topics: [...new Set(topics)].sort(), destination }
}

function readMessage(message, topics) {
  let event
  try {
    event = message.json()
  } catch {
    throw new DeliveryError('broker message is not JSON')
  }
  // Match the delivered subject as well as the envelope. A misrouted event
  // must stay pending instead of reaching an unrelated home or endpoint.
  if (typeof event?.event_id !== 'string' || !idPattern.test(event.event_id) ||
      event.topic !== message.subject || !topics.some(topic => matchesTopic(topic, message.subject))) {
    throw new DeliveryError('broker message requires a stable ID and a matching topic')
  }
  return event
}

export function deliveryRequestId(event) {
  return 'tinstar-' + createHash('sha256').update(event.topic + '\n' + event.event_id).digest('hex')
}

export async function deliverMessage(journal, config, message, token) {
  let requestId = null
  let receiptId = null
  try {
    const event = readMessage(message, config.topics)
    requestId = deliveryRequestId(event)
    receiptId = journal.subscriberReceipt(config.name, requestId)
    if (!receiptId) {
      receiptId = await flavors[config.flavor].deliver(config.destination, event, requestId, token)
      journal.recordSubscriberReceipt(config.name, requestId, event.event_id, receiptId)
    }
  } catch (error) {
    if (!(error instanceof DeliveryError)) throw error
    const reason = `stream message #${message.seq}: ${error.message}`
    journal.updateSubscriber(config.name, 'retrying', reason, { sequence: message.seq, requestId, receiptId: error.receiptId })
    console.error(`JetStream subscriber ${config.name}: ${reason}`)
    const attempt = message.info.deliveryCount
    message.nak(Math.min(60, 2 ** Math.min(attempt, 6)) * 1000)
    return
  }
  // A lost broker acknowledgment can cause redelivery. The durable local
  // receipt makes the next attempt skip the external side effect.
  journal.updateSubscriber(config.name, 'received', null, { sequence: message.seq, requestId, receiptId })
  const confirmed = await message.ackAck({ timeout: 5000 }).catch(() => false)
  if (!confirmed) throw new DeliveryError('broker did not confirm the acknowledgment')
  journal.updateSubscriber(config.name, 'ok', null, { sequence: message.seq, requestId, receiptId })
}

export async function runSubscriber(journal, config, seed, token, signal) {
  journal.registerSubscriber(config)
  let delay = 1000
  while (!signal.aborted) {
    let nc
    try {
      const prefix = `_INBOX.tinstar_subscriber.${config.name}`
      nc = await connectBroker(config.server, config.name, prefix, seed)
      const consumer = await jetstream(nc, { timeout: 5000, checkAPI: false }).consumers.get(config.stream, config.name)
      const { config: durable } = await consumer.info(true)
      const filters = durable.filter_subjects ?? (durable.filter_subject ? [durable.filter_subject] : [])
      if (durable.ack_policy !== 'explicit' || durable.deliver_subject ||
          JSON.stringify([...filters].sort()) !== JSON.stringify(config.topics)) {
        throw new DeliveryError('broker durable must be a pull consumer with explicit ack and the configured topic filters')
      }
      journal.updateSubscriber(config.name, 'connected')
      delay = 1000
      const messages = await consumer.consume({ max_messages: 1 })
      const stop = () => messages.stop()
      signal.addEventListener('abort', stop, { once: true })
      try {
        if (signal.aborted) stop()
        for await (const message of messages) {
          if (signal.aborted) break
          await deliverMessage(journal, config, message, token)
        }
        if (!signal.aborted) throw new DeliveryError('broker delivery stopped')
      } finally {
        signal.removeEventListener('abort', stop)
        stop()
      }
    } catch (error) {
      if (error instanceof SubscriberJournalError) throw error
      if (signal.aborted) break
      const reason = error instanceof DeliveryError ? error.message : 'broker connection or consumer pull failed'
      journal.updateSubscriber(config.name, 'retrying', reason)
      console.error(`JetStream subscriber ${config.name}: ${reason}; retry in ${delay / 1000}s`)
      await sleep(delay, undefined, { signal }).catch(error => {
        if (error.name !== 'AbortError') throw error
      })
      delay = Math.min(delay * 2, 30_000)
    } finally {
      await nc?.close()
    }
  }
  journal.updateSubscriber(config.name, 'stopped')
}
