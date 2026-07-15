import { describe, it, expect, beforeEach } from 'vitest'
import { applyDelta, pruneHiddenForRemoval } from '../useServerEvents'
import type { Run } from '../../domain/types'

const LS_KEY = 'tinstar-hidden-runs'

function stored(): string[] {
  const raw = localStorage.getItem(LS_KEY)
  return raw ? (JSON.parse(raw) as string[]) : []
}

function run(id: string): Run {
  // Only id/marshal are read here, so a thin shape is enough; the cast keeps
  // the fixture from tracking the full Run interface.
  return { id, sessionId: id } as unknown as Run
}

function state(over: { runs?: Run[]; marshal?: Run | null }) {
  return { runs: over.runs ?? [], marshal: over.marshal ?? null } as never
}

describe('pruneHiddenForRemoval — run-removed prunes hidden-runs', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('prunes the deleted run id from the hidden set — a stale id must NOT survive a delete', () => {
    localStorage.setItem(LS_KEY, JSON.stringify(['dj', 'goose']))

    pruneHiddenForRemoval({ entity: 'run', id: 'dj', data: null })

    // Guard: revert the prune-on-remove side-effect and this fails — the ghost
    // "dj" survives and a future same-named run would be born hidden.
    expect(stored()).not.toContain('dj')
    expect(stored()).toContain('goose')
  })

  it('does not prune on a non-removal (run upsert) delta', () => {
    localStorage.setItem(LS_KEY, JSON.stringify(['dj']))
    pruneHiddenForRemoval({ entity: 'run', id: 'dj', data: { id: 'dj' } })
    expect(stored()).toContain('dj')
  })

  it('is a safe no-op when the removed id is not hidden', () => {
    localStorage.setItem(LS_KEY, JSON.stringify(['goose']))
    pruneHiddenForRemoval({ entity: 'run', id: 'dj', data: null })
    expect(stored()).toEqual(['goose'])
  })
})

describe('applyDelta stays pure — run-removed does not touch localStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('filters the removed run without writing to the hidden set', () => {
    localStorage.setItem(LS_KEY, JSON.stringify(['dj']))
    const prev = state({ runs: [run('dj'), run('goose')] })

    const next = applyDelta(prev, { entity: 'run', id: 'dj', data: null })

    expect((next as unknown as { runs: Run[] }).runs.map(r => r.id)).toEqual(['goose'])
    // Purity guard: the reducer must NOT mutate localStorage — the prune is the
    // call site's job (pruneHiddenForRemoval), keeping applyDelta side-effect-free.
    expect(stored()).toEqual(['dj'])
  })
})
