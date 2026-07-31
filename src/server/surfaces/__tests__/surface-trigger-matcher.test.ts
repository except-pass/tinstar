// The closed trigger vocabulary and what it makes stale (plan U6, R14/R15).
import { describe, it, expect } from 'vitest'
import type { Surface, SurfaceRefreshDeclaration } from '../../../domain/types'
import {
  coalesceGeneration,
  deriveDueAt,
  effectiveDeclaration,
  isExternalSourceId,
  matchTrigger,
  MIN_INTERVAL_MS,
  normalizeTrigger,
  parseRefreshDeclaration,
  pathMatchesGlob,
  triggerDedupeKey,
  type SurfaceTriggerEvent,
} from '../surface-trigger-matcher'

const SPACE = 'spc_1'
const WORKTREE = '/tmp/wt/alpha'

function surface(over: Partial<Surface> = {}): Surface {
  return {
    id: 'srf_1',
    spaceId: SPACE,
    home: { kind: 'canvas', spaceId: SPACE },
    content: { headline: 'Coverage', recipe: 'Re-run coverage and rewrite the surface.' },
    contentAuthority: 'source-binding',
    author: 'agent',
    provenance: { runId: 'run-a', worktreeId: WORKTREE },
    source: { adapter: 'slate-file', locator: 'file:cov.json#cov', worktree: WORKTREE, generation: 3 },
    thread: { replies: [], status: 'open' },
    freshness: { phase: 'current', overdue: false, observedGeneration: 3, verifiedAt: 1_000 },
    rev: 1,
    homeRev: 1,
    createdAt: 100,
    amendedAt: 1_000,
    ...over,
  }
}

function event(over: Partial<SurfaceTriggerEvent> = {}): SurfaceTriggerEvent {
  return { kind: 'git-revision', sourceId: WORKTREE, worktree: WORKTREE, evidence: 'abc123', at: 2_000, ...over }
}

describe('parseRefreshDeclaration', () => {
  it('keeps only vocabulary the host implements', () => {
    const d = parseRefreshDeclaration({
      policy: 'mark-stale',
      triggers: ['git-revision', 'on-full-moon', 'periodic', 'git-revision'],
    })
    expect(d).toEqual({ policy: 'mark-stale', triggers: ['git-revision', 'periodic'] })
  })

  it('ignores an executable watcher declaration entirely', () => {
    // The plan's scenario: an author (or a hostile branch) writing a trigger that
    // is a COMMAND rather than a name gets no trigger, not a command run.
    const d = parseRefreshDeclaration({ triggers: [{ exec: 'make check' }, { command: 'rm -rf /' }] })
    expect(d).toBeUndefined()
  })

  it('refuses a non-object declaration', () => {
    expect(parseRefreshDeclaration('every 5 minutes')).toBeUndefined()
    expect(parseRefreshDeclaration(['git-revision'])).toBeUndefined()
    expect(parseRefreshDeclaration(null)).toBeUndefined()
  })

  it('floors a too-eager interval rather than accepting a refresh storm', () => {
    expect(parseRefreshDeclaration({ intervalMs: 1_000 })?.intervalMs).toBe(MIN_INTERVAL_MS)
    expect(parseRefreshDeclaration({ intervalMs: 90 * 60_000 })?.intervalMs).toBe(90 * 60_000)
  })

  it('drops an out-of-vocabulary policy back to automatic', () => {
    expect(parseRefreshDeclaration({ policy: 'aggressive', triggers: ['periodic'] })?.policy).toBe('automatic')
  })

  it('bounds and de-duplicates declared sources and signals', () => {
    const d = parseRefreshDeclaration({
      sources: ['a', 'a', '  ', 'b', 'x'.repeat(500)],
      signals: ['deploy-finished'],
    })
    expect(d?.sources).toEqual(['a', 'b'])
    expect(d?.signals).toEqual(['deploy-finished'])
  })

  it('keeps an EMPTY sources array distinct from an absent one', () => {
    // The three-state contract. `[]` is a real declaration — "I checked, nothing in
    // the repo derives this" — and collapsing it to undefined would make it
    // indistinguishable from an author who never said, which behaves the opposite
    // way.
    expect(parseRefreshDeclaration({ sources: [] })?.sources).toEqual([])
    expect(parseRefreshDeclaration({ triggers: ['periodic'] })?.sources).toBeUndefined()
  })

  it('drops non-string source entries without collapsing the declaration', () => {
    expect(parseRefreshDeclaration({ sources: [{ exec: 'ls' }, 42] })?.sources).toEqual([])
  })
})

