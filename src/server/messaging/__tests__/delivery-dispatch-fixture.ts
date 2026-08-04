import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, vi } from 'vitest'
import { acquireBackendSingleton } from '../../infra/lock'
import { DeliveryLedger } from '../delivery-ledger'

export const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

export async function acceptedLedger(recipients = [{
  providerId: 'claude', sessionId: 'receiver', incarnation: 'receiver-v3',
}], options: {
  maxOutstandingDeliveries?: number
  maxHistoryEntries?: number
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
