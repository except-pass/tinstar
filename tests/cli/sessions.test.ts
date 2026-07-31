import { describe, expect, it } from 'vitest'
import { renderSessionList } from '../../bin/tinstar/commands/sessions.js'

describe('renderSessionList', () => {
  it('lists persisted session state with stable template IDs', () => {
    const output = renderSessionList({
      runs: [{
        id: 'run-worker',
        status: 'idle',
        cliTemplate: 'wrong-run-template',
      }],
      sessions: [{
        name: 'worker',
        state: 'running',
        cliTemplate: 'codex-full-auto',
      }],
    })

    expect(output).toBe('worker\trunning\tcodex-full-auto')
  })

  it('renders an empty list when the state has no sessions', () => {
    expect(renderSessionList({ runs: [{ id: 'legacy-run' }] })).toBe('')
  })
})
