import { readFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { jetstream } from '@nats-io/jetstream'
import { connect, nkeyAuthenticator } from '@nats-io/transport-node'

const namePattern = /^[a-zA-Z0-9_-]+$/
const eventTypePattern = /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/
const pageSize = 100

export class RelayConfigurationError extends Error {}

class RelayTransportError extends Error {}

export async function readRelayConfig(path) {
  if (!path) throw new RelayConfigurationError('set --config')
  let config
  try {
    config = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new RelayConfigurationError('cannot read the JetStream relay configuration as JSON')
  }
  const { name, server, stream, eventTypes } = config ?? {}
  const endpoint = typeof server === 'string' && URL.parse(server)
  if (typeof name !== 'string' || !namePattern.test(name) || typeof stream !== 'string' || !namePattern.test(stream)) {
    throw new RelayConfigurationError('name and stream must use letters, digits, hyphens or underscores')
  }
  if (!endpoint || !['nats:', 'tls:'].includes(endpoint.protocol) || !endpoint.hostname ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      (endpoint.pathname && endpoint.pathname !== '/')) {
    throw new RelayConfigurationError('server must be a NATS URL without credentials or a path')
  }
  if (!Array.isArray(eventTypes) || eventTypes.length === 0 ||
      eventTypes.some(type => typeof type !== 'string' || !eventTypePattern.test(type))) {
    throw new RelayConfigurationError('eventTypes must list exact journal event types')
  }
  return { name, server, stream, eventTypes: new Set(eventTypes) }
}

export function factTopic(event) {
  const subject = Buffer.from(event.subject.id).toString('base64url')
  return `tinstar.fact.${event.source.provider}.${event.subject.type}.${subject}`
}

export async function publishPage(journal, config, js, sequence, signal) {
  for (const event of journal.events({ after: sequence, limit: pageSize })) {
    if (signal.aborted) break
    let ackAt = null
    if (event.source.mode !== 'fixture' && config.eventTypes.has(event.event_type)) {
      const topic = factTopic(event)
      try {
        await js.publish(topic, Buffer.from(JSON.stringify({ ...event, kind: 'fact', topic })), {
          msgID: event.event_id,
          expect: { streamName: config.stream },
        })
      } catch (error) {
        // SDK errors can include connection details. Persist the failure class
        // and exact journal position without copying credentials or payloads.
        throw new RelayTransportError(`publish at journal #${event.sequence} failed (${error.name})`)
      }
      ackAt = new Date().toISOString()
    }
    sequence = event.sequence
    journal.updateRelay(config.name, sequence, 'ok', null, ackAt)
  }
  return sequence
}

export async function runRelay(journal, config, seed, signal) {
  let sequence = journal.registerRelay(config)
  let nc
  let js
  let delay = 1000
  const authenticator = nkeyAuthenticator(Buffer.from(seed))
  const tls = new URL(config.server).protocol === 'tls:' ? { rejectUnauthorized: true } : undefined
  try {
    while (!signal.aborted) {
      try {
        if (!nc || nc.isClosed()) {
          try {
            nc = await connect({ servers: config.server, name: config.name, authenticator, tls,
              inboxPrefix: `_INBOX.tinstar_relay.${config.name}`,
              reconnect: false, timeout: 5000, pingInterval: 10_000 })
            js = jetstream(nc, { timeout: 5000, checkAPI: false })
          } catch (error) {
            throw new RelayTransportError(`broker connection failed (${error.name})`)
          }
          journal.updateRelay(config.name, sequence, 'connected')
        }
        const next = await publishPage(journal, config, js, sequence, signal)
        delay = 1000
        if (next === sequence) await sleep(delay, undefined, { signal })
        sequence = next
      } catch (error) {
        if (signal.aborted && error.name === 'AbortError') break
        if (!(error instanceof RelayTransportError)) throw error
        journal.updateRelay(config.name, sequence, 'retrying', error.message)
        console.error(`JetStream relay ${config.name}: ${error.message}; retry in ${delay / 1000}s`)
        await nc?.close()
        nc = undefined
        sequence = journal.registerRelay(config)
        await sleep(delay, undefined, { signal }).catch(error => {
          if (error.name !== 'AbortError') throw error
        })
        delay = Math.min(delay * 2, 30_000)
      }
    }
  } finally {
    await nc?.close()
  }
  journal.updateRelay(config.name, sequence, 'stopped')
}
