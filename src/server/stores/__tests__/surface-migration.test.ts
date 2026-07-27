// @vitest-environment node
//
// Legacy Slate → canonical Surface migration (U1).
//
// The named U1 scenarios this file owns:
//   · migrating a file-authored point preserves body, thread, status, order,
//     author, timestamps, and a deterministic alias across repeated boots;
//   · two runs using the same local Surface slug receive different global ids;
//   · deleting and recreating a run name does not reuse the earlier identity;
//   · an alias collision quarantines the candidate and leaves the legacy Run
//     Workspace usable;
//   · legacy incarnation derivation is deterministic, and a missing `createdAt` is
//     quarantined;
//   · A POINT AND A THREAD REPLY WRITTEN THROUGH THE LEGACY BRIDGE AFTER THE FIRST
//     MIGRATION ARE RECONCILED ON THE NEXT BOOT WITHOUT DUPLICATING IDENTITIES.
//     That last one is the data-loss path — the whole reason migration is
//     re-entrant rather than one-shot — and it is the most important test here.
// Plus happy-path, edge (empty input, a run with no points, a body-less point, a
// run whose points were all deleted, a promoted/closed Surface) and error-path
// (malformed point, missing headline, duplicate local id, space drift) coverage.
import { describe, it, expect } from 'vitest'
import {
  LEGACY_RUN_ROOT_LOCAL_ID,
  LEGACY_SLATE_ADAPTER,
  LEGACY_SPACELESS_SPACE_ID,
  deriveLegacyRunRootId,
  legacyPointLocator,
  migrateLegacySlate,
  type LegacyRunSnapshot,
  type SurfaceMigrationOutcome,
} from '../surface-migration'
import { SurfaceStore, deriveLegacySurfaceId, deriveRunIncarnation } from '../surfaces'
import { OBJECTIVE_POINT_ID } from '../../../domain/types'
import type { Point, Surface, SurfaceCompatAlias } from '../../../domain/types'

const SPACE = 'space-1'
const RUN = 'CLD-run-1'
const BORN = '2026-07-13T00:00:00.000Z'
const NOW = 1_800_000_000_000

function body(text: string) {
  return { root: 'r', components: [{ component: 'Text', id: 'r', text }] }
}

function point(over: Partial<Point> & Pick<Point, 'id'>): Point {
  return {
    runId: RUN,
    author: 'agent',
    source: 'file',
    headline: `headline for ${over.id}`,
    status: 'open',
    createdAt: 1_000,
    amendedAt: 1_000,
    ...over,
  }
}

function run(over: Partial<LegacyRunSnapshot> = {}): LegacyRunSnapshot {
  return { runId: RUN, createdAt: BORN, spaceId: SPACE, points: [], ...over }
}

/** The id a run's point WILL get, computed independently of the migration so a
 *  test asserts against the derivation rather than against whatever came out. */
function idFor(runId: string, createdAt: string, localId: string): string {
  return deriveLegacySurfaceId(deriveRunIncarnation(runId, createdAt)!, localId)
}

/** Stand in for the canonical store between boots: merge a pass's puts onto the
 *  records that were already there, by id. */
function applyPuts(existing: readonly Surface[], puts: readonly Surface[]): Surface[] {
  const byId = new Map(existing.map(s => [s.id, s]))
  for (const s of puts) byId.set(s.id, s)
  return [...byId.values()]
}

function surfaceFor(out: SurfaceMigrationOutcome, id: string): Surface {
  const found = out.puts.find(s => s.id === id)
  if (!found) throw new Error(`no put for ${id}; puts were ${out.puts.map(s => s.id).join(', ')}`)
  return found
}

function runAlias(s: Surface, runId: string): SurfaceCompatAlias | undefined {
  return s.aliases?.find(a => a.bucket.kind === 'run' && a.bucket.runId === runId)
}

