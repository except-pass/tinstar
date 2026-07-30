// The closed trigger vocabulary and what it makes stale (plan U6, R14/R15).
import { describe, it, expect } from 'vitest'
import type { Surface, SurfaceRefreshDeclaration } from '../../../domain/types'
import {
  claimsObserveTriggerKind,
  claimTriggerKinds,
  CLAIM_LOCUS_TRIGGER_KINDS,
  coalesceGeneration,
  deriveDueAt,
  effectiveDeclaration,
  matchTrigger,
  MIN_INTERVAL_MS,
  normalizeTrigger,
  parseRefreshDeclaration,
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

  it('UNIONS the kinds a Surface\'s claims earn onto whatever the author asked for', () => {
    // R14, and unioned rather than defaulted for a reason: an author who names
    // `git-revision` beside an infra-locus claim has said which announcement they
    // care about, not "and never check that claim". Without the union such a Surface
    // earns no deadline and its claim is never revalidated at all.
    const d = effectiveDeclaration(surface({
      content: {
        headline: 'Roadmap', recipe: 'x',
        refreshPolicy: { policy: 'automatic', triggers: ['git-revision'] },
        claims: [{ id: 'up', witness: 'http-status', locus: 'infra' }],
      },
    }))
    expect(d.triggers).toEqual(['git-revision', 'periodic'])
  })

  it('gives a recipe-LESS claim-bearing Surface the kinds its loci imply', () => {
    const d = effectiveDeclaration(surface({
      content: { headline: 'Roadmap', claims: [{ id: 'u4', witness: 'unit-landed', locus: 'repo' }] },
    }))
    // Still `mark-stale` — no recipe means no rebuild anything could run — but no
    // longer unfalsifiable.
    expect(d.policy).toBe('mark-stale')
    expect(d.triggers).toEqual(['git-revision', 'periodic'])
  })

  it('adds nothing for a Surface that declares no claims', () => {
    expect(claimTriggerKinds(undefined)).toEqual([])
    expect(claimTriggerKinds([])).toEqual([])
    expect(effectiveDeclaration(surface()).triggers).toEqual(['git-revision', 'periodic'])
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

  it('DECLARING CLAIMS earns a deadline, whatever the declaration says (R14)', () => {
    // Deliberately handed a declaration with no `periodic` and no interval — the
    // shape `effectiveDeclaration` no longer produces for a claim-bearing Surface,
    // and exactly the shape a caller holding a raw author declaration does. Returning
    // undefined here is how a card that says out loud what would prove it wrong goes
    // back to being un-doubtable.
    const s = surface({
      content: { headline: 'Roadmap', claims: [{ id: 'u4', witness: 'unit-landed', locus: 'repo' }] },
      freshness: { phase: 'current', overdue: false, verifiedAt: 5_000, witnessedAt: 8_000 },
    })
    const bare: SurfaceRefreshDeclaration = { policy: 'mark-stale', triggers: ['git-revision'] }
    expect(deriveDueAt(s, bare, 10 * 60_000)).toBe(8_000 + 10 * 60_000)
  })

  it('counts a claim-bearing Surface from witnessedAt, never from verifiedAt (KTD7)', () => {
    const base = {
      headline: 'Roadmap', recipe: 'x',
      claims: [{ id: 'u4', witness: 'unit-landed', locus: 'repo' as const }],
    }
    const saved = surface({
      content: base,
      // What a file save leaves behind: `observeSource` writes `verifiedAt` on every
      // save whose watermark moved, and `witnessedAt` never. Counting from the former
      // would let an author push the host's claim-check deadline out indefinitely just
      // by editing the card — the more attention it gets, the less it is checked.
      freshness: { phase: 'current', overdue: false, verifiedAt: 900_000, witnessedAt: 8_000 },
    })
    expect(deriveDueAt(saved, effectiveDeclaration(saved), 10 * 60_000)).toBe(8_000 + 10 * 60_000)

    const never = surface({
      content: base,
      freshness: { phase: 'current', overdue: false, verifiedAt: 900_000 },
    })
    // Never witnessed falls back to creation, so a card nobody has ever checked is
    // due rather than parked behind whenever its file last moved.
    expect(deriveDueAt(never, effectiveDeclaration(never), 10 * 60_000)).toBe(100 + 10 * 60_000)
  })
})

describe('claim loci and the trigger kinds they observe (plan U3/U5, R5)', () => {
  const repo = { id: 'u3', witness: 'unit-landed', locus: 'repo' as const }
  const infra = { id: 'up', witness: 'http-status', locus: 'infra' as const }

  it('gives every locus `periodic`, because elapsed time invalidates any observation', () => {
    // R14 says declaring claims earns a verification deadline REGARDLESS of which
    // trigger kinds the loci imply. Leaving `periodic` off `infra` would leave an
    // infra-only Surface with no trigger at all, and no way for a passing
    // revalidation to answer the deadline that produced it.
    for (const kinds of Object.values(CLAIM_LOCUS_TRIGGER_KINDS)) {
      expect(kinds).toContain('periodic')
    }
  })

  it('reaches a repo claim from a commit and an infra claim from nothing but time', () => {
    expect(claimsObserveTriggerKind([repo], 'git-revision')).toBe(true)
    expect(claimsObserveTriggerKind([infra], 'git-revision')).toBe(false)
    expect(claimsObserveTriggerKind([repo, infra], 'git-revision')).toBe(true)
    expect(claimsObserveTriggerKind([repo, infra], 'periodic')).toBe(true)
  })

  it('observes nothing a claim witness cannot speak to', () => {
    // The narrowing that keeps a witness pass from clearing a stale reason it did
    // not answer: a human pressing the button, or an agent publishing a signal, is
    // not something a `git fetch` or an HTTP status can settle.
    for (const kind of ['human-intent', 'semantic-signal', 'process-exit', 'session-lifecycle', 'source-content'] as const) {
      expect(claimsObserveTriggerKind([repo, infra], kind)).toBe(false)
    }
  })

  it('observes nothing at all for a Surface that declares no claims', () => {
    // Both empty states, and absent. A Surface that claims nothing narrows nothing
    // inbound and may clear nothing outbound.
    expect(claimsObserveTriggerKind(undefined, 'periodic')).toBe(false)
    expect(claimsObserveTriggerKind([], 'periodic')).toBe(false)
  })
})
