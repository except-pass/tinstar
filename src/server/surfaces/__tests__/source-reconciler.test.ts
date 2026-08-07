// @vitest-environment node
//
// U2's reconciliation invariants: what one epoch of a run's watched directory does
// to the canonical store. Runs the REAL service against a real in-memory
// DocumentStore with nothing mocked between them — the seam under test is exactly
// the one the watcher drives in production, minus the filesystem.
import { describe, it, expect } from 'vitest'
import { DocumentStore } from '../../stores/document-store'
import { deriveLegacySurfaceId, deriveRunIncarnation } from '../../stores/surfaces'
import { deriveLegacyRunRootId, LEGACY_SLATE_ADAPTER, legacyPointLocator } from '../../stores/surface-migration'
import { SurfaceService, type SurfaceCallContext } from '../surface-service'
import { reconcileSlateEpoch, type SlateSourceEpoch } from '../source-reconciler'
import { slateEntryWatermark, slateFileLocator, SLATE_FILE_ADAPTER, type SlateSourceEntry } from '../slate-source'
import type { Surface, SurfacePrincipalRef } from '../../../domain/types'

const SPACE = 'spc-a'
const RUN = 'run-a'
const WORKTREE = '/tmp/wt-a'
const HOST: SurfacePrincipalRef = { kind: 'job', id: 'slate-watcher' }
const INCARNATION = deriveRunIncarnation(RUN, '2026-07-01T00:00:00.000Z')!
const ROOT = deriveLegacyRunRootId(INCARNATION)

function ctx(at = 1_000): SurfaceCallContext {
  return { actor: HOST, at }
}

function entry(localId: string, headline: string, over: Partial<SlateSourceEntry> = {}): SlateSourceEntry {
  const file = over.file ?? 'a.json'
  return {
    localId,
    file,
    content: { headline },
    author: 'agent',
    watermark: slateEntryWatermark({ headline, author: 'agent' }),
    ...over,
  }
}

function epoch(entries: SlateSourceEntry[], over: Partial<SlateSourceEpoch> = {}): SlateSourceEpoch {
  return {
    runId: RUN,
    spaceId: SPACE,
    incarnation: INCARNATION,
    rootSurfaceId: ROOT,
    worktree: WORKTREE,
    at: 1_000,
    entries,
    unreadable: [],
    ...over,
  }
}

function harness() {
  const docStore = new DocumentStore()
  const svc = new SurfaceService(docStore)
  return {
    docStore,
    svc,
    // The epoch carries the clock (it is when the directory was READ), so the
    // override has to land on both halves or the assertions read the default.
    run: (e: SlateSourceEpoch, at = e.at) => reconcileSlateEpoch(svc, { ...e, at }, ctx(at)),
    surface: (localId: string): Surface | undefined =>
      docStore.getSurface(deriveLegacySurfaceId(INCARNATION, localId)),
  }
}