describe('migrateLegacySlate — happy path', () => {
  // NAMED U1 SCENARIO. Everything the legacy store owns has to survive: a reply
  // the user typed is the least recoverable thing on a point.
  it('preserves body, thread, status, order, author, timestamps, and the alias', () => {
    const p = point({
      id: 'blockers',
      author: 'agent',
      headline: 'Which rollback path?',
      content: body('the two options') as never,
      refresh: 're-run the rollback analysis',
      order: 42,
      status: 'waiting',
      replies: [{ id: 'rep1', author: 'user', text: 'roll forward', createdAt: 2_000 }],
      createdAt: 1_000,
      amendedAt: 2_000,
    })
    const out = migrateLegacySlate({ runs: [run({ points: [p] })], now: NOW })

    const s = surfaceFor(out, idFor(RUN, BORN, 'blockers'))
    expect(s.content.headline).toBe('Which rollback path?')
    expect(s.content.body).toEqual(body('the two options'))
    // The legacy file-owned `refresh` prompt IS the canonical author-declared recipe.
    expect(s.content.recipe).toBe('re-run the rollback analysis')
    expect(s.author).toBe('agent')
    expect(s.order).toBe(42)
    expect(s.thread.replies.map(r => r.text)).toEqual(['roll forward'])
    expect(s.thread.status).toBe('waiting')
    expect(s.createdAt).toBe(1_000)
    expect(s.amendedAt).toBe(2_000)
    expect(s.provenance).toEqual({ runId: RUN })
    // The compatibility alias is what `Run.slate` will later be derived through:
    // the legacy client keeps addressing the point id it already knows.
    expect(runAlias(s, RUN)).toEqual({ bucket: { kind: 'run', runId: RUN }, localId: 'blockers', visible: true })
    // A file-authored point keeps its source authority and a logical (run, point)
    // locator — the legacy store records no file path to put here.
    expect(s.contentAuthority).toBe('source-binding')
    expect(s.source).toEqual({
      adapter: LEGACY_SLATE_ADAPTER, locator: legacyPointLocator(RUN, 'blockers'), generation: 0,
    })
  })

  it('homes converted points beneath one compatibility-only run root', () => {
    const out = migrateLegacySlate({
      runs: [run({ points: [point({ id: 'a' }), point({ id: 'b' })] })],
      now: NOW,
    })
    const rootId = deriveLegacyRunRootId(deriveRunIncarnation(RUN, BORN)!)
    const root = surfaceFor(out, rootId)
    expect(root.compatibilityOnly).toBe(true)
    expect(root.home).toEqual({ kind: 'canvas', spaceId: SPACE })
    // The root's own alias is HIDDEN — it is migration scaffolding, not a card, so
    // it must not appear as a row in the very Slate list it contains.
    expect(runAlias(root, RUN)!.visible).toBe(false)
    expect(runAlias(root, RUN)!.localId).toBe(LEGACY_RUN_ROOT_LOCAL_ID)
    for (const localId of ['a', 'b']) {
      expect(surfaceFor(out, idFor(RUN, BORN, localId)).home).toEqual({ kind: 'surface', surfaceId: rootId })
    }
    expect(out.report.runsMigrated).toBe(1)
    expect(out.report.surfacesCreated).toBe(3) // root + 2 points
  })

  // The reload contract, checked against the real store rather than reimplemented:
  // whatever this module emits must index exactly the way SurfaceStore expects.
  it('produces records a real SurfaceStore indexes into the expected tree', () => {
    const out = migrateLegacySlate({
      runs: [run({ points: [point({ id: 'a', order: 2 }), point({ id: 'b', order: 1 })] })],
      now: NOW,
    })
    const store = new SurfaceStore(() => {})
    store.load(out.puts)
    const rootId = deriveLegacyRunRootId(deriveRunIncarnation(RUN, BORN)!)
    expect(store.getRoots(SPACE).map(s => s.id)).toEqual([rootId])
    // Sibling order follows the legacy `order`, so the migrated column reads the
    // way the user last arranged it.
    expect(store.getChildren(rootId).map(s => runAlias(s, RUN)!.localId)).toEqual(['b', 'a'])
    expect(store.getTopologyRev(SPACE)).toBe(1)
  })

  // NAMED U1 SCENARIO. Agents reuse slugs (`decisions`, `blockers`, `objective`),
  // so two unrelated runs routinely hold the same local id.
  it('gives two runs the same local slug different global ids', () => {
    const out = migrateLegacySlate({
      runs: [
        run({ runId: 'run-a', points: [point({ id: 'decisions', runId: 'run-a' })] }),
        run({ runId: 'run-b', points: [point({ id: 'decisions', runId: 'run-b' })] }),
      ],
      now: NOW,
    })
    const a = idFor('run-a', BORN, 'decisions')
    const b = idFor('run-b', BORN, 'decisions')
    expect(a).not.toBe(b)
    expect(out.puts.filter(s => s.id === a || s.id === b)).toHaveLength(2)
    expect(out.report.quarantined).toEqual([])
  })

  // NAMED U1 SCENARIO. A run id is a tmux session name; a user may delete and
  // recreate it, and the reborn run must not inherit a stranger's threads.
  it('does not reuse an identity when a run name is deleted and recreated', () => {
    const first = migrateLegacySlate({ runs: [run({ points: [point({ id: 'objective' })] })], now: NOW })
    const reborn = migrateLegacySlate({
      runs: [run({ createdAt: '2026-07-20T09:15:00.000Z', points: [point({ id: 'objective' })] })],
      // The reborn run is migrated against the FIRST run's records still in the
      // store, which is exactly the situation on a real boot.
      existing: first.puts,
      now: NOW,
    })
    const firstId = idFor(RUN, BORN, 'objective')
    const rebornId = idFor(RUN, '2026-07-20T09:15:00.000Z', 'objective')
    expect(rebornId).not.toBe(firstId)
    expect(surfaceFor(reborn, rebornId).rev).toBe(1) // a create, not an amend of the dead run's record

    // …and the DEAD incarnation's Surfaces are not destroyed. Compatibility
    // aliases are keyed on the run NAME, not the incarnation, so without handing
    // the run's legacy presentation over the reborn run would collide on its own
    // root and never migrate — permanently, on every boot. The old records keep
    // their identity, thread, and home; only their bucket moves.
    const retiredIds = reborn.report.retired.map(r => r.surfaceId).sort()
    expect(retiredIds).toEqual([firstId, deriveLegacyRunRootId(deriveRunIncarnation(RUN, BORN)!)].sort())
    const oldObjective = surfaceFor(reborn, firstId)
    expect(oldObjective.aliases).toEqual([
      { bucket: { kind: 'workspace-recovery' }, localId: 'objective', visible: true },
    ])
    expect(oldObjective.thread).toEqual(surfaceFor(reborn, firstId).thread)
    expect(oldObjective.createdAt).toBe(1_000)
  })

  it('retires a previous incarnation exactly once, then stays quiet', () => {
    const p = point({ id: 'p1' })
    const first = migrateLegacySlate({ runs: [run({ points: [p] })], now: NOW })
    const rebornRun = run({ createdAt: '2026-07-20T09:15:00.000Z', points: [p] })
    const boot2 = migrateLegacySlate({ runs: [rebornRun], existing: first.puts, now: NOW })
    const boot3 = migrateLegacySlate({
      runs: [rebornRun], existing: applyPuts(first.puts, boot2.puts), now: NOW,
    })
    expect(boot2.report.retired).toHaveLength(2)
    // Idempotent: the retired records no longer hold a run alias, so the third
    // boot has nothing to hand over and nothing to write.
    expect(boot3.report.retired).toEqual([])
    expect(boot3.puts).toEqual([])
  })

  // The retirement is scoped to the run whose name was recreated. A stranger
  // holding ONE of the run's point aliases (but not its reserved root alias) is an
  // ordinary collision, not a dead incarnation, and must not be re-bucketed.
  it('does not retire a record when the run root alias is still its own', () => {
    const p = point({ id: 'p1' })
    const first = migrateLegacySlate({ runs: [run({ points: [p] })], now: NOW })
    const squatted = first.puts.map(s =>
      runAlias(s, RUN)?.localId === 'p1'
        ? { ...s, id: 'sf-hand-edited' }
        : s,
    )
    const out = migrateLegacySlate({ runs: [run({ points: [p] })], existing: squatted, now: NOW })
    expect(out.report.retired).toEqual([])
    expect(out.report.quarantined.map(q => q.reason)).toEqual(['alias-collision'])
  })

  // The space is deliberately NOT in the incarnation basis (an early draft of the
  // plan said it was). If it were, moving a run between spaces would re-derive
  // every id it owns and migrate the whole run again as a duplicate set.
  it('derives the same identity for a run regardless of its space', () => {
    const inA = migrateLegacySlate({ runs: [run({ spaceId: 'space-a', points: [point({ id: 'x' })] })], now: NOW })
    const inB = migrateLegacySlate({ runs: [run({ spaceId: 'space-b', points: [point({ id: 'x' })] })], now: NOW })
    expect(inA.puts.map(s => s.id).sort()).toEqual(inB.puts.map(s => s.id).sort())
  })

  it('parks a space-less run in the fallback space rather than quarantining it', () => {
    const out = migrateLegacySlate({ runs: [run({ spaceId: undefined, points: [point({ id: 'x' })] })], now: NOW })
    expect(out.report.quarantined).toEqual([])
    for (const s of out.puts) expect(s.spaceId).toBe(LEGACY_SPACELESS_SPACE_ID)
  })
})

