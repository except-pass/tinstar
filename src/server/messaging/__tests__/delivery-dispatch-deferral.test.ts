import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createDefaultProviderRegistry } from '../../providers/lifecycle'
import {
  DeliveryRetryScheduler,
  dispatchAcceptedMessage,
  recoverAcceptedMessages,
} from '../delivery-dispatch'
import { DeliveryLedger } from '../delivery-ledger'
import {
  CodexDeliveryAdapter,
  parseCodexMessageEnvelope,
} from '../../providers/codex-delivery'
import { acceptedLedger, roots } from './delivery-dispatch-fixture'

describe('durable provider dispatch deferrals', () => {
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
        getWorkingDirectory: async () => null,
        getAgentIdentity: async () => 'receiver-v3',
        submitPrompt: async (prompt, beforeInput, beforeEnter) => {
          if (!await beforeInput()) return false
          submitted.push(prompt)
          screen = `› ${prompt}`
          await beforeEnter()
          screen = '› Add a follow-up\n  ? for shortcuts'
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
    expect(parseCodexMessageEnvelope(submitted[0]!)).toMatchObject({
      message_id: 'msg-7',
      delivery_id: 'msg-7/d/1',
      attempt: 2,
    })
  })

  it('does not spend the send-attempt budget while provider acceptance is deferred', async () => {
    let now = Date.parse('2026-08-01T12:00:00.000Z')
    const { ledger } = await acceptedLedger(undefined, { now: () => now })
    const attempts: number[] = []
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', {
      async accept(request) {
        attempts.push(request.attempt)
        if (attempts.length <= 5) {
          return {
            state: 'deferred',
            providerId: 'claude',
            messageId: request.messageId,
            attempt: request.attempt,
            recipient: request.recipient,
            checkedAt: new Date(now).toISOString(),
            reason: 'operator interaction is still active',
            retryAt: new Date(now + 1_000).toISOString(),
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
    const options = {
      now: () => now,
      retryDelayMs: 1_000,
      maxAttempts: 1,
      maxDeferrals: 10,
    }

    await dispatchAcceptedMessage('msg-7', ledger, registry, options)
    for (let index = 0; index < 5; index += 1) {
      now += 1_000
      await recoverAcceptedMessages(ledger, registry, options)
    }

    expect(attempts).toEqual([1, 2, 3, 4, 5, 6])
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'delivered', attempt: 6,
    })
  })

  it('backs off repeated provider deferrals without full-ledger write churn', async () => {
    let now = Date.parse('2026-08-01T12:00:00.000Z')
    const startedAt = now
    const { ledger } = await acceptedLedger(undefined, { now: () => now })
    const attempts: number[] = []
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', {
      async accept(request) {
        attempts.push(now - startedAt)
        return {
          state: 'deferred',
          providerId: 'claude',
          messageId: request.messageId,
          attempt: request.attempt,
          recipient: request.recipient,
          checkedAt: new Date(now).toISOString(),
          reason: 'operator interaction is still active',
        }
      },
    })
    const options = { now: () => now, retryDelayMs: 1_000, maxDeferrals: 10 }

    await dispatchAcceptedMessage('msg-7', ledger, registry, options)
    for (const delta of [999, 1, 1_999, 1, 3_999, 1]) {
      now += delta
      await recoverAcceptedMessages(ledger, registry, options)
    }

    expect(attempts).toEqual([0, 1_000, 3_000, 7_000])
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'pending',
      deferralCount: 4,
      history: expect.arrayContaining([expect.objectContaining({
        retryAt: '2026-08-01T12:00:15.000Z',
      })]),
    })
  })

  it('starts a fresh deferral budget after a classified provider call', async () => {
    let now = Date.parse('2026-08-01T12:00:00.000Z')
    const { ledger } = await acceptedLedger(undefined, { now: () => now })
    let call = 0
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', {
      async accept(request) {
        call += 1
        if (call !== 2) {
          return {
            state: 'deferred',
            providerId: 'claude',
            messageId: request.messageId,
            attempt: request.attempt,
            recipient: request.recipient,
            checkedAt: new Date(now).toISOString(),
            reason: 'provider remains busy',
            retryAt: new Date(now + 1_000).toISOString(),
          }
        }
        return {
          state: 'rejected',
          providerId: 'claude',
          messageId: request.messageId,
          attempt: request.attempt,
          recipient: request.recipient,
          checkedAt: new Date(now).toISOString(),
          reason: 'retryable provider response',
          retryable: true,
        }
      },
    })
    const options = {
      now: () => now,
      retryDelayMs: 1_000,
      maxAttempts: 2,
      maxDeferrals: 2,
    }

    await dispatchAcceptedMessage('msg-7', ledger, registry, options)
    now += 1_000
    await recoverAcceptedMessages(ledger, registry, options)
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'failed', deferralCount: 0, sendAttemptCount: 1,
    })
    now += 1_000
    await expect(recoverAcceptedMessages(ledger, registry, options)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1',
      state: 'pending',
      reason: 'provider remains busy',
    }])
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'pending', deferralCount: 1, sendAttemptCount: 1,
    })
  })

  it('persists the deferral cap beyond pruned history and ledger reopen', async () => {
    let now = Date.parse('2026-08-01T12:00:00.000Z')
    const { ledger } = await acceptedLedger(undefined, {
      now: () => now,
      maxHistoryEntries: 4,
    })
    const abandon = vi.fn(async () => {})
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', {
      async accept(request) {
        return {
          state: 'deferred',
          providerId: 'claude',
          messageId: request.messageId,
          attempt: request.attempt,
          recipient: request.recipient,
          checkedAt: new Date(now).toISOString(),
          reason: 'provider remains busy',
          retryAt: new Date(now + 1_000).toISOString(),
        }
      },
      abandon,
    })
    const options = {
      now: () => now,
      retryDelayMs: 1_000,
      maxDeferrals: 6,
    }

    await dispatchAcceptedMessage('msg-7', ledger, registry, options)
    for (let index = 0; index < 4; index += 1) {
      now += 1_000
      await recoverAcceptedMessages(ledger, registry, options)
    }
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'pending',
      deferralCount: 5,
      historyTruncated: true,
      history: expect.arrayContaining([expect.objectContaining({ attempt: 5 })]),
    })

    const root = roots.at(-1)!
    const reopened = DeliveryLedger.open({
      dir: root,
      lockPath: join(root, 'server.lock'),
      now: () => now,
      maxHistoryEntries: 4,
    })
    expect(reopened.getDelivery('msg-7/d/1')).toMatchObject({ deferralCount: 5 })
    now += 1_000
    await expect(recoverAcceptedMessages(reopened, registry, options)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1',
      state: 'failed',
      reason: 'Provider acceptance remained deferred after 6 deferrals: provider remains busy',
    }])
    expect(reopened.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'failed', deferralCount: 6,
    })
    expect(abandon).toHaveBeenCalledOnce()
  })

  it('persists spent send attempts across later deferrals and ledger reopen', async () => {
    let now = Date.parse('2026-08-01T12:00:00.000Z')
    const { ledger } = await acceptedLedger(undefined, {
      now: () => now,
      maxHistoryEntries: 4,
    })
    const attempts: number[] = []
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', {
      async accept(request) {
        attempts.push(request.attempt)
        if (attempts.length === 1 || attempts.length === 7) {
          return {
            state: 'rejected',
            providerId: 'claude',
            messageId: request.messageId,
            attempt: request.attempt,
            recipient: request.recipient,
            checkedAt: new Date(now).toISOString(),
            reason: 'temporary provider rejection',
            retryable: true,
          }
        }
        return {
          state: 'deferred',
          providerId: 'claude',
          messageId: request.messageId,
          attempt: request.attempt,
          recipient: request.recipient,
          checkedAt: new Date(now).toISOString(),
          reason: 'provider remains busy',
          retryAt: new Date(now + 1_000).toISOString(),
        }
      },
    })
    const options = {
      now: () => now,
      retryDelayMs: 1_000,
      maxAttempts: 2,
      maxDeferrals: 10,
    }

    await dispatchAcceptedMessage('msg-7', ledger, registry, options)
    for (let index = 0; index < 5; index += 1) {
      now += 1_000
      await recoverAcceptedMessages(ledger, registry, options)
    }
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'pending',
      sendAttemptCount: 1,
      deferralCount: 5,
      historyTruncated: true,
    })

    const root = roots.at(-1)!
    const reopened = DeliveryLedger.open({
      dir: root,
      lockPath: join(root, 'server.lock'),
      now: () => now,
      maxHistoryEntries: 4,
    })
    expect(reopened.getDelivery('msg-7/d/1')).toMatchObject({
      sendAttemptCount: 1,
      deferralCount: 5,
    })
    now += 1_000
    await expect(recoverAcceptedMessages(reopened, registry, options)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1',
      state: 'failed',
      reason: 'temporary provider rejection',
    }])
    expect(reopened.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'failed', sendAttemptCount: 2,
      history: expect.arrayContaining([expect.objectContaining({ retryable: false })]),
    })
    now += 1_000
    await expect(recoverAcceptedMessages(reopened, registry, options)).resolves.toEqual([])
    expect(attempts).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('bootstraps the send aggregate from a pre-aggregate retry record', async () => {
    let now = Date.parse('2026-08-01T12:00:00.000Z')
    const { ledger } = await acceptedLedger(undefined, { now: () => now })
    await ledger.transition({
      deliveryId: 'msg-7/d/1',
      expected: { state: 'accepted', attempt: 0 },
      next: { state: 'in-flight', attempt: 1 },
    })
    await ledger.transition({
      deliveryId: 'msg-7/d/1',
      expected: { state: 'in-flight', attempt: 1 },
      next: {
        state: 'failed',
        attempt: 1,
        reason: 'pre-aggregate provider rejection',
        retryable: true,
        retryAt: new Date(now).toISOString(),
      },
    })
    expect(ledger.getDelivery('msg-7/d/1')).not.toHaveProperty('sendAttemptCount')

    const root = roots.at(-1)!
    const reopened = DeliveryLedger.open({
      dir: root,
      lockPath: join(root, 'server.lock'),
      now: () => now,
    })
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', {
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

    await expect(recoverAcceptedMessages(reopened, registry, {
      now: () => now,
      maxAttempts: 2,
    })).resolves.toEqual([{
      deliveryId: 'msg-7/d/1', state: 'delivered',
    }])
    expect(reopened.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'delivered', attempt: 2, sendAttemptCount: 2,
    })
  })

  it('keeps the legacy send count stable when a claim truncates classified history', async () => {
    const now = Date.parse('2026-08-01T12:00:00.000Z')
    const { ledger } = await acceptedLedger(undefined, {
      now: () => now,
      maxHistoryEntries: 4,
    })
    for (const attempt of [1, 2]) {
      const priorState = attempt === 1 ? 'accepted' as const : 'failed' as const
      await ledger.transition({
        deliveryId: 'msg-7/d/1',
        expected: { state: priorState, attempt: attempt - 1 },
        next: { state: 'in-flight', attempt },
      })
      await ledger.transition({
        deliveryId: 'msg-7/d/1',
        expected: { state: 'in-flight', attempt },
        next: {
          state: 'failed',
          attempt,
          reason: `legacy failure ${attempt}`,
          retryable: true,
          retryAt: new Date(now).toISOString(),
        },
      })
    }
    const legacy = ledger.getDelivery('msg-7/d/1')!
    expect(legacy).toMatchObject({
      state: 'failed', attempt: 2, historyTruncated: true,
    })
    expect(legacy).not.toHaveProperty('sendAttemptCount')
    expect(legacy.history.filter(event => event.state === 'failed'))
      .toHaveLength(2)

    const root = roots.at(-1)!
    const reopened = DeliveryLedger.open({
      dir: root,
      lockPath: join(root, 'server.lock'),
      now: () => now,
      maxHistoryEntries: 4,
    })
    const accept = vi.fn(async request => ({
      state: 'delivered' as const,
      providerId: 'claude',
      messageId: request.messageId,
      attempt: request.attempt,
      recipient: request.recipient,
      deliveredAt: new Date(now).toISOString(),
      evidence: { source: { id: 'test-receipt', label: 'Test receipt' } },
    }))
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', { accept })

    await expect(recoverAcceptedMessages(reopened, registry, {
      now: () => now,
      maxAttempts: 3,
    })).resolves.toEqual([{
      deliveryId: 'msg-7/d/1', state: 'delivered',
    }])
    expect(accept).toHaveBeenCalledOnce()
    expect(reopened.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'delivered', attempt: 3, sendAttemptCount: 3,
    })
  })

  it('materializes a truncated legacy send count before recording a deferral', async () => {
    const now = Date.parse('2026-08-01T12:00:00.000Z')
    const { ledger } = await acceptedLedger(undefined, {
      now: () => now,
      maxHistoryEntries: 4,
    })
    for (const attempt of [1, 2]) {
      const priorState = attempt === 1 ? 'accepted' as const : 'failed' as const
      await ledger.transition({
        deliveryId: 'msg-7/d/1',
        expected: { state: priorState, attempt: attempt - 1 },
        next: { state: 'in-flight', attempt },
      })
      await ledger.transition({
        deliveryId: 'msg-7/d/1',
        expected: { state: 'in-flight', attempt },
        next: {
          state: 'failed',
          attempt,
          reason: `legacy failure ${attempt}`,
          retryable: true,
          retryAt: new Date(now).toISOString(),
        },
      })
    }
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'failed', attempt: 2, historyTruncated: true,
    })
    expect(ledger.getDelivery('msg-7/d/1')).not.toHaveProperty('sendAttemptCount')

    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', {
      async accept(request) {
        return {
          state: 'deferred',
          providerId: 'claude',
          messageId: request.messageId,
          attempt: request.attempt,
          recipient: request.recipient,
          checkedAt: new Date(now).toISOString(),
          reason: 'provider remains busy',
        }
      },
      async abandon() {},
    })

    await expect(recoverAcceptedMessages(ledger, registry, {
      now: () => now,
      maxAttempts: 3,
    })).resolves.toEqual([{
      deliveryId: 'msg-7/d/1',
      state: 'pending',
      reason: 'provider remains busy',
    }])
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'pending', attempt: 3, deferralCount: 1, sendAttemptCount: 2,
    })
  })

  it('retries failed deferral cleanup without losing its durable count', async () => {
    let now = Date.parse('2026-08-01T12:00:00.000Z')
    const { ledger } = await acceptedLedger(undefined, { now: () => now })
    let cleanupCalls = 0
    let cleanupSnapshot: ReturnType<DeliveryLedger['getDelivery']>
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', {
      async accept(request) {
        return {
          state: 'deferred',
          providerId: 'claude',
          messageId: request.messageId,
          attempt: request.attempt,
          recipient: request.recipient,
          checkedAt: new Date(now).toISOString(),
          reason: 'provider remains busy',
        }
      },
      async abandon() {
        cleanupCalls += 1
        if (cleanupCalls === 1) throw new Error('queue lock busy')
        const root = roots.at(-1)!
        const reopened = DeliveryLedger.open({
          dir: root,
          lockPath: join(root, 'server.lock'),
        })
        cleanupSnapshot = reopened.getDelivery('msg-7/d/1')
      },
    })
    const options = {
      now: () => now,
      retryDelayMs: 1_000,
      maxDeferrals: 1,
    }

    await expect(dispatchAcceptedMessage(
      'msg-7', ledger, registry, options,
    )).resolves.toEqual([{
      deliveryId: 'msg-7/d/1',
      state: 'pending',
      reason: 'Provider deferral cleanup failed after 1 attempt: queue lock busy',
    }])
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({ deferralCount: 1 })
    now += 1_000
    await expect(recoverAcceptedMessages(ledger, registry, options)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1',
      state: 'failed',
      reason: 'Provider acceptance remained deferred after 1 deferral; '
        + 'provider-local cleanup completed after 2 attempts',
    }])
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'failed', attempt: 1, deferralCount: 1,
    })
    expect(ledger.getDelivery('msg-7/d/1')).not.toHaveProperty('sendAttemptCount')
    expect(cleanupSnapshot).toMatchObject({
      state: 'pending', attempt: 1, deferralCount: 1, abandonFailureCount: 1,
    })
    expect(cleanupSnapshot).not.toHaveProperty('sendAttemptCount')
    expect(cleanupCalls).toBe(2)
  })

  it('terminalizes permanently failing provider-local cleanup', async () => {
    let now = Date.parse('2026-08-01T12:00:00.000Z')
    const { ledger } = await acceptedLedger(undefined, { now: () => now })
    const accept = vi.fn(async request => ({
      state: 'deferred' as const,
      providerId: 'claude',
      messageId: request.messageId,
      attempt: request.attempt,
      recipient: request.recipient,
      checkedAt: new Date(now).toISOString(),
      reason: 'provider remains busy',
    }))
    const abandon = vi.fn(async () => { throw new Error('queue lock busy') })
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', { accept, abandon })
    const options = {
      now: () => now,
      retryDelayMs: 1_000,
      maxDeferrals: 1,
      maxAbandonFailures: 2,
    }

    await expect(dispatchAcceptedMessage(
      'msg-7', ledger, registry, options,
    )).resolves.toEqual([{
      deliveryId: 'msg-7/d/1',
      state: 'pending',
      reason: 'Provider deferral cleanup failed after 1 attempt: queue lock busy',
    }])
    now += 1_000
    await expect(recoverAcceptedMessages(ledger, registry, options)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1',
      state: 'failed',
      reason: 'Provider deferral cleanup exhausted after 2 attempts: queue lock busy',
    }])
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'failed',
      deferralCount: 1,
      abandonFailureCount: 2,
      history: expect.arrayContaining([expect.objectContaining({ retryable: false })]),
    })
    now += 60_000
    await expect(recoverAcceptedMessages(ledger, registry, options)).resolves.toEqual([])
    expect(accept).toHaveBeenCalledOnce()
    expect(abandon).toHaveBeenCalledTimes(2)
  })

  it('abandons an exhausted Codex deferral before delivering the next FIFO item', async () => {
    let now = Date.parse('2026-08-01T12:00:00.000Z')
    const messageIds = ['msg-7', 'msg-8']
    const { ledger } = await acceptedLedger([{
      providerId: 'codex', sessionId: 'receiver', incarnation: 'receiver-v3',
    }], {
      now: () => now,
      createMessageId: () => messageIds.shift()!,
    })
    let screen = 'Would you like to run this command?\nPress enter to confirm or esc to cancel'
    const submitted: string[] = []
    const adapter = new CodexDeliveryAdapter({
      now: () => new Date(now).toISOString(),
      currentIncarnation: async () => 'receiver-v3',
      resolveTranscript: async () => null,
      withSessionInput: async (_sessionId, operation) => operation({
        captureScreen: async () => screen,
        getWorkingDirectory: async () => null,
        getAgentIdentity: async () => 'receiver-v3',
        submitPrompt: async (prompt, beforeInput, beforeEnter) => {
          if (!await beforeInput()) return false
          submitted.push(prompt)
          screen = `› ${prompt}`
          await beforeEnter()
          screen = '› Add a follow-up\n  ? for shortcuts'
          return true
        },
      }),
    })
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('codex', adapter)
    const options = {
      now: () => now,
      retryDelayMs: 1_000,
      maxAttempts: 1,
      maxDeferrals: 2,
    }

    await dispatchAcceptedMessage('msg-7', ledger, registry, options)
    expect(adapter.queueDepth('receiver')).toBe(1)
    now += 1_000
    await expect(recoverAcceptedMessages(ledger, registry, options)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1',
      state: 'failed',
      reason: 'Provider acceptance remained deferred after 2 deferrals: '
        + 'Codex is waiting for a modal confirmation',
    }])
    expect(adapter.queueDepth('receiver')).toBe(0)

    screen = '• Working\n\n› Add a follow-up\n  ? for shortcuts'
    const second = await ledger.accept({
      requestId: 'request-8',
      sender: { sessionId: 'sender', incarnation: 'sender-v2' },
      destination: { subject: 'agents.receiver' },
      text: 'later message',
      recipients: [{
        providerId: 'codex', sessionId: 'receiver', incarnation: 'receiver-v3',
      }],
    })
    expect(second).toMatchObject({ accepted: true, message: { id: 'msg-8' } })
    await expect(dispatchAcceptedMessage('msg-8', ledger, registry, options)).resolves.toEqual([{
      deliveryId: 'msg-8/d/1', state: 'accepted',
    }])
    expect(adapter.queueDepth('receiver')).toBe(0)
    expect(submitted).toHaveLength(1)
  })

})
