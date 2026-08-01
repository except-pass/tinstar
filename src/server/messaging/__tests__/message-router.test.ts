// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type {
  LiveDeliveryResult,
  RecipientExclusion,
} from '../live-recipient-resolution'
import {
  MESSAGE_ROUTE_PROTOCOL_VERSION,
  MessageRouteTransportError,
  NatsMessageRouterService,
  createReplyMcpHandler,
  deliverySenderFromEnvironment,
  messageRouterSubject,
  requestMessageRoute,
  routeResponse,
  type MessageRouteRequest,
  type NatsRouteConnection,
  type NatsRouteMessage,
  type NatsRouteSubscription,
} from '../message-router'

const REQUEST: MessageRouteRequest = {
  version: MESSAGE_ROUTE_PROTOCOL_VERSION,
  requestId: 'req-7',
  sender: { sessionId: 'sender', incarnation: 'sender-v2' },
  destination: { subject: 'tinstar.space.init.epic.task.receiver' },
  text: 'Please inspect the boundary.',
}

function accepted(exclusions: RecipientExclusion[] = []): LiveDeliveryResult {
  return {
    ok: true,
    destinationKind: 'dm',
    exclusions,
    acceptance: {
      accepted: true,
      replayed: false,
      wrote: true,
      details: 'retained',
      receipt: {
        requestId: REQUEST.requestId,
        messageId: 'msg-7',
        acceptedAt: '2026-08-01T12:00:00.000Z',
        deliveryIds: ['msg-7/d/1'],
      },
      message: {
        id: 'msg-7',
        requestId: REQUEST.requestId,
        requestFingerprint: '0'.repeat(64),
        acceptedAt: '2026-08-01T12:00:00.000Z',
        sender: REQUEST.sender,
        destination: REQUEST.destination,
        text: REQUEST.text,
        deliveryIds: ['msg-7/d/1'],
      },
      deliveries: [{
        id: 'msg-7/d/1',
        messageId: 'msg-7',
        recipient: {
          providerId: 'forge',
          sessionId: 'receiver',
          incarnation: 'receiver-v4',
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
  }
}

describe('message router wire contract', () => {
  it('uses a stable per-Tinstar service subject outside managed address space', () => {
    expect(messageRouterSubject('/cfg/one')).toMatch(
      /^_TINSTAR\.delivery\.route\.v1\.[a-f0-9]{24}$/,
    )
    expect(messageRouterSubject('/cfg/one')).toBe(messageRouterSubject('/cfg/one'))
    expect(messageRouterSubject('/cfg/one')).not.toBe(messageRouterSubject('/cfg/two'))
  })

  it('requires both managed sender identity fields from the MCP environment', () => {
    expect(deliverySenderFromEnvironment({
      TINSTAR_SESSION_NAME: 'sender',
      TINSTAR_AGENT_INCARNATION: 'sender-v2',
    })).toEqual(REQUEST.sender)
    expect(() => deliverySenderFromEnvironment({
      TINSTAR_SESSION_NAME: 'sender',
    })).toThrow('TINSTAR_AGENT_INCARNATION')
  })

  it('returns accepted and partial receipts only after durable acceptance', () => {
    expect(routeResponse(REQUEST, accepted())).toMatchObject({
      version: MESSAGE_ROUTE_PROTOCOL_VERSION,
      status: 'accepted',
      requestId: 'req-7',
      receipt: {
        messageId: 'msg-7',
        destinationKind: 'dm',
        recipients: [{
          providerId: 'forge',
          sessionId: 'receiver',
          incarnation: 'receiver-v4',
        }],
      },
    })

    expect(routeResponse(REQUEST, accepted([
      { sessionId: 'stopped-peer', reason: 'stopped' },
    ]))).toMatchObject({
      status: 'partial',
      receipt: {
        exclusions: [{ sessionId: 'stopped-peer', reason: 'stopped' }],
      },
    })
  })

  it('returns a structured router error without implying publication', () => {
    const result: LiveDeliveryResult = {
      ok: false,
      error: {
        code: 'recipient-unavailable',
        destinationKind: 'dm',
        subject: REQUEST.destination.subject,
        exclusions: [{ sessionId: 'receiver', reason: 'process-dead' }],
      },
    }

    expect(routeResponse(REQUEST, result)).toEqual({
      version: MESSAGE_ROUTE_PROTOCOL_VERSION,
      status: 'error',
      requestId: 'req-7',
      error: {
        code: 'recipient-unavailable',
        message: 'No live recipient accepted the message.',
        destinationKind: 'dm',
        subject: REQUEST.destination.subject,
        exclusions: [{ sessionId: 'receiver', reason: 'process-dead' }],
      },
    })
  })
})

describe('provider-neutral reply MCP handler', () => {
  it('submits sender identity, destination, text, and a stable request ID', async () => {
    const route = vi.fn(async () => routeResponse(REQUEST, accepted()))
    const reply = createReplyMcpHandler({
      sender: REQUEST.sender,
      createRequestId: () => 'req-7',
      route,
    })

    const result = await reply({
      to: REQUEST.destination.subject,
      text: REQUEST.text,
    })

    expect(route).toHaveBeenCalledWith(REQUEST)
    expect(result).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('msg-7') }],
      structuredContent: { status: 'accepted' },
    })
    expect(result).not.toHaveProperty('isError')
  })

  it('surfaces router and transport failures instead of falling back to publish', async () => {
    const rejected = createReplyMcpHandler({
      sender: REQUEST.sender,
      createRequestId: () => 'req-7',
      route: async () => ({
        version: MESSAGE_ROUTE_PROTOCOL_VERSION,
        status: 'error',
        requestId: 'req-7',
        error: { code: 'recipient-unavailable', message: 'recipient stopped' },
      }),
    })
    await expect(rejected({
      to: REQUEST.destination.subject,
      text: REQUEST.text,
    })).resolves.toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('recipient stopped') }],
    })

    const offline = createReplyMcpHandler({
      sender: REQUEST.sender,
      route: async () => {
        throw new MessageRouteTransportError(
          'no-responder',
          'Tinstar message router has no responder',
        )
      },
    })
    await expect(offline({
      to: REQUEST.destination.subject,
      text: REQUEST.text,
    })).resolves.toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('no responder') }],
    })
  })
})