describe('migrateLegacySlate — determinism across repeated boots', () => {
  // NAMED U1 SCENARIO. Non-determinism here is not a cosmetic problem: a second
  // set of ids means a second set of Surfaces, and every thread on the first set
  // becomes unreachable.
  it('produces byte-identical records when run twice on identical input', () => {
    const points = [
      point({ id: 'a', order: 5, replies: [{ id: 'r1', author: 'user', text: 'hi', createdAt: 9 }] }),
      point({ id: 'b', content: body('b') as never, resolvedAt: 77, status: 'resolved' }),
    ]
    const first = migrateLegacySlate({ runs: [run({ points })], now: NOW })
    // A DIFFERENT wall clock on the second boot, which is the realistic case. If
    // any record field were stamped with `now` instead of copied from the legacy
    // point, this is the assertion that would fail.
    const second = migrateLegacySlate({ runs: [run({ points })], now: NOW + 86_400_000 })
    expect(second.puts).toEqual(first.puts)
    expect(JSON.stringify(second.puts)).toBe(JSON.stringify(first.puts))
  })

  it('re-migrating against its own output writes nothing at all', () => {
    const points = [point({ id: 'a' }), point({ id: 'b' })]
    const first = migrateLegacySlate({ runs: [run({ points })], now: NOW })
    const second = migrateLegacySlate({ runs: [run({ points })], existing: first.puts, now: NOW })
    expect(second.puts).toEqual([])
    expect(second.report.surfacesCreated).toBe(0)
    expect(second.report.surfacesUpdated).toBe(0)
    expect(second.report.surfacesUnchanged).toBe(3) // root + 2 points
  })
})

