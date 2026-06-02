// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { RunData } from '../../../domain/types'

// The widget's child panels reach for ConstellationProvider / server-event
// contexts that aren't relevant to the `session.nats` capability effect under
// test. Stub them so the render exercises only the effect in index.tsx.
vi.mock('../RunWorkspaceHeader', () => ({ RunWorkspaceHeader: () => null }))
vi.mock('../TouchedFilesPanel', () => ({ TouchedFilesPanel: () => null }))
vi.mock('../FileTreePanel', () => ({ FileTreePanel: () => null }))
vi.mock('../RunSessionPanel', () => ({ RunSessionPanel: () => null }))
vi.mock('../TelemetryPanel', () => ({ TelemetryPanel: () => null }))
vi.mock('../HandsPanel', () => ({ HandsPanel: () => null }))

import { RunWorkspaceWidget } from '../index'
import { capabilityRegistry } from '../../../core/constellationCapabilities'

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

describe('session.nats constellation capability', () => {
  beforeEach(() => capabilityRegistry.clearAll())

  it('publishes session.nats with the expected payload and unpublishes on unmount', async () => {
    const run = makeRun({ natsSubscriptions: ['a.broadcast', 'a.broadcast.sess'] })
    const { unmount } = render(<RunWorkspaceWidget run={run} />)

    expect(capabilityRegistry.capabilitiesOf('run-r1')).toContain('session.nats')
    const payload = await capabilityRegistry.invoke('run-r1', 'session.nats', undefined)
    expect(payload).toEqual({
      sessionId: 'sess-1',
      status: 'idle',
      subscriptions: ['a.broadcast', 'a.broadcast.sess'],
      color: '#ff7700',
    })

    unmount()
    expect(capabilityRegistry.capabilitiesOf('run-r1')).not.toContain('session.nats')
  })

  it('derives both broadcast and direct subjects when only natsSubject is present', async () => {
    const run = makeRun({ natsSubject: 'tinstar.space.init.epic.task.agent', natsSubscriptions: undefined })
    render(<RunWorkspaceWidget run={run} />)

    const payload = await capabilityRegistry.invoke('run-r1', 'session.nats', undefined) as { subscriptions: string[] }
    expect(payload.subscriptions).toEqual([
      'tinstar.space.init.epic.task',
      'tinstar.space.init.epic.task.agent',
    ])
  })
})
