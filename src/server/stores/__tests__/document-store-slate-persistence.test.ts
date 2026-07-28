// @vitest-environment node
//
// The LEGACY Slate points on the persistence path, after U2 retired them as a
// write path.
//
// `docstore.json` still carries a `slatePoints` array and still rehydrates it, and
// that is now its whole job: KTD5 keeps legacy Slate data "in the existing document
// snapshot as migration evidence but … no longer rewritten by canonical Surface
// mutations". The boot migration adopts any point with no canonical counterpart yet;
// nothing else reads it.
//
// So what these tests pin is the EVIDENCE contract — an existing snapshot on disk
// still loads, whole, with threads and lifecycle stamps intact — plus the property
// that makes retiring the write path safe: a canonical mutation does not schedule a
// core document write, and `Run.slate` renders canonical records rather than these.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentStore } from '../document-store'
import { OBJECTIVE_POINT_ID } from '../../../domain/types'
import type { Point, Run } from '../../../domain/types'
import { seedRunSlate } from './seedRunSlate'
import { RunSlateBridge } from '../../surfaces/run-slate-bridge'
import { SurfaceService } from '../../surfaces/surface-service'
import type { SurfacePrincipalRef } from '../../../domain/types'

const USER: SurfacePrincipalRef = { kind: 'human', id: 'actor-1' }

/** One legacy point, as an existing `docstore.json` states it. */
function legacyPoint(over: Partial<Point> = {}): Point {
  return {
    id: 'p1', runId: 'r1', author: 'agent', source: 'file',
    headline: 'Which rollback path?', status: 'waiting',
    replies: [{ id: 'rep1', author: 'user', text: 'roll forward', createdAt: 1_000 }],
    createdAt: 1, amendedAt: 2, ...over,
  }
}

/** Write a snapshot by hand — the only way to produce legacy points now that
 *  nothing in the process writes them. Which is the point of the test: the file on
 *  a user's disk predates U2, and it still has to load. */
function writeSnapshot(file: string, data: Record<string, unknown>): void {
  writeFileSync(file, JSON.stringify({ runs: [], slatePoints: [], ...data }))
}

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

describe('legacy Slate points are migration EVIDENCE, not a write path', () => {
  it('rehydrates an existing snapshot whole — body, thread, status, and author intact', () => {
    withSnapshotFile((file) => {
      writeSnapshot(file, {
        runs: [makeRun()],
        slatePoints: [legacyPoint({
          content: { root: 'c', components: [{ id: 'c', component: 'Text', text: 'body text' }] } as never,
        })],
      })

      const store = new DocumentStore()
      store.enablePersistence(file)

      // Read off the LEGACY accessor. `getSlatePointsForRun` projects canonical
      // records now, so it deliberately does NOT see these.
      const points = store.getAllSlatePoints()
      expect(points).toHaveLength(1)
      expect(points[0]!.headline).toBe('Which rollback path?')
      expect(points[0]!.author).toBe('agent')
      // The thread is the least recoverable thing on a point and has to survive the
      // disk hop, not just the in-memory merge.
      expect(points[0]!.replies?.map(r => r.text)).toEqual(['roll forward'])
      expect(points[0]!.status).toBe('waiting')
    })
  })

  it('keeps same-id points in different runs distinct across a reload', () => {
    withSnapshotFile((file) => {
      writeSnapshot(file, {
        runs: [makeRun({ id: 'r1', sessionId: 'r1' }), makeRun({ id: 'r2', sessionId: 'r2' })],
        slatePoints: [
          legacyPoint({ id: 'shared-slug', runId: 'r1', headline: 'from r1' }),
          legacyPoint({ id: 'shared-slug', runId: 'r2', headline: 'from r2' }),
        ],
      })

      const store = new DocumentStore()
      store.enablePersistence(file)
      const byRun = new Map(store.getAllSlatePoints().map(p => [p.runId, p.headline]))
      expect(byRun.get('r1')).toBe('from r1')
      expect(byRun.get('r2')).toBe('from r2')
    })
  })

  it('does not render legacy points — Run.slate comes from canonical Surfaces', () => {
    withSnapshotFile((file) => {
      writeSnapshot(file, { runs: [makeRun()], slatePoints: [legacyPoint()] })
      const store = new DocumentStore()
      store.enablePersistence(file)

      // Present as evidence, absent from the rendered channel: the boot migration
      // is what turns one into the other, and it has not run here.
      expect(store.getAllSlatePoints()).toHaveLength(1)
      expect(store.getRun('r1')!.slate).toBeUndefined()
    })
  })

  it('a canonical Slate mutation does NOT rewrite the legacy points in docstore.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-persist-'))
    try {
      {
        {
          const file = join(dir, 'snapshot.json')
          writeSnapshot(file, { runs: [makeRun()], slatePoints: [legacyPoint()] })
          const store = new DocumentStore()
          store.enablePersistence(file)

          await seedRunSlate(store, 'r1', [{ id: 'canonical-1', headline: 'authored now' }])
          await new RunSlateBridge(store, new SurfaceService(store))
            .upsertUserPoint('r1', { id: OBJECTIVE_POINT_ID, headline: 'Ship U2' }, USER)
          store.flush()

          // The frozen evidence is byte-identical: canonical work goes to the Surface
          // sidecar, and re-authoring this array from it would be the data loss the
          // adopt-only migration exists to prevent.
          const raw = JSON.parse(readFileSync(file, 'utf-8')) as { slatePoints?: Point[] }
          expect(raw.slatePoints).toHaveLength(1)
          expect(raw.slatePoints![0]!.id).toBe('p1')
          // And the rendered Slate is the canonical work, not the evidence.
          expect(store.getRun('r1')!.slate!.map(s => s.id).sort())
            .toEqual([OBJECTIVE_POINT_ID, 'canonical-1'].sort())
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
