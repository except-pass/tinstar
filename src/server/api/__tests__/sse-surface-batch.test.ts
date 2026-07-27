// @vitest-environment node
//
// U1e — the SSE half of the wiring. `SSEBroadcaster` previously derived every
// delta from one store's `changes` stream and snapshotted only that store; it now
// also carries canonical Surfaces, on their own channel and in the snapshot.
//
// The channel is separate on purpose, and the "one frame per batch" assertion
// below is what pins that: a Surface batch is ATOMIC and carries the space's
// post-mutation topology revision, so flattening it into per-record deltas would
// let a client render the half-applied frame where a grouped parent exists but
// its children are still siblings.
import { describe, it, expect, afterEach } from 'vitest'
import type { ServerResponse } from 'node:http'
import { SSEBroadcaster, SURFACE_BATCH_EVENT } from '../sse'
import { DocumentStore } from '../../stores/document-store'
import type { Surface, SurfaceHome } from '../../../domain/types'

const SPACE = 'spc-a'
const CANVAS: SurfaceHome = { kind: 'canvas', spaceId: SPACE }

/** The smallest thing `SSEBroadcaster` treats as a client: something it can
 *  `writeHead`/`write` to and ask whether it is destroyed. */
function fakeClient(): { res: ServerResponse; frames: string[] } {
  const frames: string[] = []
  const res = {
    destroyed: false,
    writeHead() { return res },
    write(chunk: string) { frames.push(chunk); return true },
    on() { return res },
    end() { /* no-op */ },
  } as unknown as ServerResponse
  return { res, frames }
}

/** Parse `event: X\ndata: {...}\n\n` frames into (event, payload) pairs. */
function parse(frames: string[]): { event: string; data: unknown }[] {
  return frames.map(f => {
    const [head, body] = f.split('\n')
    return { event: head!.replace('event: ', ''), data: JSON.parse(body!.replace('data: ', '')) }
  })
}

function surface(id: string, over: Partial<Surface> = {}): Surface {
  return {
    id, spaceId: SPACE, home: CANVAS,
    content: { headline: id },
    contentAuthority: 'canonical-direct',
    author: 'agent',
    thread: { replies: [], status: 'open' },
    freshness: { phase: 'current', overdue: false },
    rev: 1, homeRev: 1, createdAt: 1_000, amendedAt: 1_000,
    ...over,
  }
}

let sse: SSEBroadcaster | null = null
afterEach(() => { sse?.destroy(); sse = null })

describe('SSEBroadcaster — canonical Surfaces', () => {
  it('sends canonical Surfaces and the store health in the connect snapshot', () => {
    const store = new DocumentStore()
    store.upsertSpace(SPACE, { id: SPACE, name: 'A', createdAt: '2026-07-13T00:00:00.000Z' })
    store.activeSpaceId = SPACE
    store.loadSurfaces([surface('sf-1'), surface('sf-other', { spaceId: 'spc-b', home: { kind: 'canvas', spaceId: 'spc-b' } })])
    sse = new SSEBroadcaster(store)

    const client = fakeClient()
    sse.addClient(client.res)

    const [frame] = parse(client.frames)
    expect(frame!.event).toBe('snapshot')
    const snapshot = frame!.data as { surfaces: Surface[]; surfaceHealth: { health: string } }
    // Space-filtered like every other space-scoped entity in the snapshot.
    expect(snapshot.surfaces.map(s => s.id)).toEqual(['sf-1'])
    expect(snapshot.surfaceHealth.health).toBe('healthy')
  })

  it('broadcasts one ordered batch per canonical mutation', async () => {
    const store = new DocumentStore()
    store.activeSpaceId = SPACE
    store.loadSurfaces([surface('sf-1')])
    sse = new SSEBroadcaster(store)
    const client = fakeClient()
    sse.addClient(client.res)
    client.frames.length = 0

    await store.commitSurfaceContent({ ...surface('sf-1'), rev: 2, content: { headline: 'edited' } })

    const batches = parse(client.frames).filter(f => f.event === SURFACE_BATCH_EVENT)
    expect(batches).toHaveLength(1)
    const batch = batches[0]!.data as { spaceId: string; topologyRev: number; changes: { id: string }[] }
    expect(batch.spaceId).toBe(SPACE)
    expect(batch.changes.map(c => c.id)).toEqual(['sf-1'])
  })

  it('suppresses batches for a space that is not active', async () => {
    const store = new DocumentStore()
    store.activeSpaceId = 'spc-elsewhere'
    store.loadSurfaces([surface('sf-1')])
    sse = new SSEBroadcaster(store)
    const client = fakeClient()
    sse.addClient(client.res)
    client.frames.length = 0

    await store.commitSurfaceContent({ ...surface('sf-1'), rev: 2, content: { headline: 'edited' } })

    expect(parse(client.frames).filter(f => f.event === SURFACE_BATCH_EVENT)).toHaveLength(0)
  })
})
