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
  ClaudeChannelControlError,
  createClaudeDeliveryAdapter,
} from '../../providers/claude-delivery'
import { acceptedLedger, roots } from './delivery-dispatch-fixture'

describe('durable provider dispatch acceptance', () => {
  it('terminally rejects a persisted group self-delivery before provider dispatch', async () => {
    const { ledger } = await acceptedLedger([{
      providerId: 'claude', sessionId: 'sender', incarnation: 'sender-v2',
    }], {
      destinationSubject: 'tinstar.room.review-pair',
    })
    const accept = vi.fn()
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', { accept })

    const reason = 'Refused group delivery to its own sender'
    await expect(dispatchAcceptedMessage('msg-7', ledger, registry)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1', state: 'failed', reason,
    }])
    expect(accept).not.toHaveBeenCalled()
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'failed',
      history: expect.arrayContaining([expect.objectContaining({
        reason,
        retryable: false,
      })]),
    })
  })

  it('terminally rejects a recovered in-flight group self-delivery before retry', async () => {
    let now = Date.parse('2026-08-01T12:00:00.000Z')
    const { ledger } = await acceptedLedger([{
      providerId: 'claude', sessionId: 'sender', incarnation: 'sender-v2',
    }], {
      destinationSubject: 'tinstar.room.review-pair',
      now: () => now,
    })
    await ledger.transition({
      deliveryId: 'msg-7/d/1',
      expected: { state: 'accepted', attempt: 0 },
      next: { state: 'in-flight', attempt: 1 },
    })
    const accept = vi.fn()
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', { accept })
    const options = { now: () => now, retryDelayMs: 1_000 }

    await expect(recoverAcceptedMessages(ledger, registry, options)).resolves.toEqual([
      expect.objectContaining({ deliveryId: 'msg-7/d/1', state: 'ambiguous' }),
    ])
    now += 1_000
    const reason = 'Refused group delivery to its own sender'
    await expect(recoverAcceptedMessages(ledger, registry, options)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1', state: 'failed', reason,
    }])
    expect(accept).not.toHaveBeenCalled()
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'failed',
      history: expect.arrayContaining([expect.objectContaining({
        reason,
        retryable: false,
      })]),
    })
  })

  it('dispatches an explicitly addressed persisted self-DM', async () => {
    const { ledger } = await acceptedLedger([{
      providerId: 'claude', sessionId: 'sender', incarnation: 'sender-v2',
    }], {
      destinationSubject: 'tinstar.space.project.worktree.sender',
    })
    const accept = vi.fn(async request => ({
      state: 'delivered' as const,
      providerId: 'claude',
      messageId: request.messageId,
      attempt: request.attempt,
      recipient: request.recipient,
      deliveredAt: '2026-08-01T12:00:02.000Z',
      evidence: { source: { id: 'test-receipt', label: 'Test receipt' } },
    }))
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', { accept })

    await expect(dispatchAcceptedMessage('msg-7', ledger, registry)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1', state: 'delivered',
    }])
    expect(accept).toHaveBeenCalledOnce()
  })

  it('claims the ledger attempt once and passes the complete router stamp', async () => {
    const { ledger, accepted } = await acceptedLedger()
    const accept = vi.fn(async (request) => ({
      state: 'accepted' as const,
      providerId: 'claude',
      messageId: request.messageId,
      attempt: request.attempt,
      recipient: request.recipient,
      acceptedAt: '2026-08-01T12:00:02Z',
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
          providerAcceptedAt: '2026-08-01T12:00:02.000Z',
        }),
      ]),
    })
  })

  it('loads a broadcast envelope once while recovering its due recipients', async () => {
    const { ledger } = await acceptedLedger([
      { providerId: 'claude', sessionId: 'receiver-a', incarnation: 'receiver-a-v1' },
      { providerId: 'claude', sessionId: 'receiver-b', incarnation: 'receiver-b-v1' },
      { providerId: 'claude', sessionId: 'receiver-c', incarnation: 'receiver-c-v1' },
    ])
    const getMessage = vi.spyOn(ledger, 'getMessage')
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', {
      async accept(request) {
        return {
          state: 'delivered' as const,
          providerId: 'claude',
          messageId: request.messageId,
          attempt: request.attempt,
          recipient: request.recipient,
          deliveredAt: '2026-08-01T12:00:02.000Z',
          evidence: { source: { id: 'test-receipt', label: 'Test receipt' } },
        }
      },
    })

    await expect(recoverAcceptedMessages(ledger, registry)).resolves.toEqual([
      { deliveryId: 'msg-7/d/1', state: 'delivered' },
      { deliveryId: 'msg-7/d/2', state: 'delivered' },
      { deliveryId: 'msg-7/d/3', state: 'delivered' },
    ])
    expect(getMessage).toHaveBeenCalledTimes(1)
  })

  it('does not load a not-due broadcast for a provider without confirmation', async () => {
    const { ledger } = await acceptedLedger([
      { providerId: 'claude', sessionId: 'receiver-a', incarnation: 'receiver-a-v1' },
      { providerId: 'claude', sessionId: 'receiver-b', incarnation: 'receiver-b-v1' },
      { providerId: 'claude', sessionId: 'receiver-c', incarnation: 'receiver-c-v1' },
    ])
    const retryAt = '2026-08-02T12:00:00.000Z'
    for (const delivery of ledger.getMessage('msg-7')!.deliveries) {
      await ledger.transition({
        deliveryId: delivery.id,
        expected: { state: 'accepted', attempt: 0 },
        next: { state: 'pending', attempt: 0, reason: 'provider is busy', retryAt },
      })
    }
    const getMessage = vi.spyOn(ledger, 'getMessage')
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', {
      async accept() {
        throw new Error('not-due delivery must not be attempted')
      },
    })

    await expect(recoverAcceptedMessages(ledger, registry, {
      now: () => Date.parse('2026-08-01T12:00:00.000Z'),
    })).resolves.toEqual([])
    expect(getMessage).not.toHaveBeenCalled()
  })

  it('closes an acceptance-only provider outcome as ambiguous instead of leaking capacity', async () => {
    const { ledger } = await acceptedLedger(undefined, { maxOutstandingDeliveries: 1 })
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', {
      async accept(request) {
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

    await dispatchAcceptedMessage('msg-7', ledger, registry)
    const reason = 'Provider "claude" accepted attempt 1 but exposes no confirmation '
      + 'evidence; delivery outcome is ambiguous'
    await expect(recoverAcceptedMessages(ledger, registry)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1', state: 'ambiguous', reason,
    }])
    expect(ledger.listRecoverable()).toEqual([])
  })

  it('keeps provider acceptance recoverable when its timestamp is malformed', async () => {
    const now = Date.parse('2026-08-01T12:00:03.000Z')
    const { ledger } = await acceptedLedger(undefined, { now: () => now })
    const registry = createDefaultProviderRegistry()
    registry.registerDelivery('claude', {
      async accept(request) {
        return {
          state: 'accepted',
          providerId: 'claude',
          messageId: request.messageId,
          attempt: request.attempt,
          recipient: request.recipient,
          acceptedAt: 'not-a-provider-timestamp',
          attemptRef: request.deliveryId,
        }
      },
    })

    await expect(dispatchAcceptedMessage('msg-7', ledger, registry, {
      now: () => now,
    })).resolves.toEqual([{
      deliveryId: 'msg-7/d/1', state: 'accepted',
    }])
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'accepted',
      history: expect.arrayContaining([expect.objectContaining({
        providerAcceptedAt: '2026-08-01T12:00:03.000Z',
      })]),
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

})
