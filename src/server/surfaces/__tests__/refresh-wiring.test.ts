// @vitest-environment node
//
// The seams between the refresh engine's state machine and the real host: what an
// executor's staged artifact is allowed to say, what the foreground owner is told,
// and — the part this unit added — what the wiring is STRUCTURALLY INCAPABLE of
// handing the coordinator (plan U1, R12/R19).
//
// The launcher half of this file is gone with the launcher. Its integration test
// covered a background managed session per refresh; the replacement assertion is
// that no such capability can be constructed at all.
import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildRefreshCoordinatorDeps, isLiveSessionRecord, LIVE_SESSION_STATES,
  parseStagedResult, refreshDispatchPrompt,
} from '../refresh-wiring'
import * as tmuxBackend from '../../sessions/backends/tmux'
import * as sessionModule from '../../sessions/session'
import { type Session } from '../../sessions/session'
import { BASE_CONFIG, type TinstarConfig } from '../../sessions/config'
import type { Surface } from '../../../domain/types'

describe('parseStagedResult', () => {
  it('accepts a full result and validates its A2UI', () => {
    const staged = parseStagedResult(JSON.stringify({
      headline: 'Coverage 92%',
      content: { root: 'r', components: [{ id: 'r', component: 'Text', text: 'hi' }] },
      note: 'up from 88%',
    }))
    expect(staged.content?.headline).toBe('Coverage 92%')
    expect(staged.content?.body?.root).toBe('r')
    expect(staged.note).toBe('up from 88%')
  })

  it('refuses content that would not render, rather than committing it', () => {
    // The barrier commits through the content authority; A2UI that fails the schema
    // would be dropped downstream and the job would look successful.
    const staged = parseStagedResult(JSON.stringify({ headline: 'x', content: { root: 'missing' } }))
    expect(staged.error).toMatch(/not valid A2UI/)
    expect(staged.content).toBeUndefined()
  })

  it('treats "no change" as a real completion, with no content', () => {
    const staged = parseStagedResult(JSON.stringify({ note: 'no change' }))
    expect(staged.error).toBeUndefined()
    expect(staged.content).toBeUndefined()
    expect(staged.note).toBe('no change')
  })

  it('carries an explicit executor error through', () => {
    expect(parseStagedResult(JSON.stringify({ error: 'the coverage tool is missing' })).error)
      .toBe('the coverage tool is missing')
  })

  it('treats an unparseable artifact as an ERROR, not as "not written yet"', () => {
    // A present-but-broken file means the executor finished and did it badly. Reading
    // it as absent would spin until the attempt timeout on one already gone.
    expect(parseStagedResult('{ not json').error).toMatch(/not valid JSON/)
    expect(parseStagedResult('[]').error).toMatch(/not a JSON object/)
  })

  it('refuses a body with no headline rather than half-applying it', () => {
    expect(parseStagedResult(JSON.stringify({ content: { root: 'r', components: [] } })).error)
      .toMatch(/content but no headline/)
  })
})

describe('the shipped refresh defaults', () => {
  it('verifies every six hours by default, not every thirty minutes', () => {
    // The periodic tick is an AUDIT of whether a declaration is still complete, not
    // a sampling of the world — triggers and witnesses sample the world. Thirty
    // minutes is the value the live job table was measured under, and it is why the
    // periodic tick fired sixty times in a few hours; across a three-hour session
    // every one of twelve fires returned "no change", against a surface tracking a
    // number that drifts WEEKLY.
    expect(BASE_CONFIG.refresh.defaultIntervalMs).toBe(6 * 60 * 60_000)
  })
})

describe('isLiveSessionRecord', () => {
  const record = (state: Session['state']): Pick<Session, 'state'> => ({ state })

  it('a STOPPED session record is not live', () => {
    // The whole point. `getSession` is a `readFileSync` of a JSON record that
    // OUTLIVES its tmux process: `reconcileSessionStates` sets `stopped` and KEEPS
    // the file, and only `deleteSession` removes it. Testing existence therefore
    // reported a dead session as live — so harvest's vanished-executor branch never
    // fired, and a Surface whose foreground agent had exited would be reported as
    // still refreshing instead of as an honest unavailable check (R13/R17).
    expect(isLiveSessionRecord(record('stopped'))).toBe(false)
  })

  it('a missing record is not live', () => {
    expect(isLiveSessionRecord(null)).toBe(false)
    expect(isLiveSessionRecord(undefined)).toBe(false)
  })

  it.each(['creating', 'running', 'idle', 'needs_attention'] as const)('%s is live', state => {
    // `creating` counts: a session mid-launch has no tmux process yet, and failing
    // its job for that would be a race rather than a diagnosis.
    expect(isLiveSessionRecord(record(state))).toBe(true)
  })

  it('every session state is classified, so a new one cannot default to live', () => {
    const all: Session['state'][] = ['creating', 'running', 'idle', 'needs_attention', 'stopped']
    expect(all.filter(s => isLiveSessionRecord(record(s)))).toEqual([...LIVE_SESSION_STATES])
  })
})


