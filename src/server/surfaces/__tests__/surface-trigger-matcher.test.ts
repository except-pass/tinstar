// The closed trigger vocabulary and what it makes stale (plan U6, R14/R15).
import { describe, it, expect } from 'vitest'
import type { Surface, SurfaceClaim, SurfaceRefreshDeclaration } from '../../../domain/types'
import {
  claimLocusAdmits,
  claimsObserveTriggerKind,
  claimTriggerKinds,
  CLAIM_LOCUS_TRIGGER_KINDS,
  coalesceGeneration,
  deriveDueAt,
  effectiveDeclaration,
  isExternalSourceId,
  matchTrigger,
  MIN_INTERVAL_MS,
  normalizeTrigger,
  parseProposal,
  parseRefreshDeclaration,
  parseSurfaceClaims,
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
    // Round-trip fidelity of the authored file, not a behaviour switch: nothing in
    // trigger matching branches on `[]` vs absent today. The parser records what the
    // author wrote — `"sources": []` is the statement "I checked, nothing derives
    // this" — rather than silently rewriting it into an omission.
    expect(parseRefreshDeclaration({ sources: [] })?.sources).toEqual([])
    expect(parseRefreshDeclaration({ triggers: ['periodic'] })?.sources).toBeUndefined()
  })

  it('drops non-string source entries without collapsing the declaration', () => {
    expect(parseRefreshDeclaration({ sources: [{ exec: 'ls' }, 42] })?.sources).toEqual([])
  })
})

