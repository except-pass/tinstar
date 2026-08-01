// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireBackendSingleton } from '../../infra/lock'
import { DeliveryLedger } from '../delivery-ledger'
import type {
  LiveDeliveryResult,
  RecipientExclusion,
} from '../live-recipient-resolution'
import {
  MESSAGE_ROUTE_PROTOCOL_VERSION,
  MessageRouteTransportError,
  NatsMessageRouterService,
  createReplyMcpHandler,
  deriveMessageRouterSessionKey,
  deliveryAuthKeyFromEnvironment,
  deliverySenderFromEnvironment,
  messageRouterMasterKey,
  messageRouterSubject,
  reserveMessageRouterOwner,
  resetMessageRouterOwnersForTests,
  requestMessageRoute,
  routeResponse,
  signMessageRoutePayload,
  verifyMessageRouteEnvelope,
  type MessageRouteRequest,
  type NatsRouteConnection,
  type NatsRouteMessage,
  type NatsRouteSubscription,
} from '../message-router'

afterEach(async () => {
  await resetMessageRouterOwnersForTests()
})

const REQUEST: MessageRouteRequest = {
  version: MESSAGE_ROUTE_PROTOCOL_VERSION,
  requestId: 'req-7',
  sender: { sessionId: 'sender', incarnation: 'sender-v2' },
  destination: { subject: 'tinstar.space.init.epic.task.receiver' },
  text: 'Please inspect the boundary.',
}

const MASTER_KEY = Buffer.alloc(32, 0x41)
const AUTH_KEY = deriveMessageRouterSessionKey(MASTER_KEY, REQUEST.sender)
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function encodedRequest(
  request: MessageRouteRequest = REQUEST,
  authKey: Uint8Array = AUTH_KEY,
): Uint8Array {
  return textEncoder.encode(JSON.stringify(signMessageRoutePayload(request, authKey)))
}