describe('the happy path', () => {
  it('fills a reserved compose card only when the current attempt token matches', async () => {
    const h = harness()
    await h.svc.ensureRunRoot({ id: ROOT, spaceId: SPACE, runId: RUN, createdAt: 1_000 }, ctx())
    const localId = 'compose-open-points'
    const id = deriveLegacySurfaceId(INCARNATION, localId)
    const reserved = await h.svc.reserveComposition({
      id, spaceId: SPACE, home: { kind: 'surface', surfaceId: ROOT }, runId: RUN, localId,
      label: 'Open points', request: { templateId: 'open-points' }, token: 'current-token', deadlineAt: 31_000,
      source: {
        adapter: SLATE_FILE_ADAPTER, locator: slateFileLocator(`${localId}.json`, localId),
        worktree: WORKTREE, generation: 0, state: 'missing',
      },
    }, ctx())
    expect(reserved.ok).toBe(true)

    const stale = await h.run(epoch([entry(localId, 'wrong result', { attemptToken: 'old-token' })]))
    expect(stale.refusals).toEqual([{ localId, reason: 'superseded' }])
    expect(h.surface(localId)!.creation!.phase).toBe('authoring')

    const accepted = await h.run(epoch([entry(localId, 'No open points', {
      file: `${localId}.json`, attemptToken: 'current-token',
    })]), 2_000)
    expect(accepted).toMatchObject({ observed: 1, created: 0, updated: 1 })
    expect(h.surface(localId)).toMatchObject({
      id, author: 'agent', content: { headline: 'No open points' }, presentation: 'compose-card',
      creation: { phase: 'ready', token: 'current-token' },
      source: { state: 'present', generation: 1 },
    })

    const refreshed = await h.run(epoch([entry(localId, 'One open point', {
      file: `${localId}.json`, attemptToken: 'current-token',
    })]), 3_000)
    expect(refreshed).toMatchObject({ observed: 1, created: 0, updated: 1 })
    expect(h.surface(localId)).toMatchObject({
      content: { headline: 'One open point' },
      creation: { phase: 'ready', token: 'current-token' },
      source: { generation: 2 },
    })

    const late = await h.run(epoch([entry(localId, 'old attempt came back', {
      file: `${localId}.json`, attemptToken: 'old-token',
    })]), 4_000)
    expect(late.refusals).toEqual([{ localId, reason: 'superseded' }])
    expect(h.surface(localId)!.content.headline).toBe('One open point')
  })

  it('refuses a reserved result that omits its attempt token without affecting direct file entries', async () => {
    const h = harness()
    await h.svc.ensureRunRoot({ id: ROOT, spaceId: SPACE, runId: RUN, createdAt: 1_000 }, ctx())
    const localId = 'compose-card'
    await h.svc.reserveComposition({
      id: deriveLegacySurfaceId(INCARNATION, localId), spaceId: SPACE,
      home: { kind: 'surface', surfaceId: ROOT }, runId: RUN, localId,
      label: 'Card', request: { freeform: 'Make a card' }, token: 'token-1', deadlineAt: 31_000,
      source: { adapter: SLATE_FILE_ADAPTER, locator: slateFileLocator('compose-card.json', localId), generation: 0, state: 'missing' },
    }, ctx())
    const out = await h.run(epoch([entry(localId, 'missing token'), entry('direct', 'ordinary file surface')]))
    expect(out.refusals).toContainEqual({ localId, reason: 'missing-attempt-token' })
    expect(h.surface(localId)!.creation).toMatchObject({
      phase: 'failed', failure: { code: 'invalid-content' },
    })
    expect(h.surface('direct')!.content.headline).toBe('ordinary file surface')
  })

  it('creates a run root and one bound Surface per entry, homed on the root', async () => {
    const h = harness()
    const out = await h.run(epoch([entry('blockers', 'Two blockers'), entry('plan', 'The plan')]))

    expect(out).toMatchObject({ observed: 2, created: 2, updated: 0, missing: 0 })
    const root = h.docStore.getSurface(ROOT)!
    expect(root.compatibilityOnly).toBe(true)
    expect(root.home).toEqual({ kind: 'canvas', spaceId: SPACE })

    const blockers = h.surface('blockers')!
    expect(blockers.content.headline).toBe('Two blockers')
    expect(blockers.home).toEqual({ kind: 'surface', surfaceId: ROOT })
    expect(blockers.contentAuthority).toBe('source-binding')
    expect(blockers.source).toMatchObject({
      adapter: SLATE_FILE_ADAPTER,
      locator: slateFileLocator('a.json', 'blockers'),
      worktree: WORKTREE,
      generation: 1,
      state: 'present',
    })
    expect(blockers.aliases).toEqual([{ bucket: { kind: 'run', runId: RUN }, localId: 'blockers', visible: true }])
    expect(blockers.freshness).toMatchObject({ phase: 'current', observedGeneration: 1 })
  })

  it('is a no-op on re-observation of unchanged content — no revision burned', async () => {
    const h = harness()
    await h.run(epoch([entry('blockers', 'Two blockers')]))
    const first = h.surface('blockers')!
    const out = await h.run(epoch([entry('blockers', 'Two blockers')]), 2_000)

    expect(out).toMatchObject({ observed: 1, created: 0, updated: 0 })
    expect(h.surface('blockers')!.rev).toBe(first.rev)
    expect(h.surface('blockers')!.source!.generation).toBe(1)
  })

  it('advances the observation generation only when the watermark moves', async () => {
    const h = harness()
    await h.run(epoch([entry('blockers', 'Two blockers')]))
    await h.run(epoch([entry('blockers', 'One blocker')]), 2_000)

    const after = h.surface('blockers')!
    expect(after.content.headline).toBe('One blocker')
    expect(after.source!.generation).toBe(2)
    expect(after.freshness.observedGeneration).toBe(2)
    expect(after.freshness.verifiedAt).toBe(2_000)
  })

  it('preserves thread, identity, and home across a content update', async () => {
    const h = harness()
    await h.run(epoch([entry('blockers', 'Two blockers')]))
    const id = h.surface('blockers')!.id
    await h.svc.appendThread(id, { text: 'which two?' }, ctx(1_500))
    await h.run(epoch([entry('blockers', 'One blocker')]), 2_000)

    const after = h.surface('blockers')!
    expect(after.id).toBe(id)
    expect(after.thread.replies).toHaveLength(1)
    expect(after.thread.replies[0]!.text).toBe('which two?')
    expect(after.home).toEqual({ kind: 'surface', surfaceId: ROOT })
  })
})