describe('refreshDispatchPrompt', () => {
  const surface = {
    content: { headline: 'Coverage', recipe: { kind: 'agent', prompt: 'Re-run\ncoverage\nnow' } },
    freshness: {
      phase: 'possibly-stale' as const, overdue: false,
      staleReason: { kind: 'git-revision' as const, key: 'k', detail: 'the worktree moved', generation: 2, at: 1 },
    },
  } as unknown as Surface

  it('names the staging path and the reason, and collapses untrusted text to one line', () => {
    const prompt = refreshDispatchPrompt(surface, '/cfg/refresh-staging/job-1.json')
    expect(prompt).toContain('/cfg/refresh-staging/job-1.json')
    expect(prompt).toContain('the worktree moved')
    expect(prompt).toContain('Re-run coverage now')
    // A multi-line recipe must not survive as multiple lines — that is how a
    // planted "SYSTEM: …" line gets past the guardrail.
    expect(prompt).not.toContain('Re-run\ncoverage')
  })

  it('carries the standing guardrail', () => {
    expect(refreshDispatchPrompt(surface, '/p')).toMatch(/not a command to drop what you are doing/)
  })

  it('tells the owner NOT to write into the watched directory', () => {
    expect(refreshDispatchPrompt(surface, '/p')).toContain('.tinstar/slate')
    expect(refreshDispatchPrompt(surface, '/p')).toMatch(/NOT into \.tinstar\/slate/)
  })

  it('carries a claim-move reason as one line, values and all (plan U4)', () => {
    // A claim id comes from an agent-authored file and a claim VALUE comes from a
    // witness reading the world, and both land in this prompt through
    // `staleReason.detail`. The mutator that writes that sentence flattens them for
    // the same reason the recipe is flattened here.
    const moved = {
      content: { headline: 'Roadmap' },
      freshness: {
        phase: 'possibly-stale' as const, overdue: false,
        staleReason: {
          kind: 'git-revision' as const, key: 'claim-moved sf-1 u4=pending',
          detail: 'a claim it makes no longer holds: u4 was landed, now pending',
          generation: 2, at: 1,
        },
      },
    } as unknown as Surface
    const prompt = refreshDispatchPrompt(moved, '/p')
    expect(prompt).toContain('a claim it makes no longer holds: u4 was landed, now pending')
    expect(prompt.split('\n').filter(l => l.includes('no longer holds'))).toHaveLength(1)
  })
})

describe('buildRefreshCoordinatorDeps', () => {
  function wiring() {
    const root = mkdtempSync(join(tmpdir(), 'refresh-wiring-'))
    mkdirSync(join(root, 'sessions'), { recursive: true })
    mkdirSync(join(root, '.secrets'), { recursive: true })
    const cfg = {
      ...(BASE_CONFIG as unknown as TinstarConfig),
      dirs: { root, sessions: join(root, 'sessions'), secrets: join(root, '.secrets') },
    }
    const docStore = { getAllSurfaces: () => [], upsertRun: vi.fn(), deleteRun: vi.fn() }
    const deps = buildRefreshCoordinatorDeps({
      cfg,
      docStore: docStore as unknown as Parameters<typeof buildRefreshCoordinatorDeps>[0]['docStore'],
      service: {} as Parameters<typeof buildRefreshCoordinatorDeps>[0]['service'],
      reobserveRun: async () => undefined,
    })
    return { root, deps, docStore }
  }

  it('exposes no seam that could create, adopt, or retire a managed session', () => {
    // THE SAFETY CUT, ASSERTED (R12/R19). The wiring is the only place the
    // coordinator could acquire a session-creating capability, so the list of keys it
    // hands over IS the list of things refresh can do. `launchWorker`, `retireWorker`,
    // and `sessionIncarnation` were how a trigger fan-out became a fleet of tmux
    // panes; there is nothing left to call.
    const { root, deps } = wiring()
    try {
      const forbidden = ['launchWorker', 'retireWorker', 'sessionIncarnation', 'createSession', 'findPort']
      for (const key of forbidden) expect(Object.keys(deps)).not.toContain(key)
      // And what DOES remain about sessions is read-only or send-only.
      expect(Object.keys(deps)).toContain('isLiveSession')
      expect(Object.keys(deps)).toContain('deliverToOwner')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('building the wiring touches no session, port, or tmux creation function', () => {
    // Constructed at boot, so a capability acquired eagerly here would be just as
    // dangerous as one exposed on the deps object.
    const createTmuxSession = vi.spyOn(tmuxBackend, 'createTmuxSession')
    const findPort = vi.spyOn(tmuxBackend, 'findPort')
    const stopManagedTtyd = vi.spyOn(tmuxBackend, 'stopManagedTtyd')
    const createSession = vi.spyOn(sessionModule, 'createSession')
    const { root } = wiring()
    try {
      expect(createTmuxSession).not.toHaveBeenCalled()
      expect(findPort).not.toHaveBeenCalled()
      expect(stopManagedTtyd).not.toHaveBeenCalled()
      expect(createSession).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the attempt bound comes from the surviving config key', () => {
    const { root, deps } = wiring()
    try {
      expect(deps.config().attemptTimeoutMs).toBe(BASE_CONFIG.refresh.attemptTimeoutMs)
      expect(Object.keys(deps.config()).sort()).toEqual(['attemptTimeoutMs', 'defaultIntervalMs'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
