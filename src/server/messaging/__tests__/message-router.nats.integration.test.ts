// @vitest-environment node
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, type NatsConnection } from 'nats'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireBackendSingleton } from '../../infra/lock'
import type { Session } from '../../sessions/session'
import { DeliveryLedger } from '../delivery-ledger'
import { acceptForLiveRecipients } from '../live-recipient-resolution'
import {
  deriveMessageRouterSessionKey,
  MESSAGE_ROUTE_PROTOCOL_VERSION,
  NatsMessageRouterService,
  requestMessageRoute,
  type MessageRouteRequest,
} from '../message-router'

const natsServerAvailable = spawnSync(
  'nats-server',
  ['-v'],
  { stdio: 'ignore' },
).status === 0

const children: ChildProcess[] = []
const connections: NatsConnection[] = []
const roots: string[] = []

afterEach(async () => {
  for (const connection of connections.splice(0)) {
    await connection.close()
  }
  for (const child of children.splice(0)) child.kill('SIGTERM')
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test port')
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
  return address.port
}

async function connectEventually(url: string): Promise<NatsConnection> {
  let lastError: unknown
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const connection = await connect({
        servers: url,
        maxReconnectAttempts: 0,
        timeout: 250,
      })
      connections.push(connection)
      return connection
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  throw lastError
}

describe.skipIf(!natsServerAvailable)('message router with real NATS', () => {
  it('fails with no responder, accepts through Tinstar, then fails after shutdown', async () => {
    const port = await freePort()
    const url = `nats://127.0.0.1:${port}`
    const server = spawn('nats-server', ['-a', '127.0.0.1', '-p', String(port)], {
      stdio: 'ignore',
    })
    children.push(server)
    const client = await connectEventually(url)
    const request: MessageRouteRequest = {
      version: MESSAGE_ROUTE_PROTOCOL_VERSION,
      requestId: 'real-nats-request',
      sender: { sessionId: 'sender', incarnation: 'sender-v1' },
      destination: { subject: 'tinstar.space.project.worktree.receiver' },
      text: 'real transport proof',
    }
    const authMasterKey = Buffer.alloc(32, 0x41)
    const authKey = deriveMessageRouterSessionKey(authMasterKey, request.sender)

    await expect(requestMessageRoute(
      client,
      '_TINSTAR.delivery.route.test',
      request,
      authKey,
      500,
    )).rejects.toMatchObject({ code: 'no-responder' })

    const root = mkdtempSync(join(tmpdir(), 'message-router-real-nats-'))
    roots.push(root)
    expect(acquireBackendSingleton(join(root, 'server.lock')).acquired).toBe(true)
    let ledger = DeliveryLedger.open({
      dir: root,
      createMessageId: () => 'msg-real',
      now: () => Date.parse('2026-08-01T12:00:00.000Z'),
    })
    const receiver = {
      name: 'receiver',
      state: 'running',
      nats: {
        enabled: true,
        subscriptions: [request.destination.subject],
      },
    } as Session
    const service = new NatsMessageRouterService({
      subject: '_TINSTAR.delivery.route.test',
      authMasterKey,
      natsUrl: url,
      route: routeRequest => acceptForLiveRecipients(routeRequest, {
        coordinationKey: ledger,
        listSessions: () => [receiver],
        readSession: sessionId => sessionId === receiver.name ? receiver : null,
        isDeleting: () => false,
        graveyardSessionNames: () => [],
        acquireLease: () => ({ token: 'receiver-generation', release: () => {} }),
        leaseIsCurrent: () => true,
        observeProcess: async () => ({ state: 'alive', incarnation: 'receiver-v1' }),
        providerIdFor: () => 'forge',
        replayAcceptance: intent => ledger.replayAcceptance(intent),
        accept: input => ledger.accept(input),
      }),
    })
    await service.start()

    await expect(requestMessageRoute(
      client,
      '_TINSTAR.delivery.route.test',
      request,
      authKey,
      1_000,
    )).resolves.toMatchObject({
      status: 'accepted',
      receipt: { messageId: 'msg-real' },
    })
    expect(ledger.getMessage('msg-real')).toMatchObject({
      message: { requestId: request.requestId },
      deliveries: [{
        recipient: { providerId: 'forge', sessionId: 'receiver', incarnation: 'receiver-v1' },
      }],
    })

    // Reopen the durable store and retry the caller-owned idempotency key. The
    // live resolver must replay one acceptance, not append another obligation.
    ledger = DeliveryLedger.open({ dir: root })
    await expect(requestMessageRoute(
      client,
      '_TINSTAR.delivery.route.test',
      request,
      authKey,
      1_000,
    )).resolves.toMatchObject({
      status: 'accepted',
      receipt: { messageId: 'msg-real', deliveryIds: ['msg-real/d/1'] },
    })
    expect(ledger.listRecoverable()).toHaveLength(1)

    await service.stop()
    await client.flush()
    await expect(requestMessageRoute(
      client,
      '_TINSTAR.delivery.route.test',
      request,
      authKey,
      500,
    )).rejects.toMatchObject({ code: 'no-responder' })
  })
})