describe('rename and identity', () => {
  it('rebinds the same Surface when an entry moves file, in either event order', async () => {
    // Both orderings collapse to the same epoch, which is the property: the watcher
    // debounces create and remove into one directory read, so there is no ordering
    // left to get wrong.
    for (const [first, second] of [['a.json', 'b.json'], ['b.json', 'a.json']] as const) {
      const h = harness()
      await h.run(epoch([entry('blockers', 'Two blockers', { file: first })]))
      const before = h.surface('blockers')!
      await h.svc.appendThread(before.id, { text: 'noted' }, ctx(1_500))
      await h.run(epoch([entry('blockers', 'Two blockers', { file: second })]), 2_000)

      const after = h.surface('blockers')!
      expect(after.id).toBe(before.id)
      expect(after.thread.replies).toHaveLength(1)
      expect(after.source!.locator).toBe(slateFileLocator(second, 'blockers'))
      // A rename observed no new content, so the generation must not move — the
      // surface is exactly as current as it was a moment ago.
      expect(after.source!.generation).toBe(1)
    }
  })

  it('rejects a duplicate local id observably and keeps the first occurrence', async () => {
    const h = harness()
    const out = await h.run(epoch([
      entry('blockers', 'from a.json', { file: 'a.json' }),
      entry('blockers', 'from b.json', { file: 'b.json' }),
    ]))

    expect(out.duplicates).toEqual(['blockers'])
    expect(out.observed).toBe(1)
    expect(h.surface('blockers')!.content.headline).toBe('from a.json')
  })
})

