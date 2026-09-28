import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the two seams: the child-process spawn and the session lookup. The author is
// deliberately a bare child (no tmux/ttyd/session record), so the whole surface under
// test is "did we launch a child, with the right cwd/args, without blocking or throwing".
const spawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => spawn(...a) }))
const getSession = vi.hoisted(() => vi.fn())
vi.mock('../session', () => ({ getSession: (...a: unknown[]) => getSession(...a) }))
vi.mock('../../logger', () => ({ log: { info: () => {}, warn: () => {} } }))

import { dispatchSurfaceAuthor, SLATE_AUTHOR_CONTRACT } from '../surfaceAuthor'
import {
  SEVERITY_SCALE, LIKELIHOOD_SCALE, DISCOVERABILITY_SCALE,
  REVERSAL_ACTION_SCALE, REVERSAL_DAMAGE_SCALE, HORIZON_SCALE,
} from '../../../a2ui/controls'

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
    const [bin, args, opts] = spawn.mock.calls[0] as [string, string[], { cwd?: string; timeout?: number; env?: Record<string, string> }]
    expect(bin).toBe('claude')
    const promptArg = args[args.indexOf('-p') + 1]!
    expect(promptArg).toContain('AUTHOR THIS')                     // the caller's pre-built prompt
    expect(promptArg).toContain('SLATE SURFACE AUTHORING CONTRACT') // ...prepended with the A2UI contract
    expect(promptArg).toContain('component:"Text"')                // the contract carries the vocabulary
    expect(args).toContain('--model')
    expect(args).toContain('sonnet')
    expect(opts.cwd).toBe('/wd')               // the run's workdir (where the watcher looks)
    expect(opts.timeout).toBe(1000)            // bounded — a wandering author is killed
    // GUEST BOUNDARY: this claude runs in someone else's repo, so it must get a
    // scoped env, not Tinstar's. Asserted here because deleting `env:` from
    // surfaceAuthor.ts would otherwise pass this suite untouched.
    expect(opts.env).toBeDefined()
    expect(opts.env).not.toHaveProperty('NODE_ENV')
  })

  it('injects the caller-supplied credentials instead of hoping the ambient env has them', () => {
    // This child has NO login shell to re-export anything, and the dispatch is
    // fire-and-forget — so a missing credential would surface only as "the
    // author wrote nothing", indistinguishable from success. Explicit beats
    // implicit: the caller passes what the child needs.
    dispatchSurfaceAuthor({
      ...base,
      config: cfg,
      secrets: { ANTHROPIC_API_KEY: 'sk-test', CLAUDE_CODE_OAUTH_TOKEN: 'tok' },
    })
    const [, , opts] = spawn.mock.calls[0] as [string, string[], { env?: Record<string, string> }]
    expect(opts.env!.ANTHROPIC_API_KEY).toBe('sk-test')
    expect(opts.env!.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok')
    expect(opts.env).not.toHaveProperty('NODE_ENV')   // still scoped
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

// SEVERITY_SCALE/LIKELIHOOD_SCALE/DISCOVERABILITY_SCALE/REVERSAL_ACTION_SCALE/
// REVERSAL_DAMAGE_SCALE/HORIZON_SCALE (controls.ts) are consumed by nothing
// outside that file — not even the tests, until this guard. Without it, renaming
// a scale value there (e.g. severe → critical) leaves every test green while the
// contract goes on instructing a one-shot author to emit a word the parser no
// longer recognises. Derived from the exported constants, not a hardcoded copy,
// so the two can never drift apart silently again.
describe('SLATE_AUTHOR_CONTRACT covers the Decision scale vocabulary', () => {
  it('names every value of every exported Decision scale', () => {
    const allValues: readonly string[] = [
      ...SEVERITY_SCALE, ...LIKELIHOOD_SCALE, ...DISCOVERABILITY_SCALE,
      ...REVERSAL_ACTION_SCALE, ...REVERSAL_DAMAGE_SCALE, ...HORIZON_SCALE,
    ]
    const missing = allValues.filter(v => !SLATE_AUTHOR_CONTRACT.includes(v))
    expect(missing).toEqual([])
  })

  it('keeps composed decisions interactive, stable, and evidence-led', () => {
    expect(SLATE_AUTHOR_CONTRACT).toContain('host-assigned compose cards')
    expect(SLATE_AUTHOR_CONTRACT).toMatch(/controls submit\s+normally/)
    expect(SLATE_AUTHOR_CONTRACT).toContain('ONE Surface per human decision')
    expect(SLATE_AUTHOR_CONTRACT).toContain('source or observation time')
    expect(SLATE_AUTHOR_CONTRACT).toContain('label uncertain claims as hypotheses')
    expect(SLATE_AUTHOR_CONTRACT).toContain('another valid outcome such as delegation or waiting')
    expect(SLATE_AUTHOR_CONTRACT).toContain('NEVER put a refresh recipe on an unanswered Decision')
  })
})