describe('effectiveDeclaration', () => {
  it('a recipe-bearing bound Surface defaults to automatic on git + periodic', () => {
    expect(effectiveDeclaration(surface())).toEqual({
      policy: 'automatic',
      triggers: ['git-revision', 'periodic'],
    })
  })

  it('a recipe-LESS Surface defaults to mark-stale with no triggers', () => {
    // R13: absent recipe means refresh degrades to a nudge. Calling that automatic
    // would promise a rebuild nothing can perform.
    const d = effectiveDeclaration(surface({ content: { headline: 'Notes' } }))
    expect(d.policy).toBe('mark-stale')
    expect(d.triggers).toEqual([])
  })

  it('an author declaration wins over the defaults', () => {
    const declared: SurfaceRefreshDeclaration = { policy: 'manual', triggers: ['human-intent'] }
    const d = effectiveDeclaration(surface({
      content: { headline: 'Coverage', recipe: 'x', refreshPolicy: declared },
    }))
    expect(d.policy).toBe('manual')
    expect(d.triggers).toEqual(['human-intent'])
  })
})

describe('normalizeTrigger', () => {
  it('refuses an arbitrary payload string', () => {
    expect(normalizeTrigger('the build finished', 1)).toBeNull()
    expect(normalizeTrigger({ text: 'the build finished' }, 1)).toBeNull()
  })

  it('refuses a kind outside the vocabulary and a kind with no source', () => {
    expect(normalizeTrigger({ kind: 'moon-phase', sourceId: 'x' }, 1)).toBeNull()
    expect(normalizeTrigger({ kind: 'git-revision' }, 1)).toBeNull()
  })

  it('accepts a well-formed observation and stamps the host clock', () => {
    const e = normalizeTrigger({ kind: 'process-exit', sourceId: 'pid:42', evidence: '0', runId: 'run-a' }, 77)
    expect(e).toEqual({ kind: 'process-exit', sourceId: 'pid:42', evidence: '0', runId: 'run-a', at: 77 })
  })
})

describe('triggerDedupeKey', () => {
  it('repeated equivalent observations share one key', () => {
    expect(triggerDedupeKey(event())).toBe(triggerDedupeKey(event({ at: 9_999 })))
  })

  it('new evidence is a DIFFERENT key, not a later one', () => {
    expect(triggerDedupeKey(event({ evidence: 'def456' }))).not.toBe(triggerDedupeKey(event()))
  })
})

describe('matchTrigger', () => {
  it('a matching event records the reason, the evidence, and the host generation', () => {
    const [match] = matchTrigger(event(), [surface()])
    expect(match?.reason.kind).toBe('git-revision')
    expect(match?.reason.evidence).toBe('abc123')
    expect(match?.reason.detail).toMatch(/new revision/)
    // The dedupe key travels with the reason, so the durable record can refuse a
    // repeat without re-deriving it.
    expect(match?.reason.key).toBe(triggerDedupeKey(event()))
  })

  it('never matches a manual-policy Surface', () => {
    const s = surface({
      content: { headline: 'x', recipe: 'x', refreshPolicy: { policy: 'manual', triggers: ['git-revision'] } },
    })
    expect(matchTrigger(event(), [s])).toEqual([])
  })

  it('a worktree-scoped event does not reach another worktree', () => {
    const other = surface({ id: 'srf_2', source: { adapter: 'slate-file', locator: 'f#b', worktree: '/tmp/wt/beta', generation: 1 } })
    expect(matchTrigger(event(), [other])).toEqual([])
  })

  it('ignores deleted, recovery-homed, and compatibility-only records', () => {
    const gone = surface({ id: 'a', home: { kind: 'recovery', spaceId: SPACE } })
    const root = surface({ id: 'b', compatibilityOnly: true })
    expect(matchTrigger(event(), [gone, root])).toEqual([])
  })

  it('a source-content event never matches the Surface\'s OWN binding', () => {
    // Observing a Surface's own source is the content ARRIVING (observeSource marks
    // it current); treating it as stale would queue a refresh on every save.
    const s = surface({
      content: {
        headline: 'x', recipe: 'x',
        refreshPolicy: { policy: 'automatic', triggers: ['source-content'], sources: ['file:cov.json#cov'] },
      },
    })
    expect(matchTrigger(event({ kind: 'source-content', sourceId: 'file:cov.json#cov' }), [s])).toEqual([])
  })

  it('a source-content event matches a DECLARED upstream source', () => {
    const s = surface({
      content: {
        headline: 'x', recipe: 'x',
        refreshPolicy: { policy: 'automatic', triggers: ['source-content'], sources: ['file:budget.csv'] },
      },
    })
    expect(matchTrigger(event({ kind: 'source-content', sourceId: 'file:budget.csv' }), [s])).toHaveLength(1)
  })

  it('a semantic signal only matches a Surface that named it', () => {
    const listening = surface({
      id: 'a',
      content: {
        headline: 'x', recipe: 'x',
        refreshPolicy: { policy: 'automatic', triggers: ['semantic-signal'], signals: ['deploy-finished'] },
      },
    })
    const deaf = surface({
      id: 'b',
      content: {
        headline: 'x', recipe: 'x',
        refreshPolicy: { policy: 'automatic', triggers: ['semantic-signal'], signals: ['other'] },
      },
    })
    const e = event({ kind: 'semantic-signal', sourceId: 'agent:alpha', signal: 'deploy-finished', worktree: undefined })
    expect(matchTrigger(e, [listening, deaf]).map(m => m.surface.id)).toEqual(['a'])
  })
})

