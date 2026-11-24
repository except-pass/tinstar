import { deepEqual, equal, match, rejects } from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { publishPage, readRelayConfig } from '../jetstream.js'
import { Journal, RelayCheckpointError } from '../journal.js'

const observedAt = '2026-11-24T20:00:00.000Z'
const source = { provider: 'jira', source_id: 'jira:cloud:test:project:123' }
const subject = { type: 'ticket', id: 'jira:ticket:test:456' }
const config = { name: 'test-relay', stream: 'TEST_FACTS',
  eventTypes: new Set(['ticket.status.changed', 'mate.migration.recorded']) }
const signal = new AbortController().signal

function record(journal, deliveryId, eventType) {
  journal.recordJiraDelivery(source.source_id, deliveryId, {
    native: deliveryId,
    observedAt,
    events: [{
      schema: 'event-publisher.event.v1', event_type: eventType, source, subject,
      observed_at: observedAt, occurred_at: observedAt,
      change: { field: 'status', before: 'In Progress', after: 'Done' },
      evidence: { source_reference: { issue_id: '456' } },
    }],
  })
}

async function tempDirectory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'event-publisher-jetstream-'))
  t.after(() => rm(dir, { force: true, recursive: true }))
  return dir
}

test('lost publish acknowledgment preserves the journal ID and cannot skip a fact', async t => {
  const path = join(await tempDirectory(t), 'journal.sqlite')
  let journal = new Journal(path)
  journal.registerSources([{ ...source, home_path: null }])
  record(journal, 'skip', 'ticket.comment.created')
  record(journal, 'first', 'ticket.status.changed')
  record(journal, 'second', 'ticket.status.changed')
  const [, first, second] = journal.events()
  const attempts = []
  const publish = async (topic, bytes, options) => {
    attempts.push({ topic, payload: JSON.parse(bytes), options })
    if (attempts.length === 1) throw new Error('lost acknowledgment')
  }
  try {
    const cursor = journal.registerRelay(config)
    equal(cursor, 0)
    await rejects(publishPage(journal, config, { publish }, cursor, signal), /journal #2/)
    equal(journal.relayStatus()[0].sequence, 1)
    journal.close()
    journal = new Journal(path)
    const resume = journal.registerRelay(config)
    equal(await publishPage(journal, config, { publish }, resume, signal), 3)
    deepEqual(attempts[0], attempts[1])
    const topic = 'tinstar.fact.jira.ticket.' + Buffer.from(subject.id).toString('base64url')
    deepEqual(attempts.slice(1), [first, second].map(event => ({
      topic, payload: { ...event, kind: 'fact', topic },
      options: { msgID: event.event_id, expect: { streamName: config.stream } },
    })))
    match(journal.relayStatus()[0].last_ack_at, /Z$/)
    equal(journal.registerRelay(config), 3)
  } finally {
    journal.close()
  }
})

test('fixture rows are excluded even when their type is selected', async t => {
  const path = join(await tempDirectory(t), 'journal.sqlite')
  const journal = new Journal(path)
  try {
    journal.recordMigration({
      event_id: 'fixture-id', source: { mode: 'fixture' },
      subject: { type: 'mate', id: 'fixture-mate' },
      event_type: 'mate.migration.recorded', observed_at: observedAt,
    })
    const publish = () => { throw new Error('a fixture reached the publisher') }
    const cursor = journal.registerRelay(config)
    equal(await publishPage(journal, config, { publish }, cursor, signal), 1)
    equal(journal.relayStatus()[0].sequence, 1)
  } finally {
    journal.close()
  }
})

test('a failed checkpoint after acknowledgment leaves the fact pending', async t => {
  const path = join(await tempDirectory(t), 'journal.sqlite')
  const journal = new Journal(path)
  try {
    journal.registerSources([{ ...source, home_path: null }])
    record(journal, 'first', 'ticket.status.changed')
    const [event] = journal.events()
    const cursor = journal.registerRelay(config)
    journal.updateRelay(config.name, cursor, 'connected')
    journal.db.exec(`
      CREATE TEMP TRIGGER reject_checkpoint BEFORE UPDATE ON jetstream_relays
      BEGIN SELECT RAISE(ABORT, 'private database detail'); END;
    `)
    const published = []
    const publish = async (_topic, _payload, { msgID }) => { published.push(msgID) }
    await rejects(publishPage(journal, config, { publish }, cursor, signal), {
      constructor: RelayCheckpointError,
      message: 'JetStream relay test-relay could not save checkpoint at journal #1 (state ok)',
    })
    equal(journal.relayStatus()[0].health, 'connected')
    equal(journal.relayStatus()[0].last_ack_at, null)
    const resume = journal.registerRelay(config)
    equal(resume, cursor)
    journal.db.exec('DROP TRIGGER reject_checkpoint')
    equal(await publishPage(journal, config, { publish }, resume, signal), event.sequence)
    deepEqual(published, [event.event_id, event.event_id])
    equal(journal.registerRelay(config), event.sequence)
  } finally {
    journal.close()
  }
})

test('relay config uses an explicit event selection and credential-free server URL', async t => {
  const path = join(await tempDirectory(t), 'relay.json')
  const fields = { ...config, eventTypes: [...config.eventTypes], server: 'nats://127.0.0.1:4222' }
  await writeFile(path, JSON.stringify(fields))
  deepEqual(await readRelayConfig(path), { ...config, server: fields.server })
  await writeFile(path, JSON.stringify({ ...fields, eventTypes: ['ticket.>'] }))
  await rejects(readRelayConfig(path), /exact journal event types/)
  await writeFile(path, JSON.stringify({ ...fields, server: 'nats://user:password@127.0.0.1:4222' }))
  await rejects(readRelayConfig(path), /without credentials/)
})
