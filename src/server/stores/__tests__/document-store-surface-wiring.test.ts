// @vitest-environment node
//
// U1e — the WIRING half of U1. Everything here is about seams between the
// canonical Surface store and things that already existed: the DocumentStore's
// persistence path, the SSE change stream, and the space/store lifecycle
// cascade. The canonical model, the sidecar, and the migration are covered by
// their own suites; this file only asserts that connecting them did not move
// anything that was already working.
//
// The scenarios this file owns (plan U1):
//   · a canonical Surface content change emits a run delta over SSE and schedules
//     no `docstore.json` write;
//   · concurrent non-Surface DocumentStore mutations survive a Surface commit
//     because the stores do not replace each other's snapshots;
//   · deleting a space leaves no orphan canonical Surfaces, and a FAST_SIM boot
//     clear cascades identically;
//   · a faulted load renders legacy Slate content behind the degraded marker and
//     never presents it as current, while canonical projection stays empty.
//
// The latency gate lives in its own file (`surface-latency-budget.test.ts`) so a
// slow machine's timing noise can never be mistaken for a correctness failure.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentStore, type DocumentChange } from '../document-store'
import { SurfaceSidecar, surfaceSidecarPaths, type SidecarWriteStep } from '../surface-persistence'
import { bootSurfaces } from '../surface-boot'
import { acquireBackendSingleton } from '../../infra/lock'
import type { Run, Surface, SurfaceHome } from '../../../domain/types'

const SPACE = 'spc-a'
const CANVAS: SurfaceHome = { kind: 'canvas', spaceId: SPACE }

function makeRun(over: Partial<Run> = {}): Run {
  return {
    id: 'r1', sessionId: 'r1', taskId: 't1', worktreeId: 'wt1',
    status: 'running', background: false, blocked: false,
    initiative: 'i', epic: 'e', task: 't', repo: 'r', worktree: 'w',
    touchedFiles: [], recapEntries: [], rawLogs: '',
    port: null, backend: null, createdAt: '2026-07-13T00:00:00.000Z',
    spaceId: SPACE,
    ...over,
  }
}

/** A complete canonical record aliased to a run, which is what makes it visible
 *  to the compatibility half of the wiring. */
function surface(id: string, over: Partial<Surface> = {}): Surface {
  return {
    id,
    spaceId: SPACE,
    home: CANVAS,
    content: { headline: id },
    contentAuthority: 'canonical-direct',
    author: 'agent',
    thread: { replies: [], status: 'open' },
    freshness: { phase: 'current', overdue: false },
    aliases: [{ bucket: { kind: 'run', runId: 'r1' }, localId: id, visible: true }],
    rev: 1,
    homeRev: 1,
    createdAt: 1_000,
    amendedAt: 1_000,
    ...over,
  }
}

/** A throwaway config root with the backend singleton REALLY held, mirroring the
 *  sidecar suite: the assertion inside `SurfaceSidecar.open` is part of what U1e
 *  wires, so faking it would let it rot unnoticed. */