describe('omission', () => {
  it('marks only the omitted binding missing and retains its content', async () => {
    const h = harness()
    await h.run(epoch([entry('blockers', 'Two blockers'), entry('plan', 'The plan')]))
    const out = await h.run(epoch([entry('plan', 'The plan')]), 2_000)

    expect(out.missing).toBe(1)
    const gone = h.surface('blockers')!
    expect(gone.content.headline).toBe('Two blockers')
    expect(gone.source).toMatchObject({ state: 'missing', missingSince: 2_000 })
    expect(gone.freshness.phase).toBe('possibly-stale')
    // The surviving binding is untouched — one file's omission cannot reach another.
    expect(h.surface('plan')!.source!.state).toBe('present')
    expect(h.surface('plan')!.source!.missingSince).toBeUndefined()
  })

  it('distinguishes a vanished source from one that never existed', async () => {
    const h = harness()
    await h.run(epoch([entry('blockers', 'Two blockers')]))
    await h.run(epoch([]), 2_000)

    // Vanished: state says so, and says when.
    expect(h.surface('blockers')!.source).toMatchObject({ state: 'missing', missingSince: 2_000 })
    // Never observed: the run root has no binding at all, so there is nothing to
    // report missing about it.
    expect(h.docStore.getSurface(ROOT)!.source).toBeUndefined()
  })

  it('marking missing is idempotent — a second empty epoch writes nothing', async () => {
    const h = harness()
    await h.run(epoch([entry('blockers', 'x')]))
    await h.run(epoch([]), 2_000)
    const marked = h.surface('blockers')!
    const out = await h.run(epoch([]), 3_000)

    expect(out.missing).toBe(0)
    expect(h.surface('blockers')!.rev).toBe(marked.rev)
    expect(h.surface('blockers')!.source!.missingSince).toBe(2_000)
  })

  it('does not mark a binding missing when its file was unreadable this epoch', async () => {
    const h = harness()
    await h.run(epoch([entry('blockers', 'Two blockers', { file: 'a.json' })]))
    const before = h.surface('blockers')!
    const out = await h.run(epoch([], { unreadable: ['a.json'] }), 2_000)

    expect(out.missing).toBe(0)
    expect(h.surface('blockers')!.rev).toBe(before.rev)
    expect(h.surface('blockers')!.source!.state).toBe('present')
  })

  it('restores a missing binding to present when the source comes back', async () => {
    const h = harness()
    await h.run(epoch([entry('blockers', 'Two blockers')]))
    await h.run(epoch([]), 2_000)
    await h.run(epoch([entry('blockers', 'Two blockers')]), 3_000)

    const back = h.surface('blockers')!
    expect(back.source).toMatchObject({ state: 'present' })
    expect(back.source!.missingSince).toBeUndefined()
  })

  it('mixed valid and invalid entries update the valid ones and leave the rest alone', async () => {
    const h = harness()
    await h.run(epoch([
      entry('blockers', 'Two blockers', { file: 'a.json' }),
      entry('plan', 'The plan', { file: 'b.json' }),
    ]))
    // `b.json` is torn this epoch; `a.json` read fine and its entry changed.
    const out = await h.run(epoch(
      [entry('blockers', 'One blocker', { file: 'a.json' })],
      { unreadable: ['b.json'] },
    ), 2_000)

    expect(out).toMatchObject({ observed: 1, updated: 1, missing: 0 })
    expect(h.surface('blockers')!.content.headline).toBe('One blocker')
    expect(h.surface('plan')!.content.headline).toBe('The plan')
    expect(h.surface('plan')!.source!.state).toBe('present')
  })
})

describe('content authority', () => {
  it('reports divergence without overwriting canonical-direct content', async () => {
    const h = harness()
    await h.run(epoch([entry('blockers', 'Two blockers')]))
    const id = h.surface('blockers')!.id
    const taken = await h.svc.transferContentAuthority(id, { to: 'canonical-direct', expectedRev: h.surface('blockers')!.rev }, ctx(1_500))
    expect(taken.ok).toBe(true)

    await h.run(epoch([entry('blockers', 'the file disagrees')]), 2_000)

    const after = h.surface('blockers')!
    expect(after.content.headline).toBe('Two blockers')
    expect(after.source!.divergedWatermark).toBe(slateEntryWatermark({ headline: 'the file disagrees', author: 'agent' }))
    // The stored watermark still names the observation the CONTENT reflects, which
    // is what the divergence is measured against.
    expect(after.source!.watermark).toBe(slateEntryWatermark({ headline: 'Two blockers', author: 'agent' }))
    expect(after.source!.generation).toBe(1)
  })

  it('resumes source authorship after authority is transferred back', async () => {
    const h = harness()
    await h.run(epoch([entry('blockers', 'Two blockers')]))
    const id = h.surface('blockers')!.id
    await h.svc.transferContentAuthority(id, { to: 'canonical-direct', expectedRev: h.surface('blockers')!.rev }, ctx(1_500))
    await h.run(epoch([entry('blockers', 'the file disagrees')]), 2_000)
    await h.svc.transferContentAuthority(id, { to: 'source-binding', expectedRev: h.surface('blockers')!.rev }, ctx(2_500))
    await h.run(epoch([entry('blockers', 'the file disagrees')]), 3_000)

    expect(h.surface('blockers')!.content.headline).toBe('the file disagrees')
  })
})

