import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the two seams: the child-process spawn and the session lookup. The author is
// deliberately a bare child (no tmux/ttyd/session record), so the whole surface under
// test is "did we launch a child, with the right cwd/args, without blocking or throwing".
const spawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => spawn(...a) }))
const getSession = vi.hoisted(() => vi.fn())
vi.mock('../session', () => ({ getSession: (...a: unknown[]) => getSession(...a) }))
vi.mock('../../logger', () => ({ log: { info: () => {}, warn: () => {} } }))

import { dispatchSurfaceAuthor } from '../surfaceAuthor'

function fakeChild() {
  return { on: vi.fn(), unref: vi.fn() }
}
const cfg = { enabled: true, model: 'sonnet', timeoutMs: 1000 }
const base = { sessionsDir: '/sessions', runId: 'run-1', prompt: 'AUTHOR THIS', label: 'srf-1' }

describe('dispatchSurfaceAuthor', () => {
  beforeEach(() => {
    spawn.mockReset()
    getSession.mockReset()
    spawn.mockReturnValue(fakeChild())
    getSession.mockReturnValue({ workspace: { path: '/wd' } })
  })

  it('spawns a headless child in the run workdir with the prompt + model, returns dispatched:true', () => {
    const r = dispatchSurfaceAuthor({ ...base, config: cfg })
    expect(r.dispatched).toBe(true)
    expect(spawn).toHaveBeenCalledTimes(1)
    const [bin, args, opts] = spawn.mock.calls[0] as [string, string[], { cwd?: string; timeout?: number }]
    expect(bin).toBe('claude')
    expect(args).toContain('AUTHOR THIS')      // the pre-built (GUARDRAIL'd) prompt, passed as one argv
    expect(args).toContain('--model')
    expect(args).toContain('sonnet')
    expect(opts.cwd).toBe('/wd')               // the run's workdir (where the watcher looks)
    expect(opts.timeout).toBe(1000)            // bounded — a wandering author is killed
  })

  it('is fire-and-forget: unref() is called so the child never blocks the server loop', () => {
    const child = fakeChild()
    spawn.mockReturnValue(child)
    dispatchSurfaceAuthor({ ...base, config: cfg })
    expect(child.unref).toHaveBeenCalled()
  })

  it('disabled (kill switch) → dispatched:false, launches nothing', () => {
    const r = dispatchSurfaceAuthor({ ...base, config: { ...cfg, enabled: false } })
    expect(r.dispatched).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('no workdir for the run → dispatched:false, launches nothing', () => {
    getSession.mockReturnValue(null)
    const r = dispatchSurfaceAuthor({ ...base, config: cfg })
    expect(r.dispatched).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('a spawn failure → dispatched:false, never throws into the request path', () => {
    spawn.mockImplementation(() => { throw new Error('ENOENT claude') })
    expect(() => dispatchSurfaceAuthor({ ...base, config: cfg })).not.toThrow()
    expect(dispatchSurfaceAuthor({ ...base, config: cfg }).dispatched).toBe(false)
  })
})