describe('migrateLegacySlate — re-entrancy (THE data-loss path)', () => {
  // THE most important test in this unit.
  //
  // Between U1 and U2 the legacy bridge is still the write path. A one-shot
  // migration ("records exist, so skip") would leave everything written after the
  // first pass stranded in the legacy store, and it would vanish the moment U2
  // makes aliases authoritative. So: boot, then let the user reply to a point and
  // an agent add a new one, then boot again.
  it('reconciles a point and a thread reply written AFTER the first migration', () => {
    const p1 = point({ id: 'p1', headline: 'Which rollback path?', createdAt: 1_000, amendedAt: 1_000 })
    const boot1 = migrateLegacySlate({ runs: [run({ points: [p1] })], now: NOW })
    const store = applyPuts([], boot1.puts)
    expect(store).toHaveLength(2) // root + p1

    // …the user replies to p1 through the legacy HTTP path, and an agent's file
    // projection adds p2. Both land in `slatePoints`, not in the canonical store.
    const p1Answered: Point = {
      ...p1,
      status: 'waiting',
      replies: [{ id: 'rep1', author: 'user', text: 'roll forward', createdAt: 5_000 }],
      amendedAt: 5_000,
    }
    const p2 = point({ id: 'p2', headline: 'Ship behind a flag?', createdAt: 6_000, amendedAt: 6_000 })

    const boot2 = migrateLegacySlate({ runs: [run({ points: [p1Answered, p2] })], existing: store, now: NOW })

    // The reply reached the canonical store, on the SAME record as before.
    const p1Id = idFor(RUN, BORN, 'p1')
    const p1Next = surfaceFor(boot2, p1Id)
    expect(p1Next.thread.replies.map(r => r.text)).toEqual(['roll forward'])
    expect(p1Next.thread.status).toBe('waiting')
    expect(p1Next.rev).toBe(2) // amended, not recreated
    expect(p1Next.createdAt).toBe(1_000)

    // The new point was created — and only it.
    const p2Id = idFor(RUN, BORN, 'p2')
    expect(surfaceFor(boot2, p2Id).rev).toBe(1)
    expect(boot2.report.surfacesCreated).toBe(1)
    expect(boot2.report.surfacesUpdated).toBe(1)
    expect(boot2.report.surfacesUnchanged).toBe(1) // the untouched root

    // NO DUPLICATE IDENTITIES: the merged store holds root + p1 + p2 and nothing
    // else, and every id is distinct.
    const merged = applyPuts(store, boot2.puts)
    expect(merged).toHaveLength(3)
    expect(new Set(merged.map(s => s.id)).size).toBe(3)
    const aliases = merged.flatMap(s => s.aliases ?? []).map(a => JSON.stringify(a.bucket) + a.localId)
    expect(new Set(aliases).size).toBe(aliases.length)
  })

  it('does not drag a PROMOTED Surface back under its run root', () => {
    const p = point({ id: 'p1' })
    const boot1 = migrateLegacySlate({ runs: [run({ points: [p] })], now: NOW })
    const id = idFor(RUN, BORN, 'p1')
    // A later unit promotes the Surface onto the Canvas (KTD3), which changes
    // `home` and `homeRev` but keeps the run alias.
    const promoted = boot1.puts.map(s =>
      s.id === id ? { ...s, home: { kind: 'canvas' as const, spaceId: SPACE }, homeRev: 7, rev: 2 } : s,
    )
    const boot2 = migrateLegacySlate({ runs: [run({ points: [p] })], existing: promoted, now: NOW })
    // Nothing changed on the legacy side, so nothing is written — and critically
    // the promotion is not undone.
    expect(boot2.puts).toEqual([])
    expect(boot2.report.surfacesUnchanged).toBe(2)
  })

  it('does not re-show a legacy presentation the user closed', () => {
    const p = point({ id: 'p1' })
    const boot1 = migrateLegacySlate({ runs: [run({ points: [p] })], now: NOW })
    const id = idFor(RUN, BORN, 'p1')
    const closed = boot1.puts.map(s =>
      s.id === id
        ? { ...s, aliases: s.aliases!.map(a => ({ ...a, visible: false })), rev: 2 }
        : s,
    )
    // The legacy point also changed, so the record IS rewritten — and the
    // visibility must survive that rewrite rather than being reset to the default.
    const amended: Point = { ...p, headline: 'edited upstream', amendedAt: 9_000 }
    const boot2 = migrateLegacySlate({ runs: [run({ points: [amended] })], existing: closed, now: NOW })
    const next = surfaceFor(boot2, id)
    expect(next.content.headline).toBe('edited upstream')
    expect(runAlias(next, RUN)!.visible).toBe(false)
  })

  it('preserves host-owned owner and freshness across a reconcile', () => {
    const p = point({ id: 'p1' })
    const boot1 = migrateLegacySlate({ runs: [run({ points: [p] })], now: NOW })
    const id = idFor(RUN, BORN, 'p1')
    const owned = boot1.puts.map(s =>
      s.id === id
        ? {
            ...s,
            owner: { kind: 'session' as const, id: 'sess-9', label: 'the author' },
            freshness: { phase: 'refreshing' as const, overdue: true },
            rev: 2,
          }
        : s,
    )
    const amended: Point = { ...p, headline: 'edited upstream', amendedAt: 9_000 }
    const boot2 = migrateLegacySlate({ runs: [run({ points: [amended] })], existing: owned, now: NOW })
    const next = surfaceFor(boot2, id)
    expect(next.owner).toEqual({ kind: 'session', id: 'sess-9', label: 'the author' })
    expect(next.freshness).toEqual({ phase: 'refreshing', overdue: true })
  })
})

