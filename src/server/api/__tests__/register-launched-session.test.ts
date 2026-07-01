import { describe, it, expect, vi } from 'vitest'
import { registerLaunchedSession } from '../routes'
import { DocumentStore } from '../../stores/document-store'
import type { CreateSessionContext } from '../routes'
import type { BusEvent } from '../../types'

// The shared post-launch wiring both a fresh create and a graveyard revive run
// through. Proving it here means a revived session is a first-class citizen
// (NATS registered, ready queue entered, event emitted) by construction.
function makeDeps() {
  const docStore = new DocumentStore()
  const events: BusEvent[] = []
  const readyStatuses: Array<[string, string]> = []
  const tracked: string[] = []
  const deps = {
    docStore,
    natsTraffic: undefined,
    natsHealth: { trackSession: (n: string) => tracked.push(n) },
    readyQueue: { onStatusChange: (n: string, s: string) => readyStatuses.push([n, s]), getQueue: () => [] },
    sse: { setReadyQueue: vi.fn(), broadcastReadyQueueUpdate: vi.fn() },
    emitSessionEvent: (<T,>(type: T, payload: unknown) => events.push({ type, timestamp: '', payload } as unknown as BusEvent)),
  } as unknown as Pick<CreateSessionContext, 'docStore' | 'natsTraffic' | 'natsHealth' | 'readyQueue' | 'sse' | 'emitSessionEvent'>
  return { deps, events, readyStatuses, tracked }
}

describe('registerLaunchedSession', () => {
  it('enters the ready queue, tracks NATS health, and emits managed_session.created', () => {
    const { deps, events, readyStatuses, tracked } = makeDeps()
    registerLaunchedSession(deps, 'askviktor-necro', { enabled: true, subscriptions: ['bcast', 'dm'] }, 'running')

    expect(readyStatuses).toEqual([['askviktor-necro', 'running']])
    expect(tracked).toEqual(['askviktor-necro'])
    expect(events.map(e => e.type)).toContain('managed_session.created')
  })

  it('does not track NATS health when NATS is disabled', () => {
    const { deps, tracked } = makeDeps()
    registerLaunchedSession(deps, 'ghost-necro', null, 'idle')
    expect(tracked).toEqual([])
  })
})
