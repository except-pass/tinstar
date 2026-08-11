// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { DocumentStore } from '../../stores/document-store'
import { SurfaceService } from '../surface-service'
import { SurfaceComposeCoordinator } from '../surface-compose-coordinator'

const ACTOR = { kind: 'human' as const, id: 'user' }

async function harness(deadlineAt = 10_000) {
  const docStore = new DocumentStore()
  const service = new SurfaceService(docStore)
  await service.reserveComposition({
    id: 'sf-1', spaceId: 'space-1', home: { kind: 'canvas', spaceId: 'space-1' },
    runId: 'run-1', localId: 'compose-1', label: 'Open points',
    request: { templateId: 'open-points' }, token: 'token-1', deadlineAt,
    source: { adapter: 'slate-file', locator: 'file:compose-1.json#compose-1', generation: 0, state: 'missing' },
  }, { actor: ACTOR, at: 1_000 })
  const reobserve = vi.fn(async () => {})
  const coordinator = new SurfaceComposeCoordinator(docStore, service, reobserve, () => 20_000)
  return { docStore, service, coordinator, reobserve }
}

describe('SurfaceComposeCoordinator', () => {
  it('re-observes once and fails the same card after an unsuccessful author exit', async () => {
    const h = await harness()
    await h.coordinator.settleExit('sf-1', 'token-1', { code: 1, signal: null, timedOut: false })
    expect(h.reobserve).toHaveBeenCalledWith('run-1')
    expect(h.docStore.getSurface('sf-1')!.creation).toMatchObject({
      phase: 'failed', token: 'token-1', failure: { code: 'author-failed' },
    })
  })

  it('does not call a clean process exit success — valid watched content is success', async () => {
    const h = await harness()
    await h.coordinator.settleExit('sf-1', 'token-1', { code: 0, signal: null, timedOut: false })
    expect(h.reobserve).not.toHaveBeenCalled()
    expect(h.docStore.getSurface('sf-1')!.creation!.phase).toBe('authoring')
  })

  it('fails current invalid output but ignores an invalid stale attempt', async () => {
    const h = await harness()
    await h.coordinator.rejectInvalidOutput('run-1', 'compose-1.json', 'compose-1', 'old-token')
    expect(h.docStore.getSurface('sf-1')!.creation!.phase).toBe('authoring')

    await h.coordinator.rejectInvalidOutput('run-1', 'compose-1.json', 'compose-1', 'token-1')
    expect(h.docStore.getSurface('sf-1')!.creation).toMatchObject({
      phase: 'failed', failure: { code: 'invalid-content' },
    })
  })

  it('ignores an invalid entry from a file other than the assigned destination', async () => {
    const h = await harness()
    await h.coordinator.rejectInvalidOutput('run-1', 'unrelated.json', 'compose-1', 'token-1')
    expect(h.docStore.getSurface('sf-1')!.creation!.phase).toBe('authoring')
  })

  it('ends an overdue attempt after one final source observation', async () => {
    const h = await harness(5_000)
    expect(await h.coordinator.sweep()).toEqual(['sf-1'])
    expect(h.reobserve).toHaveBeenCalledWith('run-1')
    expect(h.docStore.getSurface('sf-1')!.creation?.failure?.code).toBe('timed-out')
  })

  it('re-observes a run only once when several cards expire together', async () => {
    const h = await harness(5_000)
    await h.service.reserveComposition({
      id: 'sf-2', spaceId: 'space-1', home: { kind: 'canvas', spaceId: 'space-1' },
      runId: 'run-1', localId: 'compose-2', label: 'Checklist',
      request: { templateId: 'checklist' }, token: 'token-2', deadlineAt: 5_000,
      source: { adapter: 'slate-file', locator: 'file:compose-2.json#compose-2', generation: 0, state: 'missing' },
    }, { actor: ACTOR, at: 1_000 })

    expect(await h.coordinator.sweep()).toEqual(['sf-1', 'sf-2'])
    expect(h.reobserve).toHaveBeenCalledTimes(1)
  })

  it('re-observes before restart failure and leaves a card ready when that observation completes it', async () => {
    const h = await harness()
    h.reobserve.mockImplementationOnce(async () => {
      const current = h.docStore.getSurface('sf-1')!
      await h.service.completeComposition('sf-1', {
        token: 'token-1', expectedRev: current.rev, content: { headline: 'No open points' },
      }, { actor: ACTOR, at: 20_000 })
    })
    expect(await h.coordinator.recover()).toEqual({ failed: [] })
    expect(h.docStore.getSurface('sf-1')!.creation?.phase).toBe('ready')
  })
})