describe('migrateLegacySlate — the Objective', () => {
  // The Objective is the user's own point, store-only, and the one thing a run
  // loses outright if migration mangles it. `document-store.ts` renders it as the
  // pinned goal only when `source === 'user' && id === OBJECTIVE_POINT_ID`, so
  // BOTH halves of that pairing have to survive as canonical fields.
  it('survives as a user-authored, canonically-direct Surface under its reserved local id', () => {
    const objective = point({
      id: OBJECTIVE_POINT_ID,
      source: 'user',
      author: 'user',
      headline: 'Ship U1 invisibly',
    })
    const out = migrateLegacySlate({ runs: [run({ points: [objective] })], now: NOW })
    const s = surfaceFor(out, idFor(RUN, BORN, OBJECTIVE_POINT_ID))
    expect(s.author).toBe('user')
    // `source:'user'` has no file behind it, so the record itself is authoritative
    // and carries NO source binding. That pairing is how the projection back to
    // `Run.slate` recovers `source:'user'`.
    expect(s.contentAuthority).toBe('canonical-direct')
    expect(s.source).toBeUndefined()
    expect(runAlias(s, RUN)!.localId).toBe(OBJECTIVE_POINT_ID)
  })
})

describe('migrateLegacySlate — quarantine', () => {
  // NAMED U1 SCENARIO. The candidate is refused, and — the part that matters — the
  // legacy input is returned untouched, so the Run Workspace keeps rendering it.
  it('quarantines an alias collision and leaves the legacy Run Workspace usable', () => {
    const p = point({ id: 'p1', headline: 'mine' })
    const input = { runs: [run({ points: [p] })], now: NOW }
    const before = structuredClone(input)
    // A stranger record already claims run/p1 — e.g. a hand-edited sidecar, or a
    // record whose run was recreated under a colliding derivation.
    const squatter: Surface = {
      id: 'sf-squatter',
      spaceId: SPACE,
      home: { kind: 'canvas', spaceId: SPACE },
      content: { headline: 'not yours' },
      contentAuthority: 'canonical-direct',
      author: 'agent',
      thread: { replies: [], status: 'open' },
      freshness: { phase: 'current', overdue: false },
      aliases: [{ bucket: { kind: 'run', runId: RUN }, localId: 'p1', visible: true }],
      rev: 3,
      homeRev: 1,
      createdAt: 1,
      amendedAt: 1,
    }
    const out = migrateLegacySlate({ ...input, existing: [squatter] })

    expect(out.puts.map(s => s.id)).not.toContain(idFor(RUN, BORN, 'p1'))
    const q = out.report.quarantined.find(x => x.reason === 'alias-collision')
    expect(q).toBeTruthy()
    expect(q!.runId).toBe(RUN)
    expect(q!.localId).toBe('p1')
    expect(q!.detail).toContain('sf-squatter')
    // The squatter is not rewritten either.
    expect(out.puts.map(s => s.id)).not.toContain('sf-squatter')
    // LEGACY UNTOUCHED — the migration only ever reads its input.
    expect(input).toEqual(before)
    // …and the rest of the run still migrated, so one bad point does not sink the
    // whole run.
    expect(out.report.runsMigrated).toBe(1)
  })

  it('quarantines a derived id held by a record that is not its counterpart', () => {
    const p = point({ id: 'p1' })
    const impostor: Surface = {
      id: idFor(RUN, BORN, 'p1'),
      spaceId: SPACE,
      home: { kind: 'canvas', spaceId: SPACE },
      content: { headline: 'someone else' },
      contentAuthority: 'canonical-direct',
      author: 'agent',
      thread: { replies: [], status: 'open' },
      freshness: { phase: 'current', overdue: false },
      rev: 1, homeRev: 1, createdAt: 1, amendedAt: 1,
    }
    const out = migrateLegacySlate({ runs: [run({ points: [p] })], existing: [impostor], now: NOW })
    expect(out.report.quarantined.map(q => q.reason)).toContain('id-collision')
    expect(out.puts.map(s => s.id)).not.toContain(impostor.id)
  })

  // NAMED U1 SCENARIO. There is no safe deterministic substitute for `createdAt`:
  // any placeholder would be indistinguishable from a real basis next boot.
  it('quarantines a run with no createdAt instead of guessing an incarnation', () => {
    const out = migrateLegacySlate({
      runs: [run({ createdAt: undefined, points: [point({ id: 'p1' })] })],
      now: NOW,
    })
    expect(out.puts).toEqual([])
    expect(out.report.quarantined.map(q => q.reason)).toEqual(['missing-run-created-at'])
    expect(out.report.runsQuarantined).toBe(1)
    expect(out.report.runs[0]!.incarnation).toBeNull()
  })

  it('quarantines a run whose createdAt is not a parseable date', () => {
    const out = migrateLegacySlate({
      runs: [run({ createdAt: 'not-a-date', points: [point({ id: 'p1' })] })],
      now: NOW,
    })
    expect(out.puts).toEqual([])
    expect(out.report.quarantined.map(q => q.reason)).toEqual(['unparsable-run-created-at'])
  })

  it('quarantines a run snapshot with no runId', () => {
    const out = migrateLegacySlate({ runs: [run({ runId: '' })], now: NOW })
    expect(out.puts).toEqual([])
    expect(out.report.quarantined.map(q => q.reason)).toEqual(['missing-run-id'])
  })

  it('quarantines a malformed point but still migrates its siblings', () => {
    const out = migrateLegacySlate({
      runs: [run({ points: [{ headline: 'no id here' } as unknown as Point, point({ id: 'good' })] })],
      now: NOW,
    })
    expect(out.report.quarantined.map(q => q.reason)).toEqual(['malformed-point'])
    expect(out.puts.map(s => s.id)).toContain(idFor(RUN, BORN, 'good'))
  })

  it('quarantines a point with no headline (a Surface with none renders nowhere)', () => {
    const out = migrateLegacySlate({
      runs: [run({ points: [point({ id: 'bare', headline: '' })] })],
      now: NOW,
    })
    expect(out.report.quarantined.map(q => q.reason)).toEqual(['missing-headline'])
    expect(out.puts.map(s => s.id)).not.toContain(idFor(RUN, BORN, 'bare'))
  })

  it('keeps the first of two points sharing a local id and quarantines the rest', () => {
    const out = migrateLegacySlate({
      runs: [run({ points: [
        point({ id: 'dupe', headline: 'first', createdAt: 1 }),
        point({ id: 'dupe', headline: 'second', createdAt: 2 }),
      ] })],
      now: NOW,
    })
    expect(surfaceFor(out, idFor(RUN, BORN, 'dupe')).content.headline).toBe('first')
    expect(out.report.quarantined.map(q => q.reason)).toEqual(['duplicate-local-id'])
  })

  // `Surface.spaceId` is immutable, so a run that moved space cannot have its
  // canonical records followed over by an ordinary write.
  it('quarantines a record whose run now reports a different space', () => {
    const p = point({ id: 'p1' })
    const boot1 = migrateLegacySlate({ runs: [run({ points: [p] })], now: NOW })
    const boot2 = migrateLegacySlate({
      runs: [run({ spaceId: 'space-2', points: [p] })],
      existing: boot1.puts,
      now: NOW,
    })
    expect(boot2.report.quarantined.map(q => q.reason)).toContain('space-drift')
    expect(boot2.puts).toEqual([])
  })

  // A run whose root cannot be claimed has nowhere to home its points, and homing
  // them on the Canvas instead would dump every legacy point onto the canvas as a
  // top-level card. So the whole run waits for the next boot — its legacy Slate
  // keeps rendering it in the meantime, which is the entire point of the window.
  it('migrates none of a run whose compatibility root is unavailable', () => {
    const rootId = deriveLegacyRunRootId(deriveRunIncarnation(RUN, BORN)!)
    // Holds the root's derived ID without its alias — so it is not a previous
    // incarnation to be retired, it is a stranger sitting on the identity.
    const impostor: Surface = {
      id: rootId,
      spaceId: SPACE,
      home: { kind: 'canvas', spaceId: SPACE },
      content: { headline: 'not a run root' },
      contentAuthority: 'canonical-direct',
      author: 'agent',
      thread: { replies: [], status: 'open' },
      freshness: { phase: 'current', overdue: false },
      rev: 1, homeRev: 1, createdAt: 1, amendedAt: 1,
    }
    const out = migrateLegacySlate({
      runs: [run({ points: [point({ id: 'p1' }), point({ id: 'p2' })] })],
      existing: [impostor],
      now: NOW,
    })
    expect(out.puts).toEqual([])
    expect(out.report.quarantined.map(q => q.reason)).toEqual(['id-collision', 'run-root-unavailable'])
    expect(out.report.runs[0]!.rootSurfaceId).toBeNull()
  })
})

