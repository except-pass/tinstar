// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RecapEntry, Run } from '../../../domain/types'
import { DocumentStore, MAX_RECAP_ENTRIES } from '../document-store'

function makeRun(recapEntries: RecapEntry[] = []): Run {
  return {
    id: 'run-1', sessionId: 'run-1', taskId: 'task-1', worktreeId: 'wt-1',
    status: 'running', background: false, blocked: false,
    initiative: 'initiative', epic: 'epic', task: 'task', repo: 'repo', worktree: 'worktree',
    touchedFiles: [], recapEntries, rawLogs: '', port: null, backend: null,
    createdAt: '2026-08-11T12:00:00.000Z',
  }
}

describe('DocumentStore recap entries', () => {
  it('treats repeated stable IDs as no-ops', () => {
    const store = new DocumentStore()
    store.upsertRun('run-1', makeRun())
    const events: unknown[] = []
    store.changes.on('change', event => events.push(event))

    const turn: RecapEntry[] = [
      { id: 'prompt-1', type: 'user', content: 'Ship it', timestamp: '2026-08-11T12:00:00.000Z' },
      { id: 'complete-1', type: 'status', statusKind: 'completed', content: 'Completed', durationMs: 72_000, timestamp: '2026-08-11T12:01:12.000Z' },
      { id: 'answer-1', type: 'agent', content: 'Done', timestamp: '2026-08-11T12:01:12.000Z' },
    ]

    for (const entry of turn) store.addRecapEntry('run-1', entry)
    for (const entry of turn) store.addRecapEntry('run-1', { ...entry })

    expect(store.getRun('run-1')?.recapEntries).toEqual(turn)
    expect(events).toHaveLength(3)
  })

  it('keeps identical text when native identities differ even at the same timestamp', () => {
    const store = new DocumentStore()
    store.upsertRun('run-1', makeRun())

    store.addRecapEntry('run-1', { id: 'prompt-1', type: 'user', content: 'Again', timestamp: '2026-08-11T12:00:00.000Z' })
    store.addRecapEntry('run-1', { id: 'prompt-2', type: 'user', content: 'Again', timestamp: '2026-08-11T12:00:00.000Z' })

    expect(store.getRun('run-1')?.recapEntries).toHaveLength(2)
  })

  it(`keeps only the newest ${MAX_RECAP_ENTRIES} recap entries across add and upsert`, () => {
    const store = new DocumentStore()
    store.upsertRun('run-1', makeRun())

    for (let i = 0; i < MAX_RECAP_ENTRIES + 25; i++) {
      store.addRecapEntry('run-1', {
        id: `e-${i}`,
        type: 'agent',
        content: `msg ${i}`,
        timestamp: `2026-08-11T12:00:${String(i % 60).padStart(2, '0')}.000Z`,
      })
    }

    const afterAdds = store.getRun('run-1')!.recapEntries
    expect(afterAdds).toHaveLength(MAX_RECAP_ENTRIES)
    expect(afterAdds[0]?.id).toBe('e-25')
    expect(afterAdds.at(-1)?.id).toBe(`e-${MAX_RECAP_ENTRIES + 24}`)

    store.upsertRun('run-1', makeRun([
      ...Array.from({ length: MAX_RECAP_ENTRIES + 10 }, (_, i) => ({
        id: `u-${i}`,
        type: 'user' as const,
        content: `u ${i}`,
      })),
    ]))
    const afterUpsert = store.getRun('run-1')!.recapEntries
    expect(afterUpsert).toHaveLength(MAX_RECAP_ENTRIES)
    expect(afterUpsert[0]?.id).toBe('u-10')
    expect(afterUpsert.at(-1)?.id).toBe(`u-${MAX_RECAP_ENTRIES + 9}`)
  })

  it('normalizes exact legacy duplicates on load and preserves chronology', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recap-store-'))
    const file = join(dir, 'docstore.json')
    try {
      const prompt = { id: '11111111-1111-4111-8111-111111111111', type: 'user', content: 'Hello', timestamp: '2026-08-11T12:00:00.000Z' } satisfies RecapEntry
      const completed = { id: '22222222-2222-4222-8222-222222222222', type: 'status', statusKind: 'completed', content: 'Completed', durationMs: 900, timestamp: '2026-08-11T12:00:00.900Z' } satisfies RecapEntry
      writeFileSync(file, JSON.stringify({
        runs: [makeRun([
          prompt,
          { ...prompt, id: '33333333-3333-4333-8333-333333333333' },
          completed,
          { ...completed, id: '44444444-4444-4444-8444-444444444444' },
          { id: 'answer-1', type: 'agent', content: 'Hi', timestamp: '2026-08-11T12:00:00.900Z' },
        ])],
      }))

      const store = new DocumentStore()
      store.enablePersistence(file)

      expect(store.getRun('run-1')?.recapEntries.map(entry => entry.id)).toEqual([
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        'answer-1',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each([72_000, undefined])('round-trips completion duration %s', (durationMs) => {
    const dir = mkdtempSync(join(tmpdir(), 'recap-store-'))
    const file = join(dir, 'docstore.json')
    try {
      const store = new DocumentStore()
      store.enablePersistence(file)
      store.upsertRun('run-1', makeRun())
      store.addRecapEntry('run-1', {
        id: 'complete-1', type: 'status', statusKind: 'completed', content: 'Completed',
        ...(durationMs === undefined ? {} : { durationMs }),
      })
      store.flush()

      const persisted = JSON.parse(readFileSync(file, 'utf8'))
      expect(persisted.runs[0].recapEntries[0]).toMatchObject({
        id: 'complete-1', statusKind: 'completed', ...(durationMs === undefined ? {} : { durationMs }),
      })

      const reloaded = new DocumentStore()
      reloaded.enablePersistence(file)
      expect(reloaded.getRun('run-1')?.recapEntries[0]).toEqual(store.getRun('run-1')?.recapEntries[0])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