function signedResponse(payload = routeResponse(REQUEST, accepted())) {
  return signMessageRoutePayload(payload, AUTH_KEY)
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
  it('persists one private master and derives isolated rotating session keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'tinstar-router-auth-'))
    const otherRoot = mkdtempSync(join(tmpdir(), 'tinstar-router-auth-other-'))
    try {
      const master = messageRouterMasterKey(root)
      expect(master).toHaveLength(32)
      expect(messageRouterMasterKey(root)).toEqual(master)
      expect(messageRouterMasterKey(otherRoot)).not.toEqual(master)
      expect(readFileSync(join(root, '.message-router-auth'))).toEqual(master)
      expect(statSync(join(root, '.message-router-auth')).mode & 0o777).toBe(0o600)

      const senderKey = deriveMessageRouterSessionKey(master, REQUEST.sender)
      expect(senderKey).toHaveLength(32)
      expect(deriveMessageRouterSessionKey(master, REQUEST.sender)).toEqual(senderKey)
      expect(deriveMessageRouterSessionKey(master, {
        sessionId: 'other',
        incarnation: REQUEST.sender.incarnation,
      })).not.toEqual(senderKey)
      expect(deriveMessageRouterSessionKey(master, {
        sessionId: REQUEST.sender.sessionId,
        incarnation: 'sender-v3',
      })).not.toEqual(senderKey)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(otherRoot, { recursive: true, force: true })
    }
  })

  it('uses a stable per-Tinstar service subject outside managed address space', () => {
    const root = mkdtempSync(join(tmpdir(), 'tinstar-router-address-'))
    const first = join(root, 'one')
    const second = join(root, 'two')
    try {
      expect(messageRouterSubject(first)).toMatch(
        /^_TINSTAR\.delivery\.route\.v1\.[a-f0-9]{24}$/,
      )
      expect(messageRouterSubject(first)).toBe(messageRouterSubject(first))
      expect(messageRouterSubject(first)).not.toBe(messageRouterSubject(second))
      expect(statSync(join(first, '.message-router-instance')).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('requires both managed sender identity fields from the MCP environment', () => {
    expect(deliverySenderFromEnvironment({
      TINSTAR_SESSION_NAME: 'sender',
      TINSTAR_AGENT_INCARNATION: 'sender-v2',
    })).toEqual(REQUEST.sender)
    expect(() => deliverySenderFromEnvironment({
      TINSTAR_SESSION_NAME: 'sender',
    })).toThrow('TINSTAR_AGENT_INCARNATION')
    expect(deliveryAuthKeyFromEnvironment({
      TINSTAR_MESSAGE_ROUTER_AUTH: AUTH_KEY.toString('hex'),
    })).toEqual(AUTH_KEY)
    expect(() => deliveryAuthKeyFromEnvironment({})).toThrow(
      'TINSTAR_MESSAGE_ROUTER_AUTH',
    )
    expect(() => deliveryAuthKeyFromEnvironment({
      TINSTAR_MESSAGE_ROUTER_AUTH: AUTH_KEY.toString('hex').toUpperCase(),
    })).toThrow('64 lowercase hex characters')
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
    const route = vi.fn(async () => signedResponse())
    const reply = createReplyMcpHandler({
      sender: REQUEST.sender,
      authKey: AUTH_KEY,
      createRequestId: () => 'req-7',
      route,
    })

    const result = await reply({
      to: REQUEST.destination.subject,
      text: REQUEST.text,
    })

    expect(route).toHaveBeenCalledWith(signMessageRoutePayload(REQUEST, AUTH_KEY))
    expect(result).toMatchObject({
      content: [{ type: 'text', text: expect.stringContaining('msg-7') }],
      structuredContent: { status: 'accepted' },
    })
    expect(result).not.toHaveProperty('isError')
  })

  it('surfaces router and transport failures instead of falling back to publish', async () => {
    const rejected = createReplyMcpHandler({
      sender: REQUEST.sender,
      authKey: AUTH_KEY,
      createRequestId: () => 'req-7',
      route: async () => signedResponse({
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
      authKey: AUTH_KEY,
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

  it('rejects a forged response before reporting durable acceptance', async () => {
    const reply = createReplyMcpHandler({
      sender: REQUEST.sender,
      authKey: AUTH_KEY,
      createRequestId: () => REQUEST.requestId,
      route: async () => signMessageRoutePayload(
        routeResponse(REQUEST, accepted()),
        Buffer.alloc(32, 0x42),
      ),
    })

    await expect(reply({
      to: REQUEST.destination.subject,
      text: REQUEST.text,
    })).resolves.toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('unauthenticated response') }],
    })
  })
})

describe('NATS request/reply boundary', () => {
  it('serially replaces the process responder when backend initialization repeats', async () => {
    const calls: string[] = []
    const service = (name: string) => ({
      start: vi.fn(async () => { calls.push(`${name}:start`) }),
      stop: vi.fn(async () => { calls.push(`${name}:stop`) }),
    }) as unknown as NatsMessageRouterService
    const first = service('first')
    const second = service('second')
    const firstLease = reserveMessageRouterOwner('/cfg/hmr')
    await expect(firstLease.start(first)).resolves.toBe(true)

    const secondLease = reserveMessageRouterOwner('/cfg/hmr')
    await expect(secondLease.start(second)).resolves.toBe(true)

    expect(calls).toEqual(['first:start', 'first:stop', 'second:start'])
    await firstLease.stop()
    expect(calls).toEqual(['first:start', 'first:stop', 'second:start'])
    await secondLease.stop()
    expect(calls).toEqual([
      'first:start',
      'first:stop',
      'second:start',
      'second:stop',
    ])
  })

  it('drains an old acceptance before replacement state opens and preserves both writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'message-router-hmr-'))
    const lockPath = join(dir, 'server.lock')
    const lock = acquireBackendSingleton(lockPath)
    if (!lock.acquired) throw new Error('test setup could not acquire backend singleton')
    const calls: string[] = []
    let releaseWrite!: () => void
    const writeFinished = new Promise<void>(resolve => { releaseWrite = resolve })
    const ids = ['msg-before-handoff', 'msg-after-handoff']
    const openLedger = () => DeliveryLedger.open({
      dir,
      lockPath,
      createMessageId: () => ids.shift() ?? 'msg-unused',
    })
    const oldLedger = openLedger()
    const accept = (requestId: string) => oldLedger.accept({
      requestId,
      sender: { sessionId: 'sender', incarnation: 'sender-v1' },
      destination: { subject: 'tinstar.agent.receiver' },
      text: requestId,
      recipients: [{
        providerId: 'codex',
        sessionId: 'receiver',
        incarnation: 'receiver-v1',
      }],
    })
    const first = {
      start: vi.fn(async () => { calls.push('first:start') }),
      stop: vi.fn(async () => {
        calls.push('first:draining')
        await writeFinished
        await accept('req-before-handoff')
        calls.push('first:stopped')
      }),
    } as unknown as NatsMessageRouterService
    const firstLease = reserveMessageRouterOwner('/cfg/hmr-held-write')
    await firstLease.start(first)

    const secondLease = reserveMessageRouterOwner('/cfg/hmr-held-write')
    let replacement: DeliveryLedger | null = null
    const replacementOpen = secondLease.handoff(async () => {
      calls.push('replacement:open')
      replacement = openLedger()
      await replacement.accept({
        requestId: 'req-after-handoff',
        sender: { sessionId: 'sender', incarnation: 'sender-v1' },
        destination: { subject: 'tinstar.agent.receiver' },
        text: 'req-after-handoff',
        recipients: [{
          providerId: 'codex',
          sessionId: 'receiver',
          incarnation: 'receiver-v1',
        }],
      })
    })
    await Promise.resolve()
    expect(calls).toEqual(['first:start', 'first:draining'])

    releaseWrite()
    await expect(replacementOpen).resolves.toBe(true)
    expect(calls).toEqual([
      'first:start',
      'first:draining',
      'first:stopped',
      'replacement:open',
    ])
    expect(replacement!.getMessage('msg-before-handoff')).toBeDefined()
    expect(replacement!.getMessage('msg-after-handoff')).toBeDefined()
    await secondLease.stop()
    rmSync(`${lockPath}.mark`, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })

  it('skips a queued handoff that a rapid replacement supersedes', async () => {
    let releaseDrain!: () => void
    const drainHeld = new Promise<void>(resolve => { releaseDrain = resolve })
    const first = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => { await drainHeld }),
    } as unknown as NatsMessageRouterService
    const firstLease = reserveMessageRouterOwner('/cfg/hmr-skip-stale')
    await firstLease.start(first)

    const secondLease = reserveMessageRouterOwner('/cfg/hmr-skip-stale')
    const secondPrepare = vi.fn(async () => {})
    const secondHandoff = secondLease.handoff(secondPrepare)
    const thirdLease = reserveMessageRouterOwner('/cfg/hmr-skip-stale')
    const thirdPrepare = vi.fn(async () => {})
    const thirdHandoff = thirdLease.handoff(thirdPrepare)

    releaseDrain()
    await expect(secondHandoff).resolves.toBe(false)
    await expect(thirdHandoff).resolves.toBe(true)
    expect(secondPrepare).not.toHaveBeenCalled()
    expect(thirdPrepare).toHaveBeenCalledOnce()
    await thirdLease.stop()
  })

  it('holds the owner transition through recovery before a newer handoff begins', async () => {
    const calls: string[] = []
    let releaseRecovery!: () => void
    const recoveryHeld = new Promise<void>(resolve => { releaseRecovery = resolve })
    const secondLease = reserveMessageRouterOwner('/cfg/hmr-serialized-recovery')
    const secondHandoff = secondLease.handoff(async () => {
      calls.push('second:open')
      await recoveryHeld
      calls.push('second:recovered')
    })
    await vi.waitFor(() => expect(calls).toEqual(['second:open']))

    const thirdLease = reserveMessageRouterOwner('/cfg/hmr-serialized-recovery')
    const thirdHandoff = thirdLease.handoff(async () => {
      calls.push('third:open')
    })
    await Promise.resolve()
    expect(calls).toEqual(['second:open'])

    releaseRecovery()
    await expect(secondHandoff).resolves.toBe(false)
    await expect(thirdHandoff).resolves.toBe(true)
    expect(calls).toEqual(['second:open', 'second:recovered', 'third:open'])
    await thirdLease.stop()
  })

  it('makes no-responder and timeout failures visible to the sender', async () => {
    const noResponder = {
      request: vi.fn(async () => {
        throw Object.assign(new Error('503'), { code: '503' })
      }),
    }
    await expect(requestMessageRoute(noResponder, '_route', REQUEST, AUTH_KEY)).rejects.toMatchObject({
      name: 'MessageRouteTransportError',
      code: 'no-responder',
    })

    const timeout = {
      request: vi.fn(async () => {
        throw Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' })
      }),
    }
    await expect(requestMessageRoute(timeout, '_route', REQUEST, AUTH_KEY)).rejects.toMatchObject({
      code: 'timeout',
    })
  })

  it('rejects malformed or mismatched responder receipts', async () => {
    const response = (body: unknown, authKey: Uint8Array = AUTH_KEY) => ({
      request: vi.fn(async () => ({
        data: textEncoder.encode(JSON.stringify(signMessageRoutePayload(body, authKey))),
      })),
    })
    await expect(requestMessageRoute(response({
      version: MESSAGE_ROUTE_PROTOCOL_VERSION,
      status: 'accepted',
      requestId: 'req-7',
      receipt: {},
    }), '_route', REQUEST, AUTH_KEY)).rejects.toMatchObject({ code: 'invalid-response' })

    await expect(requestMessageRoute(response({
      version: MESSAGE_ROUTE_PROTOCOL_VERSION,
      status: 'error',
      requestId: 'someone-else',
      error: { code: 'recipient-unavailable', message: 'stopped' },
    }), '_route', REQUEST, AUTH_KEY)).rejects.toMatchObject({ code: 'invalid-response' })

    await expect(requestMessageRoute(response(
      routeResponse(REQUEST, accepted()),
      Buffer.alloc(32, 0x42),
    ), '_route', REQUEST, AUTH_KEY)).rejects.toMatchObject({ code: 'invalid-response' })
  })

  it('rejects raw publications before acceptance and responds to valid requests', async () => {
    const responses: Uint8Array[] = []
    const raw: NatsRouteMessage = {
      data: encodedRequest(),
      respond: vi.fn(() => false),
    }
    const requested: NatsRouteMessage = {
      data: encodedRequest(),
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
      authMasterKey: MASTER_KEY,
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
    const response = JSON.parse(textDecoder.decode(responses[0]))
    expect(response).toMatchObject({
      payload: { status: 'accepted', requestId: 'req-7' },
    })
    expect(verifyMessageRouteEnvelope(response, AUTH_KEY)).toBe(true)
  })

  it('rejects a forged request before routing or durable mutation', async () => {
    const responses: Uint8Array[] = []
    const subscription: NatsRouteSubscription = {
      unsubscribe: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield {
          data: encodedRequest(REQUEST, Buffer.alloc(32, 0x42)),
          reply: '_INBOX.forged',
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
    const connection: NatsRouteConnection = {
      subscribe: () => subscription,
      closed: () => closed,
      flush: async () => {},
      drain: async () => { closeConnection() },
    }
    const route = vi.fn(async () => accepted())
    const service = new NatsMessageRouterService({
      subject: '_route',
      authMasterKey: MASTER_KEY,
      connect: async () => connection,
      route,
    })

    await service.start()
    await vi.waitFor(() => expect(responses).toHaveLength(1))
    await service.stop()

    expect(route).not.toHaveBeenCalled()
    const response = JSON.parse(textDecoder.decode(responses[0]))
    expect(response.payload).toMatchObject({
      status: 'error',
      requestId: REQUEST.requestId,
      error: { code: 'invalid-request', message: 'request authentication failed' },
    })
    expect(verifyMessageRouteEnvelope(response, AUTH_KEY)).toBe(true)
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
      authMasterKey: MASTER_KEY,
      connect: async () => connection,
      route,
      reconnectDelayMs: 1,
    })

    await service.start()
    await vi.waitFor(() => expect(responses).toHaveLength(1))
    await service.stop()

    expect(route).not.toHaveBeenCalled()
    expect(JSON.parse(textDecoder.decode(responses[0]))).toMatchObject({
      payload: { status: 'error', error: { code: 'invalid-request' } },
      auth: '',
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
          data: encodedRequest(),
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
      authMasterKey: MASTER_KEY,
      connect: async () => connections.shift()!,
      route: async () => accepted(),
      reconnectDelayMs: 1,
    })

    await service.start()
    await vi.waitFor(() => expect(responses).toHaveLength(1))
    await service.stop()

    expect(failedDrain).toHaveBeenCalledOnce()
  })

  it('reconnects after a live broker connection closes', async () => {
    let closeFirst!: (error?: unknown) => void
    const firstClosed = new Promise<unknown>(resolve => { closeFirst = resolve })
    const idleSubscription = (): NatsRouteSubscription => ({
      unsubscribe: vi.fn(),
      async *[Symbol.asyncIterator]() { await new Promise(() => {}) },
    })
    const first: NatsRouteConnection = {
      subscribe: vi.fn(idleSubscription),
      closed: () => firstClosed,
      flush: vi.fn(async () => {}),
      drain: vi.fn(async () => {}),
    }
    const responses: Uint8Array[] = []
    let closeSecond!: () => void
    const secondClosed = new Promise<void>(resolve => { closeSecond = resolve })
    const replacementSubscription: NatsRouteSubscription = {
      unsubscribe: vi.fn(),
      async *[Symbol.asyncIterator]() {
        yield {
          data: encodedRequest(),
          reply: '_INBOX.reconnected',
          respond: (data: Uint8Array) => {
            responses.push(data)
            return true
          },
        }
        await new Promise(() => {})
      },
    }
    const second: NatsRouteConnection = {
      subscribe: vi.fn(() => replacementSubscription),
      closed: () => secondClosed,
      flush: vi.fn(async () => {}),
      drain: vi.fn(async () => { closeSecond() }),
    }
    const connections = [first, second]
    const service = new NatsMessageRouterService({
      subject: '_route',
      authMasterKey: MASTER_KEY,
      connect: async () => connections.shift()!,
      route: async () => accepted(),
      reconnectDelayMs: 1,
    })

    await service.start()
    closeFirst(new Error('broker restarted'))
    await vi.waitFor(() => expect(second.subscribe).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(responses).toHaveLength(1))
    await service.stop()

    expect(second.flush).toHaveBeenCalledOnce()
    expect(JSON.parse(textDecoder.decode(responses[0]))).toMatchObject({
      payload: { status: 'accepted', requestId: REQUEST.requestId },
    })
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
      authMasterKey: MASTER_KEY,
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
      authMasterKey: MASTER_KEY,
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
