import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_PROVIDER,
  ProviderAdapterRegistry,
  createDefaultProviderRegistry,
} from '../../providers/lifecycle'
import type { ProviderDeliveryRequest } from '../../providers/contract'
import {
  DELIVERY_DISPATCH_CONCURRENCY,
  dispatchAcceptedMessage,
  recoverAcceptedMessages,
} from '../delivery-dispatch'
import { acceptedLedger } from './delivery-dispatch-fixture'

describe('durable provider dispatch failures and concurrency', () => {
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

  it('preserves ambiguity when an accepted provider disappears before confirmation', async () => {
    let now = Date.parse('2026-08-01T12:00:00.000Z')
    const { ledger } = await acceptedLedger([{
      providerId: 'codex', sessionId: 'receiver', incarnation: 'receiver-v3',
    }], { now: () => now })
    const initialRegistry = new ProviderAdapterRegistry([CODEX_PROVIDER])
    initialRegistry.registerDelivery('codex', {
      async accept(request) {
        return {
          state: 'accepted',
          providerId: 'codex',
          messageId: request.messageId,
          attempt: request.attempt,
          recipient: request.recipient,
          acceptedAt: new Date(now).toISOString(),
          attemptRef: 'provider-attempt-1',
        }
      },
      async confirm(acceptance) {
        return {
          state: 'pending',
          providerId: 'codex',
          messageId: acceptance.messageId,
          attempt: acceptance.attempt,
          recipient: acceptance.recipient,
          checkedAt: new Date(now).toISOString(),
          reason: 'evidence pending',
        }
      },
    })
    const options = { now: () => now, retryDelayMs: 1_000 }

    await dispatchAcceptedMessage('msg-7', ledger, initialRegistry, options)
    now += 1_000
    const unregisteredRegistry = new ProviderAdapterRegistry()
    const reason = 'Provider "codex" is no longer registered; attempt 1 may already '
      + 'have been delivered but can no longer be confirmed'
    await expect(recoverAcceptedMessages(
      ledger,
      unregisteredRegistry,
      options,
    )).resolves.toEqual([{
      deliveryId: 'msg-7/d/1', state: 'ambiguous', reason,
    }])
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'failed',
      history: expect.arrayContaining([expect.objectContaining({
        reason,
        retryable: false,
      })]),
    })
  })

  it('preserves ambiguity when a provider disappears during an in-flight attempt', async () => {
    const { ledger } = await acceptedLedger([{
      providerId: 'codex', sessionId: 'receiver', incarnation: 'receiver-v3',
    }])
    const initialRegistry = new ProviderAdapterRegistry([CODEX_PROVIDER])
    initialRegistry.registerDelivery('codex', {
      async accept() {
        throw new Error('connection dropped after submission')
      },
    })

    await expect(dispatchAcceptedMessage(
      'msg-7', ledger, initialRegistry,
    )).resolves.toEqual([{
      deliveryId: 'msg-7/d/1',
      state: 'ambiguous',
      reason: 'connection dropped after submission',
    }])
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'in-flight', attempt: 1,
    })

    const unavailableRegistry = new ProviderAdapterRegistry()
    const reason = 'Provider "codex" is no longer registered; in-flight attempt 1 '
      + 'may already have been submitted but can no longer be confirmed'
    await expect(recoverAcceptedMessages(
      ledger,
      unavailableRegistry,
    )).resolves.toEqual([{
      deliveryId: 'msg-7/d/1', state: 'ambiguous', reason,
    }])
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'failed',
      history: expect.arrayContaining([expect.objectContaining({
        reason,
        retryable: false,
      })]),
    })
  })

  it('fails pending work when a registered provider has no delivery adapter', async () => {
    const { ledger } = await acceptedLedger([{
      providerId: 'codex', sessionId: 'receiver', incarnation: 'receiver-v3',
    }])
    const registry = new ProviderAdapterRegistry([CODEX_PROVIDER])

    await expect(recoverAcceptedMessages(ledger, registry)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1',
      state: 'failed',
      reason: 'Provider "codex" has no delivery adapter',
    }])
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'failed',
      history: expect.arrayContaining([expect.objectContaining({ retryable: false })]),
    })
  })

  it('terminalizes a legacy retry whose reduced send-attempt budget is already spent', async () => {
    const now = Date.parse('2026-08-01T12:00:00.000Z')
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
        reason: 'legacy retryable failure',
        retryable: true,
        retryAt: new Date(now).toISOString(),
      },
    })
    const abandon = vi.fn(async () => {})
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', {
      accept: vi.fn(async () => {
        throw new Error('must not be called')
      }),
      abandon,
    })

    await expect(recoverAcceptedMessages(ledger, registry, {
      now: () => now,
      maxAttempts: 1,
    })).resolves.toEqual([{
      deliveryId: 'msg-7/d/1',
      state: 'failed',
      reason: 'Provider delivery attempt budget exhausted after 1 attempt',
    }])
    expect(abandon).toHaveBeenCalledOnce()
  })

  it('retries provider cleanup without accepting again after the send budget is spent', async () => {
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
      countsAsSendAttempt: true,
      next: {
        state: 'failed',
        attempt: 1,
        reason: 'retryable send failure',
        retryable: true,
        retryAt: new Date(now).toISOString(),
      },
    })
    const accept = vi.fn(async () => { throw new Error('must not be called') })
    const abandon = vi.fn()
      .mockRejectedValueOnce(new Error('queue lock busy'))
      .mockResolvedValueOnce(undefined)
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', { accept, abandon })
    const options = {
      now: () => now,
      retryDelayMs: 1_000,
      maxAttempts: 1,
      maxAbandonFailures: 2,
    }

    await expect(recoverAcceptedMessages(ledger, registry, options)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1',
      state: 'pending',
      reason: 'Provider delivery attempt budget exhausted after 1 attempt; '
        + 'provider-local cleanup failed after 1 attempt: queue lock busy',
    }])
    now += 1_000
    await expect(recoverAcceptedMessages(ledger, registry, options)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1',
      state: 'failed',
      reason: 'Provider delivery attempt budget exhausted after 1 attempt; '
        + 'provider-local cleanup completed after 2 attempts',
    }])
    expect(accept).not.toHaveBeenCalled()
    expect(abandon).toHaveBeenCalledTimes(2)
  })

  it('conservatively terminalizes a truncated pre-aggregate retry budget', async () => {
    const now = Date.parse('2026-08-01T12:00:00.000Z')
    const { ledger } = await acceptedLedger(undefined, {
      now: () => now,
      maxHistoryEntries: 4,
    })
    for (const attempt of [1, 2]) {
      const priorState = attempt === 1 ? 'accepted' as const : 'failed' as const
      const priorAttempt = attempt - 1
      await ledger.transition({
        deliveryId: 'msg-7/d/1',
        expected: { state: priorState, attempt: priorAttempt },
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

    const accept = vi.fn(async () => { throw new Error('must not be called') })
    const abandon = vi.fn(async () => {})
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', { accept, abandon })

    await expect(recoverAcceptedMessages(ledger, registry, {
      now: () => now,
      maxAttempts: 2,
    })).resolves.toEqual([{
      deliveryId: 'msg-7/d/1',
      state: 'failed',
      reason: 'Provider delivery attempt budget exhausted after 2 attempts',
    }])
    expect(accept).not.toHaveBeenCalled()
    expect(abandon).toHaveBeenCalledOnce()
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

  it('retries a lost final-mile acknowledgement at least once with the same message id', async () => {
    const { ledger } = await acceptedLedger()
    const registry = createDefaultProviderRegistry()
    const accept = vi.fn(async (_request: ProviderDeliveryRequest) => {
      throw new Error('acknowledgement timeout')
    })
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
    const reason = 'Provider "claude" in-flight attempt 1 may already have been '
      + 'submitted but returned no durable acceptance evidence'
    await expect(recoverAcceptedMessages(ledger, registry, {
      maxAttempts: 2,
      retryDelayMs: 0,
    })).resolves.toEqual([{
      deliveryId: 'msg-7/d/1', state: 'ambiguous', reason,
    }])
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'failed',
      history: expect.arrayContaining([expect.objectContaining({
        reason,
        retryable: true,
      })]),
    })

    await expect(recoverAcceptedMessages(ledger, registry, {
      maxAttempts: 2,
      retryDelayMs: 0,
    })).resolves.toEqual([{
      deliveryId: 'msg-7/d/1', state: 'ambiguous', reason: 'acknowledgement timeout',
    }])
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'in-flight', attempt: 2,
    })

    const exhaustedReason = 'Provider "claude" in-flight attempt 2 may already have been '
      + 'submitted but returned no durable acceptance evidence; '
      + 'provider delivery attempt budget exhausted after 2 attempts'
    await expect(recoverAcceptedMessages(ledger, registry, {
      maxAttempts: 2,
      retryDelayMs: 0,
    })).resolves.toEqual([{
      deliveryId: 'msg-7/d/1', state: 'ambiguous', reason: exhaustedReason,
    }])
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'failed', attempt: 2, sendAttemptCount: 2,
      history: expect.arrayContaining([expect.objectContaining({
        reason: exhaustedReason,
        retryable: false,
      })]),
    })
    await expect(recoverAcceptedMessages(ledger, registry, {
      maxAttempts: 2,
      retryDelayMs: 0,
    })).resolves.toEqual([])
    expect(accept).toHaveBeenCalledTimes(2)
    expect(accept.mock.calls.map(([request]) => ({
      messageId: request.messageId,
      attempt: request.attempt,
    }))).toEqual([
      { messageId: 'msg-7', attempt: 1 },
      { messageId: 'msg-7', attempt: 2 },
    ])
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
