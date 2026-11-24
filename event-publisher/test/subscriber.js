import { deepEqual, equal, match, rejects } from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Journal } from '../journal.js'
import { deliverMessage, deliveryRequestId, readSubscriberConfig } from '../subscriber.js'

async function sandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tinstar-subscriber-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function delivery(event, { subject = event.topic, loseAck = false } = {}) {
  return {
    subject, seq: 7, info: { deliveryCount: 1 }, json: () => event, acks: 0, retries: [],
    nak(delay) { this.retries.push(delay) },
    async ackAck() {
      this.acks++
      if (loseAck) throw new Error('lost broker confirmation')
      return true
    },
  }
}

test('webhook retries a failed POST and re-acks a durably received event after a lost confirmation', async t => {
  const directory = await sandbox(t)
  const requests = []
  const server = createServer(async (request, response) => {
    const body = []
    for await (const chunk of request) body.push(chunk)
    requests.push({ authorization: request.headers.authorization, key: request.headers['idempotency-key'],
      body: JSON.parse(Buffer.concat(body)) })
    response.writeHead(requests.length === 1 ? 503 : 204).end()
  })
  server.listen(0, '127.0.0.1')
  t.after(() => server.close())
  await once(server, 'listening')
  const config = {
    name: 'controlled-webhook', flavor: 'webhook', stream: 'TINSTAR_FACTS', consumer: 'webhook',
    topics: ['tinstar.fact.jira.ticket.*'], destination: { url: new URL(`http://127.0.0.1:${server.address().port}/receive`) },
  }
  const event = {
    schema: 'event-publisher.event.v1', event_id: 'event:subscriber-test', topic: 'tinstar.fact.jira.ticket.test',
    event_type: 'ticket.status.changed', kind: 'fact', observed_at: '2026-11-24T18:42:00Z',
    subject: { type: 'ticket', id: 'jira:ticket:test:12', private: 'ignored' },
    evidence: { account_id: 'ignored' }, body: 'ignored',
  }
  const token = 'test-token'
  const requestId = deliveryRequestId(event)
  const path = join(directory, 'receipts.sqlite')
  let journal = new Journal(path)
  try {
    journal.registerSubscriber(config)
    const rejected = delivery(event)
    await deliverMessage(journal, config, rejected, token)
    equal(rejected.acks, 0)
    deepEqual(rejected.retries, [2000])
    equal(journal.subscriberReceipt(config.name, requestId), undefined)
    match(journal.subscriberStatus()[0].reason, /HTTP 503/)

    const accepted = delivery(event, { loseAck: true })
    await rejects(deliverMessage(journal, config, accepted, token), /broker did not confirm/)
    equal(journal.subscriberReceipt(config.name, requestId), requestId)
    equal(journal.subscriberStatus()[0].health, 'received')
    deepEqual(requests, Array.from({ length: 2 }, () => ({
      authorization: 'Bearer test-token', key: requestId,
      body: { schema: 'tinstar.webhook.v1', event_id: event.event_id, topic: event.topic, event_type: event.event_type,
        kind: event.kind, observed_at: event.observed_at, subject: { type: 'ticket', id: 'jira:ticket:test:12' } },
    })))

    journal.close()
    journal = new Journal(path)
    journal.registerSubscriber(config)
    const redelivery = delivery(event)
    await deliverMessage(journal, config, redelivery, token)
    equal(redelivery.acks, 1)
    equal(requests.length, 2)
    equal(journal.subscriberStatus()[0].health, 'ok')
  } finally {
    journal.close()
  }
})

test('Mate repairs a saved but unannounced note with the same request ID and rejects another home topic', async t => {
  const home = await sandbox(t)
  await mkdir(join(home, 'bin'))
  await writeFile(join(home, 'bin', 'fm-inbox.sh'), `#!/bin/sh
set -eu
[ "$1" = note ] && [ "$2" = --request-id ] && [ "$4" = --json ] && [ "$5" = - ]
printf '%s\\n' "$3" >> "$FM_HOME/calls"
if [ ! -f "$FM_HOME/note" ]; then
  cat > "$FM_HOME/note"
  printf '{"schema":"fm-inbox-note.v1","request_id":"%s","id":"fixture-note","saved":true,"announced":false}\\n' "$3"
  exit 3
fi
cat >/dev/null
printf '{"schema":"fm-inbox-note.v1","request_id":"%s","id":"fixture-note","saved":true,"announced":true}\\n' "$3"
`, { mode: 0o700 })
  const config = {
    name: 'controlled-mate', flavor: 'mate', stream: 'TINSTAR_INBOX', consumer: 'mate',
    topics: ['inbox.mate.test'], destination: { home },
  }
  const event = { schema: 'tinstar.inbox.v1', event_id: 'event:mate-test', topic: 'inbox.mate.test', body: 'Controlled test note' }
  const requestId = deliveryRequestId(event)
  const journal = new Journal(join(home, 'receipts.sqlite'))
  try {
    journal.registerSubscriber(config)
    const misrouted = delivery(event, { subject: 'inbox.mate.someone-else' })
    await deliverMessage(journal, config, misrouted)
    equal(misrouted.acks, 0)
    await rejects(readFile(join(home, 'calls')), { code: 'ENOENT' })

    const first = delivery(event)
    await deliverMessage(journal, config, first)
    equal(first.acks, 0)
    equal(journal.subscriberStatus()[0].receipt_id, 'fixture-note')
    match(journal.subscriberStatus()[0].reason, /saved the note but could not announce/)
    equal(journal.subscriberReceipt(config.name, requestId), undefined)

    const retry = delivery(event)
    await deliverMessage(journal, config, retry)
    equal(retry.acks, 1)
    equal(journal.subscriberReceipt(config.name, requestId), 'fixture-note')
    const redelivery = delivery(event)
    await deliverMessage(journal, config, redelivery)
    equal(redelivery.acks, 1)
    equal(await readFile(join(home, 'note'), 'utf8'), event.body)
    equal(await readFile(join(home, 'calls'), 'utf8'), `${requestId}\n${requestId}\n`)
  } finally {
    journal.close()
  }
})

test('subscriber configuration fixes destinations locally and disallows plaintext remote webhooks', async t => {
  const directory = await sandbox(t)
  const path = join(directory, 'subscriber.json')
  const base = { name: 'proof', stream: 'TINSTAR_INBOX', server: 'nats://127.0.0.1:14222' }
  await writeFile(path, JSON.stringify({ ...base, flavor: 'mate', topics: ['inbox.mate.*'], destination: { home: directory } }))
  await rejects(readSubscriberConfig(path), /one exact inbox/)
  await writeFile(path, JSON.stringify({ ...base, flavor: 'mate', topics: ['inbox.mate.proof'], destination: { home: directory } }))
  deepEqual(await readSubscriberConfig(path), { ...base, consumer: 'proof', flavor: 'mate',
    topics: ['inbox.mate.proof'], destination: { home: directory } })
  await writeFile(path, JSON.stringify({ ...base, flavor: 'webhook', topics: ['tinstar.fact.>'],
    destination: { url: 'http://example.test/events' } }))
  await rejects(readSubscriberConfig(path), /HTTPS URL/)
})
