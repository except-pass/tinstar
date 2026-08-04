import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSession, getSession, setState } from '../session'
import { reconcileSessionStates } from '../reconcile'

const roots: string[] = []

function sessionsDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'tinstar-reconcile-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('reconcileSessionStates', () => {
  it('reports only definite backend observations', async () => {
    const dir = sessionsDir()
    createSession(dir, { name: 'verified-live', backend: 'tmux' })
    createSession(dir, { name: 'probe-failed', backend: 'tmux' })
    setState(dir, 'verified-live', 'running')
    setState(dir, 'probe-failed', 'running')
    const observed = vi.fn()

    await reconcileSessionStates(dir, {
      getTmuxSessionState: async (name) => {
        if (name === 'probe-failed') throw new Error('tmux unavailable')
        return { state: 'exists', generation: 'verified-generation' }
      },
      onTmuxSessionStateObserved: observed,
    })

    expect(observed).toHaveBeenCalledTimes(1)
    expect(observed).toHaveBeenCalledWith('verified-live', {
      state: 'exists',
      generation: 'verified-generation',
    })
  })

  it('does not commit stopped when the observed generation lost its CAS', async () => {
    const dir = sessionsDir()
    createSession(dir, { name: 'changed-after-probe', backend: 'tmux' })
    setState(dir, 'changed-after-probe', 'running')
    const onStateChanged = vi.fn()

    await reconcileSessionStates(dir, {
      getTmuxSessionState: async () => ({
        state: 'missing',
        generation: 'old-generation',
      }),
      beforeStateChanged: (_name, _state, observation) =>
        observation.generation === 'current-generation',
      onStateChanged,
    })

    expect(onStateChanged).not.toHaveBeenCalled()
    expect(getSession(dir, 'changed-after-probe')?.state).toBe('running')
  })
})
