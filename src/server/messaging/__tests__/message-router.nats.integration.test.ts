// @vitest-environment node
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { connect, type NatsConnection } from 'nats'
import { afterEach, describe, expect, it } from 'vitest'
import type { LiveDeliveryResult } from '../live-recipient-resolution'
import {
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

afterEach(async () => {
  for (const connection of connections.splice(0)) {
    await connection.close()
  }
  for (const child of children.splice(0)) child.kill('SIGTERM')
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
      destination: { subject: 'tinstar.space.init.epic.task.receiver' },
      text: 'real transport proof',
    }

    await expect(requestMessageRoute(
      client,
      '_TINSTAR.delivery.route.test',
      request,
      500,
    )).rejects.toMatchObject({ code: 'no-responder' })

    const service = new NatsMessageRouterService({
      subject: '_TINSTAR.delivery.route.test',
      natsUrl: url,
      route: async (): Promise<LiveDeliveryResult> => ({
        ok: true,
        destinationKind: 'dm',
        exclusions: [],
        acceptance: {
          accepted: true,
          replayed: false,
          wrote: true,
          details: 'retained',
          receipt: {
            requestId: request.requestId,
            messageId: 'msg-real',
            acceptedAt: '2026-08-01T12:00:00.000Z',
            deliveryIds: ['msg-real/d/1'],
          },
          message: {
            id: 'msg-real',
            requestId: request.requestId,
            requestFingerprint: '0'.repeat(64),
            acceptedAt: '2026-08-01T12:00:00.000Z',
            sender: request.sender,
            destination: request.destination,
            text: request.text,
            deliveryIds: ['msg-real/d/1'],
          },
          deliveries: [{
            id: 'msg-real/d/1',
            messageId: 'msg-real',
            recipient: {
              providerId: 'forge',
              sessionId: 'receiver',
              incarnation: 'receiver-v1',
            },
            state: 'pending',
            attempt: 0,
            acceptedAt: '2026-08-01T12:00:00.000Z',
            updatedAt: '2026-08-01T12:00:00.000Z',
            history: [{
              state: 'pending',
              attempt: 0,
              at: '2026-08-01T12:00:00.000Z',
            }],
            historyTruncated: false,
          }],
        },
      }),
    })
    await service.start()

    await expect(requestMessageRoute(
      client,
      '_TINSTAR.delivery.route.test',
      request,
      1_000,
    )).resolves.toMatchObject({
      status: 'accepted',
      receipt: { messageId: 'msg-real' },
    })

    await service.stop()
    await client.flush()
    await expect(requestMessageRoute(
      client,
      '_TINSTAR.delivery.route.test',
      request,
      500,
    )).rejects.toMatchObject({ code: 'no-responder' })
  })
})
