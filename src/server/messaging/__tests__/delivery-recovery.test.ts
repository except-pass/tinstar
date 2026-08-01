// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireBackendSingleton } from '../../infra/lock'
import {
  DeliveryLedger,
  deliveryLedgerPaths,
  type DeliveryAcceptInput,
} from '../delivery-ledger'
import {
  DeliveryRecoveryCoordinator,
  settleDeliveryRecoveryBarrier,
  type DeliveryRecoveryEvidence,
  type DeliveryRecoveryEvidenceRequest,
} from '../delivery-recovery'

async function withLedger(
  body: (
    open: (ids?: string[]) => DeliveryLedger,
    dir: string,
  ) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'delivery-recovery-'))
  const lockPath = join(dir, 'server.lock')
  const lock = acquireBackendSingleton(lockPath)
  if (!lock.acquired) throw new Error('test setup could not acquire backend singleton')
  try {
    await body((ids = []) => {
      const remaining = [...ids]
      return DeliveryLedger.open({
        dir,
        lockPath,
        createMessageId: () => remaining.shift() ?? 'msg-unused',
      })
    }, dir)
  } finally {
    rmSync(`${lockPath}.mark`, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
}

function input(messageId: string, recipientSession = 'receiver'): DeliveryAcceptInput {
  return {
    requestId: `req-${messageId}`,
    sender: { sessionId: 'sender', incarnation: 'sender-v1' },
    destination: { subject: 'tinstar.agent.receiver' },
    text: 'Recover this delivery.',
    recipients: [{
      providerId: 'codex',
      sessionId: recipientSession,
      incarnation: 'receiver-process-v1',
    }],
  }
}

function evidence(
  state: DeliveryRecoveryEvidence['state'],
  messageId: string,
): DeliveryRecoveryEvidence {
  const identity = {
    providerId: 'codex',
    messageId,
    attempt: 1,
    attemptRef: `attempt-${messageId}`,
    recipient: {
      providerId: 'codex',
      sessionId: 'receiver',
      incarnation: 'receiver-process-v1',
    },
  }
  if (state === 'confirmed') {
    return {
      ...identity,
      state,
      confirmedAt: '2026-08-01T12:00:00.000Z',
      evidence: {
        source: { id: 'codex-rollout', label: 'Codex rollout' },
        reference: `user_message:${messageId}`,
      },
    }
  }
  if (state === 'not-found') {
    return {
      ...identity,
      state,
      checkedAt: '2026-08-01T12:00:00.000Z',
      reason: 'complete transcript scan found no stamped message ID',
    }
  }
  return {
    ...identity,
    state,
    checkedAt: '2026-08-01T12:00:00.000Z',
    reason: 'transcript unavailable',
  }
}

function coordinator(
  ledger: DeliveryLedger,
  options: {
    incarnation?: string | null
    evidence?: DeliveryRecoveryEvidence
    probeEvidence?: () => Promise<DeliveryRecoveryEvidence>
  } = {},
): DeliveryRecoveryCoordinator {
  return new DeliveryRecoveryCoordinator({
    ledger,
    observeRecipient: async () => options.incarnation === null
      ? { state: 'dead', reason: 'process exited while Tinstar was offline' }
      : {
          state: 'alive',
          incarnation: options.incarnation ?? 'receiver-process-v1',
        },
    inspectTranscriptEvidence: options.probeEvidence ?? (async request =>
      options.evidence ?? evidence('inconclusive', request.messageId)),
  })
}

async function makeInFlight(ledger: DeliveryLedger, messageId: string): Promise<void> {
  const accepted = await ledger.accept(input(messageId))
  if (!accepted.accepted) throw new Error('expected acceptance')
  const delivery = accepted.deliveries[0]!
  const transitioned = await ledger.transition({
    deliveryId: delivery.id,
    expected: { state: 'accepted', attempt: 0 },
    next: { state: 'in-flight', attempt: 1, attemptRef: `attempt-${messageId}` },
  })
  if (!transitioned.updated) throw new Error('expected in-flight transition')
}

describe('delivery restart recovery', () => {
  it('has no obligation to resurrect when the crash happened before persist', async () => {
    await withLedger(async open => {
      const restarted = open()
      const report = await coordinator(restarted).recover()
      expect(report).toMatchObject({ status: 'complete', scanned: 0, outcomes: [] })
    })
  })

  it('resumes a durably accepted obligation only for the same surviving process', async () => {
    await withLedger(async open => {
      const ledger = open(['msg-after-accept'])
      await ledger.accept(input('msg-after-accept'))

      const restarted = open()
      const report = await coordinator(restarted).recover()
      expect(report.outcomes).toEqual([expect.objectContaining({
        deliveryId: 'msg-after-accept/d/1',
        disposition: 'ready',
      })])
      expect(restarted.getDelivery('msg-after-accept/d/1')).toMatchObject({
        state: 'pending',
        attempt: 0,
      })
    })
  })

  it('terminalizes an obligation whose recipient died instead of retaining it for resurrection', async () => {
    await withLedger(async open => {
      const ledger = open(['msg-dead'])
      await ledger.accept(input('msg-dead'))

      const restarted = open()
      await coordinator(restarted, { incarnation: null }).recover()
      expect(restarted.getDelivery('msg-dead/d/1')).toMatchObject({
        state: 'failed',
        history: expect.arrayContaining([
          expect.objectContaining({ retryable: false }),
        ]),
      })

      const resurrected = await coordinator(restarted).recover()
      expect(resurrected.scanned).toBe(0)
    })
  })

  it('makes an existing retryable failure terminal even when the death reason is unchanged', async () => {
    await withLedger(async open => {
      const ledger = open(['msg-dead-same-reason'])
      await ledger.accept(input('msg-dead-same-reason'))
      await ledger.transition({
        deliveryId: 'msg-dead-same-reason/d/1',
        expected: { state: 'accepted', attempt: 0 },
        next: {
          state: 'failed',
          attempt: 0,
          reason: 'process exited while Tinstar was offline',
          retryable: true,
        },
      })

      const restarted = open()
      await coordinator(restarted, { incarnation: null }).recover()
      expect(restarted.getDelivery('msg-dead-same-reason/d/1')?.history.at(-1))
        .toMatchObject({
          reason: 'process exited while Tinstar was offline',
          retryable: false,
        })
      expect(restarted.listRecoverable()).toEqual([])
    })
  })

  it('uses exact transcript absence before making an interrupted dispatch retry-ready', async () => {
    await withLedger(async open => {
      const ledger = open(['msg-during-dispatch'])
      await makeInFlight(ledger, 'msg-during-dispatch')

      const restarted = open()
      await coordinator(restarted, {
        evidence: evidence('not-found', 'msg-during-dispatch'),
      }).recover()
      expect(restarted.getDelivery('msg-during-dispatch/d/1')).toMatchObject({
        state: 'pending',
        attempt: 1,
      })
    })
  })

  it('marks delivered when an injection completed before the ledger update', async () => {
    await withLedger(async open => {
      const ledger = open(['msg-after-injection'])
      await makeInFlight(ledger, 'msg-after-injection')

      const restarted = open()
      await coordinator(restarted, {
        evidence: evidence('confirmed', 'msg-after-injection'),
      }).recover()
      expect(restarted.getDelivery('msg-after-injection/d/1')).toMatchObject({
        state: 'delivered',
        attempt: 1,
        history: expect.arrayContaining([expect.objectContaining({
          evidence: {
            source: { id: 'codex-rollout', label: 'Codex rollout' },
            reference: 'user_message:msg-after-injection',
          },
        })]),
      })
    })
  })

  it('never treats a different stamped message ID as delivery evidence', async () => {
    await withLedger(async open => {
      const ledger = open(['msg-expected'])
      await makeInFlight(ledger, 'msg-expected')

      const restarted = open()
      const report = await coordinator(restarted, {
        evidence: evidence('confirmed', 'msg-someone-else'),
      }).recover()
      expect(report.outcomes[0]).toMatchObject({ disposition: 'ambiguous' })
      expect(restarted.getDelivery('msg-expected/d/1')).toMatchObject({
        state: 'in-flight',
        attempt: 1,
      })
    })
  })

  it('never inherits transcript evidence from a reused recipient incarnation', async () => {
    await withLedger(async open => {
      const ledger = open(['msg-incarnation-evidence'])
      await makeInFlight(ledger, 'msg-incarnation-evidence')
      const restarted = open()
      const stale = evidence('confirmed', 'msg-incarnation-evidence')
      stale.recipient.incarnation = 'receiver-process-v0'

      const report = await coordinator(restarted, { evidence: stale }).recover()
      expect(report.outcomes[0]).toMatchObject({ disposition: 'ambiguous' })
      expect(restarted.getDelivery('msg-incarnation-evidence/d/1')).toMatchObject({
        state: 'in-flight',
      })
    })
  })

  it('is single-flight and does not duplicate recovery transitions', async () => {
    await withLedger(async open => {
      const ledger = open(['msg-concurrent'])
      await ledger.accept(input('msg-concurrent'))
      const restarted = open()
      let release!: () => void
      const held = new Promise<void>(resolve => { release = resolve })
      const observe = vi.fn(async () => {
        await held
        return { state: 'alive' as const, incarnation: 'receiver-process-v1' }
      })
      const dependencies = {
        ledger: restarted,
        observeRecipient: observe,
        inspectTranscriptEvidence: async (request: DeliveryRecoveryEvidenceRequest) => evidence(
          'inconclusive',
          request.messageId,
        ),
      }
      const first = new DeliveryRecoveryCoordinator(dependencies).recover()
      const second = new DeliveryRecoveryCoordinator(dependencies).recover()
      release()
      expect(await first).toEqual(await second)
      expect(observe).toHaveBeenCalledTimes(1)
      expect(restarted.getDelivery('msg-concurrent/d/1')?.history).toHaveLength(2)
    })
  })

  it('fails a replacement incarnation but preserves inconclusive liveness', async () => {
    await withLedger(async open => {
      const ledger = open(['msg-replaced', 'msg-inconclusive'])
      await ledger.accept(input('msg-replaced'))
      await ledger.accept(input('msg-inconclusive', 'receiver-unknown'))
      const restarted = open()
      const recovery = new DeliveryRecoveryCoordinator({
        ledger: restarted,
        observeRecipient: async recipient => recipient.sessionId === 'receiver'
          ? { state: 'alive', incarnation: 'receiver-process-v2' }
          : { state: 'inconclusive', reason: 'tmux probe timed out' },
        inspectTranscriptEvidence: async request => evidence(
          'inconclusive',
          request.messageId,
        ),
      })
      await recovery.recover()
      expect(restarted.listRecoverable()).toHaveLength(1)
      expect(restarted.getDelivery('msg-replaced/d/1')).toMatchObject({
        state: 'failed',
        history: expect.arrayContaining([expect.objectContaining({
          reason: 'recipient process incarnation changed while Tinstar was offline',
        })]),
      })
      expect(restarted.getDelivery('msg-inconclusive/d/1')).toMatchObject({
        state: 'accepted',
      })
    })
  })

  it('preserves accepted work when the liveness probe throws', async () => {
    await withLedger(async open => {
      const ledger = open(['msg-probe-error'])
      await ledger.accept(input('msg-probe-error'))
      const restarted = open()
      const report = await new DeliveryRecoveryCoordinator({
        ledger: restarted,
        observeRecipient: async () => { throw new Error('tmux unavailable') },
        inspectTranscriptEvidence: async request => evidence(
          'inconclusive',
          request.messageId,
        ),
      }).recover()

      expect(report.outcomes).toEqual([expect.objectContaining({
        disposition: 'ambiguous',
        reason: 'recipient liveness probe failed: tmux unavailable',
      })])
      expect(restarted.getDelivery('msg-probe-error/d/1')).toMatchObject({
        state: 'accepted',
      })
    })
  })

  it('leaves an in-flight attempt ambiguous when exact transcript evidence is unavailable', async () => {
    await withLedger(async open => {
      const ledger = open(['msg-ambiguous'])
      await makeInFlight(ledger, 'msg-ambiguous')
      const restarted = open()

      const report = await coordinator(restarted, {
        evidence: evidence('inconclusive', 'msg-ambiguous'),
      }).recover()
      expect(report.outcomes).toEqual([expect.objectContaining({
        disposition: 'ambiguous',
      })])
      expect(restarted.getDelivery('msg-ambiguous/d/1')).toMatchObject({
        state: 'in-flight',
        attempt: 1,
      })
    })
  })

  it('does not inspect recipients or mutate when the ledger snapshot is corrupt', async () => {
    await withLedger(async (open, dir) => {
      const ledger = open(['msg-corrupt'])
      await ledger.accept(input('msg-corrupt'))
      const paths = deliveryLedgerPaths(dir)
      writeFileSync(paths.primary, '{"version":1,"messages":[')
      writeFileSync(paths.backup, '{"version":1,"messages":[')
      const faulted = open()
      const observeRecipient = vi.fn(async () => ({
        state: 'alive' as const,
        incarnation: 'receiver-process-v1',
      }))

      const report = await new DeliveryRecoveryCoordinator({
        ledger: faulted,
        observeRecipient,
        inspectTranscriptEvidence: async request => evidence(
          'inconclusive',
          request.messageId,
        ),
      }).recover()
      expect(report).toMatchObject({
        status: 'faulted',
        ledgerHealth: 'faulted-read-only',
        scanned: 0,
      })
      expect(observeRecipient).not.toHaveBeenCalled()
    })
  })

  it('settles a failed recovery before allowing router startup', async () => {
    const order: string[] = []
    await settleDeliveryRecoveryBarrier({
      recover: async () => {
        order.push('recover')
        throw new Error('corrupt recovery dependency')
      },
      onError: () => { order.push('reported') },
    })
    order.push('router')
    expect(order).toEqual(['recover', 'reported', 'router'])
  })

  it('releases the startup barrier even when recovery error reporting also fails', async () => {
    await expect(settleDeliveryRecoveryBarrier({
      recover: async () => { throw new Error('recovery failed') },
      onError: () => { throw new Error('logger failed') },
    })).resolves.toBeUndefined()
  })
})
