import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireBackendSingleton } from '../../infra/lock'
import { createDefaultProviderRegistry } from '../../providers/lifecycle'
import {
  DELIVERY_DISPATCH_CONCURRENCY,
  DeliveryRetryScheduler,
  dispatchAcceptedMessage,
  recoverAcceptedMessages,
  replaceDeliveryRetryScheduler,
  runDeliveryRetrySchedulerNow,
  stopDeliveryRetryScheduler,
} from '../delivery-dispatch'
import { DeliveryLedger } from '../delivery-ledger'
import {
  ClaudeChannelControlError,
  createClaudeDeliveryAdapter,
} from '../../providers/claude-delivery'
import { CodexDeliveryAdapter } from '../../providers/codex-delivery'

const roots: string[] = []
afterEach(async () => {
  await stopDeliveryRetryScheduler()
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function acceptedLedger(recipients = [{
  providerId: 'claude', sessionId: 'receiver', incarnation: 'receiver-v3',
}], options: {
  maxOutstandingDeliveries?: number
  now?: () => number
  createMessageId?: () => string
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tinstar-dispatch-'))
  roots.push(root)
  const lockPath = join(root, 'server.lock')
  if (!acquireBackendSingleton(lockPath).acquired) throw new Error('could not acquire test lock')
  const ledger = DeliveryLedger.open({
    dir: root, lockPath, createMessageId: () => 'msg-7', ...options,
  })
  const accepted = await ledger.accept({
    requestId: 'request-7',
    sender: { sessionId: 'sender', incarnation: 'sender-v2' },
    destination: { subject: 'agents.receiver' },
    text: 'hello once',
    recipients,
  })
  if (!accepted.accepted) throw new Error(accepted.reason)
  return { ledger, accepted }
}

describe('durable provider dispatch', () => {
  it('claims the ledger attempt once and passes the complete router stamp', async () => {
    const { ledger, accepted } = await acceptedLedger()
    const accept = vi.fn(async (request) => ({
      state: 'accepted' as const,
      providerId: 'claude',
      messageId: request.messageId,
      attempt: request.attempt,
      recipient: request.recipient,
      acceptedAt: '2026-08-01T12:00:02.000Z',
      attemptRef: request.deliveryId,
    }))
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', { accept })

    await expect(dispatchAcceptedMessage('msg-7', ledger, registry)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1', state: 'accepted',
    }])
    await expect(dispatchAcceptedMessage('msg-7', ledger, registry)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1', state: 'skipped',
    }])
    expect(accept).toHaveBeenCalledTimes(1)
    expect(accept).toHaveBeenCalledWith({
      messageId: 'msg-7',
      deliveryId: 'msg-7/d/1',
      attempt: 1,
      acceptedAt: accepted.message.acceptedAt,
      sender: { sessionId: 'sender', incarnation: 'sender-v2' },
      destination: { subject: 'agents.receiver' },
      recipient: {
        providerId: 'claude', sessionId: 'receiver', incarnation: 'receiver-v3',
      },
      text: 'hello once',
    })
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'accepted', attempt: 1,
      history: expect.arrayContaining([
        expect.objectContaining({ state: 'in-flight', attempt: 1 }),
        expect.objectContaining({
          state: 'accepted', attempt: 1, attemptRef: 'msg-7/d/1',
        }),
      ]),
    })
  })

  it('records a Claude native receipt as terminal delivery and releases ledger capacity', async () => {
    const now = Date.parse('2026-08-01T12:00:00.000Z')
    const messageIds = ['msg-7', 'msg-8']
    const { ledger } = await acceptedLedger(undefined, {
      maxOutstandingDeliveries: 1,
      now: () => now,
      createMessageId: () => messageIds.shift()!,
    })
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', createClaudeDeliveryAdapter({
      authKeyFor: () => Buffer.alloc(32, 0x23),
      deliver: async (_socket, command) => ({
        version: 1,
        status: 'accepted',
        messageId: command.envelope.payload.messageId,
        deliveryId: command.envelope.payload.deliveryId,
        attempt: command.envelope.payload.attempt,
        recipient: command.envelope.payload.recipient,
        acceptedAt: '2026-08-01T12:00:01.000Z',
      }),
    }))

    await expect(dispatchAcceptedMessage('msg-7', ledger, registry, {
      now: () => now,
    })).resolves.toEqual([{ deliveryId: 'msg-7/d/1', state: 'delivered' }])
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'delivered',
      attempt: 1,
      history: expect.arrayContaining([
        expect.objectContaining({
          state: 'delivered',
          attempt: 1,
          evidence: {
            source: { id: 'claude-channel-receipt', label: 'Claude channel receipt' },
            reference: 'msg-7/d/1',
          },
        }),
      ]),
    })
    expect(ledger.listRecoverable()).toEqual([])

    await expect(ledger.accept({
      requestId: 'request-8',
      sender: { sessionId: 'sender', incarnation: 'sender-v2' },
      destination: { subject: 'agents.receiver' },
      text: 'capacity was released',
      recipients: [{
        providerId: 'claude', sessionId: 'receiver', incarnation: 'receiver-v3',
      }],
    })).resolves.toMatchObject({ accepted: true })
  })

  it('recovers a retryable missing-socket failure after restart with the same message id', async () => {
    let now = Date.parse('2026-08-01T12:00:00.000Z')
    const { ledger } = await acceptedLedger(undefined, { now: () => now })
    const root = roots.at(-1)!
    let available = false
    const attempts: Array<{ messageId: string; attempt: number; incarnation: string }> = []
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', createClaudeDeliveryAdapter({
      authKeyFor: () => Buffer.alloc(32, 0x23),
      now: () => new Date(now).toISOString(),
      deliver: async (_socket, command) => {
        const payload = command.envelope.payload
        attempts.push({
          messageId: payload.messageId,
          attempt: payload.attempt,
          incarnation: payload.recipient.incarnation,
        })
        if (!available) {
          throw new ClaudeChannelControlError('unavailable', 'socket missing', false)
        }
        return {
          version: 1,
          status: 'accepted',
          messageId: payload.messageId,
          deliveryId: payload.deliveryId,
          attempt: payload.attempt,
          recipient: payload.recipient,
          acceptedAt: new Date(now).toISOString(),
        }
      },
    }))
    const firstBoot = new DeliveryRetryScheduler(ledger, registry, {
      now: () => now,
      retryDelayMs: 1_000,
      pollMs: 100,
    })

    await firstBoot.start()
    await firstBoot.stop()
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'failed',
      attempt: 1,
      history: expect.arrayContaining([expect.objectContaining({
        retryable: true,
        retryAt: '2026-08-01T12:00:01.000Z',
      })]),
    })

    const restartedLedger = DeliveryLedger.open({
      dir: root,
      lockPath: join(root, 'server.lock'),
      now: () => now,
    })
    const secondBoot = new DeliveryRetryScheduler(restartedLedger, registry, {
      now: () => now,
      retryDelayMs: 1_000,
      pollMs: 100,
    })
    available = true
    now += 999
    await secondBoot.start()
    expect(attempts).toHaveLength(1)
    now += 1
    await secondBoot.runNow()
    await secondBoot.stop()

    expect(attempts).toEqual([
      { messageId: 'msg-7', attempt: 1, incarnation: 'receiver-v3' },
      { messageId: 'msg-7', attempt: 2, incarnation: 'receiver-v3' },
    ])
    expect(restartedLedger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'delivered', attempt: 2,
    })
    expect(restartedLedger.listRecoverable()).toEqual([])
  })

  it('does not retry a deferred attempt until its explicit retryAt', async () => {
    let now = Date.parse('2026-08-01T12:00:00.000Z')
    const { ledger } = await acceptedLedger(undefined, { now: () => now })
    const attempts: number[] = []
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', {
      async accept(request) {
        attempts.push(request.attempt)
        if (request.attempt === 1) {
          return {
            state: 'deferred',
            providerId: 'claude',
            messageId: request.messageId,
            attempt: request.attempt,
            recipient: request.recipient,
            checkedAt: new Date(now).toISOString(),
            reason: 'channel warming up',
            retryAt: '2026-08-01T12:00:05.000Z',
          }
        }
        return {
          state: 'delivered',
          providerId: 'claude',
          messageId: request.messageId,
          attempt: request.attempt,
          recipient: request.recipient,
          deliveredAt: new Date(now).toISOString(),
          evidence: { source: { id: 'test-receipt', label: 'Test receipt' } },
        }
      },
    })
    const scheduler = new DeliveryRetryScheduler(ledger, registry, {
      now: () => now,
      retryDelayMs: 1_000,
    })

    await scheduler.start()
    now += 4_999
    await scheduler.runNow()
    expect(attempts).toEqual([1])
    now += 1
    await scheduler.runNow()
    await scheduler.stop()

    expect(attempts).toEqual([1, 2])
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'delivered', attempt: 2,
    })
  })

  it('advances a deferred Codex queue head when the dispatcher creates a retry attempt', async () => {
    let now = Date.parse('2026-08-01T12:00:00.000Z')
    let screen = 'Would you like to run this command?\nPress enter to confirm or esc to cancel'
    const submitted: string[] = []
    const { ledger } = await acceptedLedger([{
      providerId: 'codex', sessionId: 'receiver', incarnation: 'receiver-v3',
    }], { now: () => now })
    const adapter = new CodexDeliveryAdapter({
      now: () => new Date(now).toISOString(),
      currentIncarnation: async () => 'receiver-v3',
      resolveTranscript: async () => null,
      withSessionInput: async (_sessionId, operation) => operation({
        captureScreen: async () => screen,
        submitPrompt: async (prompt, beforeEnter) => {
          if (!await beforeEnter()) return false
          submitted.push(prompt)
          return true
        },
      }),
    })
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('codex', adapter)

    await expect(dispatchAcceptedMessage('msg-7', ledger, registry, {
      now: () => now,
      retryDelayMs: 1_000,
    })).resolves.toEqual([{
      deliveryId: 'msg-7/d/1',
      state: 'pending',
      reason: 'Codex is waiting for a modal confirmation',
    }])
    expect(adapter.queueDepth('receiver')).toBe(1)

    screen = '• Working\n\n› Add a follow-up\n  ? for shortcuts'
    now += 1_000
    await expect(recoverAcceptedMessages(ledger, registry, {
      now: () => now,
      retryDelayMs: 1_000,
    })).resolves.toEqual([{
      deliveryId: 'msg-7/d/1',
      state: 'accepted',
    }])

    expect(adapter.queueDepth('receiver')).toBe(0)
    expect(submitted).toHaveLength(1)
    expect(JSON.parse(submitted[0]!.split('\n').slice(1).join('\n'))).toMatchObject({
      message_id: 'msg-7',
      delivery_id: 'msg-7/d/1',
      attempt: 2,
    })
  })

  it('stops a prior-module retry loop when HMR installs a separately evaluated scheduler', async () => {
    vi.useFakeTimers()
    const firstEvaluation = await import('../delivery-dispatch')
    vi.resetModules()
    const secondEvaluation = await import('../delivery-dispatch')
    expect(firstEvaluation.DeliveryRetryScheduler)
      .not.toBe(secondEvaluation.DeliveryRetryScheduler)
    const now = Date.parse('2026-08-01T12:00:00.000Z')
    const first = await acceptedLedger(undefined, { now: () => now })
    const second = await acceptedLedger(undefined, { now: () => now })
    let firstCalls = 0
    const firstRegistry = createDefaultProviderRegistry()
    firstRegistry.registerDelivery('claude', {
      async accept(request) {
        firstCalls += 1
        return {
          state: 'deferred',
          providerId: 'claude',
          messageId: request.messageId,
          attempt: request.attempt,
          recipient: request.recipient,
          checkedAt: new Date(now).toISOString(),
          reason: 'still unavailable',
          retryAt: new Date(now).toISOString(),
        }
      },
    })
    const secondRegistry = createDefaultProviderRegistry()
    secondRegistry.registerDelivery('claude', {
      async accept(request) {
        return {
          state: 'delivered',
          providerId: 'claude',
          messageId: request.messageId,
          attempt: request.attempt,
          recipient: request.recipient,
          deliveredAt: new Date(now).toISOString(),
          evidence: { source: { id: 'test-receipt', label: 'Test receipt' } },
        }
      },
    })

    await firstEvaluation.replaceDeliveryRetryScheduler(
      new firstEvaluation.DeliveryRetryScheduler(
        first.ledger,
        firstRegistry,
        { now: () => now, pollMs: 10 },
      ),
    )
    expect(firstCalls).toBe(1)
    await secondEvaluation.replaceDeliveryRetryScheduler(
      new secondEvaluation.DeliveryRetryScheduler(
        second.ledger,
        secondRegistry,
        { now: () => now, pollMs: 10 },
      ),
    )
    const callsAtReplacement = firstCalls

    await vi.advanceTimersByTimeAsync(50)
    expect(firstCalls).toBe(callsAtReplacement)
    expect(second.ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'delivered', attempt: 1,
    })
  })

  it('does not let stale generation cleanup stop the newer retry scheduler', async () => {
    let firstStarted!: () => void
    let releaseFirst!: () => void
    const firstStartedGate = new Promise<void>(resolve => { firstStarted = resolve })
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const first = {
      start: vi.fn(async () => {
        firstStarted()
        await firstGate
        return []
      }),
      stop: vi.fn(async () => {}),
      runNow: vi.fn(async () => []),
    } as unknown as DeliveryRetryScheduler
    const second = {
      start: vi.fn(async () => []),
      stop: vi.fn(async () => {}),
      runNow: vi.fn(async () => []),
    } as unknown as DeliveryRetryScheduler

    const firstActivation = replaceDeliveryRetryScheduler(first)
    await firstStartedGate
    const secondActivation = replaceDeliveryRetryScheduler(second)
    releaseFirst()
    await firstActivation
    await secondActivation

    await stopDeliveryRetryScheduler(first)
    await runDeliveryRetrySchedulerNow()

    expect(first.stop).toHaveBeenCalledTimes(2)
    expect(second.stop).not.toHaveBeenCalled()
    expect(second.runNow).toHaveBeenCalledOnce()
  })

  it('clears the retry interval when the initial recovery sweep rejects', async () => {
    vi.useFakeTimers()
    const scheduler = new DeliveryRetryScheduler({
      listRecoverable: () => { throw new Error('ledger read failed') },
      getMessage: vi.fn(),
      getDelivery: vi.fn(),
      transition: vi.fn(),
    }, createDefaultProviderRegistry(), { pollMs: 10 })

    await expect(replaceDeliveryRetryScheduler(scheduler)).rejects.toThrow('ledger read failed')

    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports both scheduler start and rollback failures', async () => {
    const scheduler = {
      start: vi.fn(async () => { throw new Error('initial sweep failed') }),
      stop: vi.fn(async () => { throw new Error('timer cleanup failed') }),
    } as unknown as DeliveryRetryScheduler

    await expect(replaceDeliveryRetryScheduler(scheduler)).rejects.toThrow(
      'retry scheduler start failed (initial sweep failed); rollback failed (timer cleanup failed)',
    )
  })

  it('recovers accepted work after restart with the persisted recipient incarnation', async () => {
    const { ledger } = await acceptedLedger()
    const root = roots.at(-1)!
    const recoveredLedger = DeliveryLedger.open({
      dir: root,
      lockPath: join(root, 'server.lock'),
    })
    const accept = vi.fn(async (request) => ({
      state: 'accepted' as const,
      providerId: 'claude',
      messageId: request.messageId,
      attempt: request.attempt,
      recipient: request.recipient,
      acceptedAt: '2026-08-01T12:00:02.000Z',
    }))
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', { accept })

    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'accepted', attempt: 0,
    })
    await expect(recoverAcceptedMessages(recoveredLedger, registry)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1', state: 'accepted',
    }])
    expect(accept).toHaveBeenCalledOnce()
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({
      recipient: {
        providerId: 'claude', sessionId: 'receiver', incarnation: 'receiver-v3',
      },
    }))
    expect(recoveredLedger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'accepted', attempt: 1,
    })
    await expect(recoverAcceptedMessages(recoveredLedger, registry)).resolves.toEqual([])
    expect(accept).toHaveBeenCalledOnce()
  })

  it('uses durable acceptance evidence to confirm a Codex attempt after restart', async () => {
    let now = Date.parse('2026-08-01T12:00:02.000Z')
    const { ledger } = await acceptedLedger([{
      providerId: 'codex', sessionId: 'receiver', incarnation: 'receiver-v3',
    }], { now: () => now })
    const firstRegistry = createDefaultProviderRegistry()
    firstRegistry.registerDelivery('codex', {
      async accept(request) {
        return {
          state: 'accepted',
          providerId: 'codex',
          messageId: request.messageId,
          attempt: request.attempt,
          recipient: request.recipient,
          acceptedAt: '2026-08-01T12:00:01.500Z',
          attemptRef: 'tinstar-message-v1:sha256:' + 'a'.repeat(64),
        }
      },
      async confirm(acceptance) {
        return {
          state: 'pending',
          providerId: 'codex',
          messageId: acceptance.messageId,
          attempt: acceptance.attempt,
          recipient: acceptance.recipient,
          checkedAt: '2026-08-01T12:00:03.000Z',
          reason: 'not visible before restart',
        }
      },
    })
    await dispatchAcceptedMessage('msg-7', ledger, firstRegistry, { now: () => now })

    const root = roots.at(-1)!
    const recoveredLedger = DeliveryLedger.open({
      dir: root,
      lockPath: join(root, 'server.lock'),
      now: () => now,
    })
    const confirm = vi.fn(async (acceptance) => ({
      state: 'confirmed' as const,
      providerId: 'codex',
      messageId: acceptance.messageId,
      attempt: acceptance.attempt,
      recipient: acceptance.recipient,
      confirmedAt: '2026-08-01T12:00:04.000Z',
      evidence: {
        source: { id: 'codex-rollout-user-message', label: 'Codex rollout user message' },
        reference: acceptance.attemptRef,
      },
    }))
    const recoveredRegistry = createDefaultProviderRegistry()
    recoveredRegistry.registerDelivery('codex', {
      async accept() { throw new Error('accepted attempt must not be replayed') },
      confirm,
    })

    await expect(recoverAcceptedMessages(
      recoveredLedger,
      recoveredRegistry,
      { now: () => now },
    )).resolves.toEqual([])
    expect(confirm).not.toHaveBeenCalled()

    now += 1_000
    await expect(recoverAcceptedMessages(
      recoveredLedger,
      recoveredRegistry,
      { now: () => now },
    )).resolves.toEqual([{
      deliveryId: 'msg-7/d/1', state: 'delivered',
    }])
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'codex',
      messageId: 'msg-7',
      attempt: 1,
      acceptedAt: '2026-08-01T12:00:01.500Z',
      attemptRef: 'tinstar-message-v1:sha256:' + 'a'.repeat(64),
      recipient: {
        providerId: 'codex', sessionId: 'receiver', incarnation: 'receiver-v3',
      },
    }))
    expect(recoveredLedger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'delivered',
      attempt: 1,
      history: expect.arrayContaining([
        expect.objectContaining({
          state: 'delivered',
          evidence: expect.objectContaining({
            source: expect.objectContaining({ id: 'codex-rollout-user-message' }),
          }),
        }),
      ]),
    })
  })

  it('confirms provider acceptance without provider-owned attempt state', async () => {
    let now = Date.parse('2026-08-01T12:00:00.000Z')
    const { ledger } = await acceptedLedger([{
      providerId: 'generic', sessionId: 'receiver', incarnation: 'receiver-v3',
    }], { now: () => now })
    const confirm = vi.fn(async (acceptance) => ({
      state: 'confirmed' as const,
      providerId: 'generic',
      messageId: acceptance.messageId,
      attempt: acceptance.attempt,
      recipient: acceptance.recipient,
      confirmedAt: new Date(now).toISOString(),
      evidence: {
        source: { id: 'generic-confirmation', label: 'Generic confirmation' },
      },
    }))
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('generic', {
      async accept(request) {
        return {
          state: 'accepted',
          providerId: 'generic',
          messageId: request.messageId,
          attempt: request.attempt,
          recipient: request.recipient,
          acceptedAt: '2026-08-01T11:59:59.500Z',
        }
      },
      confirm,
    })

    await dispatchAcceptedMessage('msg-7', ledger, registry, { now: () => now })
    now += 1_000
    await expect(recoverAcceptedMessages(ledger, registry, { now: () => now })).resolves.toEqual([{
      deliveryId: 'msg-7/d/1', state: 'delivered',
    }])
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      acceptedAt: '2026-08-01T11:59:59.500Z',
    }))
    expect(confirm.mock.calls[0]![0]).not.toHaveProperty('attemptRef')
  })

  it('backs off bounded confirmation before issuing a fresh at-least-once attempt', async () => {
    let now = Date.parse('2026-08-01T12:00:00.000Z')
    const { ledger } = await acceptedLedger([{
      providerId: 'codex', sessionId: 'receiver', incarnation: 'receiver-v3',
    }], { now: () => now })
    const accept = vi.fn(async (request) => ({
      state: 'accepted' as const,
      providerId: 'codex',
      messageId: request.messageId,
      attempt: request.attempt,
      recipient: request.recipient,
      acceptedAt: new Date(now).toISOString(),
      attemptRef: `attempt-${request.attempt}`,
    }))
    const confirm = vi.fn(async (acceptance) => ({
      state: 'pending' as const,
      providerId: 'codex',
      messageId: acceptance.messageId,
      attempt: acceptance.attempt,
      recipient: acceptance.recipient,
      checkedAt: new Date(now).toISOString(),
      reason: 'rollout evidence is not visible yet',
    }))
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('codex', { accept, confirm })
    const options = {
      now: () => now,
      retryDelayMs: 1_000,
      confirmationMaxChecks: 2,
      maxAttempts: 2,
    }

    await expect(dispatchAcceptedMessage('msg-7', ledger, registry, options)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1', state: 'accepted',
    }])
    now += 999
    await expect(recoverAcceptedMessages(ledger, registry, options)).resolves.toEqual([])
    expect(confirm).not.toHaveBeenCalled()

    now += 1
    await expect(recoverAcceptedMessages(ledger, registry, options)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1',
      state: 'pending',
      reason: 'rollout evidence is not visible yet',
    }])
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'pending', attempt: 1,
      history: expect.arrayContaining([expect.objectContaining({
        state: 'pending',
        retryAt: '2026-08-01T12:00:02.000Z',
      })]),
    })

    const root = roots.at(-1)!
    const reopenedLedger = DeliveryLedger.open({
      dir: root,
      lockPath: join(root, 'server.lock'),
      now: () => now,
    })

    now += 999
    await expect(recoverAcceptedMessages(reopenedLedger, registry, options)).resolves.toEqual([])
    expect(confirm).toHaveBeenCalledTimes(1)

    now += 1
    await expect(recoverAcceptedMessages(reopenedLedger, registry, options)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1',
      state: 'failed',
      reason: 'Provider confirmation remained pending after 2 checks: '
        + 'rollout evidence is not visible yet',
    }])
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(reopenedLedger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'failed', attempt: 1,
      history: expect.arrayContaining([expect.objectContaining({
        retryable: true,
        retryAt: '2026-08-01T12:00:03.000Z',
      })]),
    })

    now += 1_000
    await expect(recoverAcceptedMessages(reopenedLedger, registry, options)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1', state: 'accepted',
    }])
    expect(accept.mock.calls.map(([request]) => request.attempt)).toEqual([1, 2])
    expect(reopenedLedger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'accepted', attempt: 2,
    })

    now += 1_000
    await expect(recoverAcceptedMessages(reopenedLedger, registry, options)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1',
      state: 'pending',
      reason: 'rollout evidence is not visible yet',
    }])
    now += 1_000
    await expect(recoverAcceptedMessages(reopenedLedger, registry, options)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1',
      state: 'failed',
      reason: 'Provider delivery could not be confirmed after 2 attempts: '
        + 'rollout evidence is not visible yet',
    }])
    expect(reopenedLedger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'failed', attempt: 2,
      history: expect.arrayContaining([expect.objectContaining({
        retryable: false,
      })]),
    })
    now += 60_000
    await expect(recoverAcceptedMessages(reopenedLedger, registry, options)).resolves.toEqual([])
    expect(accept.mock.calls.map(([request]) => request.attempt)).toEqual([1, 2])
  })

  it('fails an unregistered provider without blocking healthy recovery work', async () => {
    const { ledger } = await acceptedLedger([
      { providerId: 'removed', sessionId: 'gone', incarnation: 'gone-v1' },
      { providerId: 'claude', sessionId: 'receiver', incarnation: 'receiver-v3' },
    ])
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', {
      async accept(request) {
        return {
          state: 'delivered',
          providerId: 'claude',
          messageId: request.messageId,
          attempt: request.attempt,
          recipient: request.recipient,
          deliveredAt: '2026-08-01T12:00:01.000Z',
          evidence: {
            source: { id: 'claude-receipt', label: 'Claude receipt' },
          },
        }
      },
    })

    const deliveries = ledger.getMessage('msg-7')!.deliveries
    const removedId = deliveries.find(delivery => delivery.recipient.providerId === 'removed')!.id
    const healthyId = deliveries.find(delivery => delivery.recipient.providerId === 'claude')!.id
    await expect(recoverAcceptedMessages(ledger, registry)).resolves.toEqual(expect.arrayContaining([
      {
        deliveryId: removedId,
        state: 'failed',
        reason: 'Provider "removed" is no longer registered',
      },
      { deliveryId: healthyId, state: 'delivered' },
    ]))
    expect(ledger.getDelivery(removedId)).toMatchObject({
      state: 'failed',
      history: expect.arrayContaining([expect.objectContaining({ retryable: false })]),
    })
    expect(ledger.getDelivery(healthyId)).toMatchObject({ state: 'delivered' })
  })

  it('bounds retryable acceptance rejections by the delivery attempt budget', async () => {
    let now = Date.parse('2026-08-01T12:00:00.000Z')
    const { ledger } = await acceptedLedger(undefined, { now: () => now })
    const attempts: number[] = []
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', {
      async accept(request) {
        attempts.push(request.attempt)
        return {
          state: 'rejected',
          providerId: 'claude',
          messageId: request.messageId,
          attempt: request.attempt,
          recipient: request.recipient,
          checkedAt: new Date(now).toISOString(),
          reason: 'temporary channel failure',
          retryable: true,
        }
      },
    })
    const options = { now: () => now, retryDelayMs: 1_000, maxAttempts: 2 }

    await dispatchAcceptedMessage('msg-7', ledger, registry, options)
    now += 1_000
    await recoverAcceptedMessages(ledger, registry, options)
    expect(attempts).toEqual([1, 2])
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'failed', attempt: 2,
      history: expect.arrayContaining([expect.objectContaining({ retryable: false })]),
    })
    now += 60_000
    await expect(recoverAcceptedMessages(ledger, registry, options)).resolves.toEqual([])
    expect(attempts).toEqual([1, 2])
  })

  it('bounds retryable confirmation failures by the delivery attempt budget', async () => {
    let now = Date.parse('2026-08-01T12:00:00.000Z')
    const { ledger } = await acceptedLedger([{
      providerId: 'codex', sessionId: 'receiver', incarnation: 'receiver-v3',
    }], { now: () => now })
    const attempts: number[] = []
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('codex', {
      async accept(request) {
        attempts.push(request.attempt)
        return {
          state: 'accepted',
          providerId: 'codex',
          messageId: request.messageId,
          attempt: request.attempt,
          recipient: request.recipient,
          acceptedAt: new Date(now).toISOString(),
          attemptRef: `attempt-${request.attempt}`,
        }
      },
      async confirm(acceptance) {
        return {
          state: 'failed',
          providerId: 'codex',
          messageId: acceptance.messageId,
          attempt: acceptance.attempt,
          recipient: acceptance.recipient,
          checkedAt: new Date(now).toISOString(),
          reason: 'temporary evidence failure',
          retryable: true,
        }
      },
    })
    const options = { now: () => now, retryDelayMs: 1_000, maxAttempts: 2 }

    await dispatchAcceptedMessage('msg-7', ledger, registry, options)
    now += 1_000
    await recoverAcceptedMessages(ledger, registry, options)
    now += 1_000
    await recoverAcceptedMessages(ledger, registry, options)
    now += 1_000
    await recoverAcceptedMessages(ledger, registry, options)
    expect(attempts).toEqual([1, 2])
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'failed', attempt: 2,
      history: expect.arrayContaining([expect.objectContaining({ retryable: false })]),
    })
    now += 60_000
    await expect(recoverAcceptedMessages(ledger, registry, options)).resolves.toEqual([])
    expect(attempts).toEqual([1, 2])
  })

  it('records explicit channel rejection instead of silently succeeding', async () => {
    const { ledger } = await acceptedLedger()
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', {
      async accept(request) {
        return {
          state: 'rejected',
          providerId: 'claude',
          messageId: request.messageId,
          attempt: request.attempt,
          recipient: request.recipient,
          checkedAt: '2026-08-01T12:00:02.000Z',
          reason: 'Claude channel is not subscribed',
          retryable: true,
        }
      },
    })

    await expect(dispatchAcceptedMessage('msg-7', ledger, registry)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1',
      state: 'failed',
      reason: 'Claude channel is not subscribed',
    }])
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'failed', attempt: 1,
      history: expect.arrayContaining([
        expect.objectContaining({ retryable: true }),
      ]),
    })
  })

  it('keeps a replacement process terminal instead of migrating the obligation', async () => {
    const { ledger } = await acceptedLedger()
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', {
      async accept(request) {
        expect(request.recipient).toEqual({
          providerId: 'claude', sessionId: 'receiver', incarnation: 'receiver-v3',
        })
        return {
          state: 'rejected',
          providerId: 'claude',
          messageId: request.messageId,
          attempt: request.attempt,
          recipient: request.recipient,
          checkedAt: '2026-08-01T12:00:02.000Z',
          reason: 'delivery recipient was replaced',
          retryable: false,
        }
      },
    })

    await expect(dispatchAcceptedMessage('msg-7', ledger, registry)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1',
      state: 'failed',
      reason: 'delivery recipient was replaced',
    }])
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'failed',
      attempt: 1,
      recipient: {
        providerId: 'claude', sessionId: 'receiver', incarnation: 'receiver-v3',
      },
      history: expect.arrayContaining([
        expect.objectContaining({
          state: 'failed', reason: 'delivery recipient was replaced', retryable: false,
        }),
      ]),
    })
    await expect(dispatchAcceptedMessage('msg-7', ledger, registry)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1', state: 'skipped',
    }])
  })

  it('leaves a lost final-mile acknowledgement in-flight for exact recovery', async () => {
    const { ledger } = await acceptedLedger()
    const registry = createDefaultProviderRegistry()
    const accept = vi.fn(async () => { throw new Error('acknowledgement timeout') })
    registry.registerDelivery('claude', {
      accept,
    })

    await expect(dispatchAcceptedMessage('msg-7', ledger, registry)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1',
      state: 'ambiguous',
      reason: 'acknowledgement timeout',
    }])
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'in-flight', attempt: 1,
    })
    await expect(recoverAcceptedMessages(ledger, registry)).resolves.toEqual([])
    expect(accept).toHaveBeenCalledOnce()
  })

  it('bounds a large broadcast while preserving recipient result order', async () => {
    const recipientCount = DELIVERY_DISPATCH_CONCURRENCY * 3 + 5
    const recipients = Array.from({ length: recipientCount }, (_, index) => ({
      providerId: 'claude',
      sessionId: `receiver-${index + 1}`,
      incarnation: `receiver-${index + 1}-v1`,
    }))
    const { ledger } = await acceptedLedger(recipients)
    let active = 0
    let peak = 0
    let started = 0
    let releaseFirstBatch!: () => void
    const firstBatch = new Promise<void>(resolve => { releaseFirstBatch = resolve })
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', {
      async accept(request) {
        active += 1
        started += 1
        peak = Math.max(peak, active)
        if (started === DELIVERY_DISPATCH_CONCURRENCY) releaseFirstBatch()
        await firstBatch
        await new Promise<void>(resolve => queueMicrotask(resolve))
        active -= 1
        return {
          state: 'accepted',
          providerId: 'claude',
          messageId: request.messageId,
          attempt: request.attempt,
          recipient: request.recipient,
          acceptedAt: '2026-08-01T12:00:02.000Z',
        }
      },
    })

    const outcomes = await dispatchAcceptedMessage('msg-7', ledger, registry)

    expect(peak).toBe(DELIVERY_DISPATCH_CONCURRENCY)
    expect(outcomes).toHaveLength(recipientCount)
    expect(outcomes.map(outcome => outcome.deliveryId)).toEqual(
      Array.from({ length: recipientCount }, (_, index) => `msg-7/d/${index + 1}`),
    )
    expect(outcomes.every(outcome => outcome.state === 'accepted')).toBe(true)
  })

  it('shares the concurrency bound across simultaneous messages', async () => {
    const recipients = Array.from(
      { length: DELIVERY_DISPATCH_CONCURRENCY + 5 },
      (_, index) => ({
        providerId: 'claude',
        sessionId: `receiver-${index + 1}`,
        incarnation: `receiver-${index + 1}-v1`,
      }),
    )
    const first = await acceptedLedger(recipients)
    const second = await acceptedLedger(recipients)
    let active = 0
    let peak = 0
    let started = 0
    let release!: () => void
    let saturated!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const atLimit = new Promise<void>(resolve => { saturated = resolve })
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', {
      async accept(request) {
        active += 1
        started += 1
        peak = Math.max(peak, active)
        if (started === DELIVERY_DISPATCH_CONCURRENCY) saturated()
        await gate
        active -= 1
        return {
          state: 'accepted',
          providerId: 'claude',
          messageId: request.messageId,
          attempt: request.attempt,
          recipient: request.recipient,
          acceptedAt: '2026-08-01T12:00:02.000Z',
        }
      },
    })

    const dispatches = Promise.all([
      dispatchAcceptedMessage('msg-7', first.ledger, registry),
      dispatchAcceptedMessage('msg-7', second.ledger, registry),
    ])
    await atLimit
    expect(active).toBe(DELIVERY_DISPATCH_CONCURRENCY)
    expect(peak).toBe(DELIVERY_DISPATCH_CONCURRENCY)
    expect(started).toBe(DELIVERY_DISPATCH_CONCURRENCY)
    release()

    const [firstOutcomes, secondOutcomes] = await dispatches
    expect(peak).toBe(DELIVERY_DISPATCH_CONCURRENCY)
    expect(firstOutcomes.map(outcome => outcome.deliveryId)).toEqual(
      recipients.map((_, index) => `msg-7/d/${index + 1}`),
    )
    expect(secondOutcomes.map(outcome => outcome.deliveryId)).toEqual(
      recipients.map((_, index) => `msg-7/d/${index + 1}`),
    )
  })
})
