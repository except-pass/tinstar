import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CardLeases, sourceWriteDispatched, sourceWriteRecoveryAge } from '../cardLeases'
import { ReconciliationSources } from '../index'
import { WorkflowContent } from '../workflowContent'
import { WorkReader } from '../workReader'
import { NotionApi } from '../notionApi'

const roots: string[] = []
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const card = 'a'.repeat(32)
const config = { notion: { token: 'fixture', dataSourceId: 'b'.repeat(32) }, fleet: [], warnings: [] }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tinstar-write-recovery-')); roots.push(root)
  const comments: Array<{ id: string; rich_text: unknown }> = []
  let state: 'lost-applied' | 'lost-absent' | 'offline' | 'complete' | 'truncated' = 'complete'
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === 'POST') {
      if (state !== 'lost-absent') comments.push({ id: 'note', rich_text: JSON.parse(String(init.body)).rich_text })
      throw new Error('Response interrupted')
    }
    if (state === 'offline') throw new Error('Source unavailable')
    return new Response(JSON.stringify({ results: comments, has_more: state === 'truncated' }))
  })
  const api = new NotionApi(fetcher, 0), leases = new CardLeases(root)
  const reader = new WorkReader(config.notion, api); reader.leases = leases
  return { root, leases, api, fetcher, comments, content: new WorkflowContent(reader), set: (value: typeof state) => { state = value } }
}

it('settles a landed reminder in finally after its response is interrupted', async () => {
  const f = fixture(); f.set('lost-applied')
  await expect(f.content.note(card, 'Reminder', 'unique-reminder')).rejects.toThrow('Response interrupted')
  expect(f.leases.pendingWrites()).toEqual([])
  expect(f.comments).toHaveLength(1)
  expect(f.leases.events()).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'write-completed' })]))
})

it.each(['applied', 'different'] as const)('recovers an old interrupted reminder after restart with source state %s', async state => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const f = fixture(); f.set('lost-absent')
  await expect(f.content.note(card, 'Reminder', 'unique-reminder')).rejects.toThrow('Response interrupted')
  if (state === 'applied') f.comments.push({ id: 'landed', rich_text: [{ text: { content: 'Reminder\nunique-reminder' } }] })
  const restarted = new ReconciliationSources(config, f.fetcher, f.api, f.root)
  await restarted.recoverSourceWrites()
  expect(restarted.leases.pendingWrites()).toHaveLength(1)
  vi.setSystemTime(Date.now() + sourceWriteRecoveryAge + 1)
  await restarted.recoverSourceWrites()
  expect(restarted.leases.pendingWrites()).toEqual([])
  const recovered = restarted.leases.events().find(row => row.type === 'write-reconciled')!
  expect(JSON.parse(String(recovered.detail))).toMatchObject({ source_state: state })
  // Recovery never sends a second comment.
  expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
})

it.each(['offline', 'truncated'] as const)('retains an old reservation on %s readback and recovers when complete reads return', async state => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const f = fixture(); f.set('lost-absent')
  await expect(f.content.note(card, 'Reminder', 'unique-reminder')).rejects.toThrow()
  vi.setSystemTime(Date.now() + sourceWriteRecoveryAge + 1)
  const restarted = new ReconciliationSources(config, f.fetcher, f.api, f.root)
  f.set(state)
  await restarted.recoverSourceWrites()
  expect(restarted.leases.pendingWrites()).toHaveLength(1)
  f.set('complete')
  await restarted.recoverSourceWrites()
  expect(restarted.leases.pendingWrites()).toEqual([])
})

it('never reconciles a still-running write even when its reservation is old', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const f = fixture()
  let finish!: () => void, started!: () => void
  const wait = new Promise<void>(resolve => { finish = resolve }), began = new Promise<void>(resolve => { started = resolve })
  const write = f.leases.mutate(card, async () => { sourceWriteDispatched(); started(); await wait }, { kind: 'note', text: 'Reminder' })
  await began
  try {
    await expect(f.leases.mutate(card, async () => undefined)).rejects.toThrow('Source write unresolved')
    vi.setSystemTime(Date.now() + sourceWriteRecoveryAge + 1)
    const restarted = new ReconciliationSources(config, f.fetcher, f.api, f.root)
    await restarted.recoverSourceWrites()
    expect(f.leases.pendingWrites()).toHaveLength(1)
    expect(f.fetcher).not.toHaveBeenCalled()
  } finally { finish(); await write }
  expect(f.leases.pendingWrites()).toEqual([])
})
