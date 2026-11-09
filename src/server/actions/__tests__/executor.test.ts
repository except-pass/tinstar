import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { ActionStore } from '../store'
import { ActionExecutor } from '../executor'
import { simulateRunner } from '../runner'
import { sourceDigest } from '../examples'
import { head, snapshot, installed, run, policy } from './fixtures'
import type { ActionCandidate, ActionSnapshot } from '../../../shared/actions'
const candidate = (action: ActionCandidate): ActionCandidate => ({ manifest: action.manifest, source: action.source })
const cleanup: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(cleanup.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup(id = 'explain', read: (url: string) => Promise<ActionSnapshot> = async url => snapshot(Number(url.split('/').pop()))) {
  const root = await mkdtemp(join(tmpdir(), 'tinstar-actions-')); cleanup.push(root)
  const store = new ActionStore(root), action = await store.install(candidate(installed(id)), 'owner')
  return { root, store, action, executor: new ActionExecutor(store, read, policy) }
}
// Every run fsyncs the audit log. That exceeds the 5s default when the rest of
// the suite is also staging a runtime and starting bubblewrap.
describe('durable executor runs', () => {
it('installs immutable readable source with owner grants, rolls back without inheriting broader grants and retains receipts', async () => {
  const { store, executor, action, root } = await setup()
  const input = run(action)
  const id = await executor.start(input); await executor.wait(id)
  const broadened = { ...action, manifest: { ...action.manifest, version: 'v2', capabilities: ['explain', 'repair.update'] as const } }
  await store.install(candidate({ ...broadened, manifest: { ...broadened.manifest, capabilities: [...broadened.manifest.capabilities] } }), 'second-owner')
  expect((await store.inspect('explain')).grant.actor).toBe('second-owner')
  await store.rollback('explain', 'v1', 'owner')
  expect((await store.inspect('explain')).grant.capabilities).toEqual(['explain'])
  expect((await store.receipts())[0]).toMatchObject({ version: 'v1', outcome: 'simulated', actualGitHubWrites: 0, exercised: [], resultingSha: null })
  expect(await readFile(join(root, 'explain/versions/v1/implementation.mjs'), 'utf8')).toBe(action.source)
  await expect(store.install(candidate(action), 'owner')).rejects.toThrow()
  await expect(store.rollback('explain', '../v1', 'owner')).rejects.toThrow()
  await writeFile(join(root, 'explain/versions/v1/implementation.mjs'), 'different code')
  await expect(store.inspect('explain')).rejects.toThrow('binding changed')
})
it('binds grants to reviewed source and version; does not evaluate custom code with host-file/network/process attempts', async () => {
  const { store } = await setup()
  const action = installed('explain')
  await expect(store.install(candidate({ ...action, source: 'changed' }), 'owner')).rejects.toThrow('digest')
  const source = "import fs from 'node:fs'; import https from 'node:https'; import {execSync} from 'node:child_process'; fs.readFileSync('/home/farm/.config/gh/hosts.yml'); https.get('https://example.test'); execSync('touch /tmp/should-never-exist');"
  const custom = { ...action, source, manifest: { ...action.manifest, id: 'custom', digest: sourceDigest(source) } }
  const installedCustom = await store.install(candidate(custom), 'owner')
  expect(() => simulateRunner(installedCustom, head, new AbortController().signal)).toThrow('no approved distinct-identity isolation')
  const executor = new ActionExecutor(store, async () => { throw new Error('Provider must not be called') }, policy)
  const id = await executor.start(run(installedCustom)); await executor.wait(id)
  expect((await store.receipts()).find(row => row.runId === id)).toMatchObject({ outcome: 'skipped', live: null, actualGitHubWrites: 0 })
})
it('shares duplicate locking across PRs and Releases while retaining per-item failure and correct owner/idempotency', async () => {
  let resume!: () => void
  const paused = new Promise<void>(resolve => { resume = resolve })
  const read = vi.fn(async () => { await paused; return snapshot() })
  const { store, action, executor } = await setup('explain', read)
  const first = await executor.start(run(action))
  await vi.waitFor(() => expect(read).toHaveBeenCalled())
  const secondExecutor = new ActionExecutor(store, async () => snapshot(), policy)
  const secondInput = { ...run(action), view: { scene: 'releases' as const } }
  const second = await secondExecutor.start(secondInput); await secondExecutor.wait(second)
  expect((await store.receipts()).find(row => row.runId === second)?.reasons.join()).toContain('already locked')
  resume(); await executor.wait(first)
  expect((await store.receipts()).find(row => row.runId === first)?.outcome).toBe('simulated')
  expect(await secondExecutor.start(secondInput)).toBe(second)
  await expect(secondExecutor.start({ ...secondInput, actor: 'another-owner' })).rejects.toThrow('Idempotency')
})
it('keeps in-progress execution on original version after rollback and refuses changed heads on each item', async () => {
  const { store, action, executor } = await setup('explain', async () => ({ ...snapshot(), head: 'c'.repeat(40) }))
  const id = await executor.start(run(action)); await executor.wait(id)
  expect((await store.receipts())[0]?.reasons.join()).toContain('head/base changed')
})
it('cancellation stops unsent operations and restart reconciles unfinished intent as unknown without retry', async () => {
  let resume!: () => void
  const gate = new Promise<void>(resolve => { resume = resolve })
  const read = vi.fn(async () => { await gate; return snapshot() })
  const { store, executor, action } = await setup('explain', read)
  const input = run(action, [snapshot(), snapshot(2)]), id = await executor.start(input)
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  await executor.cancel(id, 'owner'); resume(); await executor.wait(id)
  expect((await store.receipts()).every(row => row.outcome === 'cancelled')).toBe(true)
  expect(read).toHaveBeenCalledTimes(1)
  const unfinished = { ...(await store.receipts())[0]!, id: 'unfinished', runId: randomUUID(), outcome: 'intent' as const, finishedAt: null }
  await store.append(unfinished)
  const reloaded = new ActionStore(store.root); await reloaded.reconcileInterrupted()
  expect((await reloaded.receipts()).find(row => row.id === 'unfinished')).toMatchObject({ outcome: 'unknown', actualGitHubWrites: 0, resultingSha: null })
})
it('refuses Admin Merge globally for all ten targets while retaining per-target evidence and provider failures', async () => {
  const targets = Array.from({ length: 10 }, (_, i) => snapshot(i + 1))
  const { store, executor, action } = await setup('admin-merge', async url => {
    const number = Number(url.split('/').pop()), live = snapshot(number)
    if (number === 2) live.head = 'c'.repeat(40)
    if (number === 3) live.checks = []
    if (number === 4) live.threadsResolved = false
    if (number === 5) throw new Error('Synthetic provider partial failure')
    if (number === 6) live.checksComplete = false
    return live
  })
  const input = { ...run(action, targets), mode: 'coordinated' as const }
  const id = await executor.start(input); await executor.wait(id)
  const receipts = await store.receipts()
  expect(receipts).toHaveLength(10)
  expect(receipts.filter(row => row.outcome === 'simulated')).toHaveLength(0)
  expect(receipts.filter(row => row.outcome === 'skipped')).toHaveLength(10)
  expect(receipts.every(row => row.actualGitHubWrites === 0 && row.resultingSha === null && row.worker === 'Unknown')).toBe(true)
  expect(receipts.every(row => row.providerRequest === null)).toBe(true)
  expect(receipts.filter(row => row.reasons.includes('Admin Merge is globally disabled; no live Merge adapter exists'))).toHaveLength(9)
  expect(receipts[0]?.plan.join()).toContain('dependency order unknown')
  expect(receipts.every(row => row.mode === 'coordinated' && row.order >= 0)).toBe(true)
})
it('simulates one rerun once across restart with exact run/job identity, never a broad workflow dispatch', async () => {
  const { store, action } = await setup('fix-ci')
  const job = { id: 123, runId: 456, head, status: 'completed', conclusion: 'failure', runAttempt: 1, dependentJobs: [] }
  const repair = { kind: 'repair.rerun' as const, jobId: 123, runId: 456, expectedHead: head, attempt: 1 as const }
  for (let index = 0; index < 2; index++) {
    const executor = new ActionExecutor(store, async () => snapshot(), policy, async () => job)
    const id = await executor.start({ ...run(action), repair }); await executor.wait(id)
  }
  const rows = await store.receipts()
  expect(rows[0]).toMatchObject({ outcome: 'simulated', providerRequest: { path: '/repos/fortresspower/cmsandbox/actions/jobs/123/rerun' } })
  expect(rows[1]?.reasons.join()).toContain('one rerun')
  expect(rows[1]?.providerRequest).toBeNull()
})
it('unavailable audit storage prevents even simulated effects', async () => {
  const { store, executor, action } = await setup()
  const append = vi.spyOn(store, 'append').mockRejectedValue(new Error('Disk unavailable'))
  await expect(executor.start(run(action))).rejects.toThrow('Disk unavailable')
  expect(append).toHaveBeenCalledTimes(1)
})
it('retains installed catalog after locks/receipts exist and keeps runs on the captured version across rollback', async () => {
  let resume!: () => void
  const gate = new Promise<void>(resolve => { resume = resolve })
  const { store, action, executor } = await setup('explain', async () => { await gate; return snapshot() })
  const v2 = await store.install({ source: action.source, manifest: { ...action.manifest, version: 'v2' } }, 'owner')
  const id = await executor.start(run(v2))
  await store.rollback('explain', 'v1', 'owner')
  resume(); await executor.wait(id)
  expect((await store.list())[0]?.manifest.version).toBe('v1')
  expect((await store.receipts())[0]).toMatchObject({ version: 'v2', outcome: 'simulated' })
  await expect(store.install({ source: action.source, manifest: { ...action.manifest, id: 'runs' } }, 'owner')).rejects.toThrow('reserved')
})
it('coordinates ten Fix CI investigations with shared failures but no branch dispatch, and bounds timed-out unsent work', async () => {
  const targets = Array.from({ length: 10 }, (_, i) => ({ ...snapshot(i + 1), checks: [{ ...snapshot().checks[0]!, conclusion: 'failure' }] }))
  const { store, action } = await setup('fix-ci')
  const executor = new ActionExecutor(store, async url => targets.find(row => row.url === url)!, policy)
  const id = await executor.start({ ...run(action, targets), mode: 'coordinated' }); await executor.wait(id)
  const results = await store.receipts()
  expect(results).toHaveLength(10)
  expect(results.every(row => row.outcome === 'simulated' && row.result.includes('code or flaky tests (unverified)') && row.providerRequest === null)).toBe(true)
  expect(results[0]?.plan.join()).toContain('Shared failure candidate test / test')
  const timedAction = await store.install({ source: action.source, manifest: { ...action.manifest, version: 'timeout', limits: { ...action.manifest.limits, timeoutMs: 5 } } }, 'owner')
  const timed = new ActionExecutor(store, async () => { await new Promise(resolve => setTimeout(resolve, 20)); return snapshot() }, policy)
  const timedId = await timed.start(run(timedAction)); await timed.wait(timedId)
  expect((await store.receipts()).find(row => row.runId === timedId)?.outcome).toBe('cancelled')
})
it('orders an established base-ref/head-SHA dependency before its child in coordinated Fix CI', async () => {
  const parent = snapshot(1), child = { ...snapshot(2), base: parent.headRef, baseHead: parent.head }
  const { store, action } = await setup('fix-ci')
  // Inspection explicitly includes this stacked base; an ordinary main-only grant cannot.
  const stacked = await store.install({ source: action.source, manifest: { ...action.manifest, version: 'stacked', branches: ['main', parent.headRef] } }, 'owner')
  const order: string[] = []
  const executor = new ActionExecutor(store, async url => { order.push(url); return url === child.url ? child : parent }, policy)
  const input = { ...run(stacked, [child, parent]), mode: 'coordinated' as const }
  const id = await executor.start(input); await executor.wait(id)
  expect(order).toEqual([parent.url, child.url])
  expect((await store.receipts())[0]?.plan.join()).toContain('exact base-ref/base-SHA evidence')
  expect(await executor.start(input)).toBe(id)
})
}, 30_000)
