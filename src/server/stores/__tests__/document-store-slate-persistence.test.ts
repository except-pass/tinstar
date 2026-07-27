// @vitest-environment node
//
// CHARACTERIZATION coverage for U1 (canonical Surface model and crash-safe
// persistence). These tests pin the CURRENT behaviour of Slate points on the
// DocumentStore's persistence path, so that when U1 moves canonical ownership
// into a separate Surface store, any drift shows up here as a failure rather
// than as a silently different docstore.json.
//
// The existing Slate suites already characterize the PROJECTION half well
// (document-store-slate-bridge.test.ts covers run.slate field mapping, group,
// objective pinning, order, and clearSlateForRun; slate.test.ts covers the
// store's merge-by-id and lifecycle). What none of them covered is the half U1
// actually changes: the coupling between a Slate mutation and a core document
// write.
//
// U1's constraint is a pair that reads like a contradiction until you see the
// seam it requires:
//   · "keep `Run.slate` byte-equivalent through the existing bridge", and
//   · "do not schedule a core document write for a canonical Surface mutation".
// Both can hold only because `document-store.ts` wires EVERY `changes` emit to
// `schedulePersist()` unconditionally, so U1 has to introduce a persist-exempt
// emit for the derived projection. These tests capture the pre-U1 state of that
// coupling: today a Slate mutation DOES write docstore.json, and points DO
// round-trip through it. After U1, the legacy bridge must still round-trip
// exactly as pinned here, while canonical Surface mutations take a different
// path entirely.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentStore } from '../document-store'
import { OBJECTIVE_POINT_ID } from '../../../domain/types'
import type { Run } from '../../../domain/types'

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'r1', sessionId: 'r1', taskId: 't1', worktreeId: 'wt1',
    status: 'running', background: false, blocked: false,
    initiative: 'i', epic: 'e', task: 't', repo: 'r', worktree: 'w',
    touchedFiles: [], recapEntries: [], rawLogs: '',
    port: null, backend: null, createdAt: '2026-07-13T00:00:00.000Z',
    ...overrides,
  }
}

/** Run a body against a throwaway snapshot file, always cleaning the dir up. */
function withSnapshotFile(body: (file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'slate-persist-'))
  try {
    body(join(dir, 'snapshot.json'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('DocumentStore — Slate points on the persistence path (pre-U1 characterization)', () => {
  // The load side of the round trip is `data.slatePoints -> this.slate.loadPoints`.
  // If U1 moves ownership without keeping this shape, existing snapshots on disk
  // stop rehydrating and a user's Slate silently empties on restart.
  it('round-trips a point through docstore.json with body, thread, status, and author intact', () => {
    withSnapshotFile((file) => {
      const store = new DocumentStore()
      store.enablePersistence(file)
      store.upsertRun('r1', makeRun())
      store.applyRunSlateProjection('r1', [
        { id: 'p1', headline: 'Which rollback path?', author: 'agent', content: { root: 'c', components: [{ id: 'c', component: 'Text', text: 'body text' }] } as never },
      ])
      store.addSlateReply('r1', 'p1', { id: 'rep1', author: 'user', text: 'roll forward', createdAt: 1_000 })
      store.flush()

      const reloaded = new DocumentStore()
      reloaded.enablePersistence(file)
      const point = reloaded.getSlatePoint('r1', 'p1')
      expect(point).toBeTruthy()
      expect(point!.headline).toBe('Which rollback path?')
      expect(point!.author).toBe('agent')
      // The thread is store-owned and must survive the disk hop, not just the
      // in-memory merge — a reply the user typed is the least recoverable thing
      // on a point.
      expect(point!.replies?.map(r => r.text)).toEqual(['roll forward'])
      // Status is DERIVED from who spoke last; a user reply leaves it waiting.
      expect(point!.status).toBe('waiting')
    })
  })

  // THE COUPLING U1 BREAKS. `document-store.ts` subscribes persistence to the
  // change stream unconditionally, so any Slate mutation reaches disk. U1 keeps
  // this true for the legacy bridge while introducing a persist-exempt emit for
  // canonical Surface mutations — so this test is the "before" half of that
  // seam, and it should still pass after U1 lands.
  it('a Slate mutation reaches docstore.json (the change->persist coupling U1 must preserve for the legacy bridge)', () => {
    withSnapshotFile((file) => {
      const store = new DocumentStore()
      store.enablePersistence(file)
      store.upsertRun('r1', makeRun())
      store.applyRunSlateProjection('r1', [{ id: 'p1', headline: 'persisted?', author: 'agent' }])
      store.flush()

      const raw = JSON.parse(readFileSync(file, 'utf-8')) as { slatePoints?: unknown[] }
      expect(Array.isArray(raw.slatePoints)).toBe(true)
      expect(raw.slatePoints).toHaveLength(1)
    })
  })

  // The Objective is the one point the user authors and the one U1's migration
  // must not mangle: it is store-only (never file-projected) and carries the
  // reserved id. If a restart loses it, the run loses its stated goal.
  it('the user-authored Objective survives a persist/reload cycle as a user point', () => {
    withSnapshotFile((file) => {
      const store = new DocumentStore()
      store.enablePersistence(file)
      store.upsertRun('r1', makeRun())
      store.addUserSlatePoint('r1', { id: OBJECTIVE_POINT_ID, headline: 'Ship U1 invisibly', author: 'user' })
      store.flush()

      const reloaded = new DocumentStore()
      reloaded.enablePersistence(file)
      const objective = reloaded.getSlatePoint('r1', OBJECTIVE_POINT_ID)
      expect(objective).toBeTruthy()
      expect(objective!.source).toBe('user')
      // Projected as kind 'objective' only because source is user AND the id is
      // reserved — the pairing U1's migration has to carry across.
      const projected = reloaded.getRun('r1')!.slate!.find(s => s.id === OBJECTIVE_POINT_ID)
      expect(projected!.kind).toBe('objective')
    })
  })

  // Two runs may use the SAME local point id. Today they are disambiguated by
  // run scoping alone. U1 replaces that with a global, non-reusable Surface id,
  // so this pins the invariant it has to preserve: one run's point is never the
  // other's, however the identity is derived.
  it('keeps same-id points in different runs distinct across a reload', () => {
    withSnapshotFile((file) => {
      const store = new DocumentStore()
      store.enablePersistence(file)
      store.upsertRun('r1', makeRun({ id: 'r1', sessionId: 'r1' }))
      store.upsertRun('r2', makeRun({ id: 'r2', sessionId: 'r2' }))
      store.applyRunSlateProjection('r1', [{ id: 'shared-slug', headline: 'from r1', author: 'agent' }])
      store.applyRunSlateProjection('r2', [{ id: 'shared-slug', headline: 'from r2', author: 'agent' }])
      store.flush()

      const reloaded = new DocumentStore()
      reloaded.enablePersistence(file)
      expect(reloaded.getSlatePoint('r1', 'shared-slug')!.headline).toBe('from r1')
      expect(reloaded.getSlatePoint('r2', 'shared-slug')!.headline).toBe('from r2')
    })
  })
})
