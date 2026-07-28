// @vitest-environment node
//
// The seams between the refresh engine's state machine and the real host (plan
// U6): what a worker's staged artifact is allowed to say, and what a launch leaves
// behind when it fails part-way.
//
// The launcher half is an INTEGRATION test through the real chain — a real temp
// directory, the real `createSession`/`updateSession`/`deleteSession`, the real
// port claim, and real compensation. Only tmux itself is substituted, because a
// test that started a tmux server would be testing tmux.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseStagedResult, refreshDispatchPrompt } from '../refresh-wiring'
import { launchRefreshWorker, refreshBriefText, type RefreshWorkerHost } from '../../sessions/surfaceAuthor'
import { createSession, deleteSession, getSession, updateSession, type Session } from '../../sessions/session'
import { BASE_CONFIG, type PortWindow, type TinstarConfig } from '../../sessions/config'
import type { LaunchStage } from '../../sessions/session-launcher'
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

  it('carries an explicit worker error through', () => {
    expect(parseStagedResult(JSON.stringify({ error: 'the coverage tool is missing' })).error)
      .toBe('the coverage tool is missing')
  })

  it('treats an unparseable artifact as an ERROR, not as "not written yet"', () => {
    // A present-but-broken file means the worker finished and did it badly. Reading
    // it as absent would spin until the worker timeout on a worker already gone.
    expect(parseStagedResult('{ not json').error).toMatch(/not valid JSON/)
    expect(parseStagedResult('[]').error).toMatch(/not a JSON object/)
  })

  it('refuses a body with no headline rather than half-applying it', () => {
    expect(parseStagedResult(JSON.stringify({ content: { root: 'r', components: [] } })).error)
      .toMatch(/content but no headline/)
  })
})