describe('declared source paths narrow a commit (U6 follow-up)', () => {
  // The measured failure this fixes: one session produced 57 refresh jobs, 45 of
  // them from commits, essentially all "no change" — because every commit to a
  // worktree made every Surface bound to it stale regardless of what it touched.
  function declaring(sources: string[] | undefined, id = 'srf_1'): Surface {
    return surface({
      id,
      content: {
        headline: 'Decision 6',
        recipe: 'Re-run the detector and rewrite the surface.',
        refreshPolicy: { policy: 'automatic', triggers: ['git-revision'], ...(sources ? { sources } : {}) },
      },
    })
  }

  const commit = (paths: string[]) => event({ paths })

  it('an UNDECLARED Surface still matches any commit — absence is not a declaration', () => {
    // Back-compat, and the reason this is the first assertion: every Surface
    // authored before declared sources existed carries no `sources` field, and
    // silently making those never-refreshing would break freshness across the
    // canvas rather than quieten it.
    expect(matchTrigger(commit(['README.md']), [declaring(undefined)])).toHaveLength(1)
  })

  it('an EMPTY declaration is commit-silent — the author checked and said "nothing here"', () => {
    expect(matchTrigger(commit(['README.md']), [declaring([])])).toEqual([])
    expect(matchTrigger(commit(['src/anything.ts']), [declaring([])])).toEqual([])
  })

  it('the mixed shape: repo code declared, data external — quiet on unrelated commits, awake on its own', () => {
    // The real Decision 6. Its number comes from production MySQL and Jira; its
    // LOGIC is a detector script in the repo. A path glob captures the code that
    // derives the answer, never the data the answer is derived from.
    const d6 = declaring([
      'scripts/integrity/detect-site-reassignment-leftovers.sh',
      'external:prod-mysql/ra-physical',
      'external:jira/CMT-510',
    ])
    expect(matchTrigger(commit(['src/server/index.ts', 'docs/readme.md']), [d6])).toEqual([])
    expect(matchTrigger(commit(['scripts/integrity/detect-site-reassignment-leftovers.sh']), [d6])).toHaveLength(1)
  })

  it('an all-external declaration can never be woken by a commit', () => {
    const s = declaring(['external:prod-mysql/ra-physical', 'jira:CMT-510'])
    expect(matchTrigger(commit(['scripts/anything.sh']), [s])).toEqual([])
  })

  it('a commit with UNKNOWN paths matches anyway — silence must never be inferred', () => {
    // No path list means the host could not work out the diff (first poll after a
    // restart, a garbage-collected SHA, a change set past the cap). A Surface whose
    // sources might be in that unknown set has to be allowed to go stale.
    expect(matchTrigger(event({ paths: undefined }), [declaring(['scripts/**'])])).toHaveLength(1)
  })

  it('matches a glob written for files that do not exist yet', () => {
    // The authoring case that motivated globs over literal lists: three files
    // written at different times, and the author should not have to re-edit the
    // recipe when a fourth lands.
    const s = declaring(['docs/decisions/SerenaSelfCostCeiling*.md'])
    expect(matchTrigger(commit(['docs/decisions/SerenaSelfCostCeilingIV.md']), [s])).toHaveLength(1)
    expect(matchTrigger(commit(['docs/decisions/other.md']), [s])).toEqual([])
  })
})

