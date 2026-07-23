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
import { CATALOG } from '../../../a2ui/catalog'

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
    const promptArg = args[args.indexOf('-p') + 1]!
    expect(promptArg).toContain('AUTHOR THIS')                     // the caller's pre-built prompt
    expect(promptArg).toContain('SLATE SURFACE AUTHORING CONTRACT') // ...prepended with the A2UI contract
    expect(promptArg).toContain('component:"Text"')                // the contract carries the vocabulary
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

// The code-spawned author is a fresh `claude -p` in a foreign repo with no Tinstar
// skill: SLATE_AUTHOR_CONTRACT is the ONLY vocabulary it ever sees. So a primitive
// that lives in CATALOG but not in the contract is dead code no agent will ever
// emit — and until now nothing enforced that. Adding `Stepper` took five hand-edits
// across the contract and four doc tables; this is the guard that fails loudly when
// the NEXT primitive forgets step one.
describe('SLATE_AUTHOR_CONTRACT covers the render catalog', () => {
  // Types the contract deliberately withholds from a one-shot author:
  //   Choice/TextInput/Submit — interactive controls. A file-authored surface is
  //     read-only, so a form the author cannot wire up is worse than nothing.
  //   FollowUp — a DECLARATION, not a body element (it renders null in the catalog).
  const DELIBERATELY_UNDOCUMENTED = new Set(['Choice', 'TextInput', 'Submit', 'FollowUp'])

  it('names every renderable catalog primitive, so none is unreachable dead code', () => {
    const missing = Object.keys(CATALOG)
      .filter(type => !DELIBERATELY_UNDOCUMENTED.has(type))
      .filter(type => !SLATE_AUTHOR_CONTRACT.includes(`component:"${type}"`))
    expect(missing).toEqual([])
  })

  it('does NOT teach the author the interactive controls (they cannot work from a file)', () => {
    for (const type of DELIBERATELY_UNDOCUMENTED) {
      expect(SLATE_AUTHOR_CONTRACT).not.toContain(`component:"${type}"`)
    }
  })

  it('keeps the allowlist honest: every deliberately-omitted type still exists in CATALOG', () => {
    for (const type of DELIBERATELY_UNDOCUMENTED) {
      expect(Object.keys(CATALOG)).toContain(type)
    }
  })

  // The mirror image, and the nastier direction: a contract line naming a type the
  // catalog no longer has. Every code-spawned author would keep emitting the dead
  // type, and each surface would degrade to the inline "unsupported component"
  // marker — silent vocabulary drift again, just pointing the other way.
  it('names no type the catalog cannot render, so a rename/removal cannot strand authors', () => {
    const named = [...SLATE_AUTHOR_CONTRACT.matchAll(/component:"([^"]+)"/g)].map(m => m[1]!)
    expect(named.length).toBeGreaterThan(0) // the regex still matches the contract's shape
    const unrenderable = [...new Set(named)].filter(type => !(type in CATALOG))
    expect(unrenderable).toEqual([])
  })
})