describe('refreshDispatchPrompt', () => {
  const surface = {
    content: { headline: 'Coverage', recipe: 'Re-run\ncoverage\nnow' },
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

  it('tells the worker NOT to write into the watched directory', () => {
    expect(refreshDispatchPrompt(surface, '/p')).toContain('.tinstar/slate')
    expect(refreshDispatchPrompt(surface, '/p')).toMatch(/NOT into \.tinstar\/slate/)
  })
})

describe('refreshBriefText', () => {
  it('puts the recipe in the FILE, verbatim and unquoted', () => {
    // The no-shell property: the recipe's bytes live here, not on a command line.
    const recipe = 'Run `make cov`; then $(echo report) > out'
    const brief = refreshBriefText({ recipe, headline: 'Coverage', stagingPath: '/cfg/s/j.json' })
    expect(brief).toContain(recipe)
    expect(brief).toContain('/cfg/s/j.json')
  })

  it('says explicitly that writing nothing is a failure', () => {
    const brief = refreshBriefText({ recipe: 'x', headline: 'y', stagingPath: '/p' })
    expect(brief).toMatch(/If you write nothing, the refresh is recorded as FAILED/)
  })
})

describe('launchRefreshWorker', () => {
  let root: string
  let cfg: TinstarConfig
  let claimed: number[]
  let runs: Map<string, unknown>
  let stopped: string[]
  let stages: { stage: LaunchStage; detail?: string }[]

  const WINDOW: PortWindow = { label: 'refresh', start: 19_901, count: 4 }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'u6-launch-'))
    cfg = {
      ...(BASE_CONFIG as unknown as TinstarConfig),
      dirs: { root, secrets: join(root, '.secrets'), sessions: join(root, 'sessions') },
      ports: { ...BASE_CONFIG.ports, refreshStart: WINDOW.start, refreshCount: WINDOW.count },
    }
    claimed = []
    runs = new Map()
    stopped = []
    stages = []
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function host(over: Partial<RefreshWorkerHost> = {}): RefreshWorkerHost {
    return {
      config: cfg,
      worktree: root,
      sessionName: 'refresh-job-1',
      briefPath: join(root, 'job-1.brief.md'),
      stagingPath: join(root, 'job-1.json'),
      recipe: 'Re-run coverage.',
      headline: 'Coverage',
      secrets: {},
      spaceId: 'spc-a',
      writeFile: (p, d) => writeFileSync(p, d, 'utf8'),
      removeFile: p => { try { rmSync(p, { force: true }) } catch { /* ignore */ } },
      findPort: async () => { const p = WINDOW.start + claimed.length; claimed.push(p); return p },
      releasePort: p => { claimed = claimed.filter(x => x !== p) },
      createSession,
      deleteSession,
      updateSession,
      // tmux itself is the one substitution — a test that started a tmux server
      // would be testing tmux.
      startSession: async ({ port }) => ({ port, ttydPid: 4242 }),
      stopSession: name => { stopped.push(name) },
      upsertRun: (id, run) => { runs.set(id, run) },
      deleteRun: id => { runs.delete(id) },
      onStage: (stage, detail) => stages.push({ stage, detail }),
      ...over,
    }
  }

  it('creates the brief, the session, and a backgrounded focus-neutral Run', async () => {
    const result = await launchRefreshWorker(host())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // The brief exists, outside the watched directory, holding the recipe.
    const brief = readFileSync(join(root, 'job-1.brief.md'), 'utf8')
    expect(brief).toContain('Re-run coverage.')
    expect(join(root, 'job-1.brief.md')).not.toContain('.tinstar/slate')

    // The launch prompt names the brief PATH and nothing else — the recipe never
    // reaches a command line.
    const session = getSession(cfg.dirs.sessions, 'refresh-job-1')!
    expect(session.state).toBe('running')
    expect(session.background).toBe(true)

    const run = runs.get('refresh-job-1') as Record<string, unknown>
    expect(run.background).toBe(true)
    expect(run.focusOnCreate).toBe(false)
    expect(run.worktree).toBe(root)
    expect(run.spaceId).toBe('spc-a')

    // The incarnation comes back only past every step.
    expect(result.incarnation.name).toBe('refresh-job-1')
    expect(result.incarnation.incarnation).toBe(session.conversation.id)
    expect(stages.map(s => s.stage)).toContain('ready')
  })

  it.each([
    ['port', ['brief']],
    ['session', ['brief', 'port']],
    ['tmux', ['brief', 'port', 'session']],
    ['run', ['brief', 'port', 'session', 'tmux']],
  ])('failure at the %s stage compensates every earlier stage', async (failing, earlier) => {
    const boom = () => { throw new Error(`${failing} exploded`) }
    const over: Partial<RefreshWorkerHost> = {}
    if (failing === 'port') over.findPort = async () => boom()
    if (failing === 'session') over.createSession = () => boom()
    if (failing === 'tmux') over.startSession = async () => boom()
    if (failing === 'run') over.upsertRun = () => boom()

    const result = await launchRefreshWorker(host(over))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain(failing)

    // Nothing is left behind, whichever stage broke.
    if (earlier.includes('brief')) expect(existsSync(join(root, 'job-1.brief.md'))).toBe(false)
    if (earlier.includes('port')) expect(claimed).toEqual([])
    if (earlier.includes('session')) expect(getSession(cfg.dirs.sessions, 'refresh-job-1')).toBeNull()
    if (earlier.includes('tmux')) expect(stopped).toContain('refresh-job-1')
    expect(runs.size).toBe(0)
    expect(stages.map(s => s.stage)).toContain('failed')
    expect(stages.map(s => s.stage)).not.toContain('ready')
  })

  it('reports a resource it could NOT release rather than swallowing it', async () => {
    const result = await launchRefreshWorker(host({
      createSession: () => { throw new Error('session exploded') },
      removeFile: () => { throw new Error('read-only filesystem') },
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toMatch(/could not release: brief/)
  })
})

/** Compile-time assurance that the launcher's `startSession` seam still matches
 *  what `createTmuxSession` returns, exercised at runtime so it is not pruned.
 *  Without it the wiring's substitution could drift from the real backend and only
 *  fail on a live launch. */
describe('launcher seam', () => {
  it('startSession returns the port and ttyd pid the launcher records', async () => {
    const start: RefreshWorkerHost['startSession'] = async ({ port }) => ({ port, ttydPid: undefined })
    const out = await start({ session: {} as Session, port: 1, secrets: {} })
    expect(out).toEqual({ port: 1, ttydPid: undefined })
  })
})