describe('pathMatchesGlob', () => {
  it('* stops at a separator and ** crosses one', () => {
    expect(pathMatchesGlob('src/*.ts', 'src/index.ts')).toBe(true)
    expect(pathMatchesGlob('src/*.ts', 'src/server/index.ts')).toBe(false)
    expect(pathMatchesGlob('src/**/*.ts', 'src/server/api/routes.ts')).toBe(true)
    expect(pathMatchesGlob('src/**', 'src/server/api/routes.ts')).toBe(true)
  })

  it('a wildcard-free glob is a PREFIX, because authors name directories', () => {
    expect(pathMatchesGlob('src/server', 'src/server/index.ts')).toBe(true)
    expect(pathMatchesGlob('src/server', 'src/server')).toBe(true)
    // and does not leak into a sibling whose name merely starts the same way
    expect(pathMatchesGlob('src/server', 'src/serverless/x.ts')).toBe(false)
  })

  it('? is exactly one non-separator character', () => {
    expect(pathMatchesGlob('bin/serena?', 'bin/serena1')).toBe(true)
    expect(pathMatchesGlob('bin/serena?', 'bin/serena')).toBe(false)
    expect(pathMatchesGlob('bin/?', 'bin/a/b')).toBe(false)
  })

  it('treats regex metacharacters in a glob as literals', () => {
    // An author writing a filename with a dot must not have it read as "any char".
    expect(pathMatchesGlob('docs/a.md', 'docs/aXmd')).toBe(false)
    expect(pathMatchesGlob('docs/a.md', 'docs/a.md')).toBe(true)
    expect(pathMatchesGlob('docs/a+b.md', 'docs/a+b.md')).toBe(true)
  })

  it('normalizes a leading ./ and a trailing slash on either side', () => {
    expect(pathMatchesGlob('./src/server/', 'src/server/index.ts')).toBe(true)
    expect(pathMatchesGlob('src/server', './src/server/index.ts')).toBe(true)
  })
})

describe('isExternalSourceId', () => {
  it('a scheme prefix marks a source no commit can touch', () => {
    expect(isExternalSourceId('external:prod-mysql/ra-physical')).toBe(true)
    expect(isExternalSourceId('mysql://prod/detector')).toBe(true)
    expect(isExternalSourceId('jira:CMT-510')).toBe(true)
    expect(isExternalSourceId('file:cov.json#cov')).toBe(true)
  })

  it('a repo path is not external', () => {
    expect(isExternalSourceId('src/server/**')).toBe(false)
    expect(isExternalSourceId('docs/plans/2026-07-24-001-*.md')).toBe(false)
    expect(isExternalSourceId('bin/serena')).toBe(false)
  })
})

describe('coalesceGeneration', () => {
  it('takes the max of host generations', () => {
    expect(coalesceGeneration(3, 7)).toBe(7)
    expect(coalesceGeneration(undefined, 2)).toBe(2)
    expect(coalesceGeneration(undefined, undefined)).toBe(0)
  })
})

describe('deriveDueAt', () => {
  it('derives from the last SUCCESSFUL verification, not from attempts', () => {
    const s = surface({ freshness: { phase: 'failed', overdue: false, verifiedAt: 5_000 } })
    const decl = effectiveDeclaration(s)
    expect(deriveDueAt(s, decl, 10 * 60_000)).toBe(5_000 + 10 * 60_000)
  })

  it('is absent for a Surface with no periodic trigger', () => {
    const s = surface({
      content: { headline: 'x', recipe: 'x', refreshPolicy: { policy: 'automatic', triggers: ['git-revision'] } },
    })
    expect(deriveDueAt(s, effectiveDeclaration(s), 1_000)).toBeUndefined()
  })

  it('a MANUAL Surface still gets a deadline — policy decides who acts, not what is true', () => {
    // The plan requires overdue to be exposed for all three policies. A manual
    // Surface is one nothing may refresh unasked; it is not one nobody may notice
    // has gone unverified.
    const s = surface({
      content: { headline: 'x', recipe: 'x', refreshPolicy: { policy: 'manual', triggers: ['periodic'] } },
    })
    expect(deriveDueAt(s, effectiveDeclaration(s), 10 * 60_000)).toBe(1_000 + 10 * 60_000)
  })

  it('an explicit interval asks for a deadline even with no periodic trigger', () => {
    const s = surface({
      content: {
        headline: 'x', recipe: 'x',
        refreshPolicy: { policy: 'mark-stale', triggers: ['git-revision'], intervalMs: 20 * 60_000 },
      },
    })
    expect(deriveDueAt(s, effectiveDeclaration(s), 1_000)).toBe(1_000 + 20 * 60_000)
  })
})