describe('NATS request/reply boundary', () => {
  it('makes no-responder and timeout failures visible to the sender', async () => {
    const noResponder = {
      request: vi.fn(async () => {
        throw Object.assign(new Error('503'), { code: '503' })
      }),
    }
    await expect(requestMessageRoute(noResponder, '_route', REQUEST)).rejects.toMatchObject({
      name: 'MessageRouteTransportError',
      code: 'no-responder',
    })

    const timeout = {
      request: vi.fn(async () => {
        throw Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' })
      }),
    }
    await expect(requestMessageRoute(timeout, '_route', REQUEST)).rejects.toMatchObject({
      code: 'timeout',
    })
  })

  it('rejects malformed or mismatched responder receipts', async () => {
    const response = (body: unknown) => ({
      request: vi.fn(async () => ({
        data: new TextEncoder().encode(JSON.stringify(body)),
      })),
    })
    await expect(requestMessageRoute(response({
      version: MESSAGE_ROUTE_PROTOCOL_VERSION,
      status: 'accepted',
      requestId: 'req-7',
      receipt: {},
    }), '_route', REQUEST)).rejects.toMatchObject({ code: 'invalid-response' })

    await expect(requestMessageRoute(response({
      version: MESSAGE_ROUTE_PROTOCOL_VERSION,
      status: 'error',
      requestId: 'someone-else',
      error: { code: 'recipient-unavailable', message: 'stopped' },
    }), '_route', REQUEST)).rejects.toMatchObject({ code: 'invalid-response' })
  })

  it('rejects raw publications before acceptance and responds to valid requests', async () => {
    const responses: Uint8Array[] = []
    const raw: NatsRouteMessage = {
      data: new TextEncoder().encode(JSON.stringify(REQUEST)),
      respond: vi.fn(() => false),
    }
    const requested: NatsRouteMessage = {
      data: new TextEncoder().encode(JSON.stringify(REQUEST)),
      reply: '_INBOX.reply',
      respond: vi.fn(data => {
        responses.push(data)
        return true
      }),
    }
    const subscription: NatsRouteSubscription = {
      unsubscribe: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield raw
        yield requested
        await new Promise(() => {})
      },
    }
    let closeConnection!: () => void
    const closed = new Promise<void>(resolve => { closeConnection = resolve })
    const connection: NatsRouteConnection = {
      subscribe: vi.fn(() => subscription),
      closed: () => closed,
      flush: vi.fn(async () => {}),
      drain: vi.fn(async () => { closeConnection() }),
    }
    const route = vi.fn(async () => accepted())
    const observeAccepted = vi.fn()
    const service = new NatsMessageRouterService({
      subject: '_route',
      connect: async () => connection,
      route,
      observeAccepted,
      reconnectDelayMs: 1,
    })

    await service.start()
    await vi.waitFor(() => expect(responses).toHaveLength(1))
    await service.stop()

    expect(route).toHaveBeenCalledOnce()
    expect(observeAccepted).toHaveBeenCalledWith(
      REQUEST,
      expect.objectContaining({ status: 'accepted' }),
    )
    expect(JSON.parse(new TextDecoder().decode(responses[0]))).toMatchObject({
      status: 'accepted',
      requestId: 'req-7',
    })
  })

  it('answers malformed requests with structured errors without invoking routing', async () => {
    const responses: Uint8Array[] = []
    const malformed: NatsRouteMessage = {
      data: new TextEncoder().encode('{not json'),
      reply: '_INBOX.reply',
      respond: data => {
        responses.push(data)
        return true
      },
    }
    const subscription: NatsRouteSubscription = {
      unsubscribe: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield malformed
        await new Promise(() => {})
      },
    }
    let closeConnection!: () => void
    const closed = new Promise<void>(resolve => { closeConnection = resolve })
    const connection: NatsRouteConnection = {
      subscribe: () => subscription,
      closed: () => closed,
      flush: async () => {},
      drain: async () => { closeConnection() },
    }
    const route = vi.fn(async () => accepted())
    const service = new NatsMessageRouterService({
      subject: '_route',
      connect: async () => connection,
      route,
      reconnectDelayMs: 1,
    })

    await service.start()
    await vi.waitFor(() => expect(responses).toHaveLength(1))
    await service.stop()

    expect(route).not.toHaveBeenCalled()
    expect(JSON.parse(new TextDecoder().decode(responses[0]))).toMatchObject({
      status: 'error',
      error: { code: 'invalid-request' },
    })
  })

  it('drains a failed subscription setup and reconnects the responder', async () => {
    const failedDrain = vi.fn(async () => {})
    const failed: NatsRouteConnection = {
      subscribe: () => { throw new Error('subscription setup failed') },
      closed: async () => {},
      flush: async () => {},
      drain: failedDrain,
    }
    const responses: Uint8Array[] = []
    const subscription: NatsRouteSubscription = {
      unsubscribe: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield {
          data: new TextEncoder().encode(JSON.stringify(REQUEST)),
          reply: '_INBOX.reply',
          respond: (data: Uint8Array) => {
            responses.push(data)
            return true
          },
        }
        await new Promise(() => {})
      },
    }
    let closeConnection!: () => void
    const closed = new Promise<void>(resolve => { closeConnection = resolve })
    const recovered: NatsRouteConnection = {
      subscribe: () => subscription,
      closed: () => closed,
      flush: async () => {},
      drain: async () => { closeConnection() },
    }
    const connections = [failed, recovered]
    const service = new NatsMessageRouterService({
      subject: '_route',
      connect: async () => connections.shift()!,
      route: async () => accepted(),
      reconnectDelayMs: 1,
    })

    await service.start()
    await vi.waitFor(() => expect(responses).toHaveLength(1))
    await service.stop()

    expect(failedDrain).toHaveBeenCalledOnce()
  })

  it('does not attach a responder after stop wins a subscription flush race', async () => {
    let releaseFlush!: () => void
    const flush = new Promise<void>(resolve => { releaseFlush = resolve })
    const subscription: NatsRouteSubscription = {
      unsubscribe: vi.fn(),
      async *[Symbol.asyncIterator]() {
        await new Promise(() => {})
      },
    }
    const connection: NatsRouteConnection = {
      subscribe: vi.fn(() => subscription),
      closed: async () => {},
      flush: () => flush,
      drain: vi.fn(async () => {}),
    }
    const service = new NatsMessageRouterService({
      subject: '_route',
      connect: async () => connection,
      route: async () => accepted(),
    })

    const start = service.start()
    await vi.waitFor(() => expect(connection.subscribe).toHaveBeenCalledOnce())
    await service.stop()
    releaseFlush()
    await start

    expect(subscription.unsubscribe).toHaveBeenCalledOnce()
    expect(connection.drain).toHaveBeenCalledOnce()
  })

  it('generation-fences a stale connection attempt across stop and restart', async () => {
    const pendingConnections: Array<(connection: NatsRouteConnection) => void> = []
    const connect = vi.fn(() => new Promise<NatsRouteConnection>(resolve => {
      pendingConnections.push(resolve)
    }))
    const connection = () => {
      let close!: () => void
      const closed = new Promise<void>(resolve => { close = resolve })
      const subscription: NatsRouteSubscription = {
        unsubscribe: vi.fn(),
        async *[Symbol.asyncIterator]() {
          await new Promise(() => {})
        },
      }
      const value: NatsRouteConnection = {
        subscribe: vi.fn(() => subscription),
        closed: () => closed,
        flush: vi.fn(async () => {}),
        drain: vi.fn(async () => { close() }),
      }
      return value
    }
    const stale = connection()
    const current = connection()
    const service = new NatsMessageRouterService({
      subject: '_route',
      connect,
      route: async () => accepted(),
    })

    const firstStart = service.start()
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce())
    await service.stop()
    const secondStart = service.start()
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2))
    pendingConnections[0]!(stale)
    pendingConnections[1]!(current)
    await Promise.all([firstStart, secondStart])

    expect(stale.subscribe).not.toHaveBeenCalled()
    expect(stale.drain).toHaveBeenCalledOnce()
    expect(current.subscribe).toHaveBeenCalledOnce()
    expect(current.flush).toHaveBeenCalledOnce()
    await service.stop()
  })
})