// The parser's refusal channel (plan U1/U6, R1/R3). U2 shipped `validateClaim`
// unwired on purpose — a claim dropped with nowhere to report it would delete a
// mistyped witness kind out of the author's file on the next write-back, in silence
// — so the registry gate and the refusals it produces arrive in the same unit.
describe('parseSurfaceClaims and what it will not accept', () => {
  const good = { id: 'u1', witness: 'unit-landed', params: { plan: 'docs/plans/x.md', unit: 'U1' }, locus: 'repo' }

  it('says nothing about an absent declaration and nothing about a clean one', () => {
    expect(parseSurfaceClaims(undefined)).toEqual({ refusals: [] })
    expect(parseSurfaceClaims(null)).toEqual({ refusals: [] })
    // `[]` is the author having checked and found nothing witnessable — a VALUE, and
    // not a refusal of anything.
    expect(parseSurfaceClaims([])).toEqual({ claims: [], refusals: [] })
    expect(parseSurfaceClaims([good])).toEqual({ claims: [good], refusals: [] })
  })

  it('refuses a witness kind this host does not implement, and NAMES it', () => {
    const out = parseSurfaceClaims([{ ...good, witness: 'unit-lands' }])
    // The surface keeps projecting with the claim gone (KTD5) — the list is empty,
    // not absent, and the record is never withheld.
    expect(out.claims).toEqual([])
    expect(out.refusals).toHaveLength(1)
    expect(out.refusals[0]).toMatch(/unit-lands/)
    expect(out.refusals[0]).toMatch(/no such witness kind — this host implements unit-landed, http-status/)
  })

  it('refuses parameters that do not fit the kind they name', () => {
    const noPlan = parseSurfaceClaims([{ id: 'u1', witness: 'unit-landed', locus: 'repo', params: { unit: 'U1' } }])
    expect(noPlan.claims).toEqual([])
    expect(noPlan.refusals[0]).toMatch(/params\.plan must be a `docs\/plans\/<file>\.md` path/)

    // A kind observing the wrong locus is the same class of mistake: the claim is
    // well-formed and still cannot be checked by the kind it names.
    const wrongLocus = parseSurfaceClaims([{ ...good, locus: 'infra' }])
    expect(wrongLocus.claims).toEqual([])
    expect(wrongLocus.refusals[0]).toMatch(/this kind observes repo, not infra/)

    // And a hostile URL scheme, which is the check that keeps `http-status` off the
    // local filesystem.
    const badUrl = parseSurfaceClaims([{ id: 'up', witness: 'http-status', locus: 'infra', params: { url: 'file:///etc/passwd' } }])
    expect(badUrl.claims).toEqual([])
    expect(badUrl.refusals[0]).toMatch(/must be http or https/)
  })

  it('refuses one claim and keeps its siblings — the drop costs the claim, not the list', () => {
    const infra = { id: 'up', witness: 'http-status', params: { url: 'https://example.test/' }, locus: 'infra' }
    const out = parseSurfaceClaims([good, { ...good, id: 'u2', witness: 'nope' }, infra])
    expect(out.claims).toEqual([good, infra])
    expect(out.refusals).toHaveLength(1)
  })

  it('reports the drops that used to be silent: a duplicate id, a whole oversized list, a non-array', () => {
    const dup = parseSurfaceClaims([good, { ...good, params: { plan: 'docs/plans/y.md', unit: 'U2' } }])
    expect(dup.claims).toEqual([good])
    expect(dup.refusals[0]).toMatch(/declared more than once/)

    const many = Array.from({ length: 33 }, (_, i) => ({ ...good, id: `c${i}` }))
    const over = parseSurfaceClaims(many)
    // Refused WHOLE, never truncated — and now it says so.
    expect(over.claims).toBeUndefined()
    expect(over.refusals[0]).toMatch(/more than 32 claims/)

    const wrongShape = parseSurfaceClaims('claims go here')
    expect(wrongShape.claims).toBeUndefined()
    expect(wrongShape.refusals[0]).toMatch(/must be an array/)
  })

  it('does not rewrite a claim the registry normalizes at run time', () => {
    // `unit-landed`'s schema fills in a default ref and splits it into remote and
    // branch. That normalization is for the RUNNER; letting it leak back into the
    // parsed claim would rewrite the author's file with parameters they never wrote.
    const out = parseSurfaceClaims([good])
    expect(out.claims![0]).toEqual(good)
    expect(out.claims![0]!.params).not.toHaveProperty('ref')
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

  it('a source-content event whose sourceId is PATH-SHAPED is matched by glob, not only by equality', () => {
    // One declared list, two shapes: an `external:`-style id is compared for
    // equality, and an adapter that emits a repo-relative path as its `sourceId`
    // gets glob matching for free — so an author can write `scripts/**` instead of
    // enumerating every file such an adapter might name.
    const s = surface({
      content: {
        headline: 'x', recipe: 'x',
        refreshPolicy: { policy: 'automatic', triggers: ['source-content'], sources: ['scripts/integrity/**'] },
      },
    })
    const hit = event({ kind: 'source-content', sourceId: 'scripts/integrity/detect-leftovers.sh' })
    const miss = event({ kind: 'source-content', sourceId: 'scripts/other/thing.sh' })
    expect(matchTrigger(hit, [s])).toHaveLength(1)
    expect(matchTrigger(miss, [s])).toEqual([])
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

describe('declared sources do NOT narrow a commit', () => {
  // A DECISION, pinned so the next reader sees it rather than inferring it from an
  // absence. A branch of this file once compared a commit's changed paths against
  // the author's `sources` globs and dropped the event when nothing matched. That
  // came out: narrowing which triggers may reach a claim is claim-locus work — one
  // mechanism, declared per claim — and two narrowing mechanisms for one decision
  // leave an implementer no rule for which wins.
  //
  // So `sources` is a `source-content` matching list and nothing more. Declaring it
  // must not change what a `git-revision` event does, in either direction.
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

  it('a Surface declaring repo globs matches a commit like any other', () => {
    // The case the removed narrowing would have dropped: declared globs that the
    // commit did not touch. The host's declared trigger is the whole gate.
    const s = declaring(['scripts/integrity/detect-site-reassignment-leftovers.sh'])
    expect(matchTrigger(event(), [s])).toHaveLength(1)
  })

  it('an EMPTY sources declaration does not make a Surface commit-silent', () => {
    expect(matchTrigger(event(), [declaring([])])).toHaveLength(1)
  })

  it('an all-external declaration is still woken by a commit', () => {
    expect(matchTrigger(event(), [declaring(['external:prod-mysql/ra-physical', 'jira:CMT-510'])])).toHaveLength(1)
  })

  it('declaring sources changes nothing a commit does — same result as declaring none', () => {
    const undeclared = matchTrigger(event(), [declaring(undefined, 'a')])
    const declared = matchTrigger(event(), [declaring(['src/api/**', 'jira:CMT-510'], 'b')])
    expect(declared.map(m => m.reason)).toEqual(undeclared.map(m => m.reason))
  })
})

// `pathMatchesGlob` and `isExternalSourceId` are the two halves of `source-content`
// matching — one declared list carrying external ids (equality) and repo path shapes
// (glob). They are NOT reachable from a `git-revision` event; see above.
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
  it('a scheme prefix marks an opaque id, matched by equality rather than as a glob', () => {
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

describe('parseProposal (the author\'s claim)', () => {
  it('accepts the four states and nothing else', () => {
    for (const state of ['working', 'blocked', 'resolved', 'superseded']) {
      expect(parseProposal({ state }, 7)?.state).toBe(state)
    }
    expect(parseProposal({ state: 'shipped' }, 7)).toBeUndefined()
    expect(parseProposal({ state: 'dismissed' }, 7)).toBeUndefined()
  })

  it('drops a proposal that is not an object, rather than failing the entry', () => {
    expect(parseProposal('done', 7)).toBeUndefined()
    expect(parseProposal(['resolved'], 7)).toBeUndefined()
    expect(parseProposal(null, 7)).toBeUndefined()
    expect(parseProposal({}, 7)).toBeUndefined()
  })

  it('HOST-STAMPS the time and ignores any the author supplied', () => {
    // A card renders an elapsed time from this ("working, 4h"). A value the author
    // controls is one they could use — accidentally or not — to make a stale claim
    // look fresh. The claim's age is the host's observation.
    expect(parseProposal({ state: 'working', at: 1 }, 999)?.at).toBe(999)
  })

  it('collapses the detail to ONE line and bounds it', () => {
    // It renders on a card row. A paragraph there stops the Slate being glanceable,
    // and a newline could otherwise fake a second field.
    const p = parseProposal({ state: 'working', detail: 'not started,\n  half a day' }, 7)
    expect(p?.detail).toBe('not started, half a day')
    expect(parseProposal({ state: 'working', detail: 'x'.repeat(500) }, 7)?.detail).toHaveLength(200)
    expect(parseProposal({ state: 'working', detail: '   ' }, 7)?.detail).toBeUndefined()
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

// ---------------------------------------------------------------------------
// The claim-locus narrowing (plan U5, R5).
//
// The whole point is a NEGATIVE — a commit reaching nothing — so every test that
// asserts an absence is paired with the positive that makes the absence mean
// something: the same event reaching a repo-locus card, or the same card being
// reached by `periodic`. Without the pair, a matcher that matched nothing at all
// would pass.
// ---------------------------------------------------------------------------

describe('a trigger reaches only the claims that observe its locus', () => {
  const REPO: SurfaceClaim = { id: 'u5', witness: 'unit-landed', locus: 'repo' }
  const INFRA: SurfaceClaim = { id: 'up', witness: 'http-status', locus: 'infra' }

  /** A Surface carrying a recipe — so it earns the host's default `git-revision`
   *  trigger — and whatever claims the test hands it. */
  const claiming = (claims: SurfaceClaim[] | undefined, id = 'srf_1') => surface({
    id,
    content: { headline: 'Roadmap', recipe: 'Re-derive the roadmap.', ...(claims ? { claims } : {}) },
  })

  const commit = event()
  const tick = event({ kind: 'periodic', sourceId: 'clock' })

  it('a commit produces NO match on an infra-only Surface, recipe and all', () => {
    // The card asserts an HTTP status. A commit on the worktree cannot contradict
    // that, so it must not mark it and must not queue a rebuild — and the recipe is
    // the hard half: it is what gives the Surface the host's default `git-revision`
    // trigger in the first place, which is how a commit reached it on `main`.
    const s = claiming([INFRA])
    expect(effectiveDeclaration(s).triggers).toContain('git-revision')
    expect(matchTrigger(commit, [s])).toEqual([])
  })

  it('the same commit DOES match a repo-locus Surface', () => {
    expect(matchTrigger(commit, [claiming([REPO])])).toHaveLength(1)
  })

  it('a Surface claiming at both loci is reached by triggers at either', () => {
    const both = claiming([REPO, INFRA])
    expect(matchTrigger(commit, [both])).toHaveLength(1)
    expect(matchTrigger(tick, [both])).toHaveLength(1)
  })

  it('narrows nothing for absent claims, and nothing for `[]`', () => {
    // U1's tri-state, load-bearing here. `[]` is an author who checked and found
    // nothing witnessable — not an author asking to be left alone. Narrowing on it
    // would let writing down "nothing to witness" silence the card.
    expect(matchTrigger(commit, [claiming(undefined)])).toHaveLength(1)
    expect(matchTrigger(commit, [claiming([])])).toHaveLength(1)
  })

  it('a periodic tick still reaches an infra-only Surface', () => {
    // It has to. `infra` is announced by nothing but elapsed time, so if the tick
    // were narrowed away too, an infra card would never be revalidated at all and
    // the deadline R14 earned it could never be answered.
    expect(matchTrigger(tick, [claiming([INFRA])])).toHaveLength(1)
  })

  it('narrows only the kinds that ANNOUNCE a locus', () => {
    // A `source-content` event naming an upstream file the author declared by name
    // is not a locus announcement, and a claim says nothing about it. Silencing it
    // would mean adding a claim to a card quietly deafened it to the file it was
    // built to follow — the same asymmetry `effectiveDeclaration` refuses when it
    // unions claim-earned kinds on rather than replacing the author's.
    const s = surface({
      content: {
        headline: 'Budget', recipe: 'x',
        refreshPolicy: { policy: 'automatic', triggers: ['source-content'], sources: ['file:budget.csv'] },
        claims: [INFRA],
      },
    })
    expect(matchTrigger(event({ kind: 'source-content', sourceId: 'file:budget.csv' }), [s])).toHaveLength(1)
  })

  it('exposes the predicate on its own, for the coordinator to read', () => {
    expect(claimLocusAdmits(claiming([INFRA]), 'git-revision')).toBe(false)
    expect(claimLocusAdmits(claiming([INFRA]), 'periodic')).toBe(true)
    expect(claimLocusAdmits(claiming([REPO]), 'git-revision')).toBe(true)
    expect(claimLocusAdmits(claiming(undefined), 'git-revision')).toBe(true)
    expect(claimLocusAdmits(claiming([]), 'git-revision')).toBe(true)
  })
})
