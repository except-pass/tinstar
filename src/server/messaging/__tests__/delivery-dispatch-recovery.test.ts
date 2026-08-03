import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createDefaultProviderRegistry } from '../../providers/lifecycle'
import {
  DeliveryRetryScheduler,
  dispatchAcceptedMessage,
  recoverAcceptedMessages,
  replaceDeliveryRetryScheduler,
  runDeliveryRetrySchedulerNow,
  stopDeliveryRetryScheduler,
} from '../delivery-dispatch'
import { DeliveryLedger } from '../delivery-ledger'
import { acceptedLedger, roots } from './delivery-dispatch-fixture'

describe('durable provider dispatch recovery', () => {
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
    const reason = 'Provider "claude" accepted attempt 1 but exposes no confirmation '
      + 'evidence; delivery outcome is ambiguous'
    await expect(recoverAcceptedMessages(recoveredLedger, registry)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1', state: 'ambiguous', reason,
    }])
    expect(recoveredLedger.getDelivery('msg-7/d/1')).toMatchObject({ state: 'failed' })
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

  it('keeps acceptance identity and confirmation count after bounded history prunes them', async () => {
    let now = Date.parse('2026-08-01T12:00:00.000Z')
    const { ledger } = await acceptedLedger([{
      providerId: 'codex', sessionId: 'receiver', incarnation: 'receiver-v3',
    }], { now: () => now, maxHistoryEntries: 4 })
    const accept = vi.fn(async request => ({
      state: 'accepted' as const,
      providerId: 'codex',
      messageId: request.messageId,
      attempt: request.attempt,
      recipient: request.recipient,
      acceptedAt: new Date(now).toISOString(),
      attemptRef: 'durable-attempt-1',
    }))
    const confirm = vi.fn(async acceptance => ({
      state: 'pending' as const,
      providerId: 'codex',
      messageId: acceptance.messageId,
      attempt: acceptance.attempt,
      recipient: acceptance.recipient,
      checkedAt: new Date(now).toISOString(),
      reason: 'rollout evidence remains pending',
    }))
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('codex', { accept, confirm })
    const options = {
      now: () => now,
      retryDelayMs: 1_000,
      confirmationMaxChecks: 6,
      maxAttempts: 1,
    }

    await dispatchAcceptedMessage('msg-7', ledger, registry, options)
    for (const delay of [1_000, 1_000, 2_000]) {
      now += delay
      await recoverAcceptedMessages(ledger, registry, options)
    }
    const truncated = ledger.getDelivery('msg-7/d/1')!
    expect(truncated).toMatchObject({
      state: 'pending',
      historyTruncated: true,
      providerAcceptance: {
        attempt: 1,
        acceptedAt: '2026-08-01T12:00:00.000Z',
        attemptRef: 'durable-attempt-1',
        confirmationCount: 3,
      },
    })
    expect(truncated.history).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ state: 'accepted', attempt: 1 }),
    ]))

    const root = roots.at(-1)!
    const reopened = DeliveryLedger.open({
      dir: root,
      lockPath: join(root, 'server.lock'),
      now: () => now,
      maxHistoryEntries: 4,
    })
    const recoveredAccept = vi.fn(async () => {
      throw new Error('durably accepted attempt must not be replayed')
    })
    const recoveredConfirm = vi.fn(async acceptance => ({
      state: 'confirmed' as const,
      providerId: 'codex',
      messageId: acceptance.messageId,
      attempt: acceptance.attempt,
      recipient: acceptance.recipient,
      confirmedAt: new Date(now).toISOString(),
      evidence: {
        source: { id: 'codex-rollout-user-message', label: 'Codex rollout user message' },
        reference: acceptance.attemptRef,
      },
    }))
    const recoveredRegistry = createDefaultProviderRegistry()
    recoveredRegistry.registerDelivery('codex', {
      accept: recoveredAccept,
      confirm: recoveredConfirm,
    })
    now += 4_000

    await expect(recoverAcceptedMessages(
      reopened,
      recoveredRegistry,
      options,
    )).resolves.toEqual([{ deliveryId: 'msg-7/d/1', state: 'delivered' }])
    expect(recoveredAccept).not.toHaveBeenCalled()
    expect(recoveredConfirm).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 1,
      acceptedAt: '2026-08-01T12:00:00.000Z',
      attemptRef: 'durable-attempt-1',
    }))
    expect(reopened.getDelivery('msg-7/d/1')).toMatchObject({ state: 'delivered' })
  })

  it('does not spend confirmation or reinjection budgets while evidence is unobservable', async () => {
    let now = Date.parse('2026-08-01T12:00:00.000Z')
    let observable = false
    const { ledger } = await acceptedLedger([{
      providerId: 'codex', sessionId: 'receiver', incarnation: 'receiver-v3',
    }], { now: () => now })
    const accept = vi.fn(async request => ({
      state: 'accepted' as const,
      providerId: 'codex',
      messageId: request.messageId,
      attempt: request.attempt,
      recipient: request.recipient,
      acceptedAt: new Date(now).toISOString(),
      attemptRef: 'durable-attempt-1',
    }))
    const confirm = vi.fn(async acceptance => observable
      ? {
          state: 'confirmed' as const,
          providerId: 'codex',
          messageId: acceptance.messageId,
          attempt: acceptance.attempt,
          recipient: acceptance.recipient,
          confirmedAt: new Date(now).toISOString(),
          evidence: {
            source: { id: 'codex-rollout-user-message', label: 'Codex rollout user message' },
          },
        }
      : {
          state: 'unobservable' as const,
          providerId: 'codex',
          messageId: acceptance.messageId,
          attempt: acceptance.attempt,
          recipient: acceptance.recipient,
          checkedAt: new Date(now).toISOString(),
          retryAt: new Date(now + 1_000).toISOString(),
          reason: 'rollout discovery is temporarily unavailable',
        })
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('codex', { accept, confirm })
    const options = {
      now: () => now,
      retryDelayMs: 1_000,
      confirmationMaxChecks: 1,
      maxAttempts: 2,
    }

    await dispatchAcceptedMessage('msg-7', ledger, registry, options)
    for (let index = 0; index < 3; index += 1) {
      now += 1_000
      await expect(recoverAcceptedMessages(ledger, registry, options)).resolves.toEqual([{
        deliveryId: 'msg-7/d/1',
        state: 'pending',
        reason: 'rollout discovery is temporarily unavailable',
      }])
    }
    expect(accept).toHaveBeenCalledOnce()
    expect(confirm).toHaveBeenCalledTimes(3)
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'pending',
      attempt: 1,
      providerAcceptance: { confirmationCount: 0 },
    })

    observable = true
    now += 1_000
    await expect(recoverAcceptedMessages(ledger, registry, options)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1', state: 'delivered',
    }])
    expect(accept).toHaveBeenCalledOnce()
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

})
