import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireBackendSingleton } from '../../infra/lock'
import { createDefaultProviderRegistry } from '../../providers/lifecycle'
import {
  DELIVERY_DISPATCH_CONCURRENCY,
  dispatchAcceptedMessage,
  recoverAcceptedMessages,
} from '../delivery-dispatch'
import { DeliveryLedger } from '../delivery-ledger'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function acceptedLedger(recipients = [{
  providerId: 'claude', sessionId: 'receiver', incarnation: 'receiver-v3',
}]) {
  const root = mkdtempSync(join(tmpdir(), 'tinstar-dispatch-'))
  roots.push(root)
  const lockPath = join(root, 'server.lock')
  if (!acquireBackendSingleton(lockPath).acquired) throw new Error('could not acquire test lock')
  const ledger = DeliveryLedger.open({
    dir: root, lockPath, createMessageId: () => 'msg-7',
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
    registry.registerDelivery('claude', {
      async accept() { throw new Error('acknowledgement timeout') },
    })

    await expect(dispatchAcceptedMessage('msg-7', ledger, registry)).resolves.toEqual([{
      deliveryId: 'msg-7/d/1',
      state: 'ambiguous',
      reason: 'acknowledgement timeout',
    }])
    expect(ledger.getDelivery('msg-7/d/1')).toMatchObject({
      state: 'in-flight', attempt: 1,
    })
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
