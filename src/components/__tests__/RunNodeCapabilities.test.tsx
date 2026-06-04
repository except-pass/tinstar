// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import type { RunData } from '../../domain/types'
import { RunNodeCapabilities } from '../RunNodeCapabilities'
import { capabilityRegistry } from '../../core/constellationCapabilities'

function makeRun(overrides: Partial<RunData> = {}): RunData {
  return {
    id: 'r1',
    color: '#ff7700',
    status: 'idle',
    sessionId: 'sess-1',
    taskId: 't1',
    initiative: 'init',
    epic: 'epic',
    task: 'task',
    repo: 'repo',
    worktree: 'wt',
    touchedFiles: [],
    recapEntries: [],
    rawLogs: '',
    port: null,
    backend: null,
    ...overrides,
  }
}

describe('RunNodeCapabilities', () => {
  beforeEach(() => { capabilityRegistry.clearAll() })

  it('publishes both session.prompt and session.nats at run-r1', async () => {
    const run = makeRun({ natsSubscriptions: ['a.broadcast', 'a.broadcast.sess'] })
    render(<RunNodeCapabilities run={run} />)

    expect(capabilityRegistry.capabilitiesOf('run-r1')).toContain('session.prompt')
    expect(capabilityRegistry.capabilitiesOf('run-r1')).toContain('session.nats')
  })

  it('publishes session.nats with the expected payload and unpublishes on unmount', async () => {
    const run = makeRun({ natsSubscriptions: ['a.broadcast', 'a.broadcast.sess'] })
    const { unmount } = render(<RunNodeCapabilities run={run} />)

    expect(capabilityRegistry.capabilitiesOf('run-r1')).toContain('session.nats')
    const payload = await capabilityRegistry.invoke('run-r1', 'session.nats', undefined)
    expect(payload).toEqual({
      sessionId: 'sess-1',
      status: 'idle',
      subscriptions: ['a.broadcast', 'a.broadcast.sess'],
      color: '#ff7700',
      orphanedAt: null,
    })

    unmount()
    expect(capabilityRegistry.capabilitiesOf('run-r1')).not.toContain('session.nats')
    expect(capabilityRegistry.capabilitiesOf('run-r1')).not.toContain('session.prompt')
  })

  it('surfaces natsControlOrphanedAt so the Saloon can show a reconnect affordance', async () => {
    const run = makeRun({ natsControlOrphanedAt: '2026-06-02T00:00:00Z' })
    render(<RunNodeCapabilities run={run} />)

    const payload = await capabilityRegistry.invoke('run-r1', 'session.nats', undefined) as { orphanedAt: string | null }
    expect(payload.orphanedAt).toBe('2026-06-02T00:00:00Z')
  })

  it('derives both broadcast and direct subjects when only natsSubject is present', async () => {
    const run = makeRun({ natsSubject: 'tinstar.space.init.epic.task.agent', natsSubscriptions: undefined })
    render(<RunNodeCapabilities run={run} />)

    const payload = await capabilityRegistry.invoke('run-r1', 'session.nats', undefined) as { subscriptions: string[] }
    expect(payload.subscriptions).toEqual([
      'tinstar.space.init.epic.task',
      'tinstar.space.init.epic.task.agent',
    ])
  })

  it('uses a legacy wildcard natsSubject verbatim instead of trimming it', async () => {
    const run = makeRun({ natsSubject: 'tinstar.space.init.>', natsSubscriptions: undefined })
    render(<RunNodeCapabilities run={run} />)

    const payload = await capabilityRegistry.invoke('run-r1', 'session.nats', undefined) as { subscriptions: string[] }
    expect(payload.subscriptions).toEqual(['tinstar.space.init.>'])
  })
})
