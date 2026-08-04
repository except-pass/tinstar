import { describe, expect, it } from 'vitest'
import { applyDelta } from '../useServerEvents'

const base = () => ({
  activeSpaceId: '', spaces: [], initiatives: [], epics: [], tasks: [], worktrees: [],
  runs: [], marshal: null, editorWidgets: [], browserWidgets: [], imageWidgets: [],
  topicMetadata: [], readyQueue: [], pluginWidgets: [], constellationGraphs: [], pinSets: [],
}) as any

const run = (over: Record<string, unknown> = {}) => ({
  id: 'R-1', status: 'running', background: false, blocked: false,
  sessionId: 'S-1', initiative: 'I', epic: 'E', task: 'T',
  repo: 'r', worktree: 'w', touchedFiles: [], recapEntries: [], rawLogs: '',
  ...over,
})

const overTheWire = (data: unknown) => JSON.parse(JSON.stringify(data))

describe('applyDelta run NATS merge', () => {
  it('clears stale subjects when the server disables NATS', () => {
    const connected = applyDelta(base(), {
      entity: 'run',
      id: 'R-1',
      data: overTheWire(run({
        natsEnabled: true,
        natsSubject: 'legacy.subject',
        natsSubscriptions: ['legacy.subject'],
      })),
    })

    const disconnected = applyDelta(connected, {
      entity: 'run',
      id: 'R-1',
      data: overTheWire(run({
        natsEnabled: false,
        natsSubject: undefined,
        natsSubscriptions: undefined,
      })),
    })

    expect(disconnected.runs[0]).toMatchObject({ natsEnabled: false })
    expect(disconnected.runs[0]!.natsSubject).toBeUndefined()
    expect(disconnected.runs[0]!.natsSubscriptions).toBeUndefined()
  })
})