async function withConfigRoot(body: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'surface-wiring-'))
  const lockPath = join(dir, 'server.lock')
  if (!acquireBackendSingleton(lockPath).acquired) throw new Error('test setup could not acquire the singleton')
  try {
    await body(dir)
  } finally {
    rmSync(`${lockPath}.mark`, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('the persist-exempt emit', () => {
  // THE SEAM. Every `changes` emit is wired to `schedulePersist()`, so before
  // this flag existed "keep Run.slate byte-equivalent" and "schedule no core
  // document write for a canonical Surface mutation" could not both hold. The
  // scheduled TIMER is what the assertion reads, not the file bytes: a canonical
  // mutation whose derived projection happens to be unchanged would leave the
  // bytes identical either way, so a byte comparison would pass even with the
  // exemption backed out.
  it('emits a run delta and schedules no docstore.json write', async () => {
    vi.useFakeTimers()
    try {
      const dir = mkdtempSync(join(tmpdir(), 'surface-exempt-'))
      try {
        const file = join(dir, 'docstore.json')
        const store = new DocumentStore()
        store.enablePersistence(file)
        store.upsertRun('r1', makeRun())
        store.flush()
        const before = readFileSync(file, 'utf-8')
        expect(vi.getTimerCount()).toBe(0)

        store.loadSurfaces([surface('sf-1')])
        const changes: DocumentChange[] = []
        store.changes.on('change', c => changes.push(c as DocumentChange))
        const batches: unknown[] = []
        store.surfaceChanges.on('batch', b => batches.push(b))

        const result = await store.commitSurfaceContent({
          ...surface('sf-1'), rev: 2, content: { headline: 'moved on' }, amendedAt: 2_000,
        })
        expect(result.committed).toBe(true)

        // The compatibility channel: one run delta, so a client still rendering
        // the legacy Run Workspace learns the run moved.
        const runDeltas = changes.filter(c => c.entity === 'run' && c.id === 'r1')
        expect(runDeltas).toHaveLength(1)
        expect(runDeltas[0]!.persistExempt).toBe(true)
        // The canonical channel: one atomic batch, never one change per record.
        expect(batches).toHaveLength(1)

        // Nothing scheduled, nothing written.
        expect(vi.getTimerCount()).toBe(0)
        vi.advanceTimersByTime(5_000)
        expect(readFileSync(file, 'utf-8')).toBe(before)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    } finally {
      vi.useRealTimers()
    }
  })

  // The other half of the pair: the LEGACY bridge must still reach disk. If the
  // exemption ever widened to cover ordinary Slate writes, this fails — which is
  // the point, because the legacy bridge is still the write path until U2 and its
  // only durable home is `docstore.json`.
  it('leaves the legacy Slate bridge on the persistence path', () => {
    vi.useFakeTimers()
    try {
      const dir = mkdtempSync(join(tmpdir(), 'surface-exempt-legacy-'))
      try {
        const file = join(dir, 'docstore.json')
        const store = new DocumentStore()
        store.enablePersistence(file)
        store.upsertRun('r1', makeRun())
        store.flush()

        store.applyRunSlateProjection('r1', [{ id: 'p1', headline: 'still persisted?', author: 'agent' }])
        expect(vi.getTimerCount()).toBe(1)
        store.flush()
        const raw = JSON.parse(readFileSync(file, 'utf-8')) as { slatePoints?: unknown[] }
        expect(raw.slatePoints).toHaveLength(1)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('two stores, two snapshots', () => {
  // The stores must not replace each other's snapshots. Proven by holding a
  // Surface transaction OPEN at a named write step while the DocumentStore takes
  // unrelated mutations all the way to disk, then letting the Surface commit
  // finish — a real interleave, not a simulated one.
  it('keeps concurrent non-Surface mutations across a Surface commit', async () => {
    await withConfigRoot(async dir => {
      const docFile = join(dir, 'docstore.json')
      const store = new DocumentStore()
      store.enablePersistence(docFile)
      store.upsertRun('r1', makeRun())

      let release: (() => void) | undefined
      const held = new Promise<void>(resolve => { release = resolve })
      let armed = false
      const sidecar = SurfaceSidecar.open({
        dir,
        hooks: {
          beforeStep: async (step: SidecarWriteStep) => {
            if (!armed || step !== 'rename-primary') return
            armed = false
            await held
          },
        },
      })
      store.enableSurfacePersistence(sidecar)
      // Seed the canonical record the way a boot does: durable first, then in
      // memory. `commitSurfaceContent` compares against the PERSISTED revision, so
      // a record that only exists in memory is correctly refused as stale.
      await sidecar.commit({ puts: [surface('sf-1')] })
      store.loadSurfaces([surface('sf-1')])
      armed = true

      const commit = store.commitSurfaceContent({
        ...surface('sf-1'), rev: 2, content: { headline: 'canonical edit' },
      })
      // Give the transaction time to reach the paused step.
      await new Promise(r => setTimeout(r, 10))

      // Unrelated core-document work, all the way to disk, while the Surface
      // transaction is mid-write.
      store.upsertRun('r2', makeRun({ id: 'r2', sessionId: 'r2' }))
      store.applyRunSlateProjection('r1', [{ id: 'p1', headline: 'legacy point', author: 'agent' }])
      store.flush()

      release!()
      const result = await commit
      expect(result.committed).toBe(true)

      // Neither file lost the other's work.
      const doc = JSON.parse(readFileSync(docFile, 'utf-8')) as { runs: Run[]; slatePoints: unknown[] }
      expect(doc.runs.map(r => r.id).sort()).toEqual(['r1', 'r2'])
      expect(doc.slatePoints).toHaveLength(1)
      const sidecarFile = JSON.parse(readFileSync(surfaceSidecarPaths(dir).primary, 'utf-8')) as { records: Surface[] }
      expect(sidecarFile.records.map(r => r.id)).toEqual(['sf-1'])
      expect(sidecarFile.records[0]!.content.headline).toBe('canonical edit')
      // And the sidecar carries none of the core document's entities.
      expect(Object.keys(sidecarFile)).toEqual(['version', 'records', 'idempotency', 'topologyRevs'])
    })
  })
})

describe('the lifecycle cascade', () => {
  it('leaves no orphan canonical Surfaces when a space is deleted', async () => {
    await withConfigRoot(async dir => {
      const store = new DocumentStore()
      const sidecar = SurfaceSidecar.open({ dir })
      store.enableSurfacePersistence(sidecar)

      const bySpace = surface('sf-in-space')
      // The one a space-only sweep misses: migrated into the synthetic space-less
      // bucket (a run with no `spaceId` has to land somewhere) while still aliased
      // to a run that is about to be cleared.
      const byRun = surface('sf-spaceless', {
        spaceId: 'space-legacy-spaceless',
        home: { kind: 'canvas', spaceId: 'space-legacy-spaceless' },
      })
      const survivor = surface('sf-other-space', {
        spaceId: 'spc-b',
        home: { kind: 'canvas', spaceId: 'spc-b' },
        aliases: [{ bucket: { kind: 'run', runId: 'r-elsewhere' }, localId: 'x', visible: true }],
      })
      await sidecar.commit({ puts: [bySpace, byRun, survivor] })
      store.loadSurfaces([bySpace, byRun, survivor])

      store.upsertSpace(SPACE, { id: SPACE, name: 'A', createdAt: '2026-07-13T00:00:00.000Z' })
      store.upsertRun('r1', makeRun())
      store.activeSpaceId = SPACE
      store.clearSpace(SPACE)
      await store.flushSurfacePersistence()

      expect(store.getAllSurfaces().map(s => s.id)).toEqual(['sf-other-space'])
      expect(sidecar.durableRecords().map(s => s.id)).toEqual(['sf-other-space'])
      // And the snapshot the client hydrates from carries no orphan either.
      expect(store.snapshot().surfaces).toEqual([])
    })
  })

  it('cascades identically on the FAST_SIM boot clear', async () => {
    await withConfigRoot(async dir => {
      const store = new DocumentStore()
      const sidecar = SurfaceSidecar.open({ dir })
      store.enableSurfacePersistence(sidecar)
      const records = [surface('sf-1'), surface('sf-2', { spaceId: 'spc-b', home: { kind: 'canvas', spaceId: 'spc-b' } })]
      await sidecar.commit({ puts: records })
      store.loadSurfaces(records)

      // The branch `initBackend` takes on a FAST_SIM boot before seeding the
      // simulator space: no active space, so `clear()` clears everything.
      store.activeSpaceId = ''
      store.clear()
      await store.flushSurfacePersistence()

      expect(store.getAllSurfaces()).toEqual([])
      expect(sidecar.durableRecords()).toEqual([])
    })
  })
})

describe('a faulted load', () => {
  it('renders legacy Slate behind the degraded marker and keeps canonical projection empty', async () => {
    await withConfigRoot(async dir => {
      const paths = surfaceSidecarPaths(dir)
      // Both snapshots unreadable — the only state that faults. `missing` alone is
      // a first boot, not a fault.
      writeFileSync(paths.primary, '{ not json')
      writeFileSync(paths.backup, '{ also not json')
      const primaryBytes = readFileSync(paths.primary, 'utf-8')
      const backupBytes = readFileSync(paths.backup, 'utf-8')

      const docFile = join(dir, 'docstore.json')
      const store = new DocumentStore()
      store.enablePersistence(docFile)
      store.upsertSpace(SPACE, { id: SPACE, name: 'A', createdAt: '2026-07-13T00:00:00.000Z' })
      store.activeSpaceId = SPACE
      store.upsertRun('r1', makeRun())
      store.applyRunSlateProjection('r1', [{ id: 'p1', headline: 'the frozen copy', author: 'agent' }])
      store.flush()

      const boot = bootSurfaces(store, { dir })
      await boot.migration

      // The marker: explicit, and it names when the legacy copy was frozen.
      const health = store.surfaceHealth
      expect(health.health).toBe('faulted-read-only')
      expect(health.frozenAt).toBeTruthy()
      expect(Date.parse(health.frozenAt!)).not.toBeNaN()
      expect(health.detail).toMatch(/primary unparsable/)
      expect(store.snapshot().surfaceHealth).toEqual(health)

      // Canonical projection is EMPTY, not partial.
      expect(store.getAllSurfaces()).toEqual([])
      expect(store.snapshot().surfaces).toEqual([])

      // The legacy Slate is still rendered — it is the user's only copy, and
      // hiding it would be worse than showing it behind the marker.
      expect(store.getRun('r1')!.slate!.map(s => s.headline)).toEqual(['the frozen copy'])

      // Nothing may be written to a faulted store. The sidecar was never attached,
      // so a canonical mutation cannot reach it, and both files are byte untouched.
      expect(boot.sidecar).toBeNull()
      expect(readFileSync(paths.primary, 'utf-8')).toBe(primaryBytes)
      expect(readFileSync(paths.backup, 'utf-8')).toBe(backupBytes)
    })
  })

  it('reports a healthy first boot and migrates the legacy Slate into canonical records', async () => {
    await withConfigRoot(async dir => {
      const store = new DocumentStore()
      store.enablePersistence(join(dir, 'docstore.json'))
      store.upsertSpace(SPACE, { id: SPACE, name: 'A', createdAt: '2026-07-13T00:00:00.000Z' })
      store.activeSpaceId = SPACE
      store.upsertRun('r1', makeRun())
      store.applyRunSlateProjection('r1', [{ id: 'p1', headline: 'a real point', author: 'agent' }])

      const boot = bootSurfaces(store, { dir, now: 5_000 })
      const { report, commit } = await boot.migration
      expect(store.surfaceHealth.health).toBe('healthy')
      expect(report!.runsMigrated).toBe(1)
      expect(commit!.committed).toBe(true)

      // One compatibility root plus the point, and the Run Workspace projection is
      // untouched — the whole bar for U1.
      const headlines = store.getAllSurfaces().map(s => s.content.headline).sort()
      expect(headlines).toEqual(['a real point', 'r1'])
      expect(store.getRun('r1')!.slate!.map(s => s.headline)).toEqual(['a real point'])

      // Re-entrant: a second boot against the same records writes nothing new.
      const second = bootSurfaces(store, { dir, now: 6_000 })
      const secondReport = (await second.migration).report!
      expect(secondReport.surfacesCreated).toBe(0)
      expect(secondReport.surfacesUpdated).toBe(0)
      expect(secondReport.surfacesUnchanged).toBe(2)
    })
  })
})