// A claim the host would not accept has to REACH the card, or a mistyped witness
// kind is indistinguishable from a healthy surface (plan U6, R3). The refusal is
// computed by the watcher, rides the entry, and lands on the record's HOST-OWNED
// freshness — deliberately not on its content, which is in the watermark basis.
describe('claim refusals reaching the record', () => {
  /** An entry whose declaration the host refused, exactly as the watcher builds it:
   *  the accepted claims are on the content, the refusals ride alongside. */
  const refused = (localId: string, headline: string, refusals: string[]) =>
    entry(localId, headline, { claimRefusals: refusals })

  it('records the refusal beside the NEW content, not the surface it came with', async () => {
    const h = harness()
    await h.run(epoch([entry('roadmap', 'Roadmap — 2 of 8')]))
    await h.run(epoch([refused('roadmap', 'Roadmap — 3 of 8', ['claim "u1" (witness unit-lands): no such witness kind'])]), 2_000)

    const after = h.surface('roadmap')!
    // KTD5: the refused claim costs the claim. The card shows what the author just
    // wrote — NOT the prior content, which is what the `unreadable` path retains.
    expect(after.content.headline).toBe('Roadmap — 3 of 8')
    expect(after.freshness.claimRefusals).toEqual(['claim "u1" (witness unit-lands): no such witness kind'])
    // And it is host knowledge: nothing about it is in the author's content.
    expect(after.content).not.toHaveProperty('claimRefusals')
  })

  it('records a refusal on a surface created by the very epoch that refused it', async () => {
    const h = harness()
    await h.run(epoch([refused('roadmap', 'Roadmap', ['claim "u1": params.plan must be a `docs/plans/<file>.md` path'])]))

    expect(h.surface('roadmap')!.freshness.claimRefusals).toHaveLength(1)
    expect(h.surface('roadmap')!.content.headline).toBe('Roadmap')
  })

  it('clears the refusal once the entry parses cleanly, without needing new content', async () => {
    const h = harness()
    await h.run(epoch([refused('roadmap', 'Roadmap', ['claim "u1" (witness unit-lands): no such witness kind'])]))
    expect(h.surface('roadmap')!.freshness.claimRefusals).toHaveLength(1)

    // Same headline, same watermark — the ONLY thing that changed is that the bad
    // claim is gone. Gating the write on `evidenceMoved` would strand the refusal
    // here forever, since the accepted claims list was empty both times.
    await h.run(epoch([entry('roadmap', 'Roadmap')]), 2_000)

    expect(h.surface('roadmap')!.freshness.claimRefusals).toBeUndefined()
  })

  it('replaces a refusal with the next one when the accepted list did not move', async () => {
    const h = harness()
    await h.run(epoch([refused('roadmap', 'Roadmap', ['witness "unit-lands" does not exist'])]))
    await h.run(epoch([refused('roadmap', 'Roadmap', ['witness "unit-landd" does not exist'])]), 2_000)

    // Both versions dropped every claim, so the watermark never moved. A refusal
    // that only refreshed with the evidence would still be naming the first typo.
    expect(h.surface('roadmap')!.freshness.claimRefusals).toEqual(['witness "unit-landd" does not exist'])
  })

  it('marks the surface that declared it and none of its siblings', async () => {
    const h = harness()
    await h.run(epoch([
      refused('bad', 'Bad', ['claim "c" (witness nope): no such witness kind']),
      entry('good', 'Good'),
      entry('other', 'Other', { file: 'b.json' }),
    ]))

    expect(h.surface('bad')!.freshness.claimRefusals).toHaveLength(1)
    expect(h.surface('good')!.freshness.claimRefusals).toBeUndefined()
    expect(h.surface('other')!.freshness.claimRefusals).toBeUndefined()
  })

  it('is a host write: it moves no watermark, no generation, and no verification stamp', async () => {
    const h = harness()
    await h.run(epoch([entry('roadmap', 'Roadmap')]))
    const before = h.surface('roadmap')!

    await h.run(epoch([refused('roadmap', 'Roadmap', ['claim "u1" (witness nope): no such witness kind'])]), 2_000)

    const after = h.surface('roadmap')!
    // U1's guard, restated where the host write actually happens (KTD2/KTD7). If a
    // refusal ever reached the watermark basis, every epoch would burn a revision
    // and queue a rebuild on a surface nobody edited.
    expect(after.source!.watermark).toBe(before.source!.watermark)
    expect(after.source!.generation).toBe(before.source!.generation)
    expect(after.freshness.verifiedAt).toBe(before.freshness.verifiedAt)
    expect(after.freshness.phase).toBe(before.freshness.phase)
    // It IS a record change, so it earns exactly one revision — and no more.
    expect(after.rev).toBe(before.rev + 1)
  })

  it('burns no revision when the same refusal is re-observed on the poll floor', async () => {
    const h = harness()
    const same = () => epoch([refused('roadmap', 'Roadmap', ['claim "u1" (witness nope): no such witness kind'])])
    await h.run(same())
    const first = h.surface('roadmap')!.rev
    const out = await h.run(same(), 2_000)

    // The steady state is "nothing moved". A refusal that re-serialized differently
    // every epoch would be a persist-and-SSE storm across every refused surface.
    expect(out).toMatchObject({ observed: 1, created: 0, updated: 0 })
    expect(h.surface('roadmap')!.rev).toBe(first)
  })

  it('does not carry a refusal into the epoch outcome, which reports mutation failures only', async () => {
    const h = harness()
    const out = await h.run(epoch([refused('roadmap', 'Roadmap', ['claim "u1" (witness nope): no such witness kind'])]))

    // The plan's first sketch routed refusals here. It cannot work: a claim-refused
    // entry projects SUCCESSFULLY under KTD5, so `observeSource` returns ok and this
    // array — populated only from `!result.ok` branches — never sees it.
    expect(out.refusals).toEqual([])
    expect(out).toMatchObject({ observed: 1, created: 1 })
  })

  it('drops the refusal when the record takes authority over its own content', async () => {
    const h = harness()
    await h.run(epoch([refused('roadmap', 'Roadmap', ['claim "u1" (witness nope): no such witness kind'])]))
    const id = h.surface('roadmap')!.id
    await h.svc.transferContentAuthority(id, { to: 'canonical-direct', expectedRev: h.surface('roadmap')!.rev }, ctx(1_500))

    await h.run(epoch([refused('roadmap', 'the file disagrees', ['claim "u1" (witness nope): no such witness kind'])]), 2_000)

    // The file's claims are no longer in force — its content is not even rendered —
    // so a refusal about them would point at a declaration nobody can see. The API
    // door cannot store a bad claim in the first place, so there is nothing to say.
    expect(h.surface('roadmap')!.content.headline).toBe('Roadmap')
    expect(h.surface('roadmap')!.freshness.claimRefusals).toBeUndefined()
  })
})