describe('migrateLegacySlate — edges', () => {
  it('returns nothing for empty input', () => {
    const out = migrateLegacySlate({ runs: [], now: NOW })
    expect(out.puts).toEqual([])
    expect(out.report).toEqual({
      at: NOW,
      runsSeen: 0, runsMigrated: 0, runsQuarantined: 0,
      surfacesCreated: 0, surfacesUpdated: 0, surfacesUnchanged: 0,
      quarantined: [], preservationGaps: [], orphaned: [], retired: [], runs: [],
    })
  })

  // The root is created even for an empty run: a root that only appeared with the
  // first point would make the run→root mapping depend on when that point arrived.
  it('creates only the compatibility root for a run with no points', () => {
    const out = migrateLegacySlate({ runs: [run({ points: [] })], now: NOW })
    expect(out.puts.map(s => s.id)).toEqual([deriveLegacyRunRootId(deriveRunIncarnation(RUN, BORN)!)])
    expect(out.report.surfacesCreated).toBe(1)
  })

  it('migrates a point with no body', () => {
    const out = migrateLegacySlate({ runs: [run({ points: [point({ id: 'bare' })] })], now: NOW })
    const s = surfaceFor(out, idFor(RUN, BORN, 'bare'))
    expect(s.content.body).toBeUndefined()
    expect(s.content.headline).toBe('headline for bare')
  })

  // A run whose points were ALL deleted from the legacy store. The canonical
  // records are reported as orphans and left exactly where they are: under KTD15
  // removal is a move into the recovery store inside a topology transaction, which
  // is a later unit's mutation to make.
  it('reports orphans without deleting or rewriting them', () => {
    const boot1 = migrateLegacySlate({
      runs: [run({ points: [point({ id: 'a' }), point({ id: 'b' })] })],
      now: NOW,
    })
    const boot2 = migrateLegacySlate({ runs: [run({ points: [] })], existing: boot1.puts, now: NOW })
    expect(boot2.puts).toEqual([])
    expect(boot2.report.orphaned.map(o => o.localId).sort()).toEqual(['a', 'b'])
    expect(boot2.report.orphaned.every(o => o.runId === RUN)).toBe(true)
    // The root itself is never reported as its own orphan.
    expect(boot2.report.orphaned.map(o => o.localId)).not.toContain(LEGACY_RUN_ROOT_LOCAL_ID)
  })

  it('leaves records of runs absent from the input completely alone', () => {
    const boot1 = migrateLegacySlate({ runs: [run({ runId: 'run-a', points: [point({ id: 'x', runId: 'run-a' })] })], now: NOW })
    const boot2 = migrateLegacySlate({ runs: [], existing: boot1.puts, now: NOW })
    expect(boot2.puts).toEqual([])
    expect(boot2.report.orphaned).toEqual([])
    expect(boot2.report.quarantined).toEqual([])
  })

  // Legacy fields the canonical record cannot carry yet. NOT a quarantine — the
  // Surface is created and the legacy data is untouched — but the loss is reported
  // rather than discovered later by a user whose diagram anchor disappeared.
  it('reports legacy fields with no canonical home as preservation gaps', () => {
    const out = migrateLegacySlate({
      runs: [run({ points: [point({
        id: 'diagram',
        anchor: { kind: 'surface', ref: 'x' } as never,
        group: 'workbench-1',
        stalledAt: 5_000,
      })] })],
      now: NOW,
    })
    expect(out.report.preservationGaps).toEqual([
      { runId: RUN, localId: 'diagram', surfaceId: idFor(RUN, BORN, 'diagram'), fields: ['anchor', 'group', 'stalledAt'] },
    ])
    // …and the Surface itself was still migrated.
    expect(surfaceFor(out, idFor(RUN, BORN, 'diagram')).content.headline).toBe('headline for diagram')
  })

  it('re-derives a status this build does not recognise instead of propagating it', () => {
    const out = migrateLegacySlate({
      runs: [run({ points: [point({
        id: 'weird',
        status: 'from-the-future' as never,
        replies: [{ id: 'r1', author: 'agent', text: 'thinking', createdAt: 5 }],
      })] })],
      now: NOW,
    })
    // Last reply is the agent's → discussing, per `derivePointStatus`.
    expect(surfaceFor(out, idFor(RUN, BORN, 'weird')).thread.status).toBe('discussing')
  })

  it('copies the thread rather than aliasing the legacy array', () => {
    const replies = [{ id: 'r1', author: 'user' as const, text: 'first', createdAt: 5 }]
    const out = migrateLegacySlate({ runs: [run({ points: [point({ id: 'p1', replies })] })], now: NOW })
    const s = surfaceFor(out, idFor(RUN, BORN, 'p1'))
    expect(s.thread.replies).not.toBe(replies)
    s.thread.replies.push({ id: 'r2', author: 'agent', text: 'injected', createdAt: 6 })
    expect(replies).toHaveLength(1)
  })

  it('orders the report and the puts by runId so two boots diff cleanly', () => {
    const out = migrateLegacySlate({
      runs: [
        run({ runId: 'zeta', points: [point({ id: 'p', runId: 'zeta' })] }),
        run({ runId: 'alpha', points: [point({ id: 'p', runId: 'alpha' })] }),
      ],
      now: NOW,
    })
    expect(out.report.runs.map(r => r.runId)).toEqual(['alpha', 'zeta'])
    expect(out.puts[0]!.provenance!.runId).toBe('alpha')
  })
})