describe('legacy adapter interop', () => {
  it('upgrades a migrated legacy-slate-point binding to the file reconciler', async () => {
    const h = harness()
    const id = deriveLegacySurfaceId(INCARNATION, 'blockers')
    // Exactly the shape migration commits: a logical bridge locator with no path.
    h.docStore.loadSurfaces([{
      id,
      spaceId: SPACE,
      home: { kind: 'canvas', spaceId: SPACE },
      content: { headline: 'adopted from legacy' },
      contentAuthority: 'source-binding',
      source: { adapter: LEGACY_SLATE_ADAPTER, locator: legacyPointLocator(RUN, 'blockers'), generation: 0 },
      author: 'agent',
      thread: { replies: [], status: 'open' },
      freshness: { phase: 'current', overdue: false },
      aliases: [{ bucket: { kind: 'run', runId: RUN }, localId: 'blockers', visible: true }],
      rev: 1, homeRev: 1, createdAt: 1, amendedAt: 1,
    }])

    await h.run(epoch([entry('blockers', 'from the file')]))
    const after = h.docStore.getSurface(id)!
    expect(after.source!.adapter).toBe(SLATE_FILE_ADAPTER)
    expect(after.source!.locator).toBe(slateFileLocator('a.json', 'blockers'))
    expect(after.content.headline).toBe('from the file')
    // Home was NOT reset to the run root: an existing record keeps whatever home it
    // has, including one it was promoted to.
    expect(after.home).toEqual({ kind: 'canvas', spaceId: SPACE })
  })

  it('never marks a legacy-slate-point binding missing for want of a file', async () => {
    const h = harness()
    const id = deriveLegacySurfaceId(INCARNATION, 'adopted')
    h.docStore.loadSurfaces([{
      id,
      spaceId: SPACE,
      home: { kind: 'canvas', spaceId: SPACE },
      content: { headline: 'adopted from legacy' },
      contentAuthority: 'source-binding',
      source: { adapter: LEGACY_SLATE_ADAPTER, locator: legacyPointLocator(RUN, 'adopted'), generation: 0 },
      author: 'agent',
      thread: { replies: [], status: 'open' },
      freshness: { phase: 'current', overdue: false },
      aliases: [{ bucket: { kind: 'run', runId: RUN }, localId: 'adopted', visible: true }],
      rev: 1, homeRev: 1, createdAt: 1, amendedAt: 1,
    }])

    const out = await h.run(epoch([]))
    expect(out.missing).toBe(0)
    expect(h.docStore.getSurface(id)!.source!.state).toBeUndefined()
    expect(h.docStore.getSurface(id)!.rev).toBe(1)
  })

  // Defence in depth: the reconciler already scopes its prior set by adapter, so
  // this is asserted against the service directly — the layer that would have to
  // hold if a future reconciler passed it the wrong binding.
  it('refuses to mark a binding missing on behalf of an adapter that does not own it', async () => {
    const h = harness()
    await h.run(epoch([entry('blockers', 'Two blockers')]))
    const before = h.surface('blockers')!

    const r = await h.svc.markSourceMissing(before.id, 'some-other-adapter', ctx(2_000))

    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.message).toMatch(/only report on the bindings it owns/)
    expect(h.surface('blockers')!.rev).toBe(before.rev)
    expect(h.surface('blockers')!.source!.state).toBe('present')
  })

  it('refuses a second real adapter taking over a bound Surface', async () => {
    const h = harness()
    await h.run(epoch([entry('blockers', 'Two blockers')]))
    const id = h.surface('blockers')!.id
    const r = await h.svc.observeSource({
      id,
      spaceId: SPACE,
      home: { kind: 'surface', surfaceId: ROOT },
      adapter: 'some-other-adapter',
      locator: 'x:1',
      alias: { bucket: { kind: 'run', runId: RUN }, localId: 'blockers', visible: true },
      author: 'agent',
      content: { headline: 'hijacked' },
      watermark: 'w',
    }, ctx(2_000))

    expect(r.ok).toBe(false)
    expect(!r.ok && r.error.reason).toBe('source-conflict')
    expect(h.surface('blockers')!.content.headline).toBe('Two blockers')
  })
})

describe('promotion and deletion', () => {
  it('a promoted Surface keeps reconciling and survives its source going away', async () => {
    const h = harness()
    await h.run(epoch([entry('blockers', 'Two blockers')]))
    const before = h.surface('blockers')!
    const promoted = await h.svc.reparent({
      ids: [before.id], home: { kind: 'canvas', spaceId: SPACE },
    }, ctx(1_500))
    expect(promoted.ok).toBe(true)

    await h.run(epoch([entry('blockers', 'One blocker')]), 2_000)
    expect(h.surface('blockers')!.content.headline).toBe('One blocker')
    expect(h.surface('blockers')!.home).toEqual({ kind: 'canvas', spaceId: SPACE })
    // Its run alias survived promotion, which is what keeps it reachable from the
    // legacy Run Workspace (KTD3).
    expect(h.surface('blockers')!.aliases).toEqual([
      { bucket: { kind: 'run', runId: RUN }, localId: 'blockers', visible: true },
    ])

    await h.run(epoch([]), 3_000)
    expect(h.surface('blockers')).toBeDefined()
    expect(h.surface('blockers')!.source!.state).toBe('missing')
  })

  it('leaves a deleted Surface in the recovery store rather than resurrecting it', async () => {
    const h = harness()
    await h.run(epoch([entry('blockers', 'Two blockers')]))
    const id = h.surface('blockers')!.id
    const del = await h.svc.delete(id, {}, ctx(1_500))
    expect(del.ok).toBe(true)

    const out = await h.run(epoch([entry('blockers', 'Two blockers')]), 2_000)
    expect(out.refusals).toEqual([{ localId: 'blockers', reason: 'deleted' }])
    expect(h.docStore.getSurface(id)!.home).toEqual({ kind: 'recovery', spaceId: SPACE })
  })
})
